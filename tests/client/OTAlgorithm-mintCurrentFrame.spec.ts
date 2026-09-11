import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitChanges } from '../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { rebaseChanges } from '../../src/algorithms/ot/shared/rebaseChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { Patches } from '../../src/client/Patches';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';
import { DocFrameBehindStoreError } from '../../src/net/error';
import type { Change, PatchesSnapshot } from '../../src/types';
import { OTFuzzBackend } from '../fuzz/otFuzzBackend';

/**
 * DAB-1199: a mint stamps `baseRev` from the OPEN DOC's committedRev. The receive path writes
 * the store first and updates the doc after, so a doc-side apply failure leaves the doc a frame
 * behind the store while its state (and its still-pending copies of the rows the store just
 * committed) already include those changes. Every mint from that doc then carries a stale label:
 * "expressed on frame N" for ops built on top of rows committed as N+1..M. The server trusts it,
 * transforms the change against those rows — its own earlier commits from separate requests,
 * which it cannot recognise as echoes — and commits double-shifted ops: out of range (poison) or
 * silently misplaced. One tab did this for 103 commits in a row (DAB-1199).
 *
 * The fix holds the mint to the store's frame: `handleDocChange` first runs the receive the doc
 * missed (own echoes dropped untransformed, foreign rows walked through the pending queue and
 * the in-flight optimistic ops), then stamps. A doc whose local history cannot be replayed —
 * poison the floor has not neutered — refuses the mint and keeps the ops in memory, and Patches
 * latches the write path WITHOUT an outbox row (an outbox row is framed by the same stale
 * committedRev). All against the real transform machinery and server commit; no mocks.
 */

const TIMEOUT = 30 * 60_000;
const DOC_ID = 'doc1';

async function seedServer(backend: OTFuzzBackend, state: object): Promise<void> {
  await commitChanges(
    backend,
    DOC_ID,
    [{ id: 'seed', rev: 1, baseRev: 0, ops: [{ op: 'replace', path: '', value: state }], createdAt: 0 }],
    TIMEOUT
  );
}

