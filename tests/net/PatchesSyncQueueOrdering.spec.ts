/**
 * Regression tests for the send path's view of the pending queue.
 *
 * The queue is durable in the store; the open doc keeps an in-memory mirror of it. Any context
 * sharing the store may mint (a second tab, a worker), and the store — not the doc — assigns
 * each change its `rev`, from the store's own tail. So a change persisted by another context
 * can land at a rev the flushing doc's mirror already occupies.
 *
 * The send path must therefore read the store, the way the receive path does. Reading the
 * doc's mirror and supplementing it only with store rows *past the mirror's tail* silently
 * withholds every persisted change at or below that tail: it never goes on the wire, changes
 * minted after it commit ahead of it, and it only re-enters the queue when a commit echo
 * rebuilds the queue from the store — by which point it is rebased against, and can be
 * transformed away by, work that was minted later than it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm, UnstoredPendingError } from '../../src/client/OTAlgorithm.js';
import { OTDoc } from '../../src/client/OTDoc.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change } from '../../src/types.js';
import { makeConnection } from './connectionMock.js';

interface Doc {
  items?: string[];
}

const DOC_ID = 'doc1';

/** Yield to queued microtasks and timers where no queue state is being asserted. */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** Labels appended to `/items`, in the order the wire carried them. */
function sentLabels(conn: { commitChanges: { mock: { calls: any[][] } } }): string[] {
  return conn.commitChanges.mock.calls.flatMap(call =>
    (call[1] as Change[]).flatMap(c => c.ops.filter(o => typeof o.value === 'string').map(o => o.value as string))
  );
}

