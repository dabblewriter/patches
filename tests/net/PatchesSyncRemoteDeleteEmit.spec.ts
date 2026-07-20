/**
 * Regression tests for the bounded `onRemoteDocDeleted` emit in PatchesSync.
 *
 * `_handleRemoteDocDeleted` awaits the app-facing signal on purpose: subscribers may be
 * async, and the app shelves the pending changes that the delete discarded. Proceeding
 * before that shelf write lands would lose them. But the await runs inside the doc's
 * serialized sync gate, so an app subscriber that never settles wedges that doc's sync
 * forever — no error, no recovery.
 *
 * So the await is bounded: the normal case must be byte-for-byte the old behavior
 * (subscriber completes, THEN we proceed), and the pathological case must give up loudly
 * at the bound instead of parking.
 */
import { signal } from 'easy-signal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync, REMOTE_DOC_DELETED_EMIT_TIMEOUT_MS } from '../../src/net/PatchesSync.js';

const DOC_ID = 'doc1';

/** Minimal PatchesConnection fake — only what the remote-delete path touches. */
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

describe('PatchesSync — bounded onRemoteDocDeleted emit', () => {
  let patches: Patches;
  let sync: PatchesSync;
  let conn: ReturnType<typeof makeFakeConnection>;

  beforeEach(async () => {
    vi.useFakeTimers();
    const algorithm = new OTAlgorithm(new OTInMemoryStore());
    patches = new Patches({ algorithms: { ot: algorithm } });
    conn = makeFakeConnection();
    sync = new PatchesSync(patches, conn as unknown as PatchesConnection);
    vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

    await patches.trackDocs([DOC_ID]);
    sync['trackedDocs'].add(DOC_ID);
    sync['_initDocSyncState'](DOC_ID, { committedRev: 1, syncStatus: 'synced' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for an async subscriber to finish shelving before proceeding', async () => {
    const order: string[] = [];

    sync.onRemoteDocDeleted(async () => {
      order.push('shelf-start');
      // The app's shelf write is async (IndexedDB, a network call) — the library must not
      // proceed until it lands, which is the entire reason this emit is awaited.
      await new Promise(resolve => setTimeout(resolve, 50));
      order.push('shelf-written');
    });

    const handled = sync['_handleRemoteDocDeleted'](DOC_ID).then(() => order.push('proceeded'));
    await vi.advanceTimersByTimeAsync(50);
    await handled;

    expect(order).toEqual(['shelf-start', 'shelf-written', 'proceeded']);
    expect(sync.docStates.state[DOC_ID]).toBeUndefined();
  });

  it('proceeds at the bound when a subscriber never settles, logging the docId', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // An app subscriber that hangs forever: an awaited promise that is never resolved.
    sync.onRemoteDocDeleted(() => new Promise<void>(() => {}));

    let settled = false;
    const handled = sync['_handleRemoteDocDeleted'](DOC_ID).then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(REMOTE_DOC_DELETED_EMIT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await handled;

    expect(settled).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain(DOC_ID);
    // Cleanup still completed — the doc is gone from sync state, not stuck half-deleted.
    expect(sync.docStates.state[DOC_ID]).toBeUndefined();
    expect(sync['trackedDocs'].has(DOC_ID)).toBe(false);
  });

  it('does not wedge the doc: a later remote delete still completes after one hung subscriber', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sync.onRemoteDocDeleted(() => new Promise<void>(() => {}));

    const first = sync['_handleRemoteDocDeleted'](DOC_ID);
    await vi.advanceTimersByTimeAsync(REMOTE_DOC_DELETED_EMIT_TIMEOUT_MS);
    await first;

    // The gate is free again rather than held by the abandoned subscriber.
    const second = sync['_handleRemoteDocDeleted']('doc2');
    await vi.advanceTimersByTimeAsync(REMOTE_DOC_DELETED_EMIT_TIMEOUT_MS);
    await expect(second).resolves.toBeUndefined();
  });

  it('leaves a fast synchronous subscriber untouched — no timer cost, no log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const subscriber = vi.fn();
    sync.onRemoteDocDeleted(subscriber);

    await sync['_handleRemoteDocDeleted'](DOC_ID);

    expect(subscriber).toHaveBeenCalledWith(DOC_ID, []);
    expect(error).not.toHaveBeenCalled();
    // The bound's timer must be cleared on the normal path, not left pending.
    expect(vi.getTimerCount()).toBe(0);
  });
});
