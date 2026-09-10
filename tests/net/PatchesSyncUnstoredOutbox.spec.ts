/**
 * End to end for storage hardening A1: a change whose persist the store keeps refusing is latched
 * in memory — and, with the outbox, still reaches the server on the next flush, behind whatever
 * the store holds, under the same stable id the persist used. Its committed echo confirms it in
 * the open doc exactly once. Nothing here writes the refused change to the store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges.js';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import type { OTDoc } from '../../src/client/OTDoc.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { createChange } from '../../src/data/change.js';
import { UnstoredFrameLostError } from '../../src/net/error.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import { OTServer, type OTServerOptions } from '../../src/server/OTServer.js';
import type { Change } from '../../src/types.js';
import { OTFuzzBackend } from '../fuzz/otFuzzBackend.js';
import { makeConnection } from './connectionMock.js';

/** A store that refuses every pending persist (and, optionally, every receive) with a timeout. */
class RefusingStore extends OTInMemoryStore {
  refusePersists = true;
  refuseApplies = false;
  async savePendingChanges(docId: string, changes: Change[]): Promise<void> {
    if (this.refusePersists) throw new Error('[pendingChanges] did not settle within 5021ms');
    return super.savePendingChanges(docId, changes);
  }
  async applyServerChanges(
    docId: string,
    serverChanges: Change[],
    rebased: Change[],
    pendingTailRev?: number
  ): Promise<void | 'conflict'> {
    if (this.refuseApplies) throw new Error('[docs] did not settle within 5021ms');
    return super.applyServerChanges(docId, serverChanges, rebased, pendingTailRev);
  }
}

/** A server that commits what it is sent, dedups by id, and echoes committed copies back. */
function makeServer() {
  const committed: Change[] = [];
  const commitChanges = vi.fn(async (_docId: string, changes: Change[]) => {
    const known = new Set(committed.map(c => c.id));
    const fresh = changes.filter(c => !known.has(c.id));
    for (const c of fresh) committed.push({ ...c, rev: committed.length + 1, committedAt: 1 });
    const baseRev = changes[0]?.baseRev ?? 0;
    return { changes: committed.filter(c => c.rev > baseRev) };
  });
  return { committed, commitChanges };
}

