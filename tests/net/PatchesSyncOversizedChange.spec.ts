/**
 * PatchesSync's two responses to a change that is too big for the backend:
 *
 * - the server refuses ONE change with 413 `scope: 'change'`: halve this doc's split budget and
 *   flush again, down to a floor, resetting once a flush lands;
 * - the splitter itself refuses an op it cannot break (`UnsplittableChangeError`): latch that doc
 *   and surface it, without taking the sync loop or the other docs down with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { createChange } from '../../src/data/change.js';
import { StatusError, UnsplittableChangeError } from '../../src/net/error.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change } from '../../src/types.js';
import { makeConnection } from './connectionMock.js';

const DOC_ID = 'doc1';
const OTHER_DOC_ID = 'doc2';
const MAX_STORAGE_BYTES = 900_000;
/** Matches MIN_RESPLIT_STORAGE_BYTES in PatchesSync. */
const FLOOR = 100_000;

/** Many small ops, so halving the budget really does yield more (and smaller) pieces. */
function manyOpsChange(rev: number, ops = 200): Change {
  return createChange(
    0,
    rev,
    Array.from({ length: ops }, (_, i) => ({ op: 'add' as const, path: `/p${i}`, value: 'x'.repeat(10) }))
  );
}

/** Inflates JSON size so the fixture above measures megabytes without allocating them. */
const scaledSize = (data: unknown) => JSON.stringify(data).length * 200;
/** What the fake server will store: reached only after three halvings from MAX_STORAGE_BYTES. */
const SERVER_LIMIT = 150_000;

async function setup(options: Record<string, any> = {}, overrides: Record<string, any> = {}) {
  const store = new OTInMemoryStore();
  const algorithm = new OTAlgorithm(store);
  const patches = new Patches({ algorithms: { ot: algorithm } });
  const connection = makeConnection(overrides);
  const sync = new PatchesSync(patches, connection as unknown as PatchesConnection, {
    maxStorageBytes: MAX_STORAGE_BYTES,
    sizeCalculator: scaledSize,
    ...options,
  });
  await patches.trackDocs([DOC_ID, OTHER_DOC_ID]);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  sync['updateState']({ connected: true });
  return { store, algorithm, patches, connection, sync };
}

describe('PatchesSync re-splits on a 413', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => ctx?.sync.disconnect());

  /** Piece count per attempt, from a server that refuses any single change over SERVER_LIMIT. */
  function pickyServer(attempts: number[]) {
    return vi.fn(async (_docId: string, changes: Change[]) => {
      attempts.push(changes.length);
      const biggest = changes.find(c => scaledSize(c) > SERVER_LIMIT);
      if (biggest) throw new StatusError(413, 'change too large', { scope: 'change', changeId: biggest.id });
      return { changes: changes.map((c, i) => ({ ...c, rev: 1 + i, committedAt: 1000 })) };
    });
  }

  it('halves the budget until the batch is accepted, then resets it', async () => {
    const attempts: number[] = [];
    const commitChanges = pickyServer(attempts);
    ctx = await setup({}, { commitChanges });
    await ctx.store.savePendingChanges(DOC_ID, [manyOpsChange(1)]);

    await ctx.sync['syncDoc'](DOC_ID);
    await vi.waitFor(() => expect(ctx.sync.docStates.state[DOC_ID].syncStatus).toBe('synced'));

    // 900k → 450k → 225k → 112.5k: each halving cuts the change into strictly more pieces.
    expect(attempts).toHaveLength(4);
    expect(attempts).toEqual([...attempts].sort((a, b) => a - b));
    expect(ctx.sync['_resplitBudgets'].has(DOC_ID)).toBe(false);
  });

  it('starts the next flush from the configured budget again', async () => {
    const attempts: number[] = [];
    ctx = await setup({}, { commitChanges: pickyServer(attempts) });
    await ctx.store.savePendingChanges(DOC_ID, [manyOpsChange(1)]);
    await ctx.sync['syncDoc'](DOC_ID);
    await vi.waitFor(() => expect(ctx.sync.docStates.state[DOC_ID].syncStatus).toBe('synced'));
    const firstAttemptPieces = attempts[0];

    attempts.length = 0;
    await ctx.store.savePendingChanges(DOC_ID, [manyOpsChange(20)]);
    await ctx.sync['syncDoc'](DOC_ID);

    // Back at the full budget, so the fresh change is cut exactly as coarsely as the first was.
    expect(attempts[0]).toBe(firstAttemptPieces);
  });

  it('stops at the floor and latches instead of halving forever', async () => {
    const commitChanges = vi.fn(async (_docId: string, changes: Change[]) => {
      throw new StatusError(413, 'change too large', { scope: 'change', changeId: changes[0].id });
    });
    ctx = await setup({}, { commitChanges });
    await ctx.store.savePendingChanges(DOC_ID, [manyOpsChange(1)]);

    await ctx.sync['syncDoc'](DOC_ID);
    // 900k → 450k → 225k → 112.5k → floor: four halvings, so five commit attempts in all.
    await vi.waitFor(() => expect(commitChanges).toHaveBeenCalledTimes(5));

    expect(ctx.sync.docStates.state[DOC_ID].syncStatus).toBe('error');
    expect(ctx.sync.docStates.state[DOC_ID].syncError).toBeInstanceOf(StatusError);
    expect(ctx.sync['_resplitBudgets'].get(DOC_ID)).toBe(FLOOR);

    // At the floor, another pass halves nothing and adds exactly one more attempt.
    await ctx.sync['syncDoc'](DOC_ID);
    expect(ctx.sync['_resplitBudgets'].get(DOC_ID)).toBe(FLOOR);
    expect(commitChanges).toHaveBeenCalledTimes(6);
  });

  it('ignores a 413 that is not scoped to a single change', async () => {
    const commitChanges = vi.fn(async () => {
      throw new StatusError(413, 'payload too large', { scope: 'doc' });
    });
    ctx = await setup({}, { commitChanges });
    await ctx.store.savePendingChanges(DOC_ID, [manyOpsChange(1)]);

    await ctx.sync['syncDoc'](DOC_ID);

    expect(ctx.sync['_resplitBudgets'].has(DOC_ID)).toBe(false);
    expect(commitChanges).toHaveBeenCalledTimes(1);
  });

  it('does not invent a budget for a consumer that configured no splitting', async () => {
    const commitChanges = vi.fn(async (_docId: string, changes: Change[]) => {
      throw new StatusError(413, 'change too large', { scope: 'change', changeId: changes[0].id });
    });
    ctx = await setup({ maxStorageBytes: undefined, sizeCalculator: undefined }, { commitChanges });
    await ctx.store.savePendingChanges(DOC_ID, [manyOpsChange(1)]);

    await ctx.sync['syncDoc'](DOC_ID);

    expect(ctx.sync['_resplitBudgets'].has(DOC_ID)).toBe(false);
    expect(commitChanges).toHaveBeenCalledTimes(1);
  });
});

