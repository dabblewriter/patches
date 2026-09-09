/**
 * End to end for storage hardening A1: a change whose persist the store keeps refusing is latched
 * in memory — and, with the outbox, still reaches the server on the next flush, behind whatever
 * the store holds, under the same stable id the persist used. Its committed echo confirms it in
 * the open doc exactly once. Nothing here writes the refused change to the store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import type { OTDoc } from '../../src/client/OTDoc.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change } from '../../src/types.js';
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