/** A client whose store and open doc both sit at `rev` with `state`. */
async function openAt(state: object, rev: number) {
  const store = new OTInMemoryStore();
  const algorithm = new OTAlgorithm(store);
  await store.trackDocs([DOC_ID]);
  await store.saveDoc(DOC_ID, { state, rev });
  const doc = algorithm.createDoc<any>(DOC_ID, (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>) as OTDoc<any>;
  return { store, algorithm, doc };
}

/** What `doc.change()` + Patches do: apply optimistically, then mint the same ops array. */
async function mint(algorithm: OTAlgorithm, doc: OTDoc<any>, ops: JSONPatchOp[]): Promise<Change[]> {
  doc._applyOptimistic(ops);
  return algorithm.handleDocChange(DOC_ID, ops, doc, {});
}

/** Commit the doc's sendable queue on the server (clone = the wire); returns the committed rows. */
async function commitQueue(algorithm: OTAlgorithm, backend: OTFuzzBackend, doc: OTDoc<any>): Promise<Change[]> {
  const batch = await algorithm.getPendingToSend(DOC_ID, doc);
  if (!batch) return [];
  const { catchupChanges, newChanges } = await commitChanges(backend, DOC_ID, structuredClone(batch), TIMEOUT);
  return [...catchupChanges, ...newChanges].sort((a, b) => a.rev - b.rev);
}

/** A commit from another client landing on the server. */
async function commitForeign(backend: OTFuzzBackend, id: string, baseRev: number, ops: JSONPatchOp[]): Promise<Change> {
  const { newChanges } = await commitChanges(
    backend,
    DOC_ID,
    [createChange(baseRev, baseRev + 1, ops, {}, id)],
    TIMEOUT
  );
  return newChanges[0];
}

/**
 * The receive the doc misses: the store takes the committed rows (rebasing its queue, dropping
 * its own echoes) exactly as `applyServerChanges` writes it — but the open doc is never told.
 * This is the split a doc-side apply failure leaves behind.
 */
async function storeOnlyReceive(store: OTInMemoryStore, committed: Change[]): Promise<void> {
  const pending = await store.getPendingChanges(DOC_ID);
  const tailRev = pending[pending.length - 1]?.rev;
  await store.applyServerChanges(DOC_ID, committed, rebaseChanges(committed, pending), tailRev);
}

/** The server's head under STRICT replay — throws on poison. */
function strictHead(backend: OTFuzzBackend): any {
  return applyChanges(null as any, backend.log(DOC_ID));
}

describe('a mint is stamped on the store frame, not a doc frame the store has moved past', () => {
  it('DAB-1199: the doc missed its own echo — the mint applies it (no transform) and lands where it was built', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend, { items: ['a'] });
    const { store, algorithm, doc } = await openAt({ items: ['a'] }, 1);

    // Insert 'p' and flush it. The store takes the echo (rev 2); the doc does not.
    await mint(algorithm, doc, [{ op: 'add', path: '/items/1', value: 'p' }]);
    await storeOnlyReceive(store, await commitQueue(algorithm, backend, doc));
    expect(await store.getCommittedRev(DOC_ID)).toBe(2);
    expect(doc.committedRev).toBe(1);
    expect(doc.state).toEqual({ items: ['a', 'p'] });

    // The next edit removes 'p' — index 1 in a view that already includes rev 2.
    const [minted] = await mint(algorithm, doc, [{ op: 'remove', path: '/items/1' }]);

    // Labeled 1, the server would have transformed this remove against rev 2 — the add it was
    // built on — into `remove /items/2`: out of range on ['a','p'], committed as poison.
    expect(doc.committedRev).toBe(2);
    expect(minted.baseRev).toBe(2);
    expect(minted.ops).toEqual([{ op: 'remove', path: '/items/1' }]);
    expect(doc.state).toEqual({ items: ['a'] });

    const sent = await algorithm.getPendingToSend(DOC_ID, doc);
    expect(sent!.map(c => [c.id, c.baseRev])).toEqual([[minted.id, 2]]);
    await algorithm.applyServerChanges(DOC_ID, await commitQueue(algorithm, backend, doc), doc);

    const log = backend.log(DOC_ID);
    expect(log.map(c => c.rev)).toEqual([1, 2, 3]);
    expect(log[2].ops).toEqual([{ op: 'remove', path: '/items/1' }]);
    expect(strictHead(backend)).toEqual({ items: ['a'] });
    expect(doc.state).toEqual({ items: ['a'] });
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
  });

  it('the doc missed a foreign span — the in-flight ops are walked through it and labeled on the new frame', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend, { items: ['a', 'b', 'c'] });
    const { store, algorithm, doc } = await openAt({ items: ['a', 'b', 'c'] }, 1);
    const f2 = await commitForeign(backend, 'f2', 1, [{ op: 'remove', path: '/items/0' }]);
    const f3 = await commitForeign(backend, 'f3', 2, [{ op: 'remove', path: '/items/0' }]);
    await storeOnlyReceive(store, [f2, f3]);
    expect(await store.getCommittedRev(DOC_ID)).toBe(3);
    expect(doc.state).toEqual({ items: ['a', 'b', 'c'] });

    // An append in the doc's three-item view.
    const [minted] = await mint(algorithm, doc, [{ op: 'add', path: '/items/3', value: 'M' }]);

    // Transformed across the two removes the doc had not seen, and the view is current at once
    // (the old path left the doc showing ['a','b','c','M'] and shipped `add /items/3` at rev 1).
    expect(doc.committedRev).toBe(3);
    expect(minted.baseRev).toBe(3);
    expect(minted.ops).toEqual([{ op: 'add', path: '/items/1', value: 'M' }]);
    expect(doc.state).toEqual({ items: ['c', 'M'] });

    await algorithm.applyServerChanges(DOC_ID, await commitQueue(algorithm, backend, doc), doc);
    expect(strictHead(backend)).toEqual({ items: ['c', 'M'] });
    expect(doc.state).toEqual({ items: ['c', 'M'] });
  });

  it('a mixed span — own echo then a foreign row — drops the echo and transforms only against the foreign row', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend, { items: ['a'] });
    const { store, algorithm, doc } = await openAt({ items: ['a'] }, 1);
    await mint(algorithm, doc, [{ op: 'add', path: '/items/1', value: 'p' }]);
    const echo = await commitQueue(algorithm, backend, doc); // rev 2, this doc's own
    const f3 = await commitForeign(backend, 'f3', 2, [{ op: 'add', path: '/items/0', value: 'z' }]); // rev 3
    await storeOnlyReceive(store, [...echo, f3]);
    expect(await store.getCommittedRev(DOC_ID)).toBe(3);
    expect(doc.committedRev).toBe(1);
    expect(doc.state).toEqual({ items: ['a', 'p'] });

    // Remove 'p': index 1 in the doc's view.
    const [minted] = await mint(algorithm, doc, [{ op: 'remove', path: '/items/1' }]);

    // Shifted once, by the foreign add at 0 — not a second time by its own echo. Labeled 1,
    // the server would have shifted it by both: `remove /items/3` on ['z','a','p'], poison.
    expect(doc.committedRev).toBe(3);
    expect(minted.baseRev).toBe(3);
    expect(minted.ops).toEqual([{ op: 'remove', path: '/items/2' }]);
    expect(doc.state).toEqual({ items: ['z', 'a'] });

    await algorithm.applyServerChanges(DOC_ID, await commitQueue(algorithm, backend, doc), doc);
    expect(strictHead(backend)).toEqual({ items: ['z', 'a'] });
    expect(doc.state).toEqual({ items: ['z', 'a'] });
  });

  it('a span the store compacted into a snapshot rebuilds the doc from that snapshot instead', async () => {
    const { store, algorithm, doc } = await openAt({ items: ['a', 'b', 'c'] }, 1);
    // A snapshot install the doc missed: the store is at 3 with no rows to replay.
    await store.saveDoc(DOC_ID, { state: { items: ['c'] }, rev: 3 });
    expect(await store.getCommittedRev(DOC_ID)).toBe(3);
    expect(await store.listChanges(DOC_ID, { startAfter: 1 })).toEqual([]);

    const [minted] = await mint(algorithm, doc, [{ op: 'add', path: '/items/0', value: 'M' }]);

    expect(doc.committedRev).toBe(3);
    expect(minted.baseRev).toBe(3);
    expect(doc.state).toEqual({ items: ['M', 'c'] });
  });

  it('refuses the mint when the store holds a committed row the doc cannot apply, keeping the ops in memory', async () => {
    const { store, algorithm, doc } = await openAt({ items: ['a'] }, 1);
    // A committed row the floor has not neutered: strict replay of the local history throws.
    const poison: Change = {
      ...createChange(1, 2, [{ op: 'remove', path: '/items/5' }], {}, 'poison'),
      committedAt: Date.now(),
    };
    await store.applyServerChanges(DOC_ID, [poison], [], undefined);
    expect(await store.getCommittedRev(DOC_ID)).toBe(2);

    const ops: JSONPatchOp[] = [{ op: 'add', path: '/items/1', value: 'q' }];
    const err = await mint(algorithm, doc, ops).catch(e => e);

    expect(err).toBeInstanceOf(DocFrameBehindStoreError);
    expect(err.docId).toBe(DOC_ID);
    expect(err.docRev).toBe(1);
    expect(err.storeRev).toBe(2);
    expect(err.cause).toBeInstanceOf(Error);
    // No row went to the store with the stale label; the doc is untouched and still holds the
    // typed ops on screen for a later re-drive.
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
    expect(doc.committedRev).toBe(1);
    expect(doc.state).toEqual({ items: ['a', 'q'] });
    expect(doc._hasOptimisticEntry(ops)).toBe(true);
  });

  it('a refused catch-up leaves the retained ops untouched across attempts; once the floor clears, the re-drive shifts them exactly once', async () => {
    const { store, algorithm, doc } = await openAt({ items: ['a', 'b', 'c'] }, 1);
    // A foreign row ahead of the poison — the two-device shape the refusal exists for. The doc's
    // apply used to rebase the optimistic queue across the foreign row BEFORE the poison threw,
    // so every refused attempt shifted the retained ops one span further from the doc's view.
    const foreign: Change = {
      ...createChange(1, 2, [{ op: 'add', path: '/items/0', value: 'z' }], {}, 'f2'),
      committedAt: Date.now(),
    };
    const poison: Change = {
      ...createChange(2, 3, [{ op: 'remove', path: '/items/50' }], {}, 'poison'),
      committedAt: Date.now(),
    };
    await store.applyServerChanges(DOC_ID, [foreign, poison], [], undefined);
    expect(await store.getCommittedRev(DOC_ID)).toBe(3);

    const ops: JSONPatchOp[] = [{ op: 'add', path: '/items/3', value: 'M' }];
    doc._applyOptimistic(ops);
    // Two attempts on the same span, the way Patches retries before it latches.
    for (let attempt = 0; attempt < 2; attempt++) {
      const err = await algorithm.handleDocChange(DOC_ID, ops, doc, {}).catch(e => e);
      expect(err).toBeInstanceOf(DocFrameBehindStoreError);
      // Before the reorder: add /items/4 after one attempt, /items/5 after two, while the view
      // still showed M at index 3.
      expect(ops).toEqual([{ op: 'add', path: '/items/3', value: 'M' }]);
      expect(doc.committedRev).toBe(1);
      expect(doc.state).toEqual({ items: ['a', 'b', 'c', 'M'] });
    }
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);

    // The floor neuters the poison (an ops-less copy). The re-drive catches the doc up and mints
    // the op shifted exactly once, by the foreign row.
    (store as any).docs.get(DOC_ID).committed.find((c: Change) => c.id === 'poison').ops = [];
    const [minted] = await algorithm.handleDocChange(DOC_ID, ops, doc, {});
    expect(doc.committedRev).toBe(3);
    expect(minted.baseRev).toBe(3);
    expect(minted.ops).toEqual([{ op: 'add', path: '/items/4', value: 'M' }]);
    expect(doc.state).toEqual({ items: ['z', 'a', 'b', 'c', 'M'] });
  });
});

