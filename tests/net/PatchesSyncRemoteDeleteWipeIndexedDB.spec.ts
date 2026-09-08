/**
 * The DAB-1141 regression over the REAL store. The in-memory store never had the bug
 * (its untrackDocs drops the whole buffer and its confirmDeleteDoc clears quarantine); the
 * IndexedDB store is where a remote delete left snapshots, history, pending and — after
 * untrackDocs' own wipe — quarantine rows behind. This is the assertion that catches a
 * regression: after a remote delete, the real store holds no quarantine and no tombstone.
 */
import 'fake-indexeddb/auto';
import { signal } from 'easy-signal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedDBStore } from '../../src/client/IndexedDBStore.js';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore.js';
import { Patches } from '../../src/client/Patches.js';
import { createChange } from '../../src/data/change.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';

const DOC_ID = 'doc1';
let dbSeq = 0;

function makeFakeConnection() {
  return {
    url: 'fake://server',
    onStateChange: signal(),
    onChangesCommitted: signal(),
    onDocDeleted: signal(),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    subscribe: vi.fn(async (ids: string[]) => ids),
    unsubscribe: vi.fn(async () => {}),
    getDoc: vi.fn(),
    getChangesSince: vi.fn(async () => []),
    commitChanges: vi.fn(),
    deleteDoc: vi.fn(async () => {}),
  };
}

describe('PatchesSync — remote delete wipes the doc data on the real IndexedDB store (DAB-1141)', () => {
  let store: OTIndexedDBStore;
  let patches: Patches;
  let sync: PatchesSync;

  beforeEach(async () => {
    store = new OTIndexedDBStore(new IndexedDBStore(`remote-delete-wipe-${dbSeq++}`));
    const algorithm = new OTAlgorithm(store);
    patches = new Patches({ algorithms: { ot: algorithm } });
    sync = new PatchesSync(patches, makeFakeConnection() as unknown as PatchesConnection);
    vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
    await patches.trackDocs([DOC_ID]);
    sync['trackedDocs'].add(DOC_ID);
    sync['_initDocSyncState'](DOC_ID, { committedRev: 2, syncStatus: 'synced' });

    await store.saveDoc(DOC_ID, { state: { title: 'x' }, rev: 1 });
    await store.applyServerChanges(
      DOC_ID,
      [{ ...createChange(1, 2, [{ op: 'add', path: '/a', value: 1 }]), committedAt: 1 }],
      [],
      1
    );
    const kept = createChange(2, 3, [{ op: 'add', path: '/b', value: 2 }], {}, 'kept');
    const poison = createChange(2, 4, [{ op: 'add', path: '/c', value: 3 }], {}, 'poison');
    await store.savePendingChanges(DOC_ID, [kept, poison]);
    expect(await store.quarantinePendingChange(DOC_ID, poison, 'test', [kept], 4)).toMatchObject({
      change: { id: 'poison' },
    });
  });

  afterEach(async () => {
    sync.disconnect();
    await patches.close();
    vi.restoreAllMocks();
  });

  it('leaves no snapshot, history, pending, quarantine or tombstone behind', async () => {
    const shelved: unknown[] = [];
    sync.onRemoteDocDeleted((_docId, pending) => shelved.push(...pending));

    await sync['_handleRemoteDocDeleted'](DOC_ID);

    expect(await store.getDoc(DOC_ID)).toBeUndefined();
    expect(await store.listChanges(DOC_ID)).toEqual([]);
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
    expect(await store.listQuarantinedChanges(DOC_ID)).toEqual([]);
    expect(await store.listDocs(true)).toEqual([]);
    expect(shelved).toHaveLength(2); // pending + quarantined reached the app before the wipe
  });
});
