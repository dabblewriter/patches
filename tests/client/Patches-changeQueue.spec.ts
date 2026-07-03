import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { Patches } from '../../src/client/Patches';

/**
 * End-to-end regression tests for the Patches change queue over real OTAlgorithm /
 * OTInMemoryStore / OTDoc instances (no mocks of the pipeline itself), covering the
 * close/reopen drain (finding #30), failure poisoning (finding #31), submitDocChange
 * optimistic slots (finding #32) and deleteDoc vs in-flight open (finding #33).
 */
describe('Patches change queue integration', () => {
  let patches: InstanceType<typeof Patches>;
  let store: OTInMemoryStore;

  function setup() {
    store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    patches = new Patches({ algorithms: { ot: algorithm } });
  }

  afterEach(async () => {
    await patches.close();
    vi.restoreAllMocks();
  });

  it('close + immediate reopen does not lose or remint over the in-flight change (finding #30)', async () => {
    setup();
    // Slow the store write down so the mint is still in flight when closeDoc runs.
    const realSave = store.savePendingChanges.bind(store);
    vi.spyOn(store, 'savePendingChanges').mockImplementation(async (docId, changes) => {
      await new Promise(r => setTimeout(r, 5));
      return realSave(docId, changes);
    });

    const doc1 = await patches.openDoc<{ text?: string }>('doc1');
    doc1.change(patch => patch.add('/text', 'a'));
    await patches.closeDoc('doc1');

    const doc2 = await patches.openDoc<{ text?: string }>('doc1');
    expect(doc2.state).toEqual({ text: 'a' }); // the first keystroke survived the close

    doc2.change(patch => patch.add('/text', 'ab'));
    await doc2.flush();

    const pending = await store.getPendingChanges('doc1');
    expect(pending).toHaveLength(2);
    expect(pending.map(c => c.rev)).toEqual([1, 2]); // distinct revs — no silent overwrite
  });

  it('drops queued dependent changes when an earlier change is authoritatively rejected (finding #31)', async () => {
    setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const errors: Error[] = [];
    patches.onError(err => {
      errors.push(err);
    });

    vi.spyOn(store, 'savePendingChanges').mockImplementationOnce(async () => {
      throw Object.assign(new Error('write denied'), { code: 403 });
    });

    const doc = await patches.openDoc<{ list?: string[]; fresh?: boolean }>('doc1');
    doc.change(patch => patch.add('/list', []));
    doc.change(patch => patch.add('/list/0', 'x')); // depends on the failed change
    await doc.flush();

    expect(errors.map(e => e.message)).toEqual(['write denied']);
    // The dependent change must not be persisted against a base that no longer exists.
    expect(await store.getPendingChanges('doc1')).toEqual([]);
    expect(doc.state).toEqual({}); // both rolled back

    // Changes made after the rollback flow normally.
    doc.change(patch => patch.add('/fresh', true));
    await doc.flush();
    expect(await store.getPendingChanges('doc1')).toHaveLength(1);
    expect(doc.state).toEqual({ fresh: true });
  });

  it('submitDocChange interleaved with change() keeps state and store consistent (finding #32)', async () => {
    setup();
    const doc = await patches.openDoc<{ list: string[] }>('doc1');
    doc.change(patch => patch.add('/list', ['init']));
    await doc.flush();

    // Same tick: a submitted change queued first, a user change right behind it.
    const submitted = patches.submitDocChange('doc1', [{ op: 'add', path: '/list/-', value: 'submitted' }]);
    doc.change(patch => patch.add('/list/-', 'typed'));
    await submitted;
    await doc.flush();

    expect(doc.state.list).toEqual(['init', 'submitted', 'typed']);
    const pending = await store.getPendingChanges('doc1');
    expect(pending.flatMap(c => c.ops.map(o => o.value))).toEqual([['init'], 'submitted', 'typed']);
  });

  it('deleteDoc awaits an in-flight open and leaves no live doc over the tombstone (finding #33)', async () => {
    setup();
    let releaseLoad!: () => void;
    const gate = new Promise<void>(r => {
      releaseLoad = r;
    });
    vi.spyOn(store, 'getDoc').mockImplementationOnce(async function (this: OTInMemoryStore, docId: string) {
      await gate;
      return OTInMemoryStore.prototype.getDoc.call(store, docId);
    });

    const openPromise = patches.openDoc('doc1');
    await new Promise(r => setTimeout(r, 0)); // open is suspended in loadDoc

    const deletePromise = patches.deleteDoc('doc1');
    await new Promise(r => setTimeout(r, 0));
    releaseLoad();
    await openPromise;
    await deletePromise;

    expect(patches.getOpenDoc('doc1')).toBeUndefined();
    expect(patches.trackedDocs.has('doc1')).toBe(false);
  });
});