describe('the catch-up rebuild handles a live outbox row the way the misaligned receive does', () => {
  it('walks the row through the span before the import, so the re-drive mints it in the new frame', async () => {
    const { store, algorithm, doc } = await openAt({ items: ['a'] }, 5);
    const typed = (path: string, value: string): JSONPatchOp[] => {
      let emitted: JSONPatchOp[] = [];
      const off = doc.onChange(ops => (emitted = ops));
      doc.change(patch => patch.add(path, value));
      off();
      return emitted;
    };
    // P (add /x) is pending in the store and the doc; the store-refused row u = add /items/1 is
    // expressed over it and waits in the outbox.
    await algorithm.handleDocChange(DOC_ID, typed('/x', 'p'), doc, {}, 'P');
    const refusedOps = typed('/items/1', 'u');
    expect(algorithm.queueUnstoredChange(DOC_ID, refusedOps, doc, {}, 'refused')).toMatchObject({
      id: 'refused',
      baseRev: 5,
    });
    // The store took Z and `other` torn (the doc stays at 5). It cannot read the span row by
    // row, so the catch-up has to rebuild from the snapshot; the server can supply the span.
    const Z: Change = { ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }], {}, 'Z'), committedAt: 1 };
    const other: Change = {
      ...createChange(6, 7, [{ op: 'add', path: '/other', value: 1 }], {}, 'other'),
      committedAt: 1,
    };
    await algorithm.applyServerChanges(DOC_ID, [Z, other], undefined);
    expect(await store.getCommittedRev(DOC_ID)).toBe(7);
    expect(doc.committedRev).toBe(5);
    const real = store.listChanges.bind(store);
    vi.spyOn(store, 'listChanges').mockImplementation(async (docId, opts) =>
      (await real(docId, opts)).filter(c => c.rev !== 6)
    );
    const fetch = vi.fn(async () => [Z, other]);
    algorithm.setCommittedSpanFetcher(fetch);

    // retrySavingChanges re-drives the refused entry under its stable id; the mint catches the
    // doc up first.
    const [minted] = await algorithm.handleDocChange(DOC_ID, refusedOps, doc, {}, 'refused');

    expect(fetch).toHaveBeenCalledWith(DOC_ID, 5, 7);
    expect(doc.committedRev).toBe(7);
    // Walked across Z before the import re-applied it (u's slot moved from 1 to 2) and minted on
    // the new frame with those ops — not re-applied raw at /items/1 and re-minted there, which
    // would land u ahead of a on every other client.
    expect(minted).toMatchObject({ id: 'refused', baseRev: 7, ops: [{ op: 'add', path: '/items/2', value: 'u' }] });
    expect(doc.state).toEqual({ items: ['Z', 'a', 'u'], x: 'p', other: 1 });
    // The store took it, so the outbox copy is retired.
    expect(algorithm.hasUnstoredChanges(DOC_ID)).toBe(false);
    expect((await store.getPendingChanges(DOC_ID)).map(c => [c.id, c.baseRev])).toEqual([
      ['P', 7],
      ['refused', 7],
    ]);
  });
});

