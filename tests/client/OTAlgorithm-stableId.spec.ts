import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';

/**
 * Coverage for the spoke-stable-id + safe-retry write path. A spoke→hub submit that times
 * out is re-issued with the SAME caller-minted id; the hub must treat the re-issue as
 * idempotent (return the already-accepted change) instead of minting a duplicate. See
 * `OTAlgorithm.handleDocChange(id, isRetry)` and `createChange(..., id)`.
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

describe('OTAlgorithm.handleDocChange — spoke-stable id + idempotent retry (pending)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
  });

  it('mints the change with the supplied stable id (worker path, doc undefined)', async () => {
    const changes = await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1');
    expect(changes.map(c => c.id)).toEqual(['cid-1']);
    expect((await store.getPendingChanges('doc1')).map(c => c.id)).toEqual(['cid-1']);
  });

  it('a retry with the same id returns the already-pending change without duplicating', async () => {
    await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1');
    const retry = await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1', true);

    expect(retry.map(c => c.id)).toEqual(['cid-1']);
    const pending = await store.getPendingChanges('doc1');
    expect(pending).toHaveLength(1); // no duplicate minted
    expect(pending[0].rev).toBe(1);
  });

  it('a retry for an id that was never accepted mints it fresh (no false idempotency)', async () => {
    const retry = await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-new', true);
    expect(retry.map(c => c.id)).toEqual(['cid-new']);
    expect(await store.getPendingChanges('doc1')).toHaveLength(1);
  });

  it('the idempotency guard is retry-gated: distinct first submits both mint', async () => {
    await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1');
    await algorithm.handleDocChange('doc1', op('/b', 2), undefined, {}, 'cid-2');
    expect((await store.getPendingChanges('doc1')).map(c => c.id)).toEqual(['cid-1', 'cid-2']);
  });
});

describe('OTAlgorithm.handleDocChange — idempotent retry after the original committed', () => {
  // OTInMemoryStore has no listChanges, so use a minimal store exposing a committed tail.
  function makeStore(committed: Change[]) {
    let pending: Change[] = [];
    return {
      async getDoc() {
        return undefined;
      },
      async getPendingChanges() {
        return pending;
      },
      async savePendingChanges(_docId: string, changes: Change[]) {
        pending = [...pending, ...changes];
      },
      async getCommittedRev() {
        return committed.at(-1)?.rev ?? 0;
      },
      async listChanges(_docId: string, options?: { startAfter?: number }) {
        const after = options?.startAfter ?? -1;
        return committed.filter(c => c.rev > after);
      },
      async trackDocs() {},
    } as any;
  }

  it('returns the committed change on retry instead of minting a duplicate', async () => {
    const store = makeStore([createChange(0, 1, op('/a', 1), { committedAt: 123 }, 'cid-1')]);
    const algorithm = new OTAlgorithm(store);

    const retry = await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1', true);

    expect(retry.map(c => c.id)).toEqual(['cid-1']);
    expect(await store.getPendingChanges('doc1')).toHaveLength(0); // nothing new persisted
  });

  it('mints fresh when the committed tail does not contain the id', async () => {
    const store = makeStore([createChange(0, 1, op('/x', 9), { committedAt: 1 }, 'other')]);
    const algorithm = new OTAlgorithm(store);

    const retry = await algorithm.handleDocChange('doc1', op('/a', 1), undefined, {}, 'cid-1', true);

    expect(retry.map(c => c.id)).toEqual(['cid-1']);
    expect(await store.getPendingChanges('doc1')).toHaveLength(1);
  });
});

describe('OTAlgorithm.handleDocChange — stable id survives storage-size batching', () => {
  // The DW3 hub configures docOptions.maxStorageBytes (900_000), so _createChangesFromOps runs
  // breakChanges. A change that fits under the limit must keep its caller-supplied id
  // (breakSingleChange returns it as-is); otherwise the retry idempotency would break.
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

  it('still dedups a retry idempotently with batching enabled', async () => {
    await algorithm.handleDocChange('doc1', op('/a', 'hello'), undefined, {}, 'cid-1');
    await algorithm.handleDocChange('doc1', op('/a', 'hello'), undefined, {}, 'cid-1', true);
    expect(await store.getPendingChanges('doc1')).toHaveLength(1);
  });
});
