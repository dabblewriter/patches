/**
 * Regression tests for flushDoc when its re-split goes stale before it is stored (DAB-786).
 *
 * flushDoc splits oversized pending changes from a queue it read before taking any lock, then
 * swaps the stored queue for the pieces (replacePendingChanges). A receive landing between the
 * read and the swap can commit or rebase the very changes the split was computed from. Storing
 * the pieces anyway re-queues work the server already holds under new ids, which the server's
 * id-dedup cannot recognise, so it commits a second time. The swap must refuse a stale split,
 * and flushDoc must re-derive the queue instead of sending the stale pieces.
 */
import { signal } from 'easy-signal';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { createChange } from '../../src/data/change.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change } from '../../src/types.js';

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
    commitChanges: vi.fn(async (_docId: string, changes: Change[]) => ({
      changes: changes.map(c => ({ ...c, committedAt: Date.now() })),
    })),
    deleteDoc: vi.fn(async () => {}),
  };
}

const DOC_ID = 'doc1';

describe('PatchesSync flushDoc — the re-split goes stale before it is stored', () => {
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
    // A change is "oversized" once it carries more than one op, so a two-op change splits
    // into two single-op pieces with fresh ids.
    sync = new PatchesSync(patches, conn as unknown as PatchesConnection, {
      maxStorageBytes: 150,
      sizeCalculator: (value: unknown) => {
        const ops = (value as Change).ops;
        return Array.isArray(ops) ? ops.length * 100 : 0;
      },
    });
    await patches.trackDocs([DOC_ID]);
    // Let _handleDocsTracked finish while still disconnected (see PatchesSyncFlushCollapse).
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    sync['updateState']({ connected: true });
  });

  it('does not send the split of a change a receive committed in the meantime', async () => {
    const original = createChange(0, 1, [
      { op: 'add', path: '/a', value: 1 },
      { op: 'add', path: '/b', value: 2 },
    ]);
    await store.savePendingChanges(DOC_ID, [original]);

    // The receive lands between flushDoc's read of the queue and its swap to the split: the
    // server already committed `original` (an earlier send whose ack was lost).
    const replace = algorithm.replacePendingChanges.bind(algorithm);
    let received = false;
    vi.spyOn(algorithm, 'replacePendingChanges').mockImplementation(async (...args) => {
      if (!received) {
        received = true;
        await algorithm.applyServerChanges(DOC_ID, [{ ...original, committedAt: Date.now() }], undefined);
      }
      return replace(...args);
    });

    await sync['syncDoc'](DOC_ID);

    // Nothing is left to send, so nothing goes on the wire: the pieces of a committed change
    // carry ids the server has never seen, and would commit its ops a second time.
    expect(conn.commitChanges).not.toHaveBeenCalled();
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
    expect(sync.docStates.state[DOC_ID].syncStatus).toBe('synced');
  });
});
