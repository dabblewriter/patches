import { afterEach, describe, expect, it, vi } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import type { OTDoc } from '../../src/client/OTDoc';
import { Patches } from '../../src/client/Patches';
import { createChange } from '../../src/data/change';

/**
 * Non-destructive rollback on transient submit failures (sync-reliability register
 * item 4, client-engine half — refs DABBLE-WRITER-3-7Y / DABBLE-WRITER-3-4E).
 *
 * A change submit that dies from a transport timeout / abort / status-less failure is
 * NOT a verdict on the ops — the write may have landed, or may land on a later attempt.
 * Discarding the doc's optimistic queue (the old behavior) silently deleted the user's
 * un-persisted typing. These tests pin the new contract:
 *
 *   - transient/ambiguous failure  → ops KEPT applied, submit retried with backoff under
 *     the SAME stable change id (idempotent end-to-end), queued changes wait in order;
 *   - authoritative rejection (terminal StatusError code) → rollback, exactly as before;
 *   - a change confirmed through another path while the retry sleeps is not re-submitted;
 *   - close() parks the retry without rolling anything back.
 */
describe('Patches change-submit retry (non-destructive rollback)', () => {
  let patches: InstanceType<typeof Patches>;

  const timeoutError = () => new Error('Call timed out'); // no status code — ambiguous transport death
  const rejectionError = () => Object.assign(new Error('write denied'), { code: 403 });
  // A change whose own data can never be persisted (a non-cloneable value hit IndexedDB's
  // structured-clone step). Duck-typed on `name`; retrying it is provably useless.
  const defectiveError = () => Object.assign(new Error('could not be cloned'), { name: 'DataCloneError' });

  afterEach(async () => {
    vi.useRealTimers();
    await patches.close();
    vi.restoreAllMocks();
  });

  describe('OT', () => {
    let store: OTInMemoryStore;

    function setup() {
      store = new OTInMemoryStore();
      patches = new Patches({ algorithms: { ot: new OTAlgorithm(store) } });
    }

    it('keeps optimistic ops through a transient failure and retries with the same stable id', async () => {
      setup();
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errors: { error: Error; context?: any }[] = [];
      patches.onError((error, context) => {
        errors.push({ error, context });
      });

      const saveSpy = vi.spyOn(store, 'savePendingChanges');
      saveSpy.mockImplementationOnce(async () => {
        throw timeoutError();
      });

      const doc = await patches.openDoc<{ text?: string }>('doc1');
      doc.change(patch => patch.add('/text', 'hello'));
      await vi.advanceTimersByTimeAsync(0); // first attempt runs and fails

      // The typed text is still on screen and nothing persisted yet.
      expect(doc.state).toEqual({ text: 'hello' });
      expect(await store.getPendingChanges('doc1')).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0].context).toEqual({ docId: 'doc1', willRetry: true, kind: 'environment', attempt: 0 });

      await vi.advanceTimersByTimeAsync(1000); // first backoff elapses → retry succeeds

      expect(saveSpy).toHaveBeenCalledTimes(2);
      const pending = await store.getPendingChanges('doc1');
      expect(pending).toHaveLength(1);
      expect(pending[0].ops).toEqual([{ op: 'add', path: '/text', value: 'hello' }]);
      // Same stable change id across both attempts — the retry is idempotent end-to-end.
      expect(saveSpy.mock.calls[0][1][0].id).toBe(pending[0].id);
      expect(doc.state).toEqual({ text: 'hello' });

      vi.useRealTimers();
      await doc.flush(); // fully drained — no optimistic residue
    });

    it('queued dependent changes wait behind the retry and land in capture order', async () => {
      setup();
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const saveSpy = vi.spyOn(store, 'savePendingChanges');
      saveSpy.mockImplementationOnce(async () => {
        throw timeoutError();
      });

      const doc = await patches.openDoc<{ list?: string[] }>('doc1');
      doc.change(patch => patch.add('/list', []));
      doc.change(patch => patch.add('/list/0', 'x')); // depends on the first change
      await vi.advanceTimersByTimeAsync(0);

      // Only the first mint has been attempted; the dependent change is queued, not dropped.
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(doc.state).toEqual({ list: ['x'] });

      await vi.advanceTimersByTimeAsync(1000); // retry succeeds, then the queued mint drains

      const pending = await store.getPendingChanges('doc1');
      expect(pending).toHaveLength(2);
      expect(pending.map(c => c.rev)).toEqual([1, 2]);
      expect(doc.state).toEqual({ list: ['x'] });
    });

    it('does not re-submit a change confirmed through another path while the retry sleeps', async () => {
      setup();
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const saveSpy = vi.spyOn(store, 'savePendingChanges');
      saveSpy.mockImplementationOnce(async () => {
        throw timeoutError();
      });

      const doc = await patches.openDoc<{ text?: string }>('doc1');
      doc.change(patch => patch.add('/text', 'hello'));
      await vi.advanceTimersByTimeAsync(0); // first attempt fails; retry sleeping

      // Simulate the change arriving as an uncommitted confirmation from another path
      // (e.g. a hub that DID persist the timed-out submit broadcasts it back): the
      // local-change apply shifts the optimistic entry off the FIFO queue.
      const ops = [{ op: 'add' as const, path: '/text', value: 'hello' }];
      (doc as OTDoc<{ text?: string }>).applyChanges([createChange(0, 1, ops, {})]);

      await vi.advanceTimersByTimeAsync(60_000); // retry wakes → sees the entry confirmed → stops

      expect(saveSpy).toHaveBeenCalledTimes(1); // no second submit — would double-apply
      expect(doc.state).toEqual({ text: 'hello' });
      expect((doc as OTDoc<{ text?: string }>).getPendingChanges()).toHaveLength(1);
    });

    it('still rolls back on an authoritative rejection', async () => {
      setup();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const errors: { error: Error; context?: any }[] = [];
      patches.onError((error, context) => {
        errors.push({ error, context });
      });

      const saveSpy = vi.spyOn(store, 'savePendingChanges');
      saveSpy.mockImplementationOnce(async () => {
        throw rejectionError();
      });

      const doc = await patches.openDoc<{ text?: string }>('doc1');
      doc.change(patch => patch.add('/text', 'hello'));
      await doc.flush();

      expect(saveSpy).toHaveBeenCalledTimes(1); // no retry — the server's verdict is final
      expect(doc.state).toEqual({}); // rolled back
      expect(await store.getPendingChanges('doc1')).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0].context).toEqual({ docId: 'doc1', willRetry: false, kind: 'rejection' });
    });

    it('close() parks the retry loop without rolling back or re-submitting', async () => {
      setup();
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const saveSpy = vi.spyOn(store, 'savePendingChanges');
      saveSpy.mockImplementation(async () => {
        throw timeoutError();
      });

      const doc = await patches.openDoc<{ text?: string }>('doc1');
      doc.change(patch => patch.add('/text', 'hello'));
      await vi.advanceTimersByTimeAsync(0); // attempt 1 fails; retry sleeping

      await patches.close(); // sweeps the sleeping backoff; loop observes _closed and exits

      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(doc.state).toEqual({ text: 'hello' }); // teardown never discards the ops

      await vi.advanceTimersByTimeAsync(120_000);
      expect(saveSpy).toHaveBeenCalledTimes(1); // no zombie re-submits after close
    });

    it.each([
      ['an Error subclass', defectiveError],
      ['a non-Error DOMException shape', () => ({ name: 'DataCloneError', message: 'could not be cloned' })],
    ])('treats a defective change (%s) as terminal: rollback, epoch bump, no retry', async (_label, makeErr) => {
      setup();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const errors: { error: Error; context?: any }[] = [];
      patches.onError((error, context) => errors.push({ error, context }));

      const saveSpy = vi.spyOn(store, 'savePendingChanges');
      saveSpy.mockImplementationOnce(async () => {
        throw makeErr();
      });

      const doc = await patches.openDoc<{ a?: any[] }>('doc1');
      doc.change(patch => patch.add('/a', []));
      doc.change(patch => patch.add('/a/0', 'x')); // depends on the first — must be skipped after rollback
      await doc.flush();

      expect(saveSpy).toHaveBeenCalledTimes(1); // never retried — the change can NEVER be saved
      expect(doc.state).toEqual({}); // rolled back, exactly like an authoritative rejection
      expect(await store.getPendingChanges('doc1')).toEqual([]);
      expect(patches.isWriteLatched('doc1')).toBe(false); // terminal, not latched
      const defective = errors.find(e => e.context?.kind === 'defective');
      expect(defective?.context).toEqual({ docId: 'doc1', willRetry: false, kind: 'defective' });
    });

    it('caps ambiguous retries at 3 attempts, then latches the doc without rolling back', async () => {
      setup();
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const errors: { error: Error; context?: any }[] = [];
      patches.onError((error, context) => errors.push({ error, context }));

      const saveSpy = vi.spyOn(store, 'savePendingChanges');
      saveSpy.mockImplementation(async () => {
        throw timeoutError();
      });

      const doc = await patches.openDoc<{ text?: string }>('doc1');
      doc.change(patch => patch.add('/text', 'hello'));
      await vi.advanceTimersByTimeAsync(0); // attempt 1 fails, backoff 1s
      await vi.advanceTimersByTimeAsync(1000); // attempt 2 fails, backoff 2s
      await vi.advanceTimersByTimeAsync(2000); // attempt 3 fails → latch

      expect(saveSpy).toHaveBeenCalledTimes(3); // initial + 2 retries, then it stops
      expect(doc.state).toEqual({ text: 'hello' }); // NOT rolled back — the ops may yet land
      expect(await store.getPendingChanges('doc1')).toEqual([]); // nothing persisted
      expect(patches.isWriteLatched('doc1')).toBe(true);
      expect(patches.writeLatchedDocs).toEqual(['doc1']);

      expect(errors.filter(e => e.context?.willRetry === true)).toHaveLength(2); // two mid-retry emits
      expect(errors[errors.length - 1].context).toEqual({
        docId: 'doc1',
        willRetry: false,
        kind: 'environment',
        attempt: 2,
      });

      await vi.advanceTimersByTimeAsync(120_000);
      expect(saveSpy).toHaveBeenCalledTimes(3); // latched: no further submits
    });

    it('skips persistence for changes made while latched, keeping them applied in memory', async () => {
      setup();
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const errors: { error: Error; context?: any }[] = [];
      patches.onError((error, context) => errors.push({ error, context }));

      const saveSpy = vi.spyOn(store, 'savePendingChanges');
      saveSpy.mockImplementation(async () => {
        throw timeoutError();
      });

      const doc = await patches.openDoc<{ text?: string; more?: string }>('doc1');
      doc.change(patch => patch.add('/text', 'hello'));
      await vi.advanceTimersByTimeAsync(3000); // drive to latch (0 + 1s + 2s backoffs)
      expect(patches.isWriteLatched('doc1')).toBe(true);

      saveSpy.mockClear();
      errors.length = 0;
      doc.change(patch => patch.add('/more', 'text'));
      await vi.advanceTimersByTimeAsync(0);

      expect(saveSpy).not.toHaveBeenCalled(); // latched — nothing minted or sent
      expect(doc.state).toEqual({ text: 'hello', more: 'text' }); // still applied optimistically
      expect(errors).toHaveLength(1);
      expect(errors[0].context).toEqual({ docId: 'doc1', willRetry: false, kind: 'environment', latched: true });
    });

    it('retrySavingChanges clears the latch and re-submits retained ops in order once the store recovers', async () => {
      setup();
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const original = store.savePendingChanges.bind(store);
      let failSaves = true;
      const saveSpy = vi.spyOn(store, 'savePendingChanges').mockImplementation(async (id, changes) => {
        if (failSaves) throw timeoutError();
        return original(id, changes);
      });

      const doc = await patches.openDoc<{ list?: string[] }>('doc1');
      doc.change(patch => patch.add('/list', []));
      doc.change(patch => patch.add('/list/0', 'a')); // dependent — order must be preserved on re-drive
      await vi.advanceTimersByTimeAsync(3000); // drive the first change to latch
      expect(patches.isWriteLatched('doc1')).toBe(true);
      expect(await store.getPendingChanges('doc1')).toEqual([]);
      saveSpy.mockClear();

      // Store recovers; the app asks to resume saving.
      failSaves = false;
      vi.useRealTimers();
      await patches.retrySavingChanges('doc1');

      expect(patches.isWriteLatched('doc1')).toBe(false);
      const pending = await store.getPendingChanges('doc1');
      expect(pending).toHaveLength(2);
      expect(pending.map(c => c.rev)).toEqual([1, 2]); // re-driven in capture order
      expect(pending[0].ops).toEqual([{ op: 'add', path: '/list', value: [] }]);
      expect(pending[1].ops).toEqual([{ op: 'add', path: '/list/0', value: 'a' }]);
      expect(doc.state).toEqual({ list: ['a'] });
    });

    it('re-latches when retrySavingChanges runs against a still-broken store', async () => {
      setup();
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const saveSpy = vi.spyOn(store, 'savePendingChanges');
      saveSpy.mockImplementation(async () => {
        throw timeoutError();
      });

      const doc = await patches.openDoc<{ text?: string }>('doc1');
      doc.change(patch => patch.add('/text', 'hello'));
      await vi.advanceTimersByTimeAsync(3000); // latch
      expect(patches.isWriteLatched('doc1')).toBe(true);
      saveSpy.mockClear();

      const retryP = patches.retrySavingChanges('doc1');
      await vi.advanceTimersByTimeAsync(3000); // re-drive: 3 attempts against the broken store
      await retryP;

      expect(saveSpy).toHaveBeenCalledTimes(3); // the retained entry retried the full bounded budget
      expect(patches.isWriteLatched('doc1')).toBe(true); // re-latched
      expect(doc.state).toEqual({ text: 'hello' }); // still retained, never discarded
    });
  });

  describe('LWW', () => {
    let store: LWWInMemoryStore;

    function setup() {
      store = new LWWInMemoryStore();
      patches = new Patches({ algorithms: { lww: new LWWAlgorithm(store) } });
    }

    it('keeps optimistic ops through a transient failure and retries until persisted', async () => {
      setup();
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errors: { error: Error; context?: any }[] = [];
      patches.onError((error, context) => {
        errors.push({ error, context });
      });

      const saveSpy = vi.spyOn(store, 'savePendingOps');
      saveSpy.mockImplementationOnce(async () => {
        throw timeoutError();
      });

      const doc = await patches.openDoc<{ theme?: string }>('settings');
      doc.change(patch => patch.add('/theme', 'sepia'));
      await vi.advanceTimersByTimeAsync(0); // first attempt fails

      expect(doc.state).toEqual({ theme: 'sepia' }); // kept applied
      expect(await store.getPendingOps('settings')).toEqual([]);
      expect(errors[0].context).toEqual({ docId: 'settings', willRetry: true, kind: 'environment', attempt: 0 });

      await vi.advanceTimersByTimeAsync(1000); // retry succeeds

      expect(saveSpy).toHaveBeenCalledTimes(2);
      const pendingOps = await store.getPendingOps('settings');
      expect(pendingOps).toHaveLength(1);
      expect(pendingOps[0]).toMatchObject({ op: 'add', path: '/theme', value: 'sepia' });
      expect(doc.state).toEqual({ theme: 'sepia' });
    });

    it('still rolls back on an authoritative rejection', async () => {
      setup();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const errors: { error: Error; context?: any }[] = [];
      patches.onError((error, context) => {
        errors.push({ error, context });
      });

      vi.spyOn(store, 'savePendingOps').mockImplementationOnce(async () => {
        throw rejectionError();
      });

      const doc = await patches.openDoc<{ theme?: string }>('settings');
      doc.change(patch => patch.add('/theme', 'sepia'));
      await doc.flush();

      expect(doc.state).toEqual({}); // rolled back
      expect(await store.getPendingOps('settings')).toEqual([]);
      expect(errors[0].context).toEqual({ docId: 'settings', willRetry: false, kind: 'rejection' });
    });
  });
});
