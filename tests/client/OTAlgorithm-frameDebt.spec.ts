import { describe, expect, it } from 'vitest';
import { commitChanges } from '../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';
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
async function flushOnce(algorithm: OTAlgorithm, backend: OTFuzzBackend): Promise<Change[] | null> {
  const batch = await algorithm.getPendingToSend(DOC_ID);
  if (!batch) return null;
  const { catchupChanges, newChanges } = await commitChanges(backend, DOC_ID, structuredClone(batch), TIMEOUT);
  const committed = [...catchupChanges, ...newChanges].sort((a, b) => a.rev - b.rev);
  if (committed.length > 0) await algorithm.applyServerChanges(DOC_ID, committed, undefined);
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
