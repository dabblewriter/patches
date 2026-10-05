import { describe, expect, it } from 'vitest';
import { commitChanges } from '../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { OTDoc } from '../../src/client/OTDoc';
import type { PatchesDoc } from '../../src/client/PatchesDoc';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';
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
 * Flush until `getPendingToSend` has nothing to send (a withheld row stays in the store queue,
 * so an empty store queue is not what ends this). Returns each batch that went on the wire.
 */
async function drain(
  algorithm: OTAlgorithm,
  backend: OTFuzzBackend,
  doc: OTDoc<any>,
  maxPasses = 5
): Promise<Change[][]> {
  const sent: Change[][] = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    const batch = await flushOnce(algorithm, backend, doc);
    if (!batch) return sent;
    sent.push(batch);
  }
  throw new Error(`the queue did not drain in ${maxPasses} passes`);
}

/** Commit `state` as server rev 1. */
async function seed(backend: OTFuzzBackend, state: unknown): Promise<void> {
  await commitChanges(
    backend,
    DOC_ID,
    [{ id: 'seed', rev: 1, baseRev: 0, ops: [{ op: 'replace', path: '', value: state }], createdAt: 0 }],
    TIMEOUT
  );
}

/**
 * Server history: seed ['a','b','c'] at rev 1, then two foreign removes of /items/0
 * (revs 2-3) that shift every index the straggler's frame knew about.
 */
async function seedServer(backend: OTFuzzBackend): Promise<void> {
  await seed(backend, { items: ['a', 'b', 'c'] });
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

    const sent = await drain(algorithm, backend, doc, 4); // bounded: one pass per distinct frame
    expect(sent).toHaveLength(2);
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);

    const log = backend.log(DOC_ID);
    expect(log.map(c => c.rev)).toEqual([1, 2, 3, 4, 5]);
    const serverHead = applyChanges(null as any, log) as any;
    expect(serverHead.items).toEqual(['c', 'N', 'M']);
    expect(doc.state).toEqual(serverHead);
    expect(doc.droppedPendingChanges).toEqual([]);
  });
});

/**
 * A current-frame row can sit behind a frame-debt row for two different reasons:
 *
 * - it was written BESIDE it — by a context whose view did not have the straggler, so the
 *   straggler's commit is a concurrent change it must be transformed against;
 * - it was written ON TOP of it — by a context whose view did, so the straggler's commit is its
 *   own predecessor coming back, and transforming against it re-applies the straggler's effect
 *   to ops that already account for it: an op beneath a path the straggler created is removed,
 *   an index past the straggler's insert is shifted a second time.
 *
 * `_rebasePendingPreservingFrameDebt` treats every such row as the first kind. The queue cannot
 * say which kind a row is: both leave the same baseRevs and the same ops, in the same order
 * (pinned below, through the real mint path). So the second kind is a KNOWN GAP, recorded here
 * with `knownGap` — those tests run, and turn red the day the gap closes. The tests around them
 * pass today and must keep passing under any fix.
 */
