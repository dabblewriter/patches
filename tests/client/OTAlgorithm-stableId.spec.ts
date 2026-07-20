import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change } from '../../src/types';

/**
 * The caller-minted stable change id (the server dedups resubmitted commits by change id) and
 * the client-side idempotent retry around it. A retry after a REJECTED store write is safe by
 * atomicity (nothing persisted); a retry after an AMBIGUOUS failure whose write actually landed
 * (an external store acking late — plain IndexedDB cannot do this) is caught by the isRetry
 * pre-scan, which returns the landed batch instead of re-minting. The pre-scan matters most for
 * split batches: only the first piece carries the stable id, so the store's per-row id dedup
 * would let a re-split append pieces 2..N under fresh ids.
 */

const op = (path: string, value: unknown) => [{ op: 'add' as const, path, value }];

describe('createChange — explicit stable id', () => {
  it('uses an explicit id when provided (rev-assigned form)', () => {
    expect(createChange(0, 1, op('/a', 1), {}, 'stable-1').id).toBe('stable-1');
  });

  it('falls back to a rev-derived id when none is provided', () => {
    const c = createChange(0, 1, op('/a', 1));
    expect(c.id).not.toBe('stable-1');
    expect(c.id.length).toBeGreaterThan(0);
  });
});

describe('OTAlgorithm.handleDocChange — stable id passthrough', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
  });

  it('mints the change with the supplied stable id (closed-doc path)', async () => {
    const changes = await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1');
    expect(changes.map(c => c.id)).toEqual(['cid-1']);
    expect((await store.getPendingChanges('doc1')).map(c => c.id)).toEqual(['cid-1']);
  });

  it('distinct submits each mint under their own id', async () => {
    await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1');
    await algorithm.handleDocChange('doc1', op('/b', 2), undefined, {}, 'cid-2');
    expect((await store.getPendingChanges('doc1')).map(c => c.id)).toEqual(['cid-1', 'cid-2']);
  });

  it('a retry after a transient store failure mints no duplicate (atomicity)', async () => {
    // An aborted IndexedDB transaction rejects without committing: nothing persisted.
    const saveSpy = vi.spyOn(store, 'savePendingChanges').mockRejectedValueOnce(new Error('injected substrate fault'));

    await expect(algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1')).rejects.toThrow(
      'injected substrate fault'
    );
    expect(await store.getPendingChanges('doc1')).toHaveLength(0);

    // The retry loop re-issues with the SAME stable id; exactly one change lands.
    const retry = await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1');
    expect(retry.map(c => c.id)).toEqual(['cid-1']);
    expect((await store.getPendingChanges('doc1')).map(c => c.id)).toEqual(['cid-1']);
    saveSpy.mockRestore();
  });
});

describe('OTAlgorithm.handleDocChange — stable id survives storage-size batching', () => {
  // Consumers configure docOptions.maxStorageBytes, so _createChangesFromOps runs breakChanges.
  // A change that fits under the limit must keep its caller-supplied id (breakSingleChange
  // returns it as-is); otherwise the server's id dedup on a resubmit would miss.
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store, { maxStorageBytes: 900_000 });
    await store.trackDocs(['doc1']);
  });

  it('preserves the stable id for a normally-sized change under maxStorageBytes', async () => {
    const changes = await algorithm.handleDocChange('doc1', op('/a', 'hello'), undefined, {}, 'cid-1');
    expect(changes.map(c => c.id)).toEqual(['cid-1']);
  });
});

