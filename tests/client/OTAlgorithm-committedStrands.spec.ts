import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';

/**
 * A strand is a pending copy of an already-committed change, re-queued by a raced pending
 * write after its echo cleared it (DAB-607). Re-sending one commits a duplicate: its baseRev
 * has advanced past the original commit, outside the server's `startAfter: baseRev` id dedup.
 * These cover the detector that survives rebase re-stamping: the per-instance record of
 * committed ids, consulted at receive (before the rebase walk) and at send.
 */
describe('OTAlgorithm committed-strand handling (DAB-607)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: {}, rev: 100 });
  });

  const mintX = () => createChange(100, 101, [{ op: 'add', path: '/title', value: 'a' }]);

  it('drops a re-queued strand at the next foreign-only delivery (receive side)', async () => {
    // X's echo applies normally; the instance records its id as committed.
    const x = mintX();
    await algorithm.applyServerChanges('doc1', [{ ...x, committedAt: 111 }], undefined);
    // A raced stale write re-strands X in the pending queue.
    await store.savePendingChanges('doc1', [x]);
    // A purely-foreign delivery: no redundant echo of X, so without the committed-id record
    // the strand would survive the rebase re-stamped to a clean baseRev — and mis-advance
    // the foreign ops through content the committed state already contains.
    const foreign = createChange(101, 102, [{ op: 'add', path: '/other', value: 1 }]);
    await algorithm.applyServerChanges('doc1', [{ ...foreign, committedAt: 112 }], undefined);

    expect(await store.getPendingChanges('doc1')).toEqual([]);
    expect(await algorithm.getPendingToSend('doc1')).toBeNull();
  });

  it('drops a strand whose baseRev a rebase already cleaned (send side)', async () => {
    const x = mintX();
    await algorithm.applyServerChanges('doc1', [{ ...x, committedAt: 111 }], undefined);
    // The stale write lands post-rebase shaped: baseRev already equals committedRev, so the
    // stale-baseRev store scan can't see it. Only the committed-id record recognizes it.
    await store.savePendingChanges('doc1', [{ ...x, baseRev: 101, rev: 102 }]);

    expect(await algorithm.getPendingToSend('doc1')).toBeNull();
    expect(await store.getPendingChanges('doc1')).toEqual([]);
  });

  it('keeps a genuinely new pending change minted after the commit', async () => {
    const x = mintX();
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