describe('PatchesSync — outbox rows go out from memory and confirm once', () => {
  let sync: PatchesSync | undefined;
  let patches: Patches | undefined;

  afterEach(async () => {
    sync?.disconnect();
    sync = undefined;
    await patches?.close();
    patches = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function boot() {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new RefusingStore();
    const algorithm = new OTAlgorithm(store);
    patches = new Patches({ algorithms: { ot: algorithm } });
    await patches.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: { text: '' }, rev: 0 });
    const server = makeServer();
    sync = new PatchesSync(patches, makeConnection({ commitChanges: server.commitChanges }) as any);
    sync['updateState']({ connected: true });
    const doc = (await patches.openDoc<{ text?: string; more?: string }>('doc1')) as OTDoc<{
      text?: string;
      more?: string;
    }>;
    return { store, algorithm, server, doc };
  }

  it('sends the refused change from memory after the latch and confirms it on the echo, once', async () => {
    const { store, server, doc } = await boot();
    vi.useFakeTimers();

    doc.change(patch => patch.replace('/text', 'hello'));
    await vi.advanceTimersByTimeAsync(3000); // three refused persists → latch → outbox → flush

    expect(patches!.isWriteLatched('doc1')).toBe(true);
    expect(server.commitChanges).toHaveBeenCalledTimes(1);
    const [, sent] = server.commitChanges.mock.calls[0];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ baseRev: 0, ops: [{ op: 'replace', path: '/text', value: 'hello' }] });

    // The echo confirmed the memory-only entry: state holds the text exactly once and the doc is clean.
    expect(doc.state).toEqual({ text: 'hello' });
    expect(doc.committedRev).toBe(1);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(patches!.listUnstoredChanges('doc1')).toEqual([]);
    expect(await store.getPendingChanges('doc1')).toEqual([]);
    expect(await store.getCommittedRev('doc1')).toBe(1);
    expect(sync!.docStates.state['doc1'].hasPending).toBe(false);
  });

  it('keeps sending while latched: later typing goes out too, and a recovered store has nothing left to re-drive', async () => {
    const { store, server, doc } = await boot();
    vi.useFakeTimers();

    doc.change(patch => patch.replace('/text', 'hello'));
    await vi.advanceTimersByTimeAsync(3000);
    doc.change(patch => patch.add('/more', 'world')); // typed while latched
    await vi.advanceTimersByTimeAsync(0);

    expect(server.commitChanges).toHaveBeenCalledTimes(2);
    expect(server.committed.map(c => c.ops[0].path)).toEqual(['/text', '/more']);
    expect(doc.state).toEqual({ text: 'hello', more: 'world' });
    expect(doc.committedRev).toBe(2);

    // The store comes back and the app retries: every entry was confirmed through the outbox,
    // so there is nothing to persist and nothing goes out again.
    store.refusePersists = false;
    vi.useRealTimers();
    await patches!.retrySavingChanges('doc1');
    expect(patches!.isWriteLatched('doc1')).toBe(false);
    expect(await store.getPendingChanges('doc1')).toEqual([]);
    expect(server.commitChanges).toHaveBeenCalledTimes(2);
    expect(server.committed).toHaveLength(2);
    expect(doc.state).toEqual({ text: 'hello', more: 'world' });
  });

  it('rides behind the store queue in one batch, so the server never transforms it against its own predecessor', async () => {
    const { store, server, doc } = await boot();
    // The first change persists; the store breaks before the second.
    store.refusePersists = false;
    sync!['updateState']({ connected: false }); // hold the flush so both go in one batch
    doc.change(patch => patch.replace('/text', 'hel'));
    await doc.flush();
    store.refusePersists = true;
    vi.useFakeTimers();
    doc.change(patch => patch.replace('/text', 'hello'));
    await vi.advanceTimersByTimeAsync(3000); // latch → outbox (no send: offline)
    expect(server.commitChanges).not.toHaveBeenCalled();

    sync!['updateState']({ connected: true });
    await (sync as any).syncDoc('doc1');
    await vi.advanceTimersByTimeAsync(0);

    expect(server.commitChanges).toHaveBeenCalledTimes(1);
    const [, sent] = server.commitChanges.mock.calls[0];
    expect(sent.map((c: Change) => c.ops[0].value)).toEqual(['hel', 'hello']); // store row first, outbox row behind
    expect(sent.every((c: Change) => c.baseRev === 0)).toBe(true);
    expect(doc.state).toEqual({ text: 'hello' });
    expect(doc.committedRev).toBe(2);
    expect(patches!.listUnstoredChanges('doc1')).toEqual([]);
  });

  it('a store that refuses the response apply cannot keep the row queued: it is confirmed from the commit response and never resent (review round 2)', async () => {
    const { store, server, doc } = await boot();
    store.refuseApplies = true; // the disk refuses the echo as well as the persist
    vi.useFakeTimers();

    doc.change(patch => patch.replace('/text', 'hello'));
    await vi.advanceTimersByTimeAsync(3000);

    expect(server.committed).toHaveLength(1); // on the server
    expect(doc.committedRev).toBe(0); // the store could not take the response, so the doc is not advanced
    expect(doc.state).toEqual({ text: 'hello' }); // still visible from memory
    // But the row is NOT still queued: the response confirmed it before the apply that failed.
    expect(patches!.listUnstoredChanges('doc1')).toEqual([]);
    expect(doc.unstoredChangeIds).toHaveLength(1); // the doc keeps the entry until rev 1 covers it

    // Every later flush sends nothing for it — no resend loop leaning on the server's id dedupe.
    await (sync as any).syncDoc('doc1');
    await vi.advanceTimersByTimeAsync(0);
    expect(server.commitChanges).toHaveBeenCalledTimes(1);
    expect(server.committed).toHaveLength(1);

    // The disk recovers and the commit is re-delivered (a broadcast, a catch-up): the doc
    // confirms the entry exactly once.
    store.refuseApplies = false;
    await (sync as any)._applyServerChangesToDoc('doc1', server.committed);
    expect(doc.state).toEqual({ text: 'hello' });
    expect(doc.committedRev).toBe(1);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(await store.getCommittedRev('doc1')).toBe(1);
  });

  it('the response confirmation reports onUnstoredCommitted once, with the committed copies', async () => {
    const { server, doc } = await boot();
    const reported: { docId: string; changes: Change[] }[] = [];
    patches!.onUnstoredCommitted((docId, changes) => reported.push({ docId, changes }));
    vi.useFakeTimers();

    doc.change(patch => patch.replace('/text', 'hello'));
    await vi.advanceTimersByTimeAsync(3000);

    expect(reported).toHaveLength(1);
    expect(reported[0].docId).toBe('doc1');
    expect(reported[0].changes).toEqual(server.committed);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(doc.committedRev).toBe(1);
  });
});

