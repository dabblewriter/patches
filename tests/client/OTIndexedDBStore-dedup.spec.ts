import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';

/**
 * Regression tests for duplicated server deliveries (echo, re-broadcast, catchup
 * overlapping a broadcast) using the real store over fake-indexeddb. A redelivered
 * revision must not be stored again: it would double-apply on getDoc rebuilds and,
 * after snapshot compaction, resurrect its row and corrupt the persisted snapshot.
 */
let dbSeq = 0;
const docId = 'doc1';

function serverChange(rev: number): Change {
  return createChange(rev - 1, rev, [{ op: 'add', path: '/list/-', value: rev }], { committedAt: rev });
}

describe('OTIndexedDBStore duplicate delivery (real store over fake-indexeddb)', () => {
  let store: OTIndexedDBStore;

  beforeEach(async () => {
    store = new OTIndexedDBStore(`ot-dedup-test-${dbSeq++}`);
    await store.saveDoc(docId, { state: { list: [] }, rev: 0 });
  });

  it('ignores redelivered revisions', async () => {
    const c1 = serverChange(1);
    const c2 = serverChange(2);
    await store.applyServerChanges(docId, [c1, c2], []);
    await store.applyServerChanges(docId, [c2], []);

    const snap = await store.getDoc(docId);
    expect((snap?.state as any).list).toEqual([1, 2]);
    expect(snap?.rev).toBe(2);
  });

  it('keeps new revisions in a batch that partially overlaps stored ones', async () => {
    await store.applyServerChanges(docId, [serverChange(1), serverChange(2)], []);
    await store.applyServerChanges(docId, [serverChange(2), serverChange(3)], []);

    const snap = await store.getDoc(docId);
    expect((snap?.state as any).list).toEqual([1, 2, 3]);
    expect(snap?.rev).toBe(3);
  });

  it('does not resurrect compacted revisions on redelivery', async () => {
    // 200 changes trigger snapshot compaction (rows folded into the snapshot and deleted)
    const changes = Array.from({ length: 200 }, (_, i) => serverChange(i + 1));
    await store.applyServerChanges(docId, changes, []);

    // Stale redelivery of compacted revisions
    await store.applyServerChanges(docId, [changes[149], changes[199]], []);
    const snap = await store.getDoc(docId);
    expect((snap?.state as any).list).toHaveLength(200);
    expect(snap?.rev).toBe(200);

    // Force the next compaction and verify no stale rows were folded into the snapshot
    const more = Array.from({ length: 200 }, (_, i) => serverChange(i + 201));
    await store.applyServerChanges(docId, more, []);
    const snap2 = await store.getDoc(docId);
    expect((snap2?.state as any).list).toHaveLength(400);
    expect(snap2?.rev).toBe(400);
  });

  it('excludes a stray row at the snapshot rev from rebuilds', async () => {
    await store.saveDoc(docId, { state: { list: [1] }, rev: 1 });

    // Simulate a leftover row at rev == snapshot.rev (already baked into the snapshot)
    const [tx, committedChanges] = await store.db.transaction(['committedChanges'], 'readwrite');
    await committedChanges.put({ ...serverChange(1), docId });
    await tx.complete();

    const snap = await store.getDoc(docId);
    expect((snap?.state as any).list).toEqual([1]);
    expect(snap?.rev).toBe(1);
  });
});
