import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
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
 *   - rows ride BEHIND the store queue, in one batch, re-minted from the doc's pointers at send
 *     time (baseRev = committedRev now, revs after the tail);
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

  it('a queued id is not queued twice', () => {
    const refusedOps = type('u');
    expect(algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused')).not.toBeNull();
    expect(algorithm.queueUnstoredChange('doc1', refusedOps, doc, {}, 'refused')).toBeNull();
    expect(algorithm.queueUnstoredChange('doc1', [], doc, {}, 'empty')).toBeNull();
    expect(algorithm.queueUnstoredChange('doc1', refusedOps, undefined, {}, 'no-doc')).toBeNull();
    expect(algorithm.listUnstoredChanges('doc1').map(c => c.id)).toEqual(['refused']);
  });

  it('accepts rows minted by another context as they stand, deduped by id', async () => {
    const foreign = createChange(4, 9, [{ op: 'add', path: '/items/-', value: 'f' }], {}, 'from-follower');
    expect(algorithm.acceptUnstoredChanges('doc1', [foreign, foreign])).toBe(1);
    expect(algorithm.acceptUnstoredChanges('doc1', [foreign])).toBe(0);

    const batch = (await algorithm.getPendingToSend('doc1'))!;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ id: 'from-follower', baseRev: 4, ops: foreign.ops }); // its own frame
    expect(batch[0].ops).not.toBe(foreign.ops);
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
});
