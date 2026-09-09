import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { PendingDeferredError, UnstoredFrameLostError, UnstoredOutboxOverflowError } from '../../src/net/error';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';

/**
 * The outbox (storage hardening A1): a change the store REFUSED — its persist exhausted the
 * bounded retries — is sent from memory instead of sitting in the tab until it closes. This
 * reverses the send path's store-authoritative rule on purpose and only for that case: a change
 * the store never accepted has no store row to conflict with and no rebased copy to duplicate.
 *
 * Invariants pinned here:
 *   - rows ride BEHIND the store queue, in one batch: a live row re-minted from the doc's pointers
 *     at send time (baseRev = committedRev now), a frozen row at its OWN baseRev — never
 *     relabeled — and walked forward through every committed batch that extends its frame;
 *   - a row leaves when its echo arrives (applyServerChanges), when the server resolves it away
 *     (dropResolvedPending), or when the store takes it after all (handleDocChange, same id);
 *   - the doc drops its memory-only entry on each of those paths, so nothing applies twice.
 */
describe('OTAlgorithm outbox (store-refused changes sent from memory)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;
  let doc: OTDoc<any>;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: { items: ['a'] }, rev: 5 });
    doc = algorithm.createDoc('doc1', { state: { items: ['a'] }, rev: 5, changes: [] }) as unknown as OTDoc<any>;
  });

  /** Type through the doc (taking an optimistic slot) and return the emitted ops array. */
  function type(value: string): any[] {
    let emitted: any[] = [];
    const off = doc.onChange(ops => (emitted = ops));
    doc.change(patch => patch.add('/items/-', value));
    off();
    return emitted;
  }

  it('queues a refused change and sends it behind the store queue, re-minted from the doc', async () => {
    // A row the store DID take, ahead in the queue.
    const storedOps = type('s');
    await algorithm.handleDocChange('doc1', storedOps, doc, {}, 'stored');
    const refusedOps = type('u');

    const queued = algorithm.queueUnstoredChange('doc1', refusedOps, doc, { author: 'me' }, 'refused');
    expect(queued).toMatchObject({ id: 'refused', baseRev: 5, rev: 7, author: 'me' });
    expect(doc.unstoredChangeIds).toEqual(['refused']);
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(true);
    expect(await algorithm.hasPending('doc1')).toBe(true);

    const batch = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(batch.map(c => c.id)).toEqual(['stored', 'refused']);
    expect(batch[1]).toMatchObject({ baseRev: 5, rev: 7, ops: [{ op: 'add', path: '/items/-', value: 'u' }] });
    expect(batch[1].ops).not.toBe(refusedOps); // a copy goes on the wire; the live array stays the doc's
    expect(batch[1].createdAt).toBe(queued!.createdAt); // offline-session versioning keys on the mint time
    expect(await store.getPendingChanges('doc1')).toHaveLength(1); // nothing was written for it
  });

  it('re-mints at send time: a receive that moved the doc re-frames the row', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');

    // A foreign change lands: the doc rebases the live entry in place and advances committedRev.
    await algorithm.applyServerChanges(
      'doc1',
      [{ ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }]), committedAt: 1 }],
      doc
    );
    expect(doc.committedRev).toBe(6);

    const batch = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ id: 'refused', baseRev: 6, rev: 7 });
    expect(doc.unstoredChangeIds).toEqual(['refused']);
  });

  it('the committed echo confirms the row: it leaves the outbox, the doc drops its entry, onUnstoredCommitted fires', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    const committed = vi.fn();
    algorithm.onUnstoredCommitted(committed);

    const echo = {
      ...createChange(5, 6, [{ op: 'add', path: '/items/-', value: 'u' }], {}, 'refused'),
      committedAt: 1,
    };
    await algorithm.applyServerChanges('doc1', [echo], doc);

    expect(doc.state.items).toEqual(['a', 'u']); // once
    expect(doc.committedRev).toBe(6);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
    expect(await algorithm.hasPending('doc1')).toBe(false);
    expect(committed).toHaveBeenCalledWith('doc1', [echo]);
    expect(await algorithm.getPendingToSend('doc1', doc)).toBeNull();
  });

  it('a misaligned receive (rebuild from the store) drops the entry before the import so it is not re-applied', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    // The store is ahead of the doc (a torn earlier apply): rev 6 landed there but not in memory.
    await store.applyServerChanges(
      'doc1',
      [{ ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }]), committedAt: 1 }],
      [],
      5
    );
    const echo = {
      ...createChange(6, 7, [{ op: 'add', path: '/items/-', value: 'u' }], {}, 'refused'),
      committedAt: 1,
    };

    await algorithm.applyServerChanges('doc1', [echo], doc);

    expect(doc.committedRev).toBe(7);
    expect(doc.state.items).toEqual(['Z', 'a', 'u']); // from the rebuilt snapshot, not doubled
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
  });

  it('a row the server resolved away (unechoed) is dropped from the outbox and the doc', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    const [sent] = (await algorithm.getPendingToSend('doc1', doc))!;

    const dropped = await algorithm.dropResolvedPending('doc1', [sent], []);

    expect(dropped).toBe(1);
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect((doc as any)._optimisticOps).toEqual([]);
  });

  it('the store taking the row after all (same id) retires the outbox copy so it cannot go out twice', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');

    await algorithm.handleDocChange('doc1', refusedOps, doc, {}, 'refused'); // the retry re-drive

    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(doc.getPendingChanges().map(c => c.id)).toEqual(['refused']);
    const batch = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(batch.map(c => c.id)).toEqual(['refused']); // once, from the store
  });

  it('a queued id is not queued twice — a re-drive that fails again gets the row it already has', () => {
    const refusedOps = type('u');
    const first = algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    expect(first).not.toBeNull();
    expect(algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused')).toBe(first); // still unstored
    expect(algorithm.queueUnstoredChange('doc1', [], doc, {}, 'empty')).toBeNull();
    expect(algorithm.queueUnstoredChange('doc1', refusedOps, undefined, {}, 'no-doc')).toBeNull();
    expect(algorithm.listUnstoredChanges('doc1').map(c => c.id)).toEqual(['refused']);
  });

  it('refuses to queue an entry the doc no longer holds (confirmed through another path meanwhile)', () => {
    const gone = type('u');
    doc.applyChanges([createChange(5, 6, gone)]); // local confirm shifted it out of the optimistic queue
    expect(algorithm.queueUnstoredChange('doc1', gone, doc, {}, 'late')).toBeNull();
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
  });

  it('accepts rows minted by another context, deduped by id, and sends them beside the rows they were expressed over', async () => {
    // The follower expressed this row on top of the shared store's pending row P (frame 4).
    const stored = createChange(4, 6, [{ op: 'add', path: '/items/-', value: 'p' }], {}, 'stored');
    await store.savePendingChanges('doc1', [stored]);
    const foreign = createChange(4, 9, [{ op: 'add', path: '/items/-', value: 'f' }], {}, 'from-follower');
    expect(algorithm.acceptUnstoredChanges('doc1', [foreign, foreign])).toBe(1);
    expect(algorithm.acceptUnstoredChanges('doc1', [foreign])).toBe(0);

    // With P still pending: one batch, P first, the accepted row behind it at its own frame.
    const batch = (await algorithm.getPendingToSend('doc1'))!;
    expect(batch.map(c => c.id)).toEqual(['stored', 'from-follower']);
    expect(batch[1]).toMatchObject({ baseRev: 4, rev: 9, ops: foreign.ops });
    expect(batch[1].ops).not.toBe(foreign.ops);
  });

  it('walks an accepted row through a foreign commit that lands between the accept and the drain, behind P (review round 2)', async () => {
    // Store at 5 with [a, b]; pending P appends 'p'; the follower expressed F over P in frame 5:
    // insert at /items/1 (between a and b). No doc is open on this instance.
    await store.saveDoc('doc1', { state: { items: ['a', 'b'] }, rev: 5 });
    const p = createChange(5, 6, [{ op: 'add', path: '/items/-', value: 'p' }], {}, 'P');
    await store.savePendingChanges('doc1', [p]);
    const f = createChange(5, 7, [{ op: 'add', path: '/items/1', value: 'f' }], {}, 'F');
    expect(algorithm.acceptUnstoredChanges('doc1', [f])).toBe(1);

    // Foreign Z inserts at 0 and commits at 6 while P is still pending: the store rebases P; the
    // accepted row must cross Z the same way, behind P, or it is later sent in frame 5 under a
    // newer label and the server commits its /items/1 verbatim (Z, f, a, b, p).
    await algorithm.applyServerChanges(
      'doc1',
      [{ ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }]), committedAt: 1 }],
      undefined
    );
    let batch = (await algorithm.getPendingToSend('doc1'))!;
    expect(batch.map(c => c.id)).toEqual(['P', 'F']);
    expect(batch[1]).toMatchObject({ baseRev: 6, ops: [{ op: 'add', path: '/items/2', value: 'f' }] });

    // P commits at 7: its echo drops from the walk untransformed, so F comes out with P in frame
    // at the new tip and goes alone at ITS OWN baseRev 7 — the server has nothing left to
    // transform it against, and commits Z, a, f, b, p.
    await algorithm.applyServerChanges('doc1', [{ ...p, baseRev: 6, rev: 7, committedAt: 1 }], undefined);
    expect(await store.getPendingChanges('doc1')).toEqual([]);
    batch = (await algorithm.getPendingToSend('doc1'))!;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ id: 'F', baseRev: 7, ops: [{ op: 'add', path: '/items/2', value: 'f' }] });
  });

  it('a row frozen by closeDoc is walked through a foreign commit that lands with no doc open, and sent at its own baseRev (review round 2)', async () => {
    // Doc at 5 with [a, b]; the row inserts 'u' at /items/1. Close the doc: frozen at 5.
    await store.saveDoc('doc1', { state: { items: ['a', 'b'] }, rev: 5 });
    doc = algorithm.createDoc('doc1', { state: { items: ['a', 'b'] }, rev: 5, changes: [] }) as unknown as OTDoc<any>;
    let refusedOps: any[] = [];
    const off = doc.onChange(ops => (refusedOps = ops));
    doc.change(patch => patch.add('/items/1', 'u'));
    off();
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    algorithm.detachUnstoredChanges('doc1', doc);

    // Rev 6 (Z at 0) lands with no doc open.
    await algorithm.applyServerChanges(
      'doc1',
      [{ ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }]), committedAt: 1 }],
      undefined
    );

    // Not baseRev 6 with the frame-5 path (the server would commit Z, u, a, b): the row crossed
    // Z, so it goes at 6 WITH the path moved to /items/2 — Z, a, u, b everywhere.
    const [sent] = (await algorithm.getPendingToSend('doc1'))!;
    expect(sent).toMatchObject({ id: 'refused', baseRev: 6, ops: [{ op: 'add', path: '/items/2', value: 'u' }] });
    expect(algorithm.listUnstoredChanges('doc1')[0]).toMatchObject({ baseRev: 6 });
  });

  it('a frozen row whose ops transform away is dropped, not sent empty', async () => {
    let refusedOps: any[] = [];
    const off = doc.onChange(ops => (refusedOps = ops));
    doc.change(patch => patch.replace('/items/0', 'A'));
    off();
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    algorithm.detachUnstoredChanges('doc1', doc);
    await algorithm.applyServerChanges(
      'doc1',
      [{ ...createChange(5, 6, [{ op: 'remove', path: '/items' }]), committedAt: 1 }],
      undefined
    );
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
    expect(await algorithm.getPendingToSend('doc1')).toBeNull();
  });

  it('collectUnsyncedForDiscard includes outbox rows (content the user can still see)', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    const rows = await algorithm.collectUnsyncedForDiscard('doc1', doc);
    expect(rows.map(c => c.id)).toEqual(['refused']);
  });

  it('detaching a closing doc freezes its rows in the current frame; they still send', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    await algorithm.applyServerChanges(
      'doc1',
      [{ ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }]), committedAt: 1 }],
      doc
    );
    algorithm.detachUnstoredChanges('doc1', doc);

    const batch = (await algorithm.getPendingToSend('doc1'))!; // no open doc any more
    expect(batch[0]).toMatchObject({ id: 'refused', baseRev: 6, ops: [{ op: 'add', path: '/items/-', value: 'u' }] });
    // Frozen rows keep their frame, and their rev is the one they were minted with (6, after the
    // doc's tail at queue time) — not re-stamped from zero once no row has a doc.
    expect(algorithm.listUnstoredChanges('doc1')[0]).toMatchObject({ baseRev: 6, rev: 6 });
  });

  it('walks live rows through the committed tail before a rebuild-from-store import, so the ops go out in the new frame', async () => {
    // Doc at rev 5 with items [a]; an outbox row inserts at /items/1 (after a) in that frame.
    let refusedOps: any[] = [];
    const off = doc.onChange(ops => (refusedOps = ops));
    doc.change(patch => patch.add('/items/1', 'u'));
    off();
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    // A torn earlier apply: the store took rev 6 (an insert at 0) that memory never applied.
    await store.applyServerChanges(
      'doc1',
      [{ ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }]), committedAt: 1 }],
      [],
      5
    );
    // Rev 7 arrives misaligned for the doc: it rebuilds from the store (an import).
    await algorithm.applyServerChanges(
      'doc1',
      [{ ...createChange(6, 7, [{ op: 'add', path: '/other', value: 1 }]), committedAt: 1 }],
      doc
    );
    expect(doc.committedRev).toBe(7);

    const [sent] = (await algorithm.getPendingToSend('doc1', doc))!;
    // Re-minted at 7 WITH the path transformed across rev 6 (Z landed at 0, so u's slot moved
    // to 2), not the raw /items/1 the import would re-apply: every other client sees Z, a, u.
    expect(sent).toMatchObject({ id: 'refused', baseRev: 7, ops: [{ op: 'add', path: '/items/2', value: 'u' }] });
    expect(doc.state).toEqual({ items: ['Z', 'a', 'u'], other: 1 });
  });

  it("walks live rows through a snapshot reload's reconciled tail as well", async () => {
    let refusedOps: any[] = [];
    const off = doc.onChange(ops => (refusedOps = ops));
    doc.change(patch => patch.add('/items/1', 'u'));
    off();
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    await store.savePendingChanges('doc1', [createChange(5, 6, [{ op: 'add', path: '/x', value: 1 }], {}, 'p')]);

    // The reload's reconcile: committed 6 (an insert at 0) that this doc never received.
    await algorithm.reconcilePending('doc1', [
      { ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }]), committedAt: 1 },
    ]);
    expect(refusedOps).toEqual([{ op: 'add', path: '/items/2', value: 'u' }]); // the live array moved
  });

  it('noteUnstoredCommitted from another context drops the row and tells the doc', () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    algorithm.noteUnstoredCommitted('doc1', [{ ...createChange(5, 9, refusedOps, {}, 'refused'), committedAt: 1 }]);
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
    expect(doc.unstoredChangeIds).toEqual(['refused']); // rev 9 is ahead of this doc; dropped by the import that covers it
    doc.import({ state: { items: ['a', 'u'] }, rev: 9, changes: [] });
    expect(doc.state.items).toEqual(['a', 'u']);
    expect(doc.unstoredChangeIds).toEqual([]);
  });

  it('untrack, delete and close clear the outbox', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    await algorithm.untrackDocs(['doc1']);
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);

    await store.trackDocs(['doc1']);
    algorithm.queueUnstoredChange('doc1', type('v'), doc, {}, 'again');
    algorithm.discardUnstoredChanges('doc1');
    expect(algorithm.listUnstoredChanges('doc1')).toEqual([]);
  });

  it('a mixed-baseRev queue still slices by frame with outbox rows behind (DAB-951 rule holds)', async () => {
    await store.savePendingChanges('doc1', [
      createChange(3, 6, [{ op: 'add', path: '/x', value: 1 }], {}, 'straggler'), // a frame behind
    ]);
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const batch = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(batch.map(c => c.id)).toEqual(['straggler']); // the outbox row waits for the follow-up pass
  });

  it('a row deferred a second time is reported once on onError (PendingDeferredError); the first deferral is not', async () => {
    await store.savePendingChanges('doc1', [
      createChange(3, 6, [{ op: 'add', path: '/x', value: 1 }], {}, 'straggler'), // a frame behind
    ]);
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors: Error[] = [];
    algorithm.onError((err, context) => {
      errors.push(err);
      expect(context).toEqual({ docId: 'doc1' });
    });

    await algorithm.getPendingToSend('doc1', doc); // deferred once: the follow-up pass is expected to clear it
    expect(errors).toEqual([]);
    await algorithm.getPendingToSend('doc1', doc); // still deferred: the follow-up did not clear it
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(PendingDeferredError);
    expect(errors[0]).toMatchObject({
      docId: 'doc1',
      changeIds: ['refused'],
      flushedBaseRev: 3,
      deferredBaseRevs: [5],
    });
    await algorithm.getPendingToSend('doc1', doc);
    expect(errors).toHaveLength(1); // latched per row
  });

  it('confirmUnstoredCommitted (the commit response) confirms the row before the store apply — reported once, no longer listed or pending — and the echo does not re-report it', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    const committed = vi.fn();
    algorithm.onUnstoredCommitted(committed);
    const echo = {
      ...createChange(5, 6, [{ op: 'add', path: '/items/-', value: 'u' }], {}, 'refused'),
      committedAt: 1,
    };

    algorithm.confirmUnstoredCommitted('doc1', [
      echo,
      createChange(5, 7, [{ op: 'add', path: '/y', value: 1 }], {}, 'store-row'),
    ]);
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
    expect(await algorithm.hasPending('doc1')).toBe(false);
    expect(algorithm.listUnstoredChanges('doc1')).toEqual([]); // on the server: not unsaved content
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledWith('doc1', [echo]); // only the outbox row, with its committed copy
    // The doc keeps the entry visible (rev 6 is ahead of it) until a receive or import covers it.
    expect(doc.unstoredChangeIds).toEqual(['refused']);
    expect(doc.state.items).toEqual(['a', 'u']);
    expect(await algorithm.getPendingToSend('doc1', doc)).toBeNull(); // a stub alone is not a batch

    await algorithm.applyServerChanges('doc1', [echo], doc);
    expect(doc.state.items).toEqual(['a', 'u']); // once
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(committed).toHaveBeenCalledTimes(1); // not reported twice
  });

  it('a row confirmed here is not accepted again from a re-forward (recently confirmed ids are remembered, bounded)', async () => {
    const refusedOps = type('u');
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
    const [row] = algorithm.listUnstoredChanges('doc1');
    const echo = {
      ...createChange(5, 6, [{ op: 'add', path: '/items/-', value: 'u' }], {}, 'refused'),
      committedAt: 1,
    };
    await algorithm.applyServerChanges('doc1', [echo], doc);

    expect(algorithm.acceptUnstoredChanges('doc1', [row])).toBe(0); // its echo was consumed; no echo left to clear it
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);

    // The memory is a window, not a ledger: 200 later confirmations push the id out.
    for (let i = 0; i < 200; i++) {
      algorithm.acceptUnstoredChanges('doc1', [createChange(6, 7, [{ op: 'add', path: '/n', value: i }], {}, `f${i}`)]);
      algorithm.noteUnstoredCommitted('doc1', [
        { ...createChange(6, 7, [{ op: 'add', path: '/n', value: i }], {}, `f${i}`), committedAt: 1 },
      ]);
    }
    expect(algorithm.acceptUnstoredChanges('doc1', [row])).toBe(1);
  });

  it('refuses rows past the ceiling and reports the overflow once per episode (UnstoredOutboxOverflowError)', () => {
    const errors: Error[] = [];
    algorithm.onError(err => errors.push(err));
    for (let i = 0; i < 500; i++) algorithm.queueUnstoredChange('doc1', type(`v${i}`), doc, {}, `r${i}`);
    expect(algorithm.listUnstoredChanges('doc1')).toHaveLength(500);
    expect(errors).toEqual([]);

    const over = type('over');
    expect(algorithm.queueUnstoredChange('doc1', over, doc, {}, 'over')).toBeNull(); // refused, not evicting an older row
    expect(algorithm.listUnstoredChanges('doc1')).toHaveLength(500);
    expect(doc.unstoredChangeIds).not.toContain('over'); // stays an ordinary optimistic entry
    expect(doc.state.items).toContain('over'); // still visible; the app shelves it
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnstoredOutboxOverflowError);
    expect(errors[0]).toMatchObject({ docId: 'doc1', rows: 500, maxRows: 500, maxBytes: 2 * 1024 * 1024 });
    expect(algorithm.queueUnstoredChange('doc1', type('over2'), doc, {}, 'over2')).toBeNull();
    expect(
      algorithm.acceptUnstoredChanges('doc1', [createChange(5, 9, [{ op: 'add', path: '/x', value: 1 }], {}, 'f')])
    ).toBe(0);
    expect(errors).toHaveLength(1); // latched while the outbox stays full

    // The outbox drains: the latch clears and a new episode reports again.
    algorithm.discardUnstoredChanges('doc1');
    for (let i = 0; i < 500; i++)
      algorithm.acceptUnstoredChanges('doc1', [createChange(5, 9, [{ op: 'add', path: '/x', value: i }], {}, `a${i}`)]);
    expect(
      algorithm.acceptUnstoredChanges('doc1', [createChange(5, 9, [{ op: 'add', path: '/x', value: 1 }], {}, 'a-over')])
    ).toBe(0);
    expect(errors).toHaveLength(2);
  });

  it('the byte ceiling refuses a row the serialised outbox cannot hold', () => {
    const errors: Error[] = [];
    algorithm.onError(err => errors.push(err));
    const big = 'x'.repeat(1.5 * 1024 * 1024);
    expect(algorithm.queueUnstoredChange('doc1', type(big), doc, {}, 'big1')).not.toBeNull();
    expect(algorithm.queueUnstoredChange('doc1', type(big), doc, {}, 'big2')).toBeNull(); // 3 MiB > 2 MiB
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ rows: 1, maxBytes: 2 * 1024 * 1024 });
    expect((errors[0] as UnstoredOutboxOverflowError).bytes).toBeGreaterThan(1.5 * 1024 * 1024);
  });
});

