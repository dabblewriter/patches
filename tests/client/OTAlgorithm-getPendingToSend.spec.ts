import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';

/**
 * The send choke point enforces the OT pending invariant: every pending change must share
 * `baseRev === committedRev`, since pending is a contiguous sequence applied on top of the
 * committed revision. A receive-rebase racing a local mint could persist one change with a
 * stale baseRev among rebased siblings (mixed `baseRev`), and the server rejects that batch
 * ("Client changes must have consistent baseRev"), wedging sync forever. getPendingToSend
 * re-stamps the batch to the current committedRev so an already-corrupted queue still flushes.
 */
describe('OTAlgorithm.getPendingToSend baseRev normalization', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    // Committed through rev 1794 (mirrors the reported wedge).
    await store.saveDoc('doc1', { state: {}, rev: 1794 });
  });

  it('re-stamps a stale baseRev in the pending queue to committedRev', async () => {
    await store.savePendingChanges('doc1', [
      createChange(1794, 1795, [{ op: 'replace', path: '/docs/oHNA/title', value: 'a' }]),
      createChange(1794, 1796, [{ op: 'replace', path: '/docs/oHNA/title', value: 'ab' }]),
      // The straggler the race left behind: rev fits the sequence, baseRev is stale.
      createChange(1791, 1797, [{ op: 'replace', path: '/docs/oHNA/title', value: 'Drop by Home ' }]),
      createChange(1794, 1798, [{ op: 'replace', path: '/docs/oHNA/title', value: 'abc' }]),
    ]);

    const pending = await algorithm.getPendingToSend('doc1');

    expect(pending).not.toBeNull();
    expect(new Set(pending!.map(c => c.baseRev))).toEqual(new Set([1794]));
    // Order, revs, ids and ops are untouched — only baseRev is healed.
    expect(pending!.map(c => c.rev)).toEqual([1795, 1796, 1797, 1798]);
    expect(pending![2].ops).toEqual([{ op: 'replace', path: '/docs/oHNA/title', value: 'Drop by Home ' }]);
  });

  it('returns the queue untouched when every baseRev already matches', async () => {
    const changes = [
      createChange(1794, 1795, [{ op: 'add', path: '/a', value: 1 }]),
      createChange(1794, 1796, [{ op: 'add', path: '/b', value: 2 }]),
    ];
    await store.savePendingChanges('doc1', changes);

    const pending = await algorithm.getPendingToSend('doc1');

    expect(pending).toEqual(changes);
  });

  it('returns null when there is nothing pending', async () => {
    expect(await algorithm.getPendingToSend('doc1')).toBeNull();
  });

  // The DAB-607 already-committed-strand drop at the send choke point is gone: a strand
  // (a re-queued copy of an already-committed change) can no longer form. In-txn rev mint
  // (R1) and conflict-safe replace (R2) close the raced pending write that produced it, and
  // the server's change-id dedup backstops any resend. Its coverage is removed, not ported.
});

/**
 * With an open doc, getPendingToSend unions the FULL store queue with the doc's in-memory
 * pending, store rows winning by id (no state materialization). R1 mints from the shared store
 * tail, so a foreign tab's row can land BELOW the open doc's pending tail — a doc-tail-anchored
 * ranged read would structurally miss it.
 */
describe('OTAlgorithm.getPendingToSend — open doc (R3a)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: {}, rev: 10 });
  });

  it('returns the open doc pending without materializing store state', async () => {
    const p1 = createChange(10, 11, [{ op: 'add', path: '/a', value: 1 }]);
    const p2 = createChange(10, 12, [{ op: 'add', path: '/b', value: 2 }]);
    const doc = { getPendingChanges: () => [p1, p2], committedRev: 10 };
    const getDocSpy = vi.spyOn(store, 'getDoc');

    const pending = await algorithm.getPendingToSend('doc1', doc as any);

    expect(pending!.map(c => c.id)).toEqual([p1.id, p2.id]);
    expect(getDocSpy).not.toHaveBeenCalled(); // no state materialization on the send path
  });

  it('includes a foreign mint past the in-memory tail from the store queue', async () => {
    const p1 = createChange(10, 11, [{ op: 'add', path: '/a', value: 1 }]);
    await store.savePendingChanges('doc1', [p1]); // store + doc agree on rev 11
    // A foreign tab minted straight into the shared store (re-stamped to rev 12); the doc
    // hasn't seen it yet.
    const foreign = createChange(10, 12, [{ op: 'add', path: '/foreign', value: 9 }]);
    await store.savePendingChanges('doc1', [foreign]);
    const doc = { getPendingChanges: () => [p1], committedRev: 10 };

    const pending = await algorithm.getPendingToSend('doc1', doc as any);

    expect(pending!.map(c => c.id)).toEqual([p1.id, foreign.id]);
    expect(foreign.rev).toBe(12);
  });

  it('does not duplicate a change present in both the store and the doc', async () => {
    const p1 = createChange(10, 11, [{ op: 'add', path: '/a', value: 1 }]);
    const p2 = createChange(10, 12, [{ op: 'add', path: '/b', value: 2 }]);
    await store.savePendingChanges('doc1', [{ ...p1 }, { ...p2 }]);
    const doc = { getPendingChanges: () => [p1, p2], committedRev: 10 };

    const pending = await algorithm.getPendingToSend('doc1', doc as any);

    expect(pending!.map(c => c.id)).toEqual([p1.id, p2.id]);
  });

  it('includes a foreign row BELOW the doc tail (foreign tab minted first)', async () => {
    // Tab B minted X first (store rev 1), then this tab minted Y (store rev 2). This doc only
    // knows Y — a ranged read past the doc's tail (rev > 2) would never see X, so the flush
    // would send Y alone and the next flush would ship X at a stale frame.
    await store.saveDoc('doc1', { state: {}, rev: 0 });
    const foreignX = createChange(0, 1, [{ op: 'add', path: '/items/3', value: 'X' }]);
    const ourY = createChange(0, 1, [{ op: 'add', path: '/items/0', value: 'Y' }]);
    await store.savePendingChanges('doc1', [foreignX]);
    await store.savePendingChanges('doc1', [ourY]); // re-stamped to rev 2
    const doc = { getPendingChanges: () => [ourY], committedRev: 0 };

    const pending = await algorithm.getPendingToSend('doc1', doc as any);

    expect(pending!.map(c => c.id)).toEqual([foreignX.id, ourY.id]);
  });

  it('ships the store row, not the doc in-memory copy, when both hold the same id', async () => {
    // A receive rebased the store's copy of p1 in place (same rev, transformed ops). The doc's
    // in-memory copy is stale; the flush must carry the store's rebased ops.
    const p1 = createChange(10, 11, [{ op: 'add', path: '/items/0', value: 'stale' }]);
    const rebasedP1 = { ...p1, ops: [{ op: 'add' as const, path: '/items/2', value: 'stale' }] };
    await store.savePendingChanges('doc1', [rebasedP1]);
    const doc = { getPendingChanges: () => [p1], committedRev: 10 };

    const pending = await algorithm.getPendingToSend('doc1', doc as any);

    expect(pending).toHaveLength(1);
    expect(pending![0].ops).toEqual(rebasedP1.ops);
  });
});
