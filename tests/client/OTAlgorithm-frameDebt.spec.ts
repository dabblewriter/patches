import { describe, expect, it } from 'vitest';
import { commitChanges } from '../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { OTDoc } from '../../src/client/OTDoc';
import type { PatchesDoc } from '../../src/client/PatchesDoc';
import { createChange } from '../../src/data/change';
import type { Change, PatchesSnapshot } from '../../src/types';
import { OTFuzzBackend } from '../fuzz/otFuzzBackend';

/**
 * DAB-951: a change minted while its doc was a frame behind the store (a torn reload, a
 * follower tab that hadn't received the writer's broadcast yet) carries a baseRev — and ops —
 * older than siblings the receive path already rebased. Relabeling it to the newest frame
 * committed its ops without the transform across the intervening committed changes: permanent
 * history that can never apply (the DAB-946 poison class). The fix has two halves, tested
 * here against the real transform machinery (no mocks):
 *
 * - the flush seam sends one frame per pass, each at its TRUE baseRev, and the server — which
 *   holds every committed change past any baseRev — runs the transform the client can't;
 * - the receive-side queue rebase preserves a deferred row's frame instead of laundering it
 *   to the new tip (which would recreate the mislabeled commit one echo later).
 */

const TIMEOUT = 30 * 60_000;
const DOC_ID = 'doc1';

/** One flush pass, wired the way PatchesSync.flushDoc drives it (clone = the wire boundary). */
async function flushOnce(
  algorithm: OTAlgorithm,
  backend: OTFuzzBackend,
  doc?: PatchesDoc<any>
): Promise<Change[] | null> {
  const batch = await algorithm.getPendingToSend(DOC_ID, doc);
  if (!batch) return null;
  const { catchupChanges, newChanges } = await commitChanges(backend, DOC_ID, structuredClone(batch), TIMEOUT);
  const committed = [...catchupChanges, ...newChanges].sort((a, b) => a.rev - b.rev);
  if (committed.length > 0) await algorithm.applyServerChanges(DOC_ID, committed, doc);
  return batch;
}

/**
 * Server history: seed ['a','b','c'] at rev 1, then two foreign removes of /items/0
 * (revs 2-3) that shift every index the straggler's frame knew about.
 */
async function seedServer(backend: OTFuzzBackend): Promise<void> {
  const seed = { items: ['a', 'b', 'c'] };
  await commitChanges(
    backend,
    DOC_ID,
    [{ id: 'seed', rev: 1, baseRev: 0, ops: [{ op: 'replace', path: '', value: seed }], createdAt: 0 }],
    TIMEOUT
  );
  for (const [id, rev] of [
    ['f2', 2],
    ['f3', 3],
  ] as const) {
    await commitChanges(
      backend,
      DOC_ID,
      [{ id, rev, baseRev: rev - 1, ops: [{ op: 'remove', path: '/items/0' }], createdAt: 0 }],
      TIMEOUT
    );
  }
}

describe('DAB-951 — a straggler mint flushes at its true baseRev and commits appliable history', () => {
  it('the poison mint reproduction: mixed queue, both changes commit, full log replays strictly', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend);

    // Client synced through rev 3 (state ['c']). Its queue holds one row rebased to the
    // current frame and one straggler minted against frame 1 (items ['a','b','c']): an
    // append at /items/3 — valid in ITS frame, unappliable if committed in frame 3.
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs([DOC_ID]);
    await store.saveDoc(DOC_ID, { state: { items: ['c'] }, rev: 3 });
    const fresh = createChange(3, 4, [{ op: 'add', path: '/items/0', value: 'W' }]);
    const straggler = createChange(1, 5, [{ op: 'add', path: '/items/3', value: 'M' }]);
    await store.savePendingChanges(DOC_ID, [fresh, straggler]);

    // Pass 1 flushes only the current-frame run; the straggler is deferred, not relabeled.
    const first = await flushOnce(algorithm, backend);
    expect(first!.map(c => c.id)).toEqual([fresh.id]);
    // The echo's rebase preserved the straggler's frame (no laundering to the new tip).
    const afterEcho = await store.getPendingChanges(DOC_ID);
    expect(afterEcho.map(c => [c.id, c.baseRev])).toEqual([[straggler.id, 1]]);

    // Pass 2 flushes the straggler at its TRUE baseRev; the server transforms it across
    // revs 2..4 (two removes + the fresh add) into the current frame.
    const second = await flushOnce(algorithm, backend);
    expect(second!.map(c => [c.id, c.baseRev])).toEqual([[straggler.id, 1]]);
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);

    // The committed log is poison-free: contiguous, and it replays under STRICT apply —
    // the exact check the old relabel-without-transform behavior failed (an add at
    // /items/3 committed verbatim into a 2-element frame).
    const log = backend.log(DOC_ID);
    expect(log.map(c => c.rev)).toEqual([1, 2, 3, 4, 5]);
    const serverHead = applyChanges(null as any, log) as any;
    expect(serverHead.items).toEqual(['W', 'c', 'M']);

    // And the client converged on the same head.
    const clientDoc = await store.getDoc(DOC_ID);
    expect(clientDoc!.state).toEqual(serverHead);
    expect(clientDoc!.rev).toBe(5);
  });

  it('control: a frame-consistent queue flushes whole and unchanged', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend);

    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs([DOC_ID]);
    await store.saveDoc(DOC_ID, { state: { items: ['c'] }, rev: 3 });
    const a = createChange(3, 4, [{ op: 'add', path: '/items/0', value: 'A' }]);
    const b = createChange(3, 5, [{ op: 'add', path: '/items/1', value: 'B' }]);
    await store.savePendingChanges(DOC_ID, [a, b]);

    const sent = await flushOnce(algorithm, backend);
    expect(sent!.map(c => c.id)).toEqual([a.id, b.id]);
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);

    const serverHead = applyChanges(null as any, backend.log(DOC_ID)) as any;
    expect(serverHead.items).toEqual(['A', 'B', 'c']);
    expect((await store.getDoc(DOC_ID))!.state).toEqual(serverHead);
  });
});

