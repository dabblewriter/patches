import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';

/**
 * The send choke point enforces the OT batch invariant: every change in one flush must share a
 * baseRev, since a batch is a sequential program expressed against that committed frame. A
 * receive-rebase racing a local mint can persist one change with a stale baseRev among rebased
 * siblings (mixed `baseRev`). Re-stamping the straggler to the newest frame — the old behavior —
 * committed its ops without the transform across the intervening committed changes: permanent
 * history that can never apply (the DAB-946 poison class; DAB-951). Instead the flush is sliced
 * to the queue's leading same-baseRev run, each run going out at its TRUE baseRev; the server
 * holds every committed change past any baseRev and does the transform the client can't.
 */
describe('OTAlgorithm.getPendingToSend mixed-baseRev slicing (DAB-951)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    // Committed through rev 1794 (mirrors the reported wedge).
    await store.saveDoc('doc1', { state: {}, rev: 1794 });
  });

  it('never relabels a straggler; flushes the leading frame run at its true baseRev', async () => {
    await store.savePendingChanges('doc1', [
      createChange(1794, 1795, [{ op: 'replace', path: '/docs/oHNA/title', value: 'a' }]),
      createChange(1794, 1796, [{ op: 'replace', path: '/docs/oHNA/title', value: 'ab' }]),
      // The straggler the race left behind: rev fits the sequence, baseRev is stale.
      createChange(1791, 1797, [{ op: 'replace', path: '/docs/oHNA/title', value: 'Drop by Home ' }]),
      createChange(1794, 1798, [{ op: 'replace', path: '/docs/oHNA/title', value: 'abc' }]),
    ]);

    const pending = await algorithm.getPendingToSend('doc1');

    // Only the leading run of the queue's first frame goes out, untouched.
    expect(pending!.map(c => c.rev)).toEqual([1795, 1796]);
    expect(pending!.map(c => c.baseRev)).toEqual([1794, 1794]);
    // The straggler stays pending with its true frame intact — never re-stamped.
    const queued = await store.getPendingChanges('doc1');
    expect(queued.map(c => c.baseRev)).toEqual([1794, 1794, 1791, 1794]);
  });

  it('flushes a straggler at the head of the queue alone, at its own true baseRev', async () => {
    await store.savePendingChanges('doc1', [
      createChange(1791, 1795, [{ op: 'replace', path: '/docs/oHNA/title', value: 'stale' }]),
      createChange(1794, 1796, [{ op: 'replace', path: '/docs/oHNA/title', value: 'fresh' }]),
    ]);

    const pending = await algorithm.getPendingToSend('doc1');

    expect(pending!.map(c => c.baseRev)).toEqual([1791]);
    expect(pending![0].ops).toEqual([{ op: 'replace', path: '/docs/oHNA/title', value: 'stale' }]);
  });

  it('keeps adjacent same-frame stragglers together as one coherent run', async () => {
    // Two mints from the same lagging context form a sequential program on their shared frame;
    // they must flush together so the server transforms them as the program they are.
    await store.savePendingChanges('doc1', [
      createChange(1791, 1795, [{ op: 'replace', path: '/a', value: 1 }]),
      createChange(1791, 1796, [{ op: 'replace', path: '/b', value: 2 }]),
      createChange(1794, 1797, [{ op: 'replace', path: '/c', value: 3 }]),
    ]);

    const pending = await algorithm.getPendingToSend('doc1');

    expect(pending!.map(c => c.baseRev)).toEqual([1791, 1791]);
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
