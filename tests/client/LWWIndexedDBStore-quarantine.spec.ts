import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { LWWIndexedDBStore } from '../../src/client/LWWIndexedDBStore';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';

/**
 * Quarantine store contract on the real LWWIndexedDBStore (fake-indexeddb): the
 * quarantine write and the sending-slot clear are one transaction, pendingOps survive,
 * and per-doc cleanup covers the quarantinedChanges store.
 */
let dbSeq = 0;
const docId = 'doc1';

describe('LWWIndexedDBStore quarantine (real store over fake-indexeddb)', () => {
  let store: LWWIndexedDBStore;

  beforeEach(() => {
    store = new LWWIndexedDBStore(`lww-quarantine-test-${dbSeq++}`);
  });

  function sendingChange(id = 'ch1'): Change {
    return createChange(1, 2, [{ op: 'replace', path: '/title', value: 'y', ts: 5 }], {}, id);
  }

  async function seed(): Promise<Change> {
    await store.trackDocs([docId]);
    await store.saveDoc(docId, { state: { title: 'x' }, rev: 1 });
    const change = sendingChange();
    await store.saveSendingChange(docId, change);
    // Minted after capture — must survive quarantine.
    await store.savePendingOps(docId, [{ op: 'replace', path: '/subtitle', value: 'keep', ts: 6 }]);
    return change;
  }

  it('moves the sending change into quarantine and preserves pendingOps', async () => {
    const change = await seed();

    const entry = await store.quarantineSendingChange(docId, change.id, 'server rejected');

    expect(entry).toMatchObject({ docId, changeId: change.id, reason: 'server rejected' });
    expect(entry!.change.ops).toEqual(change.ops);
    expect(await store.getSendingChange(docId)).toBeNull();
    expect((await store.getPendingOps(docId)).map(op => op.path)).toEqual(['/subtitle']);
    expect((await store.listQuarantinedChanges(docId)).map(q => q.changeId)).toEqual([change.id]);
  });

  it('returns null and mutates nothing on id mismatch or empty slot', async () => {
    const change = await seed();

    expect(await store.quarantineSendingChange(docId, 'other-id', 'nope')).toBeNull();
    expect((await store.getSendingChange(docId))?.id).toBe(change.id);
    expect(await store.listQuarantinedChanges(docId)).toEqual([]);

    expect(await store.quarantineSendingChange('missing-doc', 'x', 'nope')).toBeNull();
  });

  it('lists per doc and across docs; discard removes a single entry', async () => {
    const change = await seed();
    await store.quarantineSendingChange(docId, change.id, 'rejected');
    await store.trackDocs(['doc2']);
    const other = sendingChange('ch2');
    await store.saveSendingChange('doc2', other);
    await store.quarantineSendingChange('doc2', other.id, 'rejected too');

    expect((await store.listQuarantinedChanges(docId)).map(q => q.changeId)).toEqual(['ch1']);
    expect((await store.listQuarantinedChanges()).map(q => q.changeId).sort()).toEqual(['ch1', 'ch2']);

    await store.discardQuarantinedChange(docId, 'ch1');
    expect(await store.listQuarantinedChanges(docId)).toEqual([]);
    expect((await store.listQuarantinedChanges()).map(q => q.changeId)).toEqual(['ch2']);
  });

  it('clears quarantine rows on deleteDoc and untrackDocs', async () => {
    const change = await seed();
    await store.quarantineSendingChange(docId, change.id, 'rejected');
    await store.deleteDoc(docId);
    expect(await store.listQuarantinedChanges(docId)).toEqual([]);

    const change2 = sendingChange('ch2');
    await store.trackDocs(['doc2']);
    await store.saveSendingChange('doc2', change2);
    await store.quarantineSendingChange('doc2', change2.id, 'rejected');
    await store.untrackDocs(['doc2']);
    expect(await store.listQuarantinedChanges('doc2')).toEqual([]);
  });

  it('getCommittedState rebuilds snapshot + committed ops without sending/pending layers', async () => {
    await seed();
    await store.applyServerChanges(docId, [
      createChange(1, 2, [{ op: 'replace', path: '/status', value: 'live', ts: 7, rev: 2 }], { committedAt: 7 }),
    ]);

    expect(await store.getCommittedState(docId)).toEqual({
      state: { title: 'x', status: 'live' },
      rev: 2,
    });
  });
});