describe('DAB-951 — the receive-side rebase preserves frame debt instead of laundering it', () => {
  async function makeMixedQueue() {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs([DOC_ID]);
    await store.saveDoc(DOC_ID, { state: { items: ['c'] }, rev: 3 });
    const fresh = createChange(3, 4, [{ op: 'add', path: '/items/1', value: 'W' }]);
    const straggler = createChange(1, 5, [{ op: 'add', path: '/items/3', value: 'M' }]);
    await store.savePendingChanges(DOC_ID, [fresh, straggler]);
    return { store, algorithm, fresh, straggler };
  }

  const foreign = (rev: number): Change => ({
    ...createChange(rev - 1, rev, [{ op: 'remove', path: '/items/0' }]),
    committedAt: Date.now(),
  });

  it('applyServerChanges: walks current-frame rows, leaves the straggler ops and baseRev intact', async () => {
    const { store, algorithm, fresh, straggler } = await makeMixedQueue();

    await algorithm.applyServerChanges(DOC_ID, [foreign(4)], undefined);

    const queue = await store.getPendingChanges(DOC_ID);
    expect(queue.map(c => c.id)).toEqual([fresh.id, straggler.id]);
    // The current-frame row was transformed against the foreign remove and relabeled.
    expect(queue[0].baseRev).toBe(4);
    expect(queue[0].ops).toEqual([{ op: 'add', path: '/items/0', value: 'W' }]);
    // The straggler was neither transformed nor relabeled — its frame stays honest.
    expect(queue[1].baseRev).toBe(1);
    expect(queue[1].ops).toEqual([{ op: 'add', path: '/items/3', value: 'M' }]);
    // Both were re-sequenced past the new tip.
    expect(queue.map(c => c.rev)).toEqual([5, 6]);
  });

  it('applyServerChanges: drops a straggler when the server echoes its commit', async () => {
    const { store, algorithm, straggler } = await makeMixedQueue();

    // The straggler's own true-baseRev flush came back committed (transformed by the server).
    const echo: Change = { ...straggler, rev: 4, baseRev: 3, ops: [], committedAt: Date.now() };
    await algorithm.applyServerChanges(DOC_ID, [echo], undefined);

    const queue = await store.getPendingChanges(DOC_ID);
    expect(queue.map(c => c.id)).not.toContain(straggler.id);
  });

  it('reconcilePending: same preservation on the snapshot-reload recovery path', async () => {
    const { store, algorithm, fresh, straggler } = await makeMixedQueue();

    await algorithm.reconcilePending(DOC_ID, [foreign(4)]);

    const queue = await store.getPendingChanges(DOC_ID);
    expect(queue.map(c => [c.id, c.baseRev])).toEqual([
      [fresh.id, 4],
      [straggler.id, 1],
    ]);
    expect(queue[1].ops).toEqual([{ op: 'add', path: '/items/3', value: 'M' }]);
  });
});

/**
 * The store's queue is the wire contract; the open doc's optimistic state is a view of it. A
 * deferred row's ops sit in a frame the committed state has moved past, so they may not apply
 * there — that is the debt the flush seam is deliberately carrying, not corruption. The view
 * therefore omits the row and the queue keeps it, and the row's content appears when the server
 * commits it back. Dropping it from the QUEUE instead would discard the user's unsent edit
 * locally — the exact loss the honest-baseRev flush exists to prevent.
 */
