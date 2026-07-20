import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
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

  it('a retried save with an id already pending appends nothing (ambiguous-failure retry)', async () => {
    const change = createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }]);
    await store.savePendingChanges(docId, [change]);
    const retry = { ...change, rev: 99 };
    await store.savePendingChanges(docId, [retry]);

    const pending = await store.getPendingChanges(docId);
    expect(pending).toHaveLength(1);
    expect(retry.rev).toBe(pending[0].rev); // rev synced onto the retried object
  });

  it('a re-saved split batch dedups every derived-id piece', async () => {
    // Split pieces after the first carry ids derived from the stable id (`cid-s~2`, ...), so
    // the per-row id dedup has to cover the whole batch — otherwise a re-split appends
    // pieces 2..N again under ids the first save already stored.
    const first = [
      createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }], {}, 'cid-s'),
      createChange(0, 2, [{ op: 'add', path: '/b', value: 2 }], {}, 'cid-s~2'),
    ];
    await store.savePendingChanges(docId, first);

    const retry = [
      createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }], {}, 'cid-s'),
      createChange(0, 2, [{ op: 'add', path: '/b', value: 2 }], {}, 'cid-s~2'),
    ];
    await store.savePendingChanges(docId, retry);

    const pending = await store.getPendingChanges(docId);
    expect(pending).toHaveLength(2);
    expect(pending.map(c => c.id)).toEqual(['cid-s', 'cid-s~2']);
    expect(retry.map(c => c.rev)).toEqual(pending.map(c => c.rev)); // revs synced onto the retried objects
  });

  it('a fully-deduped save does not revive a tombstone', async () => {
    const change = createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }]);
    await store.savePendingChanges(docId, [change]);
    await store.deleteDoc(docId);
    // A delete raced ahead of a retry whose original write landed: restore the landed row under
    // the tombstone, then retry — the dedup must return before flipping `deleted` back off.
    const [tx, pendingChanges] = await store.db.transaction(['pendingChanges'], 'readwrite');
    await pendingChanges.put({ ...change, docId });
    await tx.complete();

    await store.savePendingChanges(docId, [{ ...change }]);

    const docs = await store.listDocs(true);
    expect(docs.find(d => d.docId === docId)?.deleted).toBe(true);
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

describe('OTInMemoryStore savePendingChanges retry dedup (mirrors OTIndexedDBStore)', () => {
  it('skips ids already pending, syncing the landed rev onto the retried object', async () => {
    const store = new OTInMemoryStore();
    await store.saveDoc(docId, { state: {}, rev: 0 });
    const a = createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }]);
    await store.savePendingChanges(docId, [a]);

    const retry = { ...a, rev: 99 };
    await store.savePendingChanges(docId, [retry]);

    const pending = await store.getPendingChanges(docId);
    expect(pending.map(c => c.id)).toEqual([a.id]);
    expect(retry.rev).toBe(pending[0].rev);
  });

  it('dedups every derived-id piece of a re-saved split batch', async () => {
    const store = new OTInMemoryStore();
    await store.saveDoc(docId, { state: {}, rev: 0 });
    const first = [
      createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }], {}, 'cid-s'),
      createChange(0, 2, [{ op: 'add', path: '/b', value: 2 }], {}, 'cid-s~2'),
    ];
    await store.savePendingChanges(docId, first);

    const retry = [
      createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }], {}, 'cid-s'),
      createChange(0, 2, [{ op: 'add', path: '/b', value: 2 }], {}, 'cid-s~2'),
    ];
    await store.savePendingChanges(docId, retry);

    const pending = await store.getPendingChanges(docId);
    expect(pending).toHaveLength(2);
    expect(pending.map(c => c.id)).toEqual(['cid-s', 'cid-s~2']);
    expect(retry.map(c => c.rev)).toEqual(pending.map(c => c.rev));
  });
});
