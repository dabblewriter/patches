/**
 * The DAB-1141 regression over the REAL store. The in-memory store never had the bug
 * (its untrackDocs drops the whole buffer and its confirmDeleteDoc clears quarantine); the
 * IndexedDB store is where a remote delete left rows behind. Two paths through
 * `_discardRemoteDeletedDoc` reach the wipe, and they leave different amounts to clean up:
 *
 * - Tracked doc (in `patches.trackedDocs`): `untrackDocs` already drops the snapshot, history
 *   and pending rows; the wipe's only new cleanup is the quarantine store.
 * - Untracked doc (`Patches.untrackDocs` early-returns — a closed doc named by a tombstone
 *   drain): nothing touches the store before the wipe, so `confirmDeleteDoc` alone left the
 *   snapshot, history, pending AND quarantine rows behind forever. This is the growth case.
 *
 * On the untracked path the rows are still on disk when the app receives the discarded work,
 * so a shelf write the store refuses leaves them recoverable from a database export — the
 * emit runs before the wipe, and the third case pins that order.
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

/** What the store holds for DOC_ID right now, as the assertions below compare it. */
async function rowsFor(store: OTIndexedDBStore) {
  return {
    snapshot: await store.getDoc(DOC_ID),
    history: (await store.listChanges(DOC_ID)).map(c => c.id),
    pending: (await store.getPendingChanges(DOC_ID)).map(c => c.id),
    quarantine: (await store.listQuarantinedChanges(DOC_ID)).map(q => q.change.id),
    docs: (await store.listDocs(true)).map(d => d.docId),
  };
}

describe('PatchesSync — remote delete wipes the doc data on the real IndexedDB store (DAB-1141)', () => {
  let store: OTIndexedDBStore;
  let patches: Patches;
  let sync: PatchesSync;
  let historyId: string;

  beforeEach(async () => {
    store = new OTIndexedDBStore(new IndexedDBStore(`remote-delete-wipe-${dbSeq++}`));
    const algorithm = new OTAlgorithm(store);
    patches = new Patches({ algorithms: { ot: algorithm } });
    sync = new PatchesSync(patches, makeFakeConnection() as unknown as PatchesConnection);
    vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    sync.disconnect();
    await patches.close();
    vi.restoreAllMocks();
  });

  /** The tracked path: the doc is in `patches.trackedDocs`, so `untrackDocs` runs for it. */
  async function track() {
    await patches.trackDocs([DOC_ID]);
    sync['trackedDocs'].add(DOC_ID);
    sync['_initDocSyncState'](DOC_ID, { committedRev: 2, syncStatus: 'synced' });
  }

  /** Everything a doc leaves behind: snapshot + committed history, a pending row, quarantine. */
  async function seed() {
    await store.saveDoc(DOC_ID, { state: { title: 'x' }, rev: 1 });
    const committed = createChange(1, 2, [{ op: 'add', path: '/a', value: 1 }], {}, 'committed');
    historyId = committed.id;
    await store.applyServerChanges(DOC_ID, [{ ...committed, committedAt: 1 }], [], 1);
    const kept = createChange(2, 3, [{ op: 'add', path: '/b', value: 2 }], {}, 'kept');
    const poison = createChange(2, 4, [{ op: 'add', path: '/c', value: 3 }], {}, 'poison');
    await store.savePendingChanges(DOC_ID, [kept, poison]);
    expect(await store.quarantinePendingChange(DOC_ID, poison, 'test', [kept], 4)).toMatchObject({
      change: { id: 'poison' },
    });
    expect(await rowsFor(store)).toMatchObject({
      history: [historyId, 'kept'], // listChanges is committed + pending
      pending: ['kept'],
      quarantine: ['poison'],
      docs: [DOC_ID],
    });
  }

  it('tracked doc: leaves no snapshot, history, pending, quarantine or tombstone behind', async () => {
    await track();
    await seed();
    const shelved: unknown[] = [];
    sync.onRemoteDocDeleted((_docId, pending) => shelved.push(...pending));

    await sync['_handleRemoteDocDeleted'](DOC_ID);

    // untrackDocs did most of this; the quarantine rows are the wipe's new cleanup here.
    expect(await rowsFor(store)).toEqual({ snapshot: undefined, history: [], pending: [], quarantine: [], docs: [] });
    expect(shelved).toHaveLength(2); // pending + quarantined reached the app
  });

  it('untracked doc (the growth case): wipes snapshot, history, pending and quarantine, no tombstone', async () => {
    // No trackDocs: Patches.untrackDocs early-returns, so the wipe is the only cleanup that runs.
    await seed();
    expect(patches.trackedDocs.has(DOC_ID)).toBe(false);
    const shelved: unknown[] = [];
    sync.onRemoteDocDeleted((_docId, pending) => shelved.push(...pending));

    await sync['_handleRemoteDocDeleted'](DOC_ID);

    expect(await rowsFor(store)).toEqual({ snapshot: undefined, history: [], pending: [], quarantine: [], docs: [] });
    expect(shelved).toHaveLength(2);
  });

  it('untracked doc: the rows are still on disk while the app shelves, and gone once it has', async () => {
    await seed();
    let atEmit: Awaited<ReturnType<typeof rowsFor>> | undefined;
    let gatedAtEmit = false;
    sync.onRemoteDocDeleted(async () => {
      // The app's shelve, awaited by the emit: what can it still find in the database?
      atEmit = await rowsFor(store);
      gatedAtEmit = sync['_confirmedDeletedDocs'].has(DOC_ID);
    });

    await sync['_handleRemoteDocDeleted'](DOC_ID);

    expect(atEmit).toMatchObject({
      history: [historyId, 'kept'],
      pending: ['kept'],
      quarantine: ['poison'],
      docs: [DOC_ID],
    });
    expect(atEmit?.snapshot).toBeDefined();
    expect(gatedAtEmit).toBe(true); // a batch replayed inside the emit window is already gated
    expect(await rowsFor(store)).toEqual({ snapshot: undefined, history: [], pending: [], quarantine: [], docs: [] });
  });
});
