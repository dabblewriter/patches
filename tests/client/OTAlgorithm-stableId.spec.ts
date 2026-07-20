import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';

/**
 * The caller-minted stable change id STAYS (the server dedups resubmitted commits by change id),
 * but the client-side idempotent-retry apparatus is gone: no isRetry param, no pre-scan of pending
 * or committed for the id. A retry is now safe purely by atomicity — a store write that rejected
 * did not commit, so re-issuing with the same id cannot duplicate. These cover id passthrough
 * (mint, batching, split) and that atomicity guarantee.
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
