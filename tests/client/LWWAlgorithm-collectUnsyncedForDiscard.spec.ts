import { describe, expect, it } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';

/**
 * `collectUnsyncedForDiscard` is the shelf read for a doc being discarded, and it differs from
 * `getPendingToSend` in both directions: it is a pure read (no sending change minted, no pending
 * ops cleared — nothing will send), and it returns BOTH halves when an in-flight sending change
 * has ops accumulated behind it, where the send path's retry branch returns the sending change
 * alone.
 */
describe('LWWAlgorithm.collectUnsyncedForDiscard', () => {
  const DOC = 'discard-doc';
  const op = (path: string, value: unknown): JSONPatchOp => ({ op: 'replace', path, value, ts: 1, rev: 1 });

  function setup() {
    const store = new LWWInMemoryStore();
    const algorithm = new LWWAlgorithm(store);
    return { store, algorithm };
  }

  it('returns the in-flight sending change AND a change from the ops behind it', async () => {
    const { store, algorithm } = setup();
    // savePendingOps first: the in-memory store's saveSendingChange only writes into an existing
    // doc buffer, and (per its atomic contract) clears the pending ops that became the change.
    await store.savePendingOps(DOC, [op('/a', 1)]);
    const sending = createChange(0, 1, [op('/a', 1)]);
    await store.saveSendingChange(DOC, sending);
    await store.savePendingOps(DOC, [op('/b', 2)]);

    const shelf = await algorithm.collectUnsyncedForDiscard(DOC);

    expect(shelf).toHaveLength(2);
    expect(shelf[0].id).toBe(sending.id);
    expect(shelf[1].ops).toEqual([op('/b', 2)]);
  });

  it('is a pure read: mints no sending change and leaves pending ops in place', async () => {
    const { store, algorithm } = setup();
    await store.savePendingOps(DOC, [op('/a', 1)]);

    const shelf = await algorithm.collectUnsyncedForDiscard(DOC);

    expect(shelf).toHaveLength(1);
    expect(shelf[0].ops).toEqual([op('/a', 1)]);
    expect(await store.getSendingChange(DOC)).toBeNull();
    expect(await store.getPendingOps(DOC)).toEqual([op('/a', 1)]);
  });

  it('returns an empty array when the doc holds nothing unsynced', async () => {
    const { algorithm } = setup();
    expect(await algorithm.collectUnsyncedForDiscard(DOC)).toEqual([]);
  });
});
