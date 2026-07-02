/**
 * Regression tests for flushDoc when re-splitting collapses the pending set to nothing.
 *
 * flushDoc re-splits oversized pending changes before sending (breakChangesIntoBatches).
 * A pending change whose only op is an oversized @txt op carrying no sendable delta ops
 * splits into zero pieces, so the flattened queue is empty while the original pending is
 * not. That must be treated as "the local edits amount to a no-op": clear the queue and
 * finish synced — not crash in replacePendingChanges (reading `.rev` off an empty array),
 * not put an empty batch on the wire, and not loop re-flushing the same pending forever.
 */
import { signal } from 'easy-signal';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { createChange } from '../../src/data/change.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';

/** Minimal PatchesConnection fake — only what the flush path touches. */
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

describe('PatchesSync flushDoc — pending set collapses to nothing', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;
  let patches: Patches;
  let conn: ReturnType<typeof makeFakeConnection>;
  let sync: PatchesSync;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    patches = new Patches({ algorithms: { ot: algorithm } });
    conn = makeFakeConnection();
    // Every change reads as oversized, so flushDoc re-splits the queue; the only op below
    // is an empty-delta @txt op, which splits into zero pieces — the whole set collapses.
    sync = new PatchesSync(patches, conn as unknown as PatchesConnection, {
      maxStorageBytes: 100,
      sizeCalculator: () => 1000,
    });
    await patches.trackDocs([DOC_ID]);
    // trackDocs fires onTrackDocs without awaiting the async _handleDocsTracked. Let it
    // finish while still disconnected so it doesn't auto-fire its own syncDoc: an in-flight
    // auto-sync would swallow the test's syncDoc call via @serialGate (the call returns the
    // in-flight promise and queues a follow-up), making the assertions race the real flush.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    sync['updateState']({ connected: true });
  });

  it('clears the queue, sends nothing, and lands synced', async () => {
    await store.savePendingChanges(DOC_ID, [createChange(0, 1, [{ op: '@txt', path: '/text', value: [] }])]);

    await sync['syncDoc'](DOC_ID);

    // Nothing usable to send — the wire is never touched (an empty batch is not sent).
    expect(conn.commitChanges).not.toHaveBeenCalled();
    // The no-op pending was cleared, so the next sync won't re-flush it forever.
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
    expect(sync.docStates.state[DOC_ID].hasPending).toBe(false);
    expect(sync.docStates.state[DOC_ID].syncStatus).toBe('synced');
  });
});