describe('Patches: a doc that cannot be caught up latches its write path without an outbox row', () => {
  let patches: InstanceType<typeof Patches>;

  afterEach(async () => {
    vi.useRealTimers();
    await patches.close();
    vi.restoreAllMocks();
  });

  it('keeps the change memory-only, reports it, and does the same for changes typed while latched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new OTInMemoryStore();
    patches = new Patches({ algorithms: { ot: new OTAlgorithm(store) } });
    await store.saveDoc(DOC_ID, { state: { items: ['a'] }, rev: 1 });
    const doc = await patches.openDoc<{ items: string[] }>(DOC_ID);
    expect(doc.state).toEqual({ items: ['a'] });

    // The store takes a poison row the doc never applied.
    const poison: Change = {
      ...createChange(1, 2, [{ op: 'remove', path: '/items/5' }], {}, 'poison'),
      committedAt: Date.now(),
    };
    await store.applyServerChanges(DOC_ID, [poison], [], undefined);

    vi.useFakeTimers();
    const errors: { error: Error; context?: any }[] = [];
    patches.onError((error, context) => {
      errors.push({ error, context });
    });

    doc.change(patch => patch.add('/items/1', 'q'));
    await vi.advanceTimersByTimeAsync(0); // attempt 0
    await vi.advanceTimersByTimeAsync(1000); // attempt 1
    await vi.advanceTimersByTimeAsync(2000); // attempt 2 → exhausted → latched

    expect(errors.map(e => e.error.name)).toEqual(Array(3).fill('DocFrameBehindStoreError'));
    expect(errors[2].context).toEqual({
      docId: DOC_ID,
      willRetry: false,
      kind: 'environment',
      attempt: 2,
      unstored: false,
    });
    expect(patches.isWriteLatched(DOC_ID)).toBe(true);
    // Nothing persisted with the stale label, nothing in the outbox to go out with it either;
    // the typed text is still on screen.
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
    expect(patches.listUnstoredChanges(DOC_ID)).toEqual([]);
    expect(doc.state).toEqual({ items: ['a', 'q'] });

    // A change typed while latched is reported the same way and stays out of the outbox too.
    doc.change(patch => patch.add('/items/2', 'r'));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(4);
    expect(errors[3].context).toEqual({
      docId: DOC_ID,
      willRetry: false,
      kind: 'environment',
      latched: true,
      unstored: false,
    });
    expect(patches.listUnstoredChanges(DOC_ID)).toEqual([]);
    expect(doc.state).toEqual({ items: ['a', 'q', 'r'] });
  });
});
