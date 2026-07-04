import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';

/**
 * Regression coverage for the snapshot-reload double-commit guard: when recovery reloads
 * the authoritative snapshot (a committed change failed to apply, so local committed state
 * diverged), pending changes must be reconciled against the committed tail the snapshot
 * subsumes — NOT preserved verbatim. A pending change the server has already committed
 * (a flush that succeeded on the wire but whose echo failed to apply) would otherwise be
 * re-applied on top of a state that already contains it and re-sent with a re-stamped
 * baseRev past the server's idempotency window, permanently duplicating the user's edits.
 */
describe('OTAlgorithm.reconcilePending', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
  });

  it('drops pending changes the server already committed (matched by id)', async () => {
    const pending = createChange(5, 6, [{ op: 'add', path: '/a', value: 1 }]);
    await store.savePendingChanges('doc1', [pending]);

    // The server's committed echo of the same change (same id, server-assigned rev).
    const committedEcho = { ...pending, rev: 6, committedAt: 100 };
    await algorithm.reconcilePending('doc1', [committedEcho]);

    expect(await store.getPendingChanges('doc1')).toEqual([]);
  });

  it('keeps an uncommitted pending change, re-based onto the tail tip', async () => {
    const committed = createChange(5, 6, [{ op: 'add', path: '/a', value: 1 }]);
    const committedEcho = { ...committed, committedAt: 100 };
    const survivor = createChange(5, 7, [{ op: 'add', path: '/b', value: 2 }]);
    await store.savePendingChanges('doc1', [committed, survivor]);

    // Tail: our committed change plus a foreign change on top of it.
    const foreign = createChange(6, 7, [{ op: 'add', path: '/c', value: 3 }]);
    await algorithm.reconcilePending('doc1', [committedEcho, { ...foreign, committedAt: 101 }]);

    const remaining = await store.getPendingChanges('doc1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(survivor.id);
    expect(remaining[0].ops).toEqual(survivor.ops);
    // Re-stamped into the tail's frame: based on the tail tip, one rev past it.
    expect(remaining[0].baseRev).toBe(7);
    expect(remaining[0].rev).toBe(8);
  });

  it('transforms a surviving change against foreign committed ops', async () => {
    const survivor = createChange(5, 6, [{ op: 'add', path: '/list/2', value: 'mine' }]);
    await store.savePendingChanges('doc1', [survivor]);

    // A foreign change inserted below the survivor's index; the survivor must shift up.
    const foreign = createChange(5, 6, [{ op: 'add', path: '/list/0', value: 'theirs' }]);
    await algorithm.reconcilePending('doc1', [{ ...foreign, committedAt: 100 }]);

    const remaining = await store.getPendingChanges('doc1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ops).toEqual([{ op: 'add', path: '/list/3', value: 'mine' }]);
  });

  it('is a no-op when there are no pending changes', async () => {
    const foreign = createChange(5, 6, [{ op: 'add', path: '/a', value: 1 }]);

    await algorithm.reconcilePending('doc1', [{ ...foreign, committedAt: 100 }]);

    expect(await store.getPendingChanges('doc1')).toEqual([]);
  });

  it('is a no-op for an empty committed tail', async () => {
    const pending = createChange(5, 6, [{ op: 'add', path: '/a', value: 1 }]);
    await store.savePendingChanges('doc1', [pending]);

    await algorithm.reconcilePending('doc1', []);

    expect(await store.getPendingChanges('doc1')).toEqual([pending]);
  });

  it('clears pending entirely when the tail committed every pending change', async () => {
    const first = createChange(5, 6, [{ op: 'add', path: '/a', value: 1 }]);
    const second = createChange(5, 7, [{ op: 'add', path: '/b', value: 2 }]);
    await store.savePendingChanges('doc1', [first, second]);

    await algorithm.reconcilePending('doc1', [
      { ...first, rev: 6, committedAt: 100 },
      { ...second, rev: 7, committedAt: 100 },
    ]);

    expect(await store.getPendingChanges('doc1')).toEqual([]);
    expect(await algorithm.hasPending('doc1')).toBe(false);
  });
});

/**
 * The whole reconciliation must be ATOMIC — one store transaction carrying BOTH the
 * committed tail and the rebased pending queue. Each seam this call has ever had was a
 * real, fuzz-found failure window:
 * - drop-then-save for the pending swap discarded the entire rebased set when the save
 *   leg failed after the drop leg committed (P3 silent-loss, fuzz seed 1000126);
 * - swapping pending WITHOUT installing the tail (leaving that to the caller's later
 *   saveDoc) left the store torn when that save failed — pending renumbered onto the
 *   tail's frame while committedRev lagged, mints numbering off the stale frame, and a
 *   frame-skewed resend committing the same change twice (P3 duplicate, seed 1000319).
 */
