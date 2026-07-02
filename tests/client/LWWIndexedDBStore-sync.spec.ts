import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import { LWWIndexedDBStore } from '../../src/client/LWWIndexedDBStore';
import { createChange } from '../../src/data/change';
import { LWWMemoryStoreBackend } from '../../src/server/LWWMemoryStoreBackend';
import { LWWServer } from '../../src/server/LWWServer';

/**
 * End-to-end regression tests using the real LWWIndexedDBStore (fake-indexeddb)
 * against a real LWWServer, exercising the exact PatchesSync flush order
 * (confirmSent, then applyServerChanges with the server's response).
 */
let dbSeq = 0;
const docId = 'doc1';

describe('LWWIndexedDBStore server sync (real store over fake-indexeddb)', () => {
  let store: LWWIndexedDBStore;
  let algorithm: LWWAlgorithm;
  let backend: LWWMemoryStoreBackend;
  let server: LWWServer;

  beforeEach(() => {
    store = new LWWIndexedDBStore(`lww-sync-test-${dbSeq++}`);
    algorithm = new LWWAlgorithm(store);
    backend = new LWWMemoryStoreBackend();
    server = new LWWServer(backend);
  });

  /** PatchesSync._flushDoc order: send pending, confirmSent, applyServerChanges(response). */
  async function flush() {
    const pending = (await algorithm.getPendingToSend(docId))!;
    const { changes: committed } = await server.commitChanges(docId, pending);
    await algorithm.confirmSent(docId, pending);
    await algorithm.applyServerChanges(docId, committed, undefined);
  }

  it('keeps committedRev at the server head on a noop commit so the next revision is not skipped', async () => {
    // Another client seeds the doc: server head rev 1
    await server.commitChanges(docId, [
      createChange(0, 1, [{ op: 'replace', path: '/settings/theme', value: 'dark', ts: 1000 }], { id: 'b1' }),
    ]);

    await algorithm.trackDocs([docId]);
    await algorithm.applyServerChanges(docId, await server.getChangesSince(docId, 0), undefined);
    expect(await algorithm.getCommittedRev(docId)).toBe(1);

    // A soft "ensure defaults" op the server noops because data exists — the head stays at 1,
    // so committedRev must not advance to the client-minted rev 2
    await algorithm.handleDocChange(docId, [{ op: 'add', path: '/settings', value: {}, soft: true }], undefined, {});
    await flush();
    expect(await backend.getCurrentRev(docId)).toBe(1);
    expect(await algorithm.getCommittedRev(docId)).toBe(1);

    // Another client commits rev 2 while we're offline; reconnect catchup must deliver it
    await server.commitChanges(docId, [
      createChange(1, 2, [{ op: 'replace', path: '/settings/theme', value: 'light', ts: 2000 }], { id: 'b2' }),
    ]);
    const missed = await server.getChangesSince(docId, await algorithm.getCommittedRev(docId));
    expect(missed).toHaveLength(1);
    await algorithm.applyServerChanges(docId, missed, undefined);

    const snap = await algorithm.loadDoc(docId);
    expect((snap?.state as any).settings.theme).toBe('light');
    expect(await algorithm.getCommittedRev(docId)).toBe(2);
  });

  it('converges when a flush response carries a child correction ahead of a parent catchup op', async () => {
    // Server history from other clients: parent write at rev 2, newer child write at rev 3
    await server.commitChanges(docId, [createChange(0, 1, [{ op: 'replace', path: '/misc', value: 1, ts: 50 }])]);
    await server.commitChanges(docId, [
      createChange(1, 2, [{ op: 'replace', path: '/settings', value: { theme: 'old', font: 'serif' }, ts: 100 }]),
    ]);
    await server.commitChanges(docId, [
      createChange(2, 3, [{ op: 'replace', path: '/settings/theme', value: 'dark', ts: 200 }]),
    ]);

    // Fresh client with a pending theme write that loses LWW (ts 150 < 200). The flush
    // response orders the child correction (rev 3) before the parent catchup op (rev 2);
    // applied as-delivered, the parent would prune the newer child value.
    await algorithm.trackDocs([docId]);
    await store.savePendingOps(docId, [{ op: 'replace', path: '/settings/theme', value: 'light', ts: 150 }]);
    await flush();

    const snap = await algorithm.loadDoc(docId);
    expect((snap?.state as any).settings).toEqual({ theme: 'dark', font: 'serif' });
    expect(snap?.rev).toBe(3);
  });

  it('applies a batch in commit order so a newer parent op prunes an older child op', async () => {
    await store.trackDocs([docId]);
    await store.applyServerChanges(docId, [
      createChange(0, 5, [
        { op: 'replace', path: '/settings/theme', value: 'stale', ts: 300, rev: 3 },
        { op: 'replace', path: '/settings', value: { font: 'serif' }, ts: 500, rev: 5 },
      ]),
    ]);

    const snap = await store.getDoc(docId);
    expect((snap?.state as any).settings).toEqual({ font: 'serif' });
  });
});