/**
 * Round 3: the same flush path against the REAL OTServer (in-memory backend), so the server's
 * own transform set decides where a later edit lands. Two shapes the deduping mock above cannot
 * distinguish: a confirmed row dropped from the batch while the doc's frame is still below its
 * rev (the server then transforms the next edit against the row's committed copy), and a row
 * frozen at an old frame over a pending row that flushes first (transformed against that row's
 * committed copy as well).
 */
describe('PatchesSync — outbox rows against the real OTServer (review round 3)', () => {
  let sync: PatchesSync | undefined;
  let patches: Patches | undefined;

  afterEach(async () => {
    sync?.destroy();
    sync = undefined;
    await patches?.close();
    patches = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const serverState = (backend: OTFuzzBackend) =>
    applyChanges<{ items: string[] }>(null as unknown as { items: string[] }, backend.log('doc1'));
  /** The wire: the server sees copies, never the client's own objects. */
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

  async function bootReal(items: string[], serverOptions?: OTServerOptions) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const backend = new OTFuzzBackend();
    const server = new OTServer(backend, serverOptions);
    // Doc at rev 1 on the server and in the store.
    await server.commitChanges('doc1', [
      createChange(0, 1, [{ op: 'replace', path: '', value: { items } }], {}, 'init'),
    ]);
    const store = new RefusingStore();
    const algorithm = new OTAlgorithm(store);
    patches = new Patches({ algorithms: { ot: algorithm } });
    await patches.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: { items }, rev: 1 });
    const batches: Change[][] = [];
    /**
     * Run while the server-side span fetch is in flight (the round-4 tests) or after the server
     * committed a batch, before the client sees the response (the capped-reload test).
     */
    const hooks: { duringFetch?: () => Promise<void>; duringCommit?: () => Promise<void> } = {};
    const connection = makeConnection({
      commitChanges: vi.fn(async (docId: string, changes: Change[]) => {
        batches.push(wire(changes));
        const result = wire(await server.commitChanges(docId, wire(changes)));
        await hooks.duringCommit?.();
        return result;
      }),
      getChangesSince: vi.fn(async (docId: string, rev: number) => {
        await hooks.duringFetch?.();
        return wire(await server.getChangesSince(docId, rev));
      }),
      getDoc: vi.fn(async (docId: string) => JSON.parse(await new Response(await server.getDoc(docId)).text())),
    });
    sync = new PatchesSync(patches, connection as any);
    sync['updateState']({ connected: true });
    const reported: string[][] = [];
    patches.onUnstoredCommitted((_docId, changes) => reported.push(changes.map(c => c.id)));
    const errors: Error[] = [];
    sync.onError(err => errors.push(err));
    const doc = (await patches.openDoc<{ items: string[] }>('doc1')) as OTDoc<{ items: string[] }>;
    return { store, algorithm, server, backend, connection, doc, batches, reported, errors, hooks };
  }

  it('a confirmed row stays in the batch as a stub until the doc covers its rev: a later edit minted over it is not transformed against it', async () => {
    const { store, algorithm, backend, doc, batches, reported } = await bootReal(['a']);
    store.refuseApplies = true; // the store refuses the response's apply as well as the persist
    vi.useFakeTimers();

    // u goes out at baseRev 1 and commits at 2; the store refuses the apply, so the doc stays at
    // 1 with u still in its optimistic queue.
    doc.change(patch => patch.add('/items/0', 'u'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(serverState(backend).items).toEqual(['u', 'a']);
    expect(doc.committedRev).toBe(1);
    expect(doc.state.items).toEqual(['u', 'a']);
    expect(reported).toEqual([[batches[0][0].id]]);
    expect(patches!.listUnstoredChanges('doc1')).toEqual([]); // confirmed: not listed as unsaved
    expect(await algorithm.hasPending('doc1')).toBe(false);

    // v is minted on top of u (the user sees u, v, a). Sent alone at 1 the server would
    // transform it against u's committed copy and commit /items/2: server u, a, v.
    doc.change(patch => patch.add('/items/1', 'v'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(doc.state.items).toEqual(['u', 'v', 'a']);
    expect(serverState(backend).items).toEqual(['u', 'v', 'a']);

    // The batch that carried v carried the u stub ahead of it, both at the doc's frame; the
    // server deduped u by id and kept it out of v's transform set.
    const uId = batches[0][0].id;
    const withV = batches.find(b => b.some(c => c.ops[0].value === 'v'))!;
    expect(withV.map(c => [c.id, c.baseRev, c.ops[0].path])).toEqual([
      [uId, 1, '/items/0'],
      [withV[1].id, 1, '/items/1'],
    ]);
    // Each row reported once, from the response.
    expect(reported).toEqual([[uId], [withV[1].id]]);

    // The store recovers and the commits are re-delivered: the doc converges to the server's
    // order (which is its own), the entries and the stubs retire, nothing applies twice.
    store.refuseApplies = false;
    vi.useRealTimers();
    await (sync as any)._applyServerChangesToDoc('doc1', wire(backend.log('doc1').filter(c => c.rev > 1)));
    expect(doc.committedRev).toBe(3);
    expect(doc.state.items).toEqual(['u', 'v', 'a']);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(algorithm['_outbox'].has('doc1')).toBe(false);
    expect(reported).toHaveLength(2);
    expect(await store.getCommittedRev('doc1')).toBe(3);
  });

  it('a stub alone is not a batch: nothing goes out for a doc whose only outbox rows are confirmed', async () => {
    const { store, backend, doc, batches } = await bootReal(['a']);
    store.refuseApplies = true;
    vi.useFakeTimers();
    doc.change(patch => patch.add('/items/0', 'u'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(serverState(backend).items).toEqual(['u', 'a']);
    const sent = batches.length;
    await (sync as any).syncDoc('doc1');
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(sent);
  });

  /**
   * Doc at 1 with [a, b]; P (at `p`, default /items/0) persisted; the outbox row u (at `u`,
   * default /items/1) over it (p, u, a, b); foreign Z (at `z`, default appended) at 2 and Y
   * appended at 3; the store takes Z torn (the doc stays at 1); on the Y receive the store's
   * listChanges throws (`storeSpan: 'unreadable'`, the default) or reads the span. Frozen at 1,
   * u would be a straggler: flush one sends P alone at 3, flush two sends u alone at 1 and the
   * server transforms it against P's committed copy as well — p, a, u, b, Z, Y.
   */
  async function tornOverPending(
    paths: { p?: string; u?: string; z?: string } = {},
    storeSpan: 'unreadable' | 'readable' = 'unreadable'
  ) {
    const { p = '/items/0', u = '/items/1', z = '/items/-' } = paths;
    const booted = await bootReal(['a', 'b']);
    const { store, algorithm, server, doc } = booted;
    sync!['updateState']({ connected: false });
    store.refusePersists = false;
    doc.change(patch => patch.add(p, 'p'));
    await doc.flush();
    expect(await store.getPendingChanges('doc1')).toHaveLength(1);
    store.refusePersists = true;
    vi.useFakeTimers();
    doc.change(patch => patch.add(u, 'u'));
    await vi.advanceTimersByTimeAsync(3000); // latch → outbox (offline: no send)
    vi.useRealTimers();
    expect(doc.unstoredChangeIds).toHaveLength(1);
    const uId = doc.unstoredChangeIds[0];

    const [Z] = (
      await server.commitChanges('doc1', [createChange(1, 2, [{ op: 'add', path: z, value: 'Z' }], {}, 'Z')])
    ).changes;
    const [Y] = (
      await server.commitChanges('doc1', [createChange(2, 3, [{ op: 'add', path: '/items/-', value: 'Y' }], {}, 'Y')])
    ).changes;
    await algorithm.applyServerChanges('doc1', [wire(Z)], undefined); // the store took Z; the doc did not
    expect(doc.committedRev).toBe(1);
    expect(await store.getCommittedRev('doc1')).toBe(2);
    if (storeSpan === 'unreadable') {
      vi.spyOn(store, 'listChanges').mockRejectedValue(new Error('[changes] did not settle within 5021ms'));
    }
    return { ...booted, uId, Y: wire(Y) };
  }

  /**
   * Type on the latched doc and wait for the change queue to hand the entry to the outbox (no
   * persist: the latch skips it; `doc.flush()` would spin, the optimistic queue never drains).
   */
  async function typeLatched(doc: OTDoc<{ items: string[] }>, path: string, value: string): Promise<string> {
    const before = new Set(doc.unstoredChangeIds);
    doc.change(patch => patch.add(path, value));
    await patches!['_changeQueues'].get('doc1');
    const id = doc.unstoredChangeIds.find(candidate => !before.has(candidate));
    expect(id).toBeDefined();
    return id!;
  }

  it('a row over a pending row whose span the store cannot read is walked with the span from the server, never frozen: it flushes in one batch with the pending row', async () => {
    const { store, backend, doc, batches, errors, uId, Y } = await tornOverPending();
    sync!['updateState']({ connected: true });
    await (sync as any)._applyServerChangesToDoc('doc1', [Y]);
    expect(doc.committedRev).toBe(3);
    expect(doc.state.items).toEqual(['p', 'u', 'a', 'b', 'Z', 'Y']);

    await (sync as any).syncDoc('doc1');
    // Frozen at 1, u would go alone after P and land at /items/2: p, a, u, b, Z, Y.
    expect(serverState(backend).items).toEqual(['p', 'u', 'a', 'b', 'Z', 'Y']);
    expect(doc.state.items).toEqual(['p', 'u', 'a', 'b', 'Z', 'Y']);
    // Not frozen: walked into the doc's frame with the span the server supplied, so it went in
    // one batch with P at the doc's frame.
    expect(batches).toHaveLength(1);
    expect(batches[0].map(c => [c.id, c.baseRev, c.ops[0].path])).toEqual([
      [batches[0][0].id, 3, '/items/0'],
      [uId, 3, '/items/1'],
    ]);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(await store.getPendingChanges('doc1')).toEqual([]);
    expect(errors).toEqual([]);
  });

  /**
   * Round 4: P = add /items/1 (a, p, b), u = add /items/2 behind it (a, p, u, b), Z = add
   * /items/0 at 2, Y appended at 3, the store takes Z torn, listChanges throws, no fetcher.
   * Left in the doc, u's frame-1 entry is re-applied RAW at 3 by the import (Z, a, u, p, b, Y —
   * u ahead of the P it was typed behind), and the latch's recovery, retrySavingChanges,
   * re-drives it at the doc's new committedRev with those ops: the server commits Z, a, u, p,
   * b, Y where the walk would have put u after p. So the refused entry leaves the doc too.
   */
  it('with no way to read the span (offline), the row is refused and reported rather than frozen: it leaves the doc and is never sent, not even by retrySavingChanges', async () => {
    const { store, algorithm, backend, doc, batches, errors, uId, Y } = await tornOverPending({
      p: '/items/1',
      u: '/items/2',
      z: '/items/0',
    });
    expect(doc.state.items).toEqual(['a', 'p', 'u', 'b']);
    // Offline for the receive: the server cannot be asked either.
    await (sync as any)._applyServerChangesToDoc('doc1', [Y]);
    expect(doc.committedRev).toBe(3);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnstoredFrameLostError);
    expect(errors[0]).toMatchObject({
      docId: 'doc1',
      fromRev: 1,
      toRev: 3,
      changes: [expect.objectContaining({ id: uId, baseRev: 1, ops: [{ op: 'add', path: '/items/2', value: 'u' }] })],
    });
    expect(algorithm.listUnstoredChanges('doc1')).toEqual([]);
    expect(doc.unstoredChangeIds).toEqual([]);
    // The doc no longer shows u (the shelf has it); P was walked into the new frame.
    expect(doc.state.items).toEqual(['Z', 'a', 'p', 'b', 'Y']);
    expect(doc._getOptimisticEntries()).toEqual([]);

    sync!['updateState']({ connected: true });
    await (sync as any).syncDoc('doc1');
    expect(batches).toHaveLength(1);
    expect(batches[0].map(c => [c.id, c.baseRev, c.ops[0].path])).toEqual([[batches[0][0].id, 3, '/items/2']]); // P alone
    expect(doc.committedRev).toBe(4);
    expect(serverState(backend).items).toEqual(['Z', 'a', 'p', 'b', 'Y']);

    // The latch's normal recovery: the store is back, the app retries. Nothing is minted for u
    // — it is not re-driven relabelled at 4 with its frame-1 ops.
    store.refusePersists = false;
    await patches!.retrySavingChanges('doc1');
    await (sync as any).syncDoc('doc1');
    expect(batches).toHaveLength(1);
    expect(batches.flat().some(c => c.baseRev === 4 || c.ops.some(op => op.value === 'u'))).toBe(false);
    expect(doc.state.items).toEqual(['Z', 'a', 'p', 'b', 'Y']);
    expect(serverState(backend).items).toEqual(['Z', 'a', 'p', 'b', 'Y']);
    expect(backend.log('doc1').map(c => c.id)).not.toContain(uId);
  });

  /**
   * Round 4: a row queued while the span is in flight. On a latched doc every keystroke reaches
   * queueUnstoredChange through the change queue, so typing during the round trip is the normal
   * case. Captured before the await, w = add /items/2 (p, u, w, a, b) is not walked: the import
   * re-applies it raw at 3 and the batch carries P@3 /items/0, u@3 /items/2 (walked), w@3
   * /items/2 (raw) — the server commits w AHEAD of u (p, Z, w, u, a, b, Y), nothing on onError.
   *
   * The keystroke's `onChange` wake is held for the receive (a flush racing it reads the
   * store queue at 3 while the doc is still at 1, sends P alone and defers the rows; they then
   * go out re-minted from the doc at the frame P's echo leaves it on, in place — a split batch,
   * not a misplacement — but Jacob's assertion is the single batch after the receive).
   */
  it('a row queued while the span is fetched from the server is walked with the rest and stays behind the row it was typed after', async () => {
    const { backend, doc, batches, errors, uId, Y, hooks } = await tornOverPending({ z: '/items/0' });
    expect(doc.state.items).toEqual(['p', 'u', 'a', 'b']);
    let wId = '';
    hooks.duringFetch = async () => {
      wId = await typeLatched(doc, '/items/2', 'w');
      expect(doc.state.items).toEqual(['p', 'u', 'w', 'a', 'b']);
    };
    sync!['updateState']({ connected: true });
    const wake = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
    await (sync as any)._applyServerChangesToDoc('doc1', [Y]);
    wake.mockRestore();
    expect(wId).not.toBe('');
    expect(doc.committedRev).toBe(3);
    expect(doc.state.items).toEqual(['p', 'Z', 'u', 'w', 'a', 'b', 'Y']);

    await (sync as any).syncDoc('doc1');
    expect(batches).toHaveLength(1);
    expect(batches[0].map(c => [c.id, c.baseRev, c.ops[0].path])).toEqual([
      [batches[0][0].id, 3, '/items/0'],
      [uId, 3, '/items/2'],
      [wId, 3, '/items/3'], // walked, not raw
    ]);
    expect(serverState(backend).items).toEqual(['p', 'Z', 'u', 'w', 'a', 'b', 'Y']);
    expect(doc.state.items).toEqual(['p', 'Z', 'u', 'w', 'a', 'b', 'Y']);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("a row queued while the store's span read is pending is walked with the rest as well", async () => {
    const { store, backend, doc, batches, errors, uId, Y } = await tornOverPending({ z: '/items/0' }, 'readable');
    // The store can read the span this time; a row is typed while that read is pending.
    const read = store.listChanges.bind(store);
    let wId = '';
    vi.spyOn(store, 'listChanges').mockImplementation(async (docId, options) => {
      wId = await typeLatched(doc, '/items/2', 'w');
      return read(docId, options);
    });
    sync!['updateState']({ connected: true });
    const wake = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
    await (sync as any)._applyServerChangesToDoc('doc1', [Y]);
    wake.mockRestore();
    expect(wId).not.toBe('');
    expect(doc.committedRev).toBe(3);

    await (sync as any).syncDoc('doc1');
    expect(batches).toHaveLength(1);
    expect(batches[0].map(c => [c.id, c.baseRev, c.ops[0].path])).toEqual([
      [batches[0][0].id, 3, '/items/0'],
      [uId, 3, '/items/2'],
      [wId, 3, '/items/3'],
    ]);
    expect(serverState(backend).items).toEqual(['p', 'Z', 'u', 'w', 'a', 'b', 'Y']);
    expect(doc.state.items).toEqual(['p', 'Z', 'u', 'w', 'a', 'b', 'Y']);
    expect(errors).toEqual([]);
  });

  /**
   * DAB-1340: the reload a capped commit answers with (`docReloadRequired`) reads the committed
   * tail only when pending work sits beyond the confirmed batch. A row typed on the latched doc
   * while the batch was on the wire lives only in the outbox; unseen there, the reload skips the
   * reconcile that walks the row through the tail, the import re-applies it raw in the old frame
   * and it commits at the wrong index.
   */
  it('a capped reload walks an outbox row typed during the round trip through the tail it jumps over', async () => {
    // Doc at 1 with [a, b]: P persisted, u latched into the outbox (offline, nothing sent).
    const { store, backend, server, connection, doc, batches, errors, hooks } = await bootReal(['a', 'b'], {
      maxCatchupChanges: 1,
    });
    sync!['updateState']({ connected: false });
    store.refusePersists = false;
    doc.change(patch => patch.add('/items/0', 'p'));
    await doc.flush();
    store.refusePersists = true;
    vi.useFakeTimers();
    doc.change(patch => patch.add('/items/1', 'u'));
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    expect(doc.state.items).toEqual(['p', 'u', 'a', 'b']);
    // Two foreign rows since the client's frame: over the cap, so the commit answers a reload.
    await server.commitChanges('doc1', [createChange(1, 2, [{ op: 'add', path: '/items/1', value: 'Z' }], {}, 'Z')]);
    await server.commitChanges('doc1', [createChange(2, 3, [{ op: 'add', path: '/items/-', value: 'Y' }], {}, 'Y')]);

    // w is typed after b while [P, u] is on the wire: an outbox row over the batch, in its frame.
    let wId = '';
    hooks.duringCommit = async () => {
      wId = await typeLatched(doc, '/items/4', 'w');
    };
    sync!['updateState']({ connected: true });
    const wake = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
    await (sync as any).flushDoc('doc1');
    wake.mockRestore();
    expect(wId).not.toBe('');
    expect(batches).toHaveLength(1);
    expect(serverState(backend).items).toEqual(['p', 'u', 'a', 'Z', 'b', 'Y']);

    // The reload read the tail once, for w, and walked it through: w is still after b, in the
    // reloaded frame. (Unseen, the reload skips the read and w is re-applied at /items/4: before b.)
    const after = (items: string[], x: string, y: string) => items.indexOf(x) > items.indexOf(y);
    expect(connection.getChangesSince).toHaveBeenCalledTimes(1);
    expect(doc.committedRev).toBe(5);
    expect(after(doc.state.items, 'w', 'b')).toBe(true);

    // The next flush sends w in that frame. (One flush only: a row typed during a flush round
    // trip is re-minted on later flushes, with or without the cap — the outbox's, not the reload's.)
    await (sync as any).syncDoc('doc1');
    expect(batches).toHaveLength(2);
    expect(batches[1].map(c => c.baseRev)).toEqual([5]);
    expect(after(serverState(backend).items, 'w', 'b')).toBe(true);
    expect(errors).toEqual([]);
  });
});
