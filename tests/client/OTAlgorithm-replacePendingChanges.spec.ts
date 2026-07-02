import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';

/**
 * replacePendingChanges swaps the pending queue for the re-split copy flushDoc is about to
 * send. The split can collapse a pending set to NOTHING: breaking an oversized change whose
 * only op is a @txt op carrying no sendable delta ops produces zero pieces, and flushDoc
 * passes the empty flattened array here. That must clear the old pending as a no-op — not
 * crash reading `.rev` off an empty array — while still preserving any changes minted after
 * the replaced set was read.
 */
describe('OTAlgorithm.replacePendingChanges', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1'], 'ot');
    // Committed through rev 4.
    await store.saveDoc('doc1', { state: { committed: true }, rev: 4 });
  });

  it('replaces the queue and renumbers changes minted since after the new queue', async () => {
    const oldPending = [createChange(4, 5, [{ op: 'add', path: '/a', value: 1 }])];
    await store.savePendingChanges('doc1', oldPending);
    const minted = createChange(4, 6, [{ op: 'add', path: '/later', value: 1 }]);
    await store.savePendingChanges('doc1', [minted]);

    const split = [
      createChange(4, 5, [{ op: 'add', path: '/a1', value: 1 }]),
      createChange(4, 6, [{ op: 'add', path: '/a2', value: 1 }]),
    ];
    await algorithm.replacePendingChanges('doc1', oldPending, split);

    const pending = await store.getPendingChanges('doc1');
    expect(pending.map(c => c.id)).toEqual([split[0].id, split[1].id, minted.id]);
    expect(pending.map(c => c.rev)).toEqual([5, 6, 7]); // minted-since renumbered after the new queue
  });

  it('clears the old pending without throwing when the split collapsed everything', async () => {
    const oldPending = [createChange(4, 5, [{ op: '@txt', path: '/text', value: [] }])];
    await store.savePendingChanges('doc1', oldPending);

    await expect(algorithm.replacePendingChanges('doc1', oldPending, [])).resolves.toBeUndefined();

    expect(await store.getPendingChanges('doc1')).toEqual([]);
    expect(await algorithm.hasPending('doc1')).toBe(false);
  });

  it('preserves changes minted since the read when the new queue is empty, renumbered off the committed rev', async () => {
    const oldPending = [createChange(4, 5, [{ op: '@txt', path: '/text', value: [] }])];
    await store.savePendingChanges('doc1', oldPending);
    const minted = createChange(4, 6, [{ op: 'add', path: '/later', value: 1 }]);
    await store.savePendingChanges('doc1', [minted]);

    await algorithm.replacePendingChanges('doc1', oldPending, []);

    const pending = await store.getPendingChanges('doc1');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(minted.id);
    expect(pending[0].ops).toEqual(minted.ops);
    expect(pending[0].rev).toBe(5); // next rev after the committed rev, no gap left by the dropped queue
  });
});
