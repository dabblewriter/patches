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
import { OTServer } from '../../src/server/OTServer.js';
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

  async function bootReal(items: string[]) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const backend = new OTFuzzBackend();
    const server = new OTServer(backend);
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
    const connection = makeConnection({
      commitChanges: vi.fn(async (docId: string, changes: Change[]) => {
        batches.push(wire(changes));
        return wire(await server.commitChanges(docId, wire(changes)));
      }),
      getChangesSince: vi.fn(async (docId: string, rev: number) => wire(await server.getChangesSince(docId, rev))),
    });
    sync = new PatchesSync(patches, connection as any);
    sync['updateState']({ connected: true });
    const reported: string[][] = [];
    patches.onUnstoredCommitted((_docId, changes) => reported.push(changes.map(c => c.id)));
    const errors: Error[] = [];
    sync.onError(err => errors.push(err));
    const doc = (await patches.openDoc<{ items: string[] }>('doc1')) as OTDoc<{ items: string[] }>;
    return { store, algorithm, server, backend, doc, batches, reported, errors };
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
   * Doc at 1 with [a, b]; P = add /items/0 persisted; the outbox row u = add /items/1 over it
   * (p, u, a, b); foreign Z and Y append at the end; the store takes Z torn (the doc stays at
   * 1); listChanges throws on the Y receive. Frozen at 1, u would be a straggler: flush one
   * sends P alone at 3, flush two sends u alone at 1 and the server transforms it against P's
   * committed copy as well — p, a, u, b, Z, Y.
   */
  async function tornOverPending() {
    const booted = await bootReal(['a', 'b']);
    const { store, algorithm, server, doc } = booted;
    sync!['updateState']({ connected: false });
    store.refusePersists = false;
    doc.change(patch => patch.add('/items/0', 'p'));
    await doc.flush();
    expect(await store.getPendingChanges('doc1')).toHaveLength(1);
    store.refusePersists = true;
    vi.useFakeTimers();
    doc.change(patch => patch.add('/items/1', 'u'));
    await vi.advanceTimersByTimeAsync(3000); // latch → outbox (offline: no send)
    vi.useRealTimers();
    expect(doc.state.items).toEqual(['p', 'u', 'a', 'b']);
    expect(doc.unstoredChangeIds).toHaveLength(1);
    const uId = doc.unstoredChangeIds[0];

    const [Z] = (
      await server.commitChanges('doc1', [createChange(1, 2, [{ op: 'add', path: '/items/-', value: 'Z' }], {}, 'Z')])
    ).changes;
    const [Y] = (
      await server.commitChanges('doc1', [createChange(2, 3, [{ op: 'add', path: '/items/-', value: 'Y' }], {}, 'Y')])
    ).changes;
    await algorithm.applyServerChanges('doc1', [wire(Z)], undefined); // the store took Z; the doc did not
    expect(doc.committedRev).toBe(1);
    expect(await store.getCommittedRev('doc1')).toBe(2);
    vi.spyOn(store, 'listChanges').mockRejectedValue(new Error('[changes] did not settle within 5021ms'));
    return { ...booted, uId, Y: wire(Y) };
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

  it('with no way to read the span (offline), the row is refused and reported rather than frozen: it is never sent alone', async () => {
    const { algorithm, backend, doc, batches, errors, uId, Y } = await tornOverPending();
    // Offline for the receive: the server cannot be asked either.
    await (sync as any)._applyServerChangesToDoc('doc1', [Y]);
    expect(doc.committedRev).toBe(3);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnstoredFrameLostError);
    expect(errors[0]).toMatchObject({
      docId: 'doc1',
      fromRev: 1,
      toRev: 3,
      changes: [expect.objectContaining({ id: uId, baseRev: 1, ops: [{ op: 'add', path: '/items/1', value: 'u' }] })],
    });
    expect(algorithm.listUnstoredChanges('doc1')).toEqual([]);
    expect(doc.unstoredChangeIds).toEqual([]); // an ordinary optimistic entry from here
    expect(doc.state.items).toContain('u'); // still visible; the app shelves it

    sync!['updateState']({ connected: true });
    await (sync as any).syncDoc('doc1');
    expect(batches).toHaveLength(1);
    expect(batches[0].map(c => c.id)).not.toContain(uId); // P alone; u is not sent at a frame it is not in
    expect(serverState(backend).items).toEqual(['p', 'a', 'b', 'Z', 'Y']);
    expect(backend.log('doc1').map(c => c.id)).not.toContain(uId);
  });
});