describe('OTAlgorithm outbox — walking live rows across a rebuild or reload (review round 2)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;
  let doc: OTDoc<any>;
  let refusedOps: any[];

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: { items: ['a'] }, rev: 5 });
    doc = algorithm.createDoc('doc1', { state: { items: ['a'] }, rev: 5, changes: [] }) as unknown as OTDoc<any>;
    // Doc at rev 5 with items [a]; the outbox row inserts 'u' at /items/1 (after a) in that frame.
    refusedOps = [];
    const off = doc.onChange(ops => (refusedOps = ops));
    doc.change(patch => patch.add('/items/1', 'u'));
    off();
    algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
  });

  const Z = { ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }]), committedAt: 1 };
  const other = { ...createChange(6, 7, [{ op: 'add', path: '/other', value: 1 }]), committedAt: 1 };

  it('reconcilePending anchors the walk on the DOC frame: the span between a torn doc and the tail comes from the store', async () => {
    // A torn reload: the store took rev 6 (Z at 0) that the doc never applied. The reload's
    // reconcile hands over the tail FROM 6 — anchored on the tail's frame, the walk would skip
    // rev 6 and the row would still read /items/1 under baseRev 7 (Z, u, a).
    await store.applyServerChanges('doc1', [Z], [], 5);
    await store.savePendingChanges('doc1', [createChange(6, 7, [{ op: 'add', path: '/x', value: 1 }], {}, 'p')]);
    await algorithm.reconcilePending('doc1', [{ ...other, baseRev: 6, rev: 7 }]);
    expect(refusedOps).toEqual([{ op: 'add', path: '/items/2', value: 'u' }]); // crossed 6 AND 7

    // The reload's import, then the send: in frame at 7.
    doc.import((await algorithm.loadDoc('doc1')) as any);
    expect(doc.committedRev).toBe(7);
    const batch = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(batch.find(c => c.id === 'refused')).toMatchObject({
      baseRev: 7,
      ops: [{ op: 'add', path: '/items/2', value: 'u' }],
    });
    expect(doc.state.items).toEqual(['Z', 'a', 'u']);
  });

  it("a row queued while the store's span read is pending is walked with the rest, never re-applied raw (review round 4)", async () => {
    // The store took Z torn (the doc stays at 5); the receive of `other` is misaligned and
    // rebuilds from the store, reading the span [Z, other] with listChanges. While that read
    // is pending, w is typed behind u and reaches the outbox. Captured before the read, w
    // would be re-applied raw by the import (Z, a, w, u) and re-minted at 7 with frame-5 ops.
    await store.applyServerChanges('doc1', [Z], [], 5);
    const read = store.listChanges.bind(store);
    let late: any[] = [];
    vi.spyOn(store, 'listChanges').mockImplementation(async (docId, options) => {
      late = [];
      const off = doc.onChange(ops => (late = ops));
      doc.change(patch => patch.add('/items/2', 'w'));
      off();
      algorithm.queueUnstoredChange('doc1', late, doc, {}, 'late');
      return read(docId, options);
    });
    await algorithm.applyServerChanges('doc1', [other], doc);
    expect(doc.committedRev).toBe(7);
    expect(refusedOps).toEqual([{ op: 'add', path: '/items/2', value: 'u' }]);
    expect(late).toEqual([{ op: 'add', path: '/items/3', value: 'w' }]); // crossed Z as well
    const batch = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(batch.map(c => [c.id, c.baseRev, c.ops[0].path])).toEqual([
      ['refused', 7, '/items/2'],
      ['late', 7, '/items/3'],
    ]);
    expect(doc.state).toEqual({ items: ['Z', 'a', 'u', 'w'], other: 1 });
  });

  it('a store tail that stops short of the snapshot rev (compacted or torn) freezes the rows at their true frame instead of re-minting them', async () => {
    await store.applyServerChanges('doc1', [Z], [], 5);
    // Rev 7 inserts at 0 as well: a walk that crossed 6 but not 7 would come out one slot short.
    const Y = { ...createChange(6, 7, [{ op: 'add', path: '/items/0', value: 'Y' }]), committedAt: 1 };
    // The store's committed run is short: rev 7 is missing from the read (compacted away, or the
    // envelope write tore) although the snapshot the doc rebuilds from sits at 7.
    const real = store.listChanges.bind(store);
    vi.spyOn(store, 'listChanges').mockImplementation(async (docId, opts) =>
      (await real(docId, opts)).filter(c => c.rev !== 7)
    );
    await algorithm.applyServerChanges('doc1', [Y], doc); // misaligned for the doc: rebuild from the store
    expect(doc.committedRev).toBe(7);

    // NOT re-minted at 7 with a partly-walked /items/2 (nor the raw /items/1): frozen at 5 with
    // its own ops, an honest baseRev the server transforms from.
    const [sent] = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(sent).toMatchObject({ id: 'refused', baseRev: 5, ops: [{ op: 'add', path: '/items/1', value: 'u' }] });
    expect(algorithm.listUnstoredChanges('doc1')[0]).toMatchObject({ baseRev: 5 });
  });

  it('a store tail that starts past the doc frame (the first rev missing) freezes the rows as well', async () => {
    await store.applyServerChanges('doc1', [Z], [], 5);
    const real = store.listChanges.bind(store);
    vi.spyOn(store, 'listChanges').mockImplementation(async (docId, opts) =>
      (await real(docId, opts)).filter(c => c.rev !== 6)
    );
    await algorithm.applyServerChanges('doc1', [other], doc);
    const [sent] = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(sent).toMatchObject({ id: 'refused', baseRev: 5, ops: [{ op: 'add', path: '/items/1', value: 'u' }] });
  });

  it('an empty tail read is not "nothing to walk": the rows are frozen', async () => {
    await store.applyServerChanges('doc1', [Z], [], 5);
    vi.spyOn(store, 'listChanges').mockResolvedValue([]);
    await algorithm.applyServerChanges('doc1', [other], doc);
    expect(doc.committedRev).toBe(7);
    const [sent] = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(sent).toMatchObject({ id: 'refused', baseRev: 5, ops: [{ op: 'add', path: '/items/1', value: 'u' }] });
  });

  it('pending rows in the tail read are not walked as committed history', async () => {
    await store.applyServerChanges('doc1', [Z], [], 5);
    // The store's read hands back a pending row (no committedAt) in the run's place.
    vi.spyOn(store, 'listChanges').mockResolvedValue([
      createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }], {}, 'not-committed'),
      other,
    ]);
    await algorithm.applyServerChanges('doc1', [other], doc);
    const [sent] = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(sent).toMatchObject({ id: 'refused', baseRev: 5, ops: [{ op: 'add', path: '/items/1', value: 'u' }] });
  });

  it('a frozen straggler is deferred behind the store queue and reported, not relabeled', async () => {
    await store.applyServerChanges('doc1', [Z], [], 5);
    vi.spyOn(store, 'listChanges').mockResolvedValue([]);
    await algorithm.applyServerChanges('doc1', [other], doc); // frozen at 5, doc now at 7
    await store.savePendingChanges('doc1', [createChange(7, 8, [{ op: 'add', path: '/x', value: 1 }], {}, 'p')]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors: Error[] = [];
    algorithm.onError(err => errors.push(err));

    expect((await algorithm.getPendingToSend('doc1', doc))!.map(c => c.id)).toEqual(['p']);
    expect((await algorithm.getPendingToSend('doc1', doc))!.map(c => c.id)).toEqual(['p']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: 'PendingDeferredError',
      changeIds: ['refused'],
      flushedBaseRev: 7,
      deferredBaseRevs: [5],
    });
  });

  it('an echo inside the walked span confirms the row (the store took it while the doc was torn)', async () => {
    const committedSpy = vi.fn();
    algorithm.onUnstoredCommitted(committedSpy);
    const echo = {
      ...createChange(5, 6, [{ op: 'add', path: '/items/1', value: 'u' }], {}, 'refused'),
      committedAt: 1,
    };
    await store.applyServerChanges('doc1', [echo], [], 5); // the doc's apply of this echo tore
    await algorithm.applyServerChanges('doc1', [other], doc); // rebuild from the store

    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(doc.state).toEqual({ items: ['a', 'u'], other: 1 }); // once
    expect(committedSpy).toHaveBeenCalledWith('doc1', [echo]);
  });
});