describe('PatchesSync — flush reads the durable queue, not the open doc mirror', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;
  let patches: Patches;
  let conn: ReturnType<typeof makeConnection>;
  let sync: PatchesSync;
  let doc: any;
  let foreignAlgorithm: OTAlgorithm;

  /**
   * A second context over the same store, exactly as another tab would run: its own algorithm
   * instance, so its mints share nothing but the store. Reusing the instance under test would
   * put both contexts behind one `_docLocks` chain and serialize away the very interleaving
   * these tests are about (see `OTAlgorithm._withDocLock`).
   */
  async function foreignMint(label: string): Promise<void> {
    const foreignDoc = foreignAlgorithm.createDoc<Doc>(
      DOC_ID,
      (await foreignAlgorithm.loadDoc(DOC_ID)) as any
    ) as OTDoc<Doc>;
    await foreignAlgorithm.handleDocChange(DOC_ID, [{ op: 'add', path: '/items/-', value: label }], foreignDoc, {});
  }

  /** Wait for the durable queue to hold exactly `length` rows — the precondition itself, rather
   *  than however many timer turns the in-memory store happens to need to get there. */
  async function waitForQueue(length: number): Promise<void> {
    await vi.waitFor(async () => expect(await store.getPendingChanges(DOC_ID)).toHaveLength(length));
  }

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    foreignAlgorithm = new OTAlgorithm(store);
    patches = new Patches({ algorithms: { ot: algorithm } });
    conn = makeConnection({
      // Echo each committed change back at the next rev, as a real commit response does.
      commitChanges: vi.fn(async (_docId: string, changes: Change[]) => ({
        changes: changes.map((c, i) => ({ ...c, rev: c.baseRev + 1 + i, committedAt: Date.now() })),
      })),
    });
    sync = new PatchesSync(patches, conn as unknown as PatchesConnection);
    await patches.trackDocs([DOC_ID]);
    // trackDocs fires onTrackDocs without awaiting _handleDocsTracked; let it settle while
    // disconnected so its auto-sync can't swallow the test's own syncDoc via @serialGate.
    await settle();
    sync['updateState']({ connected: true });
    doc = await patches.openDoc<Doc>(DOC_ID);
    doc.change((patch: any) => patch.replace('/items', []));
    await settle();
    await sync['syncDoc'](DOC_ID);
    // Start every test from a committed `/items: []` and an empty queue, whichever of the
    // per-change auto-sync or the explicit syncDoc above got there first.
    await vi.waitFor(() => expect(conn.commitChanges).toHaveBeenCalled());
    await waitForQueue(0);
    conn.commitChanges.mockClear();
    // Mint offline for the rest of each test, so the queue is assembled before any flush
    // rather than being drained one change at a time by the per-change auto-sync.
    sync['updateState']({ connected: false });
  });

  it('flushes every durable pending change, not just the ones the open doc mirrors', async () => {
    // The other context mints first and takes the next rev; this doc mints after it and the
    // store stamps it higher — so the older change now sits BELOW this doc's mirror tail.
    await foreignMint('foreign');
    doc.change((patch: any) => patch.add('/items/-', 'mine'));
    await waitForQueue(2);

    const queued = await store.getPendingChanges(DOC_ID);
    expect(queued.map(c => c.ops[0].value)).toEqual(['foreign', 'mine']);

    sync['updateState']({ connected: true });
    await sync['syncDoc'](DOC_ID);

    expect(sentLabels(conn)).toEqual(['foreign', 'mine']);
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
  });

  it('still flushes a change the store lost while the open doc mirrors it', async () => {
    // The torn store write `_collectPending`'s doc merge exists for: the row is gone store-side
    // and the mirror holds the only copy. Pins the case where that copy sits ABOVE the store
    // tail, which is the half of the merge rule the send path and the receive path agree on.
    doc.change((patch: any) => patch.add('/items/-', 'orphan'));
    await waitForQueue(1);
    const [orphan] = await store.getPendingChanges(DOC_ID);
    await store.dropPendingChanges(DOC_ID, [orphan.id]);

    sync['updateState']({ connected: true });
    await sync['syncDoc'](DOC_ID);

    expect(sentLabels(conn)).toEqual(['orphan']);
  });

  it('withholds a change the store lost once the tail moved past it, and reports the drop', async () => {
    // The other half of the merge rule, and the one the two paths reach differently. The store is
    // authoritative about what is durable, so a row it never accepted stays off the wire — but the
    // editor still shows that content and `hasPending` reads the store, so the only thing that can
    // make the condition distinguishable from a fully synced doc is the report.
    doc.change((patch: any) => patch.add('/items/-', 'orphan'));
    await waitForQueue(1);
    const [orphan] = await store.getPendingChanges(DOC_ID);
    // The store write that reported success without persisting: gone store-side, still mirrored.
    await store.dropPendingChanges(DOC_ID, [orphan.id]);
    // The other context then mints into the rev the orphan occupied, putting the store tail at it.
    await foreignMint('later');
    await waitForQueue(1);

    const reported: UnstoredPendingError[] = [];
    sync.onError(err => {
      if (err instanceof UnstoredPendingError) reported.push(err);
    });

    sync['updateState']({ connected: true });
    await sync['syncDoc'](DOC_ID);

    expect(sentLabels(conn)).toEqual(['later']);
    expect(reported.map(e => e.changeIds)).toContainEqual([orphan.id]);
    expect(reported[0].docId).toBe(DOC_ID);
  });

  it('never commits an older pending change after a newer one', async () => {
    await foreignMint('first');
    doc.change((patch: any) => patch.add('/items/-', 'second'));
    await waitForQueue(2);

    sync['updateState']({ connected: true });
    // Flush to a fixed point — however many passes it takes to drain the queue.
    for (let i = 0; i < 4; i++) {
      await sync['syncDoc'](DOC_ID);
      await settle();
    }

    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
    expect(sentLabels(conn)).toEqual(['first', 'second']);
  });

  it('withholds nothing when a flush fails opaquely and mints keep arriving', async () => {
    // The prod shape: a commit dies without a status (a 429'd CORS preflight surfaces as an
    // opaque TypeError), and the user keeps typing while the retry is pending.
    conn.commitChanges.mockImplementationOnce(async () => {
      const err = new Error('Failed to fetch');
      err.name = 'NetworkError';
      throw err;
    });

    await foreignMint('a');
    doc.change((patch: any) => patch.add('/items/-', 'b'));
    await waitForQueue(2);

    sync['updateState']({ connected: true });
    await sync['syncDoc'](DOC_ID); // dies opaquely; nothing may be lost or resequenced

    // Mint the retry-window edits offline so all four are queued before the next flush, rather
    // than the auto-sync draining them one at a time — the failed flush is the window under test.
    sync['updateState']({ connected: false });
    await foreignMint('c');
    doc.change((patch: any) => patch.add('/items/-', 'd'));
    await waitForQueue(4);

    sync['updateState']({ connected: true });
    for (let i = 0; i < 4; i++) {
      await sync['syncDoc'](DOC_ID);
      await settle();
    }

    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
    expect(sentLabels(conn)).toEqual(['a', 'b', 'a', 'b', 'c', 'd']);
  });
});