describe('OTAlgorithm.handleDocChange — stable id survives an actual split', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store, { maxStorageBytes: 250 });
    await store.trackDocs(['doc1']);
  });

  const bigOps = [
    { op: 'add' as const, path: '/a', value: 'x'.repeat(120) },
    { op: 'add' as const, path: '/b', value: 'y'.repeat(120) },
  ];

  it('keeps the caller-supplied id on the first split piece', async () => {
    const changes = await algorithm.handleDocChange('doc1', bigOps, undefined, {}, 'cid-split');
    expect(changes.length).toBeGreaterThan(1);
    expect(changes[0].id).toBe('cid-split');
  });

  it('a retry whose earlier split write landed returns the landed batch without re-minting', async () => {
    // Pieces after the first derive their ids from the stable id (`cid-split~2`, ...), so the
    // pre-scan's prefix match returns the WHOLE landed batch, not just the marker piece.
    const first = await algorithm.handleDocChange('doc1', bigOps, undefined, {}, 'cid-split');
    expect(first.length).toBeGreaterThan(1);
    expect(first.map(c => c.id)).toEqual(first.map((_, i) => (i === 0 ? 'cid-split' : `cid-split~${i + 1}`)));
    const persisted = await store.getPendingChanges('doc1');

    const retry = await algorithm.handleDocChange('doc1', bigOps, undefined, {}, 'cid-split', true);

    expect(retry).toEqual(persisted); // the full landed batch, in order
    expect(await store.getPendingChanges('doc1')).toEqual(persisted); // nothing appended
  });

  it('a retry whose earlier write landed AND committed mints nothing new', async () => {
    const first = await algorithm.handleDocChange('doc1', bigOps, undefined, {}, 'cid-split');
    const committed = first.map((c, i) => ({ ...c, rev: i + 1, committedAt: 1000 }));
    await algorithm.applyServerChanges('doc1', committed, undefined);
    expect(await store.getPendingChanges('doc1')).toEqual([]);

    const retry = await algorithm.handleDocChange('doc1', bigOps, undefined, {}, 'cid-split', true);

    expect(retry.map(c => c.id)).toEqual(first.map(c => c.id)); // found in the recent committed tail
    expect(retry.every(c => c.committedAt === 1000)).toBe(true); // committed copies, not fresh mints
    expect(await store.getPendingChanges('doc1')).toEqual([]); // no phantom re-mint
  });

  it('a first submit (not a retry) does not pre-scan and mints fresh', async () => {
    await algorithm.handleDocChange('doc1', bigOps, undefined, {}, 'cid-split');
    const findSpy = vi.spyOn(algorithm as any, '_findChangeById');

    await algorithm.handleDocChange('doc1', op('/c', 3), undefined, {}, 'cid-2');

    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });
});

describe('isRetry pre-scan heals an open doc', () => {
  // Attempt 0 landed the store write but threw before the doc apply, so the open doc holds an
  // unconfirmed optimistic entry and an empty pending queue. The pre-scan's pending hit must
  // finish the apply the failed attempt skipped — otherwise the commit echo reads as foreign
  // and re-applies the user's own ops.
  // An array append, not a scalar set: a doubled apply is idempotent for `add /a 1` but
  // visible as two entries here.
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;
  let doc: OTDoc<{ list: string[] }>;
  let ops: JSONPatchOp[];

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    doc = new OTDoc<{ list: string[] }>('doc1', { state: { list: [] }, rev: 0, changes: [] });
    doc.onChange(emitted => (ops = emitted));
    doc.change(patch => patch.add('/list/-', 'x'));
  });

  it('a pending hit lands the batch on the doc without re-applying the ops', async () => {
    const landed = createChange(0, 1, ops, {}, 'cid-1');
    await store.savePendingChanges('doc1', [landed]); // the write that landed unacked

    const retry = await algorithm.handleDocChange('doc1', ops, doc, {}, 'cid-1', true);

    expect(retry.map(c => c.id)).toEqual(['cid-1']);
    expect(doc.getPendingChanges().map(c => c.id)).toEqual(['cid-1']);
    expect((doc as any)._optimisticOps).toHaveLength(0); // confirmation shifted the queue
    expect(doc.state).toEqual({ list: ['x'] }); // applied exactly once

    // With the doc in line the commit echo is a PURE echo: it consumes the pending change and
    // leaves state alone. Without the heal the echo reads as foreign and re-applies the ops.
    await algorithm.applyServerChanges('doc1', [{ ...landed, committedAt: 1000 }], doc);

    expect(doc.state).toEqual({ list: ['x'] });
    expect(doc.getPendingChanges()).toEqual([]);
  });

  it('a committed hit does not touch the doc', async () => {
    // The write landed AND a flush committed it before the retry ran; the echo / misaligned
    // import path owns the doc from there, so the pre-scan must leave it alone.
    const committed = { ...createChange(0, 1, ops, {}, 'cid-c'), committedAt: 1000 };
    await store.applyServerChanges('doc1', [committed], []);

    const retry = await algorithm.handleDocChange('doc1', ops, doc, {}, 'cid-c', true);

    expect(retry).toEqual([committed]);
    expect((doc as any)._optimisticOps).toHaveLength(1);
    expect(doc.getPendingChanges()).toEqual([]);
  });
});

describe('OTAlgorithm.replacePendingChanges', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
  });

  it('replaces the queue and renumbers changes minted since the read', async () => {
    const [original] = await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'orig');
    const oldQueue = await store.getPendingChanges('doc1');
    // Simulate a concurrent mint after the flush read the queue
    await algorithm.handleDocChange('doc1', op('/b', 2), undefined, {}, 'later');

    const split: Change[] = [
      { ...original, ops: [original.ops[0]], rev: 1 },
      { ...original, id: 'piece-2', ops: [{ op: 'add', path: '/a2', value: 1 }], rev: 2 },
    ];
    await algorithm.replacePendingChanges('doc1', oldQueue, split);

    const pending = await store.getPendingChanges('doc1');
    expect(pending.map(c => c.id)).toEqual(['orig', 'piece-2', 'later']);
    expect(pending.map(c => c.rev)).toEqual([1, 2, 3]);
  });
});
