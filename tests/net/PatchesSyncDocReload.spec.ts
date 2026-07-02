/**
 * Regression tests for the docReloadRequired branch of PatchesSync.flushDoc.
 *
 * When a commit returns `docReloadRequired` (baseRev:0 changes committed onto an
 * existing server doc), flushDoc reloads the full doc state from the server and
 * imports it into the open doc. Two hazards live in that window:
 *
 * 1. Write-loss: a change the user mints while the reload is in flight must survive
 *    the snapshot import — in the open doc's pending queue, in its visible contents,
 *    and in the store. `doc.import()` replaces the doc's pending set wholesale with
 *    `snapshot.changes`, so a change minted after the store re-read but before the
 *    import would otherwise vanish from the open doc.
 *
 * 2. Duplication: the sent batch WAS committed (that's what docReloadRequired means —
 *    the server transformed it onto its tip), so the fetched snapshot already contains
 *    its effects. Leaving it in the pending queue re-applies its ops on import
 *    (doubling non-idempotent ops) and re-sends it on the next flush.
 *
 * These tests use real client components (Patches, OTAlgorithm, OTInMemoryStore,
 * OTDoc) and fake only the network connection.
 */
import { signal } from 'easy-signal';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTDoc } from '../../src/client/OTDoc.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change } from '../../src/types.js';

interface TestDoc {
  title?: string;
  note?: string;
  count?: number;
}

/** Minimal PatchesConnection fake — only what flushDoc's reload path touches. */
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

const DOC_ID = 'doc1';
// The doc exists on the server at rev 3 (foreign edits); the client's baseRev:0
// batch (`count` 0→1) is committed on top as rev 4, so the fetched snapshot
// already reflects it.
const SERVER_SNAPSHOT = { state: { title: 'server-title', count: 1 }, rev: 4 };

const opsAt = (changes: Change[], path: string) => changes.filter(c => c.ops.some(op => op.path === path));

describe('PatchesSync flushDoc — docReloadRequired reload', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;
  let patches: Patches;
  let conn: ReturnType<typeof makeFakeConnection>;
  let sync: PatchesSync;
  let doc: OTDoc<TestDoc>;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    patches = new Patches({ algorithms: { ot: algorithm } });
    conn = makeFakeConnection();
    sync = new PatchesSync(patches, conn as unknown as PatchesConnection);
    // Deterministic test: block the onChange→syncDoc auto-trigger; flushDoc is driven directly.
    vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

    await patches.trackDocs([DOC_ID]);
    doc = (await patches.openDoc<TestDoc>(DOC_ID)) as OTDoc<TestDoc>;
    sync['updateState']({ connected: true });

    // The user typed while local state was at baseRev 0 (doc exists remotely at rev 3).
    doc.change(patch => patch.increment('/count', 1));
    await doc.flush();

    conn.commitChanges.mockResolvedValue({ changes: [], docReloadRequired: true as const });
  });

  it('preserves a change minted during the getDoc fetch window (pending + contents + store)', async () => {
    conn.getDoc.mockImplementation(async () => {
      // User keeps typing while the full-doc fetch is in flight.
      doc.change(patch => patch.replace('/note', 'typed-during-fetch'));
      await doc.flush();
      return SERVER_SNAPSHOT;
    });

    await sync['flushDoc'](DOC_ID);

    // The concurrent change survives in the doc contents…
    expect(doc.state.note).toBe('typed-during-fetch');
    // …in the doc's pending queue…
    expect(opsAt(doc.getPendingChanges(), '/note')).toHaveLength(1);
    // …and in the store's pending queue.
    expect(opsAt(await store.getPendingChanges(DOC_ID), '/note')).toHaveLength(1);
    // The imported server state is in place.
    expect(doc.committedRev).toBe(4);
    expect(doc.state.title).toBe('server-title');
  });

  it('preserves a change minted between the store re-read and the snapshot import', async () => {
    conn.getDoc.mockResolvedValue(SERVER_SNAPSHOT);

    const origLoadDoc = algorithm.loadDoc.bind(algorithm);
    vi.spyOn(algorithm, 'loadDoc').mockImplementation(async docId => {
      const snapshot = await origLoadDoc(docId);
      // A mint lands after the store read but before the import — the store read and
      // the mint pipeline are not mutually serialized, so with IndexedDB the read
      // transaction can complete just before the mint's write transaction.
      doc.change(patch => patch.replace('/note', 'typed-during-reload'));
      await doc.flush();
      return snapshot;
    });

    await sync['flushDoc'](DOC_ID);

    // The concurrent change survives in the doc contents…
    expect(doc.state.note).toBe('typed-during-reload');
    // …in the doc's pending queue…
    expect(opsAt(doc.getPendingChanges(), '/note')).toHaveLength(1);
    // …and in the store's pending queue.
    expect(opsAt(await store.getPendingChanges(DOC_ID), '/note')).toHaveLength(1);
  });

  it('does not re-apply or re-send the committed batch after the reload', async () => {
    conn.getDoc.mockResolvedValue(SERVER_SNAPSHOT);

    await sync['flushDoc'](DOC_ID);

    // The batch was committed server-side (docReloadRequired ⇒ committed onto the tip)
    // and its effect is baked into the fetched snapshot. It must not be applied a
    // second time on import…
    expect(doc.state.count).toBe(1);
    // …must leave the pending queues (otherwise the next flush re-commits it and every
    // subscriber sees the edit twice)…
    expect(opsAt(doc.getPendingChanges(), '/count')).toHaveLength(0);
    expect(opsAt(await store.getPendingChanges(DOC_ID), '/count')).toHaveLength(0);
    // …and the doc lands on the server revision.
    expect(doc.committedRev).toBe(4);
  });
});
