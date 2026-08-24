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
 * alone. Quarantine rides last, since `confirmDeleteDoc` is about to drop it.
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
    // savePendingOps first because THIS store (LWWInMemoryStore) only writes a sending change
    // into an existing doc buffer — LWWIndexedDBStore.saveSendingChange puts unconditionally, so
    // a port of this spec to the persistent store can drop the priming write, not the assertions.
    // Either way saveSendingChange clears the pending ops that became the change, per its atomic
    // contract, so the second savePendingOps is what stacks ops behind the in-flight one.
    await store.savePendingOps(DOC, [op('/a', 1)]);
    const sending = createChange(0, 1, [op('/a', 1)]);
    await store.saveSendingChange(DOC, sending);
    await store.savePendingOps(DOC, [op('/b', 2)]);

    const shelf = await algorithm.collectUnsyncedForDiscard(DOC);

    expect(shelf).toHaveLength(2);
    expect(shelf[0].id).toBe(sending.id);
    expect(shelf[1].ops).toEqual([op('/b', 2)]);
    // Pure in this branch too, not just the sending-change-free one below: nothing is promoted
    // and nothing is consumed, so a regression that only mutates when both halves exist is caught.
    expect(await store.getSendingChange(DOC)).toEqual(sending);
    expect(await store.getPendingOps(DOC)).toEqual([op('/b', 2)]);
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

  it('returns an empty array for a tracked doc whose local layers have drained', async () => {
    const { store, algorithm } = setup();
    await store.trackDocs([DOC]);
    await store.savePendingOps(DOC, [op('/a', 1)]);
    const sending = createChange(0, 1, [op('/a', 1)]);
    await store.saveSendingChange(DOC, sending);
    await store.confirmSendingChange(DOC);

    // The shape a synced doc actually presents to the discard path — a live buffer with both
    // layers empty, not the store's unknown-doc early return the next case covers.
    expect(await algorithm.collectUnsyncedForDiscard(DOC)).toEqual([]);
  });

  it('returns an empty array when the doc holds nothing unsynced', async () => {
    const { algorithm } = setup();
    expect(await algorithm.collectUnsyncedForDiscard(DOC)).toEqual([]);
  });

  it('carries quarantined changes, which the discard is about to drop', async () => {
    const { store, algorithm } = setup();
    await store.savePendingOps(DOC, [op('/a', 1)]);
    const refused = createChange(0, 1, [op('/a', 1)]);
    await store.saveSendingChange(DOC, refused);
    await store.quarantineSendingChange(DOC, refused.id, 'server refused it');
    await store.savePendingOps(DOC, [op('/b', 2)]);

    const shelf = await algorithm.collectUnsyncedForDiscard(DOC);

    // Live rows first, quarantine last.
    expect(shelf.map(c => c.ops)).toEqual([[op('/b', 2)], [op('/a', 1)]]);
    expect(shelf[1].id).toBe(refused.id);
  });
});