describe('OTAlgorithm outbox — confirmed stubs and the unreadable span over pending rows (review round 3)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;
  let doc: OTDoc<any>;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: { items: ['a'] }, rev: 5 });
    doc = algorithm.createDoc('doc1', { state: { items: ['a'] }, rev: 5, changes: [] }) as unknown as OTDoc<any>;
  });

  /** Type through the doc and return the emitted ops array. */
  function type(path: string, value: string): any[] {
    let emitted: any[] = [];
    const off = doc.onChange(ops => (emitted = ops));
    doc.change(patch => patch.add(path, value));
    off();
    return emitted;
  }

  it('a confirmed row stays as a stub and rides ahead of later rows at the doc frame until the doc covers its rev', async () => {
    const committed = vi.fn();
    algorithm.onUnstoredCommitted(committed);
    algorithm.queueUnstoredChange('doc1', type('/items/0', 'u'), doc, {}, 'u');
    const uEcho = { ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'u' }], {}, 'u'), committedAt: 1 };
    algorithm.confirmUnstoredCommitted('doc1', [uEcho]); // the store then refuses the apply: the doc stays at 5
    expect(doc.committedRev).toBe(5);

    // v is minted over u (the user sees u, v, a). It must not go out alone at 5: the server
    // would transform it against u's committed copy.
    algorithm.queueUnstoredChange('doc1', type('/items/1', 'v'), doc, {}, 'v');
    expect(algorithm.listUnstoredChanges('doc1').map(c => c.id)).toEqual(['v']); // the stub is not unsaved content
    const batch = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(batch.map(c => [c.id, c.baseRev, c.ops[0].path])).toEqual([
      ['u', 5, '/items/0'],
      ['v', 5, '/items/1'],
    ]);

    // The response echoes the deduped stub again: not reported twice, still a stub.
    algorithm.confirmUnstoredCommitted('doc1', [
      uEcho,
      { ...createChange(5, 7, [{ op: 'add', path: '/items/1', value: 'v' }], {}, 'v'), committedAt: 1 },
    ]);
    expect(committed).toHaveBeenCalledTimes(2);
    expect(committed.mock.calls.map(([, changes]) => changes.map((c: Change) => c.id))).toEqual([['u'], ['v']]);
    expect(await algorithm.getPendingToSend('doc1', doc)).toBeNull(); // stubs alone: nothing to shadow
    expect(await algorithm.hasPending('doc1')).toBe(false);

    // A later batch (a store row minted over both) carries both stubs ahead of it.
    await algorithm.handleDocChange('doc1', type('/items/2', 'w'), doc, {}, 'w');
    const next = (await algorithm.getPendingToSend('doc1', doc))!;
    expect(next.map(c => c.id)).toEqual(['w', 'u', 'v']);
  });

  it("a stub retires on the doc's own echo, with no second report, and on an import that covers its rev", async () => {
    const committed = vi.fn();
    algorithm.onUnstoredCommitted(committed);
    algorithm.queueUnstoredChange('doc1', type('/items/0', 'u'), doc, {}, 'u');
    const uEcho = { ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'u' }], {}, 'u'), committedAt: 1 };
    algorithm.confirmUnstoredCommitted('doc1', [uEcho]);
    expect(algorithm['_outbox'].get('doc1')).toHaveLength(1);

    await algorithm.applyServerChanges('doc1', [uEcho], doc); // the store recovered: the echo lands
    expect(doc.committedRev).toBe(6);
    expect(doc.state.items).toEqual(['u', 'a']); // once
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(algorithm['_outbox'].has('doc1')).toBe(false);
    expect(committed).toHaveBeenCalledTimes(1);

    // The import route: the doc jumps to a snapshot that holds the row.
    algorithm.queueUnstoredChange('doc1', type('/items/1', 'v'), doc, {}, 'v');
    const vEcho = { ...createChange(6, 7, [{ op: 'add', path: '/items/1', value: 'v' }], {}, 'v'), committedAt: 1 };
    algorithm.confirmUnstoredCommitted('doc1', [vEcho]);
    doc.import({ state: { items: ['u', 'v', 'a'] }, rev: 7, changes: [] });
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(await algorithm.getPendingToSend('doc1', doc)).toBeNull();
    expect(algorithm['_outbox'].has('doc1')).toBe(false); // retired at the read
    expect(committed).toHaveBeenCalledTimes(2);
  });

  it('a stub absent from a later response is not "resolved away", and a stub deferred behind the store queue is not reported stuck', async () => {
    algorithm.queueUnstoredChange('doc1', type('/items/0', 'u'), doc, {}, 'u');
    algorithm.confirmUnstoredCommitted('doc1', [
      { ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'u' }], {}, 'u'), committedAt: 1 },
    ]);
    algorithm.queueUnstoredChange('doc1', type('/items/1', 'v'), doc, {}, 'v');
    const batch = (await algorithm.getPendingToSend('doc1', doc))!;
    // A server that did not echo the deduped stub back: only v comes back committed.
    const vEcho = { ...createChange(5, 7, [{ op: 'add', path: '/items/1', value: 'v' }], {}, 'v'), committedAt: 1 };
    expect(await algorithm.dropResolvedPending('doc1', batch, [vEcho])).toBe(0);
    expect(doc.unstoredChangeIds).toEqual(['u', 'v']); // the doc still holds both entries
    expect(algorithm['_outbox'].get('doc1')).toHaveLength(2);

    // The doc closes: the stubs (v confirmed by the next response) freeze at 5. A store row
    // minted on a newer frame heads the queue, so the stubs are stragglers — deferred, but never
    // reported as stuck.
    algorithm.confirmUnstoredCommitted('doc1', [vEcho]);
    algorithm.detachUnstoredChanges('doc1', doc);
    await store.savePendingChanges('doc1', [createChange(8, 9, [{ op: 'add', path: '/x', value: 1 }], {}, 'p')]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors: Error[] = [];
    algorithm.onError(err => errors.push(err));
    expect((await algorithm.getPendingToSend('doc1'))!.map(c => c.id)).toEqual(['p']);
    expect((await algorithm.getPendingToSend('doc1'))!.map(c => c.id)).toEqual(['p']);
    expect(errors).toEqual([]);
  });

  it('stubs count toward the ceiling: a doc that cannot advance holds the honest bound', () => {
    const errors: Error[] = [];
    algorithm.onError(err => errors.push(err));
    const echoes: Change[] = [];
    for (let i = 0; i < 500; i++) {
      algorithm.queueUnstoredChange('doc1', type('/items/-', `v${i}`), doc, {}, `r${i}`);
      echoes.push({
        ...createChange(5, 6 + i, [{ op: 'add', path: '/items/-', value: `v${i}` }], {}, `r${i}`),
        committedAt: 1,
      });
    }
    algorithm.confirmUnstoredCommitted('doc1', echoes);
    expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
    expect(algorithm.listUnstoredChanges('doc1')).toEqual([]);

    expect(algorithm.queueUnstoredChange('doc1', type('/items/-', 'over'), doc, {}, 'over')).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnstoredOutboxOverflowError);
    expect(errors[0]).toMatchObject({ rows: 500, maxRows: 500 });
  });

  describe('an unreadable span over an in-frame pending row', () => {
    const Z = { ...createChange(5, 6, [{ op: 'add', path: '/items/0', value: 'Z' }]), committedAt: 1 };
    const other = { ...createChange(6, 7, [{ op: 'add', path: '/other', value: 1 }]), committedAt: 1 };
    let refusedOps: any[];
    let errors: Error[];

    beforeEach(async () => {
      // P (add /x) is pending in the store and the doc; the row u = add /items/1 is expressed over it.
      await algorithm.handleDocChange('doc1', type('/x', 'p'), doc, {}, 'P');
      refusedOps = type('/items/1', 'u');
      algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused');
      // The store took Z torn (the doc stays at 5) and cannot read the span for the rebuild.
      await algorithm.applyServerChanges('doc1', [Z], undefined);
      expect(doc.committedRev).toBe(5);
      vi.spyOn(store, 'listChanges').mockRejectedValue(new Error('unreadable'));
      errors = [];
      algorithm.onError(err => errors.push(err));
    });

    it('is taken from the server when a fetcher is installed: the row is walked, not frozen', async () => {
      const fetch = vi.fn(async () => [Z, other]);
      algorithm.setCommittedSpanFetcher(fetch);
      await algorithm.applyServerChanges('doc1', [other], doc); // misaligned: rebuild from the store
      expect(fetch).toHaveBeenCalledWith('doc1', 5, 7);
      expect(doc.committedRev).toBe(7);
      const batch = (await algorithm.getPendingToSend('doc1', doc))!;
      expect(batch.map(c => [c.id, c.baseRev])).toEqual([
        ['P', 7],
        ['refused', 7],
      ]); // one batch, in frame
      expect(batch[1].ops).toEqual([{ op: 'add', path: '/items/2', value: 'u' }]); // crossed Z
      expect(doc.state).toEqual({ items: ['Z', 'a', 'u'], x: 'p', other: 1 });
      expect(errors).toEqual([]);
    });

    it('refuses and reports the row when no fetcher is installed: it is dropped from the outbox, never frozen', async () => {
      await algorithm.applyServerChanges('doc1', [other], doc);
      expect(doc.committedRev).toBe(7);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(UnstoredFrameLostError);
      expect(errors[0]).toMatchObject({
        docId: 'doc1',
        fromRev: 5,
        toRev: 7,
        changes: [{ id: 'refused', baseRev: 5, ops: [{ op: 'add', path: '/items/1', value: 'u' }] }],
      });
      expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
      expect(doc.unstoredChangeIds).toEqual([]);
      // Dropped from the doc as well (review round 4): the import re-applies surviving entries
      // RAW at 7, so a kept entry would show frame-5 ops in the new frame, and the latch's
      // recovery (retrySavingChanges) would re-drive it there. The shelf has its content.
      expect(doc.state).toEqual({ items: ['Z', 'a'], x: 'p', other: 1 });
      expect(doc._getOptimisticEntries()).toEqual([]);
      expect(doc.getPendingChanges().map(c => c.id)).toEqual(['P']);
      // Only P goes out; the row is not sent at a frame it is not in.
      expect((await algorithm.getPendingToSend('doc1', doc))!.map(c => c.id)).toEqual(['P']);
      // A re-drive under the same id, the way retrySavingChanges would: the entry is gone, so
      // nothing is minted for it (the ops array was emptied in place).
      expect(refusedOps).toEqual([]);
      expect(await algorithm.handleDocChange('doc1', refusedOps, doc, {}, 'refused')).toEqual([]);
      expect((await algorithm.getPendingToSend('doc1', doc))!.map(c => c.id)).toEqual(['P']);
    });

    it('a row queued while the span is being fetched is walked with the rest, never re-applied raw (review round 4)', async () => {
      // On a latched doc every keystroke reaches queueUnstoredChange through the change queue,
      // so typing during the round trip is the normal case: w is typed behind u while the
      // fetch is in flight. Captured before the await, w would be re-applied raw by the import
      // (Z, a, w, u) and re-minted at 7 with its frame-5 ops.
      let late: any[] = [];
      const fetch = vi.fn(async () => {
        late = type('/items/2', 'w');
        algorithm.queueUnstoredChange('doc1', late, doc, {}, 'late');
        return [Z, other];
      });
      algorithm.setCommittedSpanFetcher(fetch);
      await algorithm.applyServerChanges('doc1', [other], doc);
      expect(doc.committedRev).toBe(7);
      const batch = (await algorithm.getPendingToSend('doc1', doc))!;
      expect(batch.map(c => [c.id, c.baseRev, c.ops[0].path])).toEqual([
        ['P', 7, '/x'],
        ['refused', 7, '/items/2'],
        ['late', 7, '/items/3'],
      ]);
      expect(doc.state).toEqual({ items: ['Z', 'a', 'u', 'w'], x: 'p', other: 1 });
      expect(errors).toEqual([]);
    });

    it('a row queued while the fetch is in flight is refused with the rest when the span falls short (review round 4)', async () => {
      let late: any[] = [];
      algorithm.setCommittedSpanFetcher(
        vi.fn(async () => {
          late = type('/items/2', 'w');
          algorithm.queueUnstoredChange('doc1', late, doc, {}, 'late');
          return [other]; // rev 6 missing
        })
      );
      await algorithm.applyServerChanges('doc1', [other], doc);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        fromRev: 5,
        toRev: 7,
        changes: [
          { id: 'refused', baseRev: 5, ops: [{ op: 'add', path: '/items/1', value: 'u' }] },
          { id: 'late', baseRev: 5, ops: [{ op: 'add', path: '/items/2', value: 'w' }] },
        ],
      });
      expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);
      expect(doc.state).toEqual({ items: ['Z', 'a'], x: 'p', other: 1 });
      expect((await algorithm.getPendingToSend('doc1', doc))!.map(c => c.id)).toEqual(['P']);
    });

    it('refuses the row when the fetcher fails or returns a short span', async () => {
      algorithm.setCommittedSpanFetcher(vi.fn(async () => [other])); // rev 6 missing
      await algorithm.applyServerChanges('doc1', [other], doc);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(UnstoredFrameLostError);
      expect(algorithm.hasUnstoredChanges('doc1')).toBe(false);

      // And a fetcher that throws (offline).
      const again = type('/items/1', 'w');
      algorithm.queueUnstoredChange('doc1', again, doc, {}, 'again');
      const more = { ...createChange(7, 8, [{ op: 'add', path: '/items/0', value: 'Y' }]), committedAt: 1 };
      await algorithm.applyServerChanges('doc1', [more], undefined); // torn again
      algorithm.setCommittedSpanFetcher(vi.fn(async () => Promise.reject(new Error('offline'))));
      await algorithm.applyServerChanges(
        'doc1',
        [{ ...createChange(8, 9, [{ op: 'add', path: '/more', value: 1 }]), committedAt: 1 }],
        doc
      );
      expect(errors).toHaveLength(2);
      expect(errors[1]).toMatchObject({ fromRev: 7, toRev: 9, changes: [{ id: 'again' }] });
    });
  });
});
