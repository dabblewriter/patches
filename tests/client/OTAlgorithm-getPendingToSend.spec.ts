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
 * With an open doc, getPendingToSend trusts the doc for pending (no state materialization) and
 * only does a ranged store read past the doc's tail to fold in a foreign tab's mint (R3a).
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

  it('appends a foreign mint past the in-memory tail from the ranged store read', async () => {
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

  it('does not re-append a foreign row already at or below the in-memory tail', async () => {
    const p1 = createChange(10, 11, [{ op: 'add', path: '/a', value: 1 }]);
    const p2 = createChange(10, 12, [{ op: 'add', path: '/b', value: 2 }]);
    // The store holds the same two revs the doc already knows — the ranged read (rev > 12)
    // returns nothing, so no duplicates fold in.
    await store.savePendingChanges('doc1', [{ ...p1 }, { ...p2 }]);
    const doc = { getPendingChanges: () => [p1, p2], committedRev: 10 };

    const pending = await algorithm.getPendingToSend('doc1', doc as any);

    expect(pending!.map(c => c.id)).toEqual([p1.id, p2.id]);
  });

  it('does not duplicate the doc pending when a custom store ignores startAfterRev', async () => {
    const p1 = createChange(10, 11, [{ op: 'add', path: '/a', value: 1 }]);
    const p2 = createChange(10, 12, [{ op: 'add', path: '/b', value: 2 }]);
    const doc = { getPendingChanges: () => [p1, p2], committedRev: 10 };
    // A store implemented against the pre-R3a signature ignores the ranged option and returns the
    // whole pending queue; the id filter must keep the doc's own pending from folding in twice.
    store.getPendingChanges = (async () => [p1, p2]) as typeof store.getPendingChanges;

    const pending = await algorithm.getPendingToSend('doc1', doc as any);

    expect(pending!.map(c => c.id)).toEqual([p1.id, p2.id]);
  });
});