describe('PatchesSync with an already-queued unsplittable change', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => ctx?.sync.disconnect());

  /** The stuck user's queue: one op with no seam, already durably persisted. */
  const unsplittable = () => createChange(0, 1, [{ op: 'replace', path: '/cover', value: 'x'.repeat(4_000) }]);

  it('latches the doc with the error rather than throwing out of the sync loop', async () => {
    ctx = await setup({ maxStorageBytes: 100, maxUnsplittableBytes: 500, sizeCalculator: undefined });
    const errors: Error[] = [];
    ctx.sync.onError(err => errors.push(err));
    await ctx.store.savePendingChanges(DOC_ID, [unsplittable()]);

    await expect(ctx.sync['syncDoc'](DOC_ID)).resolves.toBeUndefined();

    expect(ctx.connection.commitChanges).not.toHaveBeenCalled();
    expect(ctx.sync.docStates.state[DOC_ID].syncStatus).toBe('error');
    expect(ctx.sync.docStates.state[DOC_ID].syncError).toBeInstanceOf(UnsplittableChangeError);
    expect(errors.at(-1)).toBeInstanceOf(UnsplittableChangeError);
    // Never retried: the same op measures the same on every attempt.
    expect(ctx.sync['_isRetryableSyncError'](errors.at(-1))).toBe(false);
  });

  it('leaves the other docs syncing', async () => {
    ctx = await setup({ maxStorageBytes: 100, maxUnsplittableBytes: 500, sizeCalculator: undefined });
    await ctx.store.savePendingChanges(DOC_ID, [unsplittable()]);
    await ctx.store.savePendingChanges(OTHER_DOC_ID, [createChange(0, 1, [{ op: 'add', path: '/ok', value: 1 }])]);

    await ctx.sync['syncAllKnownDocs']();

    expect(ctx.sync.docStates.state[DOC_ID].syncStatus).toBe('error');
    await vi.waitFor(() => expect(ctx.sync.docStates.state[OTHER_DOC_ID].syncStatus).toBe('synced'));
    expect(ctx.connection.commitChanges).toHaveBeenCalledTimes(1);
    expect(ctx.connection.commitChanges.mock.calls[0][0]).toBe(OTHER_DOC_ID);
  });

  it('sends it as before when maxUnsplittableBytes is unset', async () => {
    ctx = await setup({ maxStorageBytes: 100, sizeCalculator: undefined });
    await ctx.store.savePendingChanges(DOC_ID, [unsplittable()]);

    await ctx.sync['syncDoc'](DOC_ID);

    expect(ctx.connection.commitChanges).toHaveBeenCalledTimes(1);
    expect(ctx.sync.docStates.state[DOC_ID].syncStatus).toBe('synced');
  });
});
