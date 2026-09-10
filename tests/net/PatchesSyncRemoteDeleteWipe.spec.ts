/**
 * A remote delete must wipe the doc's local data, not just its tracking row (DAB-1141).
 *
 * `confirmDeleteDoc` removes only the `docs` row. The snapshot, committed history, pending
 * queue and quarantine rows live in other stores, keyed by doc id and reachable only through
 * that row — so a remote delete that skipped the wipe orphaned them forever. The local-delete
 * path already wipes through `deleteDoc`; the remote path now goes through the same wipe first.
 */
import { signal } from 'easy-signal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { createChange } from '../../src/data/change.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';

const DOC_ID = 'doc1';

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

describe('PatchesSync — remote delete wipes the doc data (DAB-1141)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;
  let patches: Patches;
  let sync: PatchesSync;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    patches = new Patches({ algorithms: { ot: algorithm } });
    sync = new PatchesSync(patches, makeFakeConnection() as unknown as PatchesConnection);
    vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
    await patches.trackDocs([DOC_ID]);
    sync['trackedDocs'].add(DOC_ID);
    sync['_initDocSyncState'](DOC_ID, { committedRev: 2, syncStatus: 'synced' });

    // Everything a doc leaves behind: snapshot + committed history, a pending row, quarantine.
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

  afterEach(() => {
    sync.disconnect();
    vi.restoreAllMocks();
  });

  it('wipes snapshot, history, pending and quarantine, then removes the tracking row', async () => {
    const wipe = vi.spyOn(algorithm, 'deleteDoc');
    const confirm = vi.spyOn(algorithm, 'confirmDeleteDoc');
    const shelved: unknown[] = [];
    let wipesAtEmit = -1;
    sync.onRemoteDocDeleted((_docId, pending) => {
      shelved.push(...pending);
      wipesAtEmit = wipe.mock.calls.length;
    });

    await sync['_handleRemoteDocDeleted'](DOC_ID);

    expect(wipe).toHaveBeenCalledWith(DOC_ID);
    expect(confirm).toHaveBeenCalledWith(DOC_ID);
    expect(wipesAtEmit).toBe(0); // the app is told before the wipe, not after
    expect(wipe.mock.invocationCallOrder[0]).toBeLessThan(confirm.mock.invocationCallOrder[0]);
    expect(await store.getDoc(DOC_ID)).toBeUndefined();
    expect(await store.listChanges(DOC_ID)).toEqual([]);
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
    expect(await store.listQuarantinedChanges(DOC_ID)).toEqual([]);
    expect(await store.listDocs(true)).toEqual([]); // no tombstone left behind either
    expect(shelved).toHaveLength(2); // the pending row and the quarantined change reach the app
  });

  it('still removes the tracking row when the wipe itself fails', async () => {
    vi.spyOn(algorithm, 'deleteDoc').mockRejectedValue(new Error('[docs] did not settle'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const confirm = vi.spyOn(algorithm, 'confirmDeleteDoc');

    await sync['_handleRemoteDocDeleted'](DOC_ID);

    expect(confirm).toHaveBeenCalledWith(DOC_ID);
    expect(await store.listDocs(true)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(DOC_ID), expect.any(Error));
    expect(sync['trackedDocs'].has(DOC_ID)).toBe(false);
  });
});