describe('OTAlgorithm.reconcilePending — atomic replacement', () => {
  it('installs the committed tail and the rebased pending in one store call, never drop-then-save', async () => {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    const pending = createChange(5, 6, [{ op: 'add', path: '/list/2', value: 'mine' }]);
    await store.savePendingChanges('doc1', [pending]);
    const dropSpy = vi.spyOn(store, 'dropPendingChanges');
    const saveSpy = vi.spyOn(store, 'savePendingChanges');
    const atomicSpy = vi.spyOn(store, 'applyServerChanges');

    const foreign = { ...createChange(5, 6, [{ op: 'add', path: '/list/0', value: 'theirs' }]), committedAt: 100 };
    await algorithm.reconcilePending('doc1', [foreign]);

    expect(dropSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(atomicSpy).toHaveBeenCalledTimes(1);
    expect(atomicSpy).toHaveBeenCalledWith('doc1', [foreign], expect.any(Array));
    expect((await store.getPendingChanges('doc1'))[0].ops).toEqual([{ op: 'add', path: '/list/3', value: 'mine' }]);
  });

  it('leaves the store self-consistent even if the caller dies right after it (no torn frame)', async () => {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    const pending = createChange(5, 6, [{ op: 'add', path: '/a', value: 1 }]);
    await store.savePendingChanges('doc1', [pending]);

    // Reconcile against a two-change foreign tail — and then STOP, as if the reload's
    // subsequent saveDoc never ran (crash, aborted IDB transaction).
    const foreign6 = { ...createChange(5, 6, [{ op: 'add', path: '/b', value: 2 }]), committedAt: 100 };
    const foreign7 = { ...createChange(6, 7, [{ op: 'add', path: '/c', value: 3 }]), committedAt: 101 };
    await algorithm.reconcilePending('doc1', [foreign6, foreign7]);

    // The tail is installed and pending sits on its tip: committedRev and the pending
    // frame agree. The old shape left pending on rev 7 with committedRev still 5 — a
    // torn store that skewed every later rev-based decision (mint numbering, the doc
    // merge, the server's dedup window).
    expect(await store.getCommittedRev('doc1')).toBe(7);
    const remaining = await store.getPendingChanges('doc1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].baseRev).toBe(7);
    expect(remaining[0].rev).toBe(8);
  });

  it('a store failure leaves the old pending intact for a retry — never a torn half-replacement', async () => {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    const pending = createChange(5, 6, [{ op: 'add', path: '/list/2', value: 'mine' }]);
    await store.savePendingChanges('doc1', [pending]);
    // Fail the way an aborted IndexedDB transaction does: reject without mutating.
    vi.spyOn(store, 'applyServerChanges').mockRejectedValueOnce(new Error('injected substrate fault'));

    const foreign = createChange(5, 6, [{ op: 'add', path: '/list/0', value: 'theirs' }]);
    await expect(algorithm.reconcilePending('doc1', [{ ...foreign, committedAt: 100 }])).rejects.toThrow(
      'injected substrate fault'
    );

    // The queue is exactly what it was — the caller can retry reconciliation. The old
    // drop-then-save shape lost everything here.
    expect(await store.getPendingChanges('doc1')).toEqual([pending]);
  });
});

/**
 * applyServerChanges merges an open doc's in-memory pending into the store snapshot
 * before rebasing. That merge previously used `rev > latestRev` as the identity test —
 * rev as identity. When the doc's frame drifts from the store's (a torn reload renumbers
 * the store queue while the open doc still holds the old frame), the doc's copies of
 * changes ALREADY in the store pass the rev test and re-enter the queue: the same change
 * id pending twice, eventually committed twice once its rebased baseRev moves past the
 * server's dedup window (P3 duplicate, fuzz seed 1000319).
 */
describe('OTAlgorithm.applyServerChanges — doc/store pending merge', () => {
  it('never re-injects a change id the store pending already holds (frame-skewed doc)', async () => {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    await store.applyServerChanges(
      'doc1',
      [{ ...createChange(0, 1, [{ op: 'add', path: '/x', value: 0 }]), committedAt: 50 }],
      []
    );

    // The store queue as a torn reload leaves it: survivors renumbered onto a future
    // frame (revs 5-6), then a mint numbered off the stale frame appended after them
    // (rev 3) — non-monotonic, so `latestRev` (last element) sits BELOW the survivors.
    const p1 = createChange(4, 5, [{ op: 'add', path: '/a', value: 1 }]);
    const p2 = createChange(4, 6, [{ op: 'add', path: '/b', value: 2 }]);
    const mint = createChange(1, 3, [{ op: 'add', path: '/c', value: 3 }]);
    await store.savePendingChanges('doc1', [p1, p2, mint]);

    // The open doc still holds p1/p2 — same ids, revs above latestRev(3). The old
    // rev-only filter re-injected both.
    const doc = {
      getPendingChanges: () => [{ ...p1 }, { ...p2 }],
      committedRev: 1,
      applyChanges: () => {},
      import: () => {},
    };

    const foreign = { ...createChange(1, 2, [{ op: 'add', path: '/f', value: 9 }]), committedAt: 100 };
    await algorithm.applyServerChanges('doc1', [foreign], doc as any);

    const ids = (await store.getPendingChanges('doc1')).map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([p1.id, p2.id, mint.id]));
  });
});