describe('DAB-951 — frame debt is a store contract, and the open doc renders around it', () => {
  async function openMixedQueue() {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs([DOC_ID]);
    await store.saveDoc(DOC_ID, { state: { items: ['c'] }, rev: 3 });
    const fresh = createChange(3, 4, [{ op: 'add', path: '/items/1', value: 'W' }]);
    const straggler = createChange(1, 5, [{ op: 'add', path: '/items/3', value: 'M' }]);
    await store.savePendingChanges(DOC_ID, [fresh, straggler]);
    const doc = algorithm.createDoc<any>(
      DOC_ID,
      (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>
    ) as OTDoc<any>;
    return { store, algorithm, doc, fresh, straggler };
  }

  const foreign = (rev: number): Change => ({
    ...createChange(rev - 1, rev, [{ op: 'remove', path: '/items/0' }]),
    committedAt: Date.now(),
  });

  it('hydration keeps a deferred row queued instead of discarding it as corrupt', async () => {
    const { doc, fresh, straggler } = await openMixedQueue();

    // `add /items/3` cannot apply in a 2-element frame, but the row is not corrupt — it is
    // waiting to flush at baseRev 1. It must survive hydration, or the unsent edit is gone.
    expect(doc.droppedPendingChanges).toEqual([]);
    expect(doc.getPendingChanges().map(c => c.id)).toEqual([fresh.id, straggler.id]);
    // The view shows the rows that ARE in frame; the straggler's 'M' waits for its commit.
    expect(doc.state).toEqual({ items: ['c', 'W'] });
  });

  it('applyServerChanges: the preserved straggler does not break the open doc', async () => {
    const { store, algorithm, doc, fresh, straggler } = await openMixedQueue();

    // Strict pending replay against the newly advanced committed state used to throw here —
    // AFTER the store transaction committed, tearing store and doc apart.
    await algorithm.applyServerChanges(DOC_ID, [foreign(4)], doc);

    expect(doc.state).toEqual({ items: ['W'] });
    // The doc's queue still mirrors the store's exactly — same ids, same frames. Anything else
    // would flush the doc's copy instead of the honest one (getPendingToSend trusts the doc).
    const queue = await store.getPendingChanges(DOC_ID);
    expect(doc.getPendingChanges()).toEqual(queue);
    expect(queue.map(c => [c.id, c.baseRev])).toEqual([
      [fresh.id, 4],
      [straggler.id, 1],
    ]);
    expect(doc.droppedPendingChanges).toEqual([]);
  });

  it('end-to-end with the doc open: the deferred edit reappears when the server commits it', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend);
    const { store, algorithm, doc, fresh, straggler } = await openMixedQueue();

    expect((await flushOnce(algorithm, backend, doc))!.map(c => c.id)).toEqual([fresh.id]);
    expect((await flushOnce(algorithm, backend, doc))!.map(c => [c.id, c.baseRev])).toEqual([[straggler.id, 1]]);

    const serverHead = applyChanges(null as any, backend.log(DOC_ID)) as any;
    expect(serverHead.items).toContain('M');
    expect(doc.state).toEqual(serverHead);
    expect(doc.getPendingChanges()).toEqual([]);
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
  });

  it('a wholly-stale queue still drains — one frame per pass — and never launders a frame', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend);

    // Every row is behind the committed frame, so the receive rebase transforms nothing: there
    // is no current-frame row left to walk. That is the design, not a stall — each frame still
    // flushes at its true baseRev and the server transforms it across everything since.
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs([DOC_ID]);
    await store.saveDoc(DOC_ID, { state: { items: ['c'] }, rev: 3 });
    const s1 = createChange(1, 4, [{ op: 'add', path: '/items/3', value: 'M' }]);
    const s2 = createChange(2, 5, [{ op: 'add', path: '/items/2', value: 'N' }]);
    await store.savePendingChanges(DOC_ID, [s1, s2]);
    const doc = algorithm.createDoc<any>(
      DOC_ID,
      (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>
    ) as OTDoc<any>;

    let passes = 0;
    while ((await store.getPendingChanges(DOC_ID)).length > 0) {
      expect(++passes).toBeLessThanOrEqual(4); // bounded: one pass per distinct frame
      expect(await flushOnce(algorithm, backend, doc)).not.toBeNull();
    }
    expect(passes).toBe(2);

    const log = backend.log(DOC_ID);
    expect(log.map(c => c.rev)).toEqual([1, 2, 3, 4, 5]);
    const serverHead = applyChanges(null as any, log) as any;
    expect(serverHead.items).toEqual(['c', 'N', 'M']);
    expect(doc.state).toEqual(serverHead);
    expect(doc.droppedPendingChanges).toEqual([]);
  });
});
