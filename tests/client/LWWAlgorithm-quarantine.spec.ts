import { describe, expect, it } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import type { LWWDoc } from '../../src/client/LWWDoc';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change } from '../../src/types';

/**
 * Poison-pill ejection at the algorithm level: verifyPendingChange is the local
 * strict-apply probe corroborating a server rejection (the server names a suspect, never
 * delivers a verdict), and ejectPendingChange atomically moves the sending change into
 * quarantine while preserving pendingOps minted since it was captured.
 */
describe('LWWAlgorithm quarantine', () => {
  const DOC = 'q-doc';

  function committed(baseRev: number, rev: number, ops: JSONPatchOp[], id?: string): Change {
    return createChange(baseRev, rev, ops, { committedAt: 1000 + rev }, id);
  }

  async function setup() {
    const store = new LWWInMemoryStore();
    const algorithm = new LWWAlgorithm(store);
    await algorithm.trackDocs([DOC]);
    // Committed base state { title: 'x' } at rev 1.
    await algorithm.applyServerChanges(
      DOC,
      [committed(0, 1, [{ op: 'replace', path: '/title', value: 'x', ts: 1, rev: 1 }])],
      undefined
    );
    return { store, algorithm };
  }

  /** Mint ops and capture them into the sending slot, as a flush would. */
  async function capture(algorithm: LWWAlgorithm, ops: JSONPatchOp[], doc?: LWWDoc): Promise<Change> {
    await algorithm.handleDocChange(DOC, ops, doc, {});
    const [sending] = (await algorithm.getPendingToSend(DOC))!;
    return sending;
  }

  describe('verifyPendingChange', () => {
    it('returns true for a sending change that strict-applies against committed state', async () => {
      const { algorithm } = await setup();
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title', value: 'y' }]);
      expect(await algorithm.verifyPendingChange(DOC, sending.id)).toBe(true);
    });

    it('returns false for a sending change that fails strict-apply (descends through a primitive)', async () => {
      const { algorithm } = await setup();
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title/a/b', value: 1 }]);
      expect(await algorithm.verifyPendingChange(DOC, sending.id)).toBe(false);
    });

    it('probes against committed-only state, not state that already includes newer pending ops', async () => {
      const { algorithm } = await setup();
      // Captured while committed /title was still a primitive — fails against committed state.
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title/a', value: 1 }]);
      // A newer pending op replaces /title with an object: against the FULL local state the
      // sending ops would apply cleanly, masking the poison. The probe must not see it.
      await algorithm.handleDocChange(DOC, [{ op: 'replace', path: '/title', value: {} }], undefined, {});
      expect(await algorithm.verifyPendingChange(DOC, sending.id)).toBe(false);
    });

    it('returns true when no pending change matches the id (nothing to corroborate)', async () => {
      const { algorithm } = await setup();
      expect(await algorithm.verifyPendingChange(DOC, 'no-such-id')).toBe(true);
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title', value: 'y' }]);
      expect(await algorithm.verifyPendingChange(DOC, sending.id + '-other')).toBe(true);
    });
  });

  describe('ejectPendingChange', () => {
    it('quarantines the sending change and preserves pendingOps minted after capture', async () => {
      const { store, algorithm } = await setup();
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title', value: 'POISON' }]);
      // Minted after the sending slot was captured — must survive the ejection.
      await algorithm.handleDocChange(DOC, [{ op: 'replace', path: '/subtitle', value: 'keep' }], undefined, {});

      const quarantined = await algorithm.ejectPendingChange(DOC, sending.id, 'server rejected');

      expect(quarantined).toMatchObject({ docId: DOC, changeId: sending.id, reason: 'server rejected' });
      expect(quarantined!.change.ops).toEqual(sending.ops);
      expect(quarantined!.quarantinedAt).toBeGreaterThan(0);
      expect(await store.getSendingChange(DOC)).toBeNull();
      expect((await store.getPendingOps(DOC)).map(op => op.path)).toEqual(['/subtitle']);

      // The rebuilt state no longer contains the ejected value; the survivor is intact.
      const snapshot = await algorithm.loadDoc(DOC);
      expect(snapshot!.state).toEqual({ title: 'x', subtitle: 'keep' });

      // The next flush sends only the survivor.
      const [next] = (await algorithm.getPendingToSend(DOC))!;
      expect(next.ops.map(op => op.path)).toEqual(['/subtitle']);
    });

    it('rebuilds an open doc without the ejected ops', async () => {
      const { algorithm } = await setup();
      const doc = algorithm.createDoc(DOC, await algorithm.loadDoc(DOC)) as LWWDoc<any>;
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title', value: 'POISON' }], doc);
      expect(doc.state).toEqual({ title: 'POISON' });

      await algorithm.ejectPendingChange(DOC, sending.id, 'server rejected', doc);

      expect(doc.state).toEqual({ title: 'x' });
    });

    it('returns null and mutates nothing when the id does not match the sending change', async () => {
      const { store, algorithm } = await setup();
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title', value: 'y' }]);

      expect(await algorithm.ejectPendingChange(DOC, 'other-id', 'nope')).toBeNull();

      expect((await store.getSendingChange(DOC))?.id).toBe(sending.id);
      expect(await store.listQuarantinedChanges(DOC)).toEqual([]);
    });

    it('quarantines only the unconfirmed remainder of a partially-confirmed change', async () => {
      const { store, algorithm } = await setup();
      const sending = await capture(algorithm, [
        { op: 'replace', path: '/a', value: 1 },
        { op: 'replace', path: '/b', value: 2 },
      ]);
      // The server confirmed /a's batch; /b remains in the sending slot.
      await store.confirmSendingChange(DOC, [sending.ops[0]]);

      const quarantined = await algorithm.ejectPendingChange(DOC, sending.id, 'rejected');

      expect(quarantined!.change.ops.map(op => op.path)).toEqual(['/b']);
    });
  });

  describe('list / discard / cleanup', () => {
    it('lists per doc and across docs, and discard removes an entry', async () => {
      const { algorithm } = await setup();
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title', value: 'y' }]);
      await algorithm.ejectPendingChange(DOC, sending.id, 'rejected');

      expect((await algorithm.listQuarantinedChanges(DOC)).map(q => q.changeId)).toEqual([sending.id]);
      expect((await algorithm.listQuarantinedChanges()).map(q => q.changeId)).toEqual([sending.id]);
      expect(await algorithm.listQuarantinedChanges('other-doc')).toEqual([]);

      await algorithm.discardQuarantinedChange(DOC, sending.id);
      expect(await algorithm.listQuarantinedChanges(DOC)).toEqual([]);
    });

    it('preserves quarantine across untrackDocs (cache eviction is not a discard decision)', async () => {
      const { store, algorithm } = await setup();
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title', value: 'y' }]);
      await algorithm.ejectPendingChange(DOC, sending.id, 'rejected');
      await algorithm.untrackDocs([DOC]);
      expect((await store.listQuarantinedChanges()).map(q => q.changeId)).toEqual([sending.id]);
    });

    it('clears quarantine on deleteDoc', async () => {
      const { store, algorithm } = await setup();
      const sending = await capture(algorithm, [{ op: 'replace', path: '/title', value: 'y' }]);
      await algorithm.ejectPendingChange(DOC, sending.id, 'rejected');
      await algorithm.deleteDoc(DOC);
      expect(await store.listQuarantinedChanges()).toEqual([]);
    });
  });

  describe('getCommittedState', () => {
    it('excludes sending and pending layers', async () => {
      const { store, algorithm } = await setup();
      await capture(algorithm, [{ op: 'replace', path: '/title', value: 'sending' }]);
      await algorithm.handleDocChange(DOC, [{ op: 'replace', path: '/subtitle', value: 'pending' }], undefined, {});

      expect(await store.getCommittedState(DOC)).toEqual({ state: { title: 'x' }, rev: 1 });
    });
  });
});
