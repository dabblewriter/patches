import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';

/**
 * The hub sync path mints local changes (handleDocChange) and applies incoming server
 * changes (applyServerChanges) on one shared OTAlgorithm with no open doc — each a
 * read-modify-write on the `[docId, rev]`-keyed pending store. Without serialization the
 * two interleave: the rebased local change and the freshly minted change both land on the
 * same rev, and one silently overwrites the other (data loss). OTAlgorithm serializes
 * these per doc; this guards that no change is lost.
 *
 * Uses the real OTIndexedDBStore over fake-indexeddb on purpose: the bug is a `[docId, rev]`
 * key collision, which OTInMemoryStore (an array, no rev key) cannot reproduce.
 */
let dbSeq = 0;

describe('OTAlgorithm receive-vs-mint interleave (real OTIndexedDBStore)', () => {
  let store: OTIndexedDBStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTIndexedDBStore(`interleave-test-${dbSeq++}`);
    algorithm = new OTAlgorithm(store);
    // Committed through rev 4, with one un-sent local change c1 (baseRev 4, rev 5).
    await store.saveDoc('doc1', { state: { committed: true }, rev: 4 });
    await store.savePendingChanges('doc1', [createChange(4, 5, [{ op: 'add', path: '/local', value: 1 }])]);
  });

  it('keeps both the rebased local change and a concurrently-typed change', async () => {
    const serverChange = createChange(4, 5, [{ op: 'add', path: '/server', value: 1 }], { committedAt: 1000 });
    const typed: JSONPatchOp[] = [{ op: 'add', path: '/typed', value: 2 }];

    // Fire receive-rebase and local mint concurrently to exercise the interleave window.
    // Pre-fix this clobbers one change at rev 6; the per-doc lock prevents it.
    await Promise.all([
      algorithm.applyServerChanges('doc1', [serverChange], undefined),
      algorithm.handleDocChange('doc1', typed, undefined, {}),
    ]);

    const pending = await store.getPendingChanges('doc1');
    const paths = pending.flatMap(c => c.ops.map(o => o.path));

    expect(pending).toHaveLength(2); // neither change lost
    expect(new Set(pending.map(c => c.rev)).size).toBe(2); // distinct revs — no key collision
    expect(new Set(pending.map(c => c.baseRev)).size).toBe(1); // one baseRev — a valid single commit
    expect(paths).toContain('/local'); // the rebased local change survived
    expect(paths).toContain('/typed'); // the concurrently-typed change survived
  });
});

// Finding #29 (mint half): a receive processed between change() and its queued mint
// rebases the optimistic ops array IN PLACE (the mint shares the reference), so the
// mint must package the rebased ops — or skip entirely when they rebased away.
describe('OTAlgorithm mint after an interleaved receive (finding #29)', () => {
  interface State {
    items: string[];
  }

  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;
  let doc: OTDoc<State>;
  let captured: JSONPatchOp[];

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1'], 'ot');
    const seed = createChange(0, 1, [{ op: 'replace', path: '', value: { items: ['a', 'b', 'c'] } }], {
      committedAt: 1,
    });
    await store.applyServerChanges('doc1', [seed], []);
    doc = algorithm.createDoc<State>('doc1', await algorithm.loadDoc('doc1')) as OTDoc<State>;
    doc.onChange(ops => (captured = ops));
  });

  it('mints the rebased ops at the post-receive committedRev when the receive wins the lock', async () => {
    // User intent: insert 'X' between 'a' and 'b'.
    doc.change(patch => patch.add('/items/1', 'X'));

    // Foreign server change is processed BEFORE the queued mint runs.
    const foreign = createChange(1, 2, [{ op: 'add', path: '/items/0', value: 'Z' }], { committedAt: 2 });
    await algorithm.applyServerChanges('doc1', [foreign], doc);

    const minted = await algorithm.handleDocChange('doc1', captured, doc, {});

    expect(doc.state.items).toEqual(['Z', 'a', 'X', 'b', 'c']);
    expect(minted).toHaveLength(1);
    expect(minted[0].baseRev).toBe(2);
    // Server at rev 2 applies baseRev-2 ops verbatim — they must be in the rev-2 frame.
    expect(minted[0].ops).toEqual([{ op: 'add', path: '/items/2', value: 'X' }]);
    expect(await store.getPendingChanges('doc1')).toEqual(minted);
  });

  it('skips a mint whose queued ops the receive rebased away while it waited on the lock', async () => {
    doc.change(patch => patch.add('/items/1', 'X'));
    const foreign = createChange(1, 2, [{ op: 'replace', path: '/items', value: ['q'] }], { committedAt: 2 });

    // Fire both without awaiting: the mint passes its pre-lock ops check, then queues
    // behind the receive, which empties the shared ops array. The in-lock re-check
    // must skip the mint instead of persisting an empty (or misplaced) change.
    const receive = algorithm.applyServerChanges('doc1', [foreign], doc);
    const mint = algorithm.handleDocChange('doc1', captured, doc, {});
    await receive;

    expect(await mint).toEqual([]);
    expect(doc.state.items).toEqual(['q']);
    expect(doc.hasPending).toBe(false);
    expect(await store.getPendingChanges('doc1')).toEqual([]);
  });
});
