import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';

/**
 * A strand — a re-queued pending copy of an already-committed change (DAB-607) — can no longer
 * form: in-txn rev mint (R1) and conflict-safe replace (R2) close the raced pending write that
 * produced it, and the server's change-id dedup backstops any resend. The receive-side and
 * send-side strand detectors are therefore deleted, and their tests with them. What remains is
 * the guard that the deletion didn't over-reach: a genuinely fresh pending change minted after a
 * commit is rebased forward on the next foreign delivery, never dropped.
 */
describe('OTAlgorithm receive rebase keeps a genuinely new pending change', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: {}, rev: 100 });
  });

  it('rebases a post-commit pending change forward instead of dropping it', async () => {
    const x = createChange(100, 101, [{ op: 'add', path: '/title', value: 'a' }]);
    await algorithm.applyServerChanges('doc1', [{ ...x, committedAt: 111 }], undefined);

    const fresh = createChange(101, 102, [{ op: 'add', path: '/body', value: 'b' }]);
    await store.savePendingChanges('doc1', [fresh]);

    const pending = await algorithm.getPendingToSend('doc1');
    expect(pending!.map(c => c.id)).toEqual([fresh.id]);

    // A later foreign delivery rebases it forward instead of dropping it.
    const foreign = createChange(101, 102, [{ op: 'add', path: '/other', value: 1 }]);
    await algorithm.applyServerChanges('doc1', [{ ...foreign, committedAt: 112 }], undefined);
    expect((await store.getPendingChanges('doc1')).map(c => c.id)).toEqual([fresh.id]);
  });
});
