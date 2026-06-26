import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
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
