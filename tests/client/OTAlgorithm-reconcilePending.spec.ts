import { beforeEach, describe, expect, it } from 'vitest';
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