describe('a current-frame row behind a frame-debt row — written beside it, or on top of it', () => {
  const headOf = (backend: OTFuzzBackend) => applyChanges(null as any, backend.log(DOC_ID)) as any;

  /**
   * A known gap: `body` asserts the wanted result and must fail on an ASSERTION, not on a throw
   * from setup or `drain` (which `it.fails` would also accept). When the gap closes `body` stops
   * throwing and this goes red: turn it into a plain `it`.
   */
  function knownGap(name: string, body: () => Promise<void>) {
    it(`KNOWN GAP: ${name}`, async () => {
      const error = await body().then(
        () => undefined,
        (e: unknown) => e
      );
      expect(error, 'the gap closed: make this a plain `it`').toBeDefined();
      expect((error as Error).name).toBe('AssertionError');
    });
  }

  describe('the reported shape: a child added to a doc whose create is still frame debt', () => {
    const timeline = { id: 'timeline', type: 'timeline', children: ['track'] };

    /**
     * Server: rev 1 seeds a group listing ['a','b']; rev 2 (foreign) removes both. Client at
     * rev 2: `create` (frame 1) adds the timeline and lists it at an index only frame 1 had;
     * `addChild` (frame 2) adds an event and lists it in the timeline `create` made.
     */
    async function drainTimelineQueue() {
      const backend = new OTFuzzBackend();
      const removeFirst: JSONPatchOp = { op: 'remove', path: '/docs/group/children/0' };
      await seed(backend, { docs: { group: { id: 'group', children: ['a', 'b'] } } });
      await commitChanges(
        backend,
        DOC_ID,
        [{ id: 'f2', rev: 2, baseRev: 1, ops: [removeFirst, removeFirst], createdAt: 0 }],
        TIMEOUT
      );

      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store);
      await store.trackDocs([DOC_ID]);
      await store.saveDoc(DOC_ID, { state: { docs: { group: { id: 'group', children: [] } } }, rev: 2 });
      const create = createChange(1, 3, [
        { op: 'add', path: '/docs/timeline', value: timeline },
        { op: 'add', path: '/docs/group/children/2', value: 'timeline' },
      ]);
      const addChild = createChange(2, 4, [
        { op: 'add', path: '/docs/event', value: { id: 'event', type: 'event' } },
        { op: 'add', path: '/docs/timeline/children/1', value: 'event' },
      ]);
      // Hand-built and opened straight from the store: nothing here records which context wrote
      // `addChild`, or over what. A fix that records that at mint leaves rows with no record on
      // today's treatment, so this queue would stay `['track']`; the on-top result below is the
      // report's expectation, and a fix has to reach it by some other route than this setup.
      await store.savePendingChanges(DOC_ID, [create, addChild]);
      const doc = algorithm.createDoc<any>(
        DOC_ID,
        (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>
      ) as OTDoc<any>;

      const sent = await drain(algorithm, backend, doc);
      return { backend, create, addChild, sent, doc };
    }

    it('the create flushes alone at its true baseRev and commits transformed (DAB-951 holds)', async () => {
      const { backend, create, addChild, sent } = await drainTimelineQueue();

      expect(sent.map(batch => batch.map(c => [c.id, c.baseRev]))).toEqual([[[create.id, 1]], [[addChild.id, 3]]]);
      expect(backend.log(DOC_ID)[2].ops).toEqual([
        { op: 'add', path: '/docs/timeline', value: timeline },
        { op: 'add', path: '/docs/group/children/0', value: 'timeline' },
      ]);
    });

    // KNOWN GAP. Today the head has `children: ['track']`: the create's echo is rebased over
    // `addChild` as a concurrent `add /docs/timeline`, which removes the op beneath that path.
    // `docs.event` still commits, listed nowhere.
    knownGap('the child is still listed in the timeline once both have committed', async () => {
      const { backend, doc } = await drainTimelineQueue();

      expect(headOf(backend).docs.timeline.children).toEqual(['track', 'event']);
      expect(doc.state).toEqual(headOf(backend)); // a commit-only fix must not leave client and server apart
    });
  });

  describe('both kinds, minted for real: two contexts on one store', () => {
    /** A store whose next pending save lets something else land first — the cross-context race. */
    class RacingStore extends OTInMemoryStore {
      beforeNextSave?: () => Promise<unknown>;

      override async savePendingChanges(docId: string, changes: Change[]): Promise<void> {
        const landFirst = this.beforeNextSave;
        this.beforeNextSave = undefined;
        await landFirst?.();
        return super.savePendingChanges(docId, changes);
      }
    }

    /**
     * What `doc.change()` + Patches do: apply optimistically, then mint the same ops array.
     * Not the whole path: the real mint goes through `Patches._processDocChange` (stable id from
     * `_removeOutboxRows` / `_forgetUnstored`, the per-doc change queue). That is where a
     * per-row record of "written over these frame-debt rows" would be set, and this calls
     * `handleDocChange` directly, so it does not run that branch.
     */
    async function mint(algorithm: OTAlgorithm, doc: OTDoc<any>, ops: JSONPatchOp[]): Promise<Change[]> {
      doc._applyOptimistic(ops);
      return algorithm.handleDocChange(DOC_ID, ops, doc, {});
    }

    const insertR: JSONPatchOp = { op: 'add', path: '/items/1', value: 'R' };

    /**
     * A writer and a follower share one store, both open at rev 1 on ['a','b']. The follower
     * inserts 'S' at the head; between its frame read and its save, the writer receives a
     * foreign rev 2 (an unrelated key). The row lands in a store that has moved to frame 2 — a
     * straggler at baseRev 1 — and the two contexts now disagree about it: the follower's view
     * shows 'S', the writer's doc has not heard of it.
     */
    async function twoContexts() {
      const backend = new OTFuzzBackend();
      const seedState = { items: ['a', 'b'] };
      await seed(backend, seedState);
      const { newChanges } = await commitChanges(
        backend,
        DOC_ID,
        [createChange(1, 2, [{ op: 'add', path: '/title', value: 't' }], {}, 'f2')],
        TIMEOUT
      );

      const store = new RacingStore();
      await store.trackDocs([DOC_ID]);
      await store.saveDoc(DOC_ID, { state: seedState, rev: 1 });
      const open = async () => {
        const algorithm = new OTAlgorithm(store);
        const snapshot = (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>;
        return { algorithm, doc: algorithm.createDoc<any>(DOC_ID, snapshot) as OTDoc<any> };
      };
      const writer = await open();
      const follower = await open();

      store.beforeNextSave = () => writer.algorithm.applyServerChanges(DOC_ID, newChanges, writer.doc);
      const [straggler] = await mint(follower.algorithm, follower.doc, [{ op: 'add', path: '/items/0', value: 'S' }]);

      return { backend, store, writer, follower, straggler };
    }

    it('setup: the follower sees the straggler, the writer does not', async () => {
      const { store, writer, follower, straggler } = await twoContexts();

      expect(await store.getCommittedRev(DOC_ID)).toBe(2);
      expect((await store.getPendingChanges(DOC_ID)).map(c => [c.id, c.baseRev])).toEqual([[straggler.id, 1]]);
      expect(follower.doc.state.items).toEqual(['S', 'a', 'b']);
      expect(writer.doc.state.items).toEqual(['a', 'b']);
    });

    it('the queue records the same rows whichever context writes the next change', async () => {
      // Beside: the writer puts 'R' after 'a'. On top: the follower puts 'R' after its own 'S'.
      const beside = await twoContexts();
      await mint(beside.writer.algorithm, beside.writer.doc, [{ ...insertR }]);
      expect(beside.writer.doc.state.items).toEqual(['a', 'R', 'b']);

      const onTop = await twoContexts();
      await mint(onTop.follower.algorithm, onTop.follower.doc, [{ ...insertR }]);
      expect(onTop.follower.doc.state.items).toEqual(['S', 'R', 'a', 'b']);

      // Everything a pending row carries, bar the random id and the clock.
      const rows = [
        { baseRev: 1, rev: 3, ops: [{ op: 'add', path: '/items/0', value: 'S' }] },
        { baseRev: 2, rev: 4, ops: [insertR] },
      ].map(row => ({ ...row, id: expect.any(String), createdAt: expect.any(Number), committedAt: 0 }));
      expect(await beside.store.getPendingChanges(DOC_ID)).toEqual(rows);
      expect(await onTop.store.getPendingChanges(DOC_ID)).toEqual(rows);
    });

    // Pins today's result, NOT a requirement on a fix. The same race with no frame debt (next
    // test) commits the row on top of 'S', so a fix that keeps the straggler in the
    // `rebaseChanges` walk would give ['S','R','a','b'] here too and may reasonably do so.
    it('written beside it: today the row lands where its author put it (after "a")', async () => {
      const { backend, writer } = await twoContexts();
      await mint(writer.algorithm, writer.doc, [{ ...insertR }]);

      await drain(writer.algorithm, backend, writer.doc);

      expect(headOf(backend).items).toEqual(['S', 'a', 'R', 'b']);
      expect(writer.doc.state).toEqual(headOf(backend));
    });

    it('the same race with no frame debt commits the row on top of "S", not beside it', async () => {
      // Both rows are minted at baseRev 1 and flush as one batch, so the server reads the second
      // as written over the first. This is the existing same-frame behaviour, for comparison.
      const backend = new OTFuzzBackend();
      const seedState = { items: ['a', 'b'] };
      await seed(backend, seedState);
      const store = new OTInMemoryStore();
      await store.trackDocs([DOC_ID]);
      await store.saveDoc(DOC_ID, { state: seedState, rev: 1 });
      const open = async () => {
        const algorithm = new OTAlgorithm(store);
        const snapshot = (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>;
        return { algorithm, doc: algorithm.createDoc<any>(DOC_ID, snapshot) as OTDoc<any> };
      };
      const writer = await open();
      const follower = await open();
      await mint(follower.algorithm, follower.doc, [{ op: 'add', path: '/items/0', value: 'S' }]);
      await mint(writer.algorithm, writer.doc, [{ ...insertR }]);
      expect((await store.getPendingChanges(DOC_ID)).map(c => c.baseRev)).toEqual([1, 1]);

      await drain(writer.algorithm, backend, writer.doc);

      expect(headOf(backend).items).toEqual(['S', 'R', 'a', 'b']);
    });

    // KNOWN GAP. Today the head is ['S','a','R','b'] here too: the straggler's echo shifts the
    // row past an insert it was already written behind.
    knownGap('written on top of it: the row lands where its author put it (after "S")', async () => {
      const { backend, follower } = await twoContexts();
      await mint(follower.algorithm, follower.doc, [{ ...insertR }]);

      await drain(follower.algorithm, backend, follower.doc);

      expect(headOf(backend).items).toEqual(['S', 'R', 'a', 'b']);
      expect(follower.doc.state).toEqual(headOf(backend));
    });

    /** `twoContexts`, then the writer's next receive (a foreign rev 3) brings the straggler into its doc. */
    async function writerHasSeenIt() {
      const contexts = await twoContexts();
      const { newChanges } = await commitChanges(
        contexts.backend,
        DOC_ID,
        [createChange(2, 3, [{ op: 'add', path: '/note', value: 'n' }], {}, 'f3')],
        TIMEOUT
      );
      await contexts.writer.algorithm.applyServerChanges(DOC_ID, newChanges, contexts.writer.doc);
      return contexts;
    }

    it('one context writes either kind: beside before its view has the straggler, on top after', async () => {
      const { store, writer, straggler } = await writerHasSeenIt();
      expect(writer.doc.state.items).toEqual(['S', 'a', 'b']);

      const [row] = await mint(writer.algorithm, writer.doc, [{ ...insertR }]);

      expect(writer.doc.state.items).toEqual(['S', 'R', 'a', 'b']);
      expect((await store.getPendingChanges(DOC_ID)).map(c => [c.id, c.baseRev])).toEqual([
        [straggler.id, 1],
        [row.id, 3],
      ]);
    });

    // KNOWN GAP, the other route to it: no catch-up involved, the writer simply typed on a view
    // that showed the straggler. Today the head is ['S','a','R','b'].
    knownGap('written on top of it by the writer, once its view shows the straggler: lands after "S"', async () => {
      const { backend, writer } = await writerHasSeenIt();
      await mint(writer.algorithm, writer.doc, [{ ...insertR }]);

      await drain(writer.algorithm, backend, writer.doc);

      expect(headOf(backend).items).toEqual(['S', 'R', 'a', 'b']);
      expect(writer.doc.state).toEqual(headOf(backend));
    });

    it('written on top of it but not yet minted when the straggler echoes: lands after "S"', async () => {
      // The doc's own rebase of unminted ops walks them behind its whole queue, straggler
      // included, so the echo is recognised as theirs. Same edit as the gap above; the only
      // difference is which side of its mint the echo arrived on.
      const { backend, follower } = await twoContexts();
      const ops = [{ ...insertR }];
      follower.doc._applyOptimistic(ops);

      await flushOnce(follower.algorithm, backend, follower.doc);
      await follower.algorithm.handleDocChange(DOC_ID, ops, follower.doc, {});
      await drain(follower.algorithm, backend, follower.doc);

      expect(headOf(backend).items).toEqual(['S', 'R', 'a', 'b']);
      expect(follower.doc.state).toEqual(headOf(backend));
    });
  });
});
