import { afterEach, describe, expect, it, vi } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import { Patches } from '../../src/client/Patches';
import { StatusError } from '../../src/net/error';
import { PatchesSync } from '../../src/net/PatchesSync';
import { createChange } from '../../src/data/change';
import type { Change, QuarantinedChange } from '../../src/types';
import { makeConnection } from './connectionMock.js';

/**
 * Poison-pill ejection routing in PatchesSync.syncDoc: a 4xx commit rejection carrying
 * `data: { changeId, scope: 'change' }` ejects the named change into quarantine — but only
 * when the local strict-apply probe corroborates the server's attribution. Everything else
 * (data-less errors, scope 'doc', locally-clean changes, a tripped circuit breaker) falls
 * through to the ordinary latch/retry handling.
 */

const DOC = 'doc1';

/** commitChanges mock that rejects every batch, naming the first change with the given data. */
function rejectingCommit(code: number, data?: (changes: Change[]) => Record<string, any> | undefined) {
  return vi.fn(async (_docId: string, changes: Change[]) => {
    throw new StatusError(code, 'rejected by server', data?.(changes));
  });
}

async function setup(connectionOverrides: Record<string, any> = {}) {
  const store = new LWWInMemoryStore();
  const algorithm = new LWWAlgorithm(store);
  const patches = new Patches({ algorithms: { lww: algorithm } });
  await patches.trackDocs([DOC], 'lww');
  // Committed base state { title: 'x' } at rev 1.
  await algorithm.applyServerChanges(
    DOC,
    [createChange(0, 1, [{ op: 'replace', path: '/title', value: 'x', ts: 1, rev: 1 }], { committedAt: 1001 })],
    undefined
  );
  const connection = makeConnection(connectionOverrides);
  const sync = new PatchesSync(patches, connection as any);
  sync['updateState']({ connected: true });
  const quarantineEvents: Array<{ docId: string; entry: QuarantinedChange }> = [];
  patches.onChangeQuarantined((docId, entry) => quarantineEvents.push({ docId, entry }));
  return { store, algorithm, patches, connection, sync, quarantineEvents };
}

/** Ops that fail the local strict-apply probe against { title: 'x' } (descend through a primitive). */
const POISON_OPS = [{ op: 'replace', path: '/title/a/b', value: 1 }];
/** Ops that apply cleanly locally (a policy-style rejection the probe cannot corroborate). */
const CLEAN_OPS = [{ op: 'replace', path: '/title', value: 'y' }];

describe('PatchesSync poison-pill ejection', () => {
  let sync: PatchesSync | undefined;

  afterEach(() => {
    sync?.disconnect();
    sync = undefined;
  });

  it('ejects a corroborated poison change and syncs the surviving pending work past it', async () => {
    const ctx = await setup({
      commitChanges: rejectingCommit(422, changes => ({ changeId: changes[0].id, scope: 'change' })),
    });
    sync = ctx.sync;
    await ctx.algorithm.handleDocChange(DOC, POISON_OPS, undefined, {});
    // Capture into the sending slot first so a survivor minted next stays in pendingOps.
    const [poison] = (await ctx.algorithm.getPendingToSend(DOC))!;
    await ctx.algorithm.handleDocChange(DOC, [{ op: 'replace', path: '/subtitle', value: 'keep' }], undefined, {});

    // The survivor's flush must succeed once the poison is gone.
    let committedOps: string[] = [];
    ctx.connection.commitChanges = vi.fn(async (_docId: string, changes: Change[]) => {
      if (changes[0].id === poison.id) {
        throw new StatusError(422, 'rejected by server', { changeId: poison.id, scope: 'change' });
      }
      committedOps = changes.flatMap(c => c.ops.map(op => op.path));
      return { changes: changes.map((c, i) => ({ ...c, rev: 2 + i, committedAt: 2000 })) };
    });

    await (sync as any).syncDoc(DOC);
    await vi.waitFor(() => expect(sync!.docStates.state[DOC].syncStatus).toBe('synced'));

    expect(ctx.quarantineEvents).toHaveLength(1);
    expect(ctx.quarantineEvents[0].entry).toMatchObject({ docId: DOC, changeId: poison.id });
    expect((await ctx.store.listQuarantinedChanges(DOC)).map(q => q.changeId)).toEqual([poison.id]);
    expect(await ctx.store.getSendingChange(DOC)).toBeNull();
    expect(committedOps).toEqual(['/subtitle']);
    expect(sync!.docStates.state[DOC].syncError).toBeUndefined();
  });

  it('does NOT eject a named change that applies cleanly locally — latches with data for the app to decide', async () => {
    const ctx = await setup({
      commitChanges: rejectingCommit(403, changes => ({ changeId: changes[0].id, scope: 'change' })),
    });
    sync = ctx.sync;
    const errors: Error[] = [];
    sync.onError(err => errors.push(err));
    await ctx.algorithm.handleDocChange(DOC, CLEAN_OPS, undefined, {});

    await (sync as any).syncDoc(DOC);

    expect(ctx.quarantineEvents).toEqual([]);
    expect(await ctx.store.listQuarantinedChanges(DOC)).toEqual([]);
    expect(await ctx.store.getSendingChange(DOC)).not.toBeNull();
    expect(sync.docStates.state[DOC].syncStatus).toBe('error');
    // The latched error carries the culprit id — the surface-and-ask affordance.
    const surfaced = errors[0] as StatusError;
    expect(surfaced).toBeInstanceOf(StatusError);
    expect(surfaced.data?.changeId).toBeDefined();
    expect(surfaced.data?.scope).toBe('change');
  });

  it('does NOT eject on a data-less rejection (no culprit named)', async () => {
    const ctx = await setup({ commitChanges: rejectingCommit(422) });
    sync = ctx.sync;
    await ctx.algorithm.handleDocChange(DOC, POISON_OPS, undefined, {});

    await (sync as any).syncDoc(DOC);

    expect(ctx.quarantineEvents).toEqual([]);
    expect(await ctx.store.getSendingChange(DOC)).not.toBeNull();
    expect(sync.docStates.state[DOC].syncStatus).toBe('error');
  });

  it("does NOT eject on scope 'doc' (the history is the problem, not the client's change)", async () => {
    const ctx = await setup({
      commitChanges: rejectingCommit(422, () => ({ scope: 'doc' })),
    });
    sync = ctx.sync;
    await ctx.algorithm.handleDocChange(DOC, POISON_OPS, undefined, {});

    await (sync as any).syncDoc(DOC);

    expect(ctx.quarantineEvents).toEqual([]);
    expect(await ctx.store.getSendingChange(DOC)).not.toBeNull();
  });

  it('trips the circuit breaker after MAX_DOC_EJECTIONS and latches like any definitive failure', async () => {
    const ctx = await setup({
      commitChanges: rejectingCommit(422, changes => ({ changeId: changes[0].id, scope: 'change' })),
    });
    sync = ctx.sync;
    (sync as any)._ejectionCounts.set(DOC, 3);
    await ctx.algorithm.handleDocChange(DOC, POISON_OPS, undefined, {});

    await (sync as any).syncDoc(DOC);

    expect(ctx.quarantineEvents).toEqual([]);
    expect(await ctx.store.getSendingChange(DOC)).not.toBeNull();
    expect(sync.docStates.state[DOC].syncStatus).toBe('error');
  });

  it('re-surfaces persisted quarantine entries once per session when the doc first syncs', async () => {
    const ctx = await setup();
    sync = ctx.sync;
    // A quarantined change persisted by a previous session.
    await ctx.algorithm.handleDocChange(DOC, CLEAN_OPS, undefined, {});
    const [old] = (await ctx.algorithm.getPendingToSend(DOC))!;
    await ctx.store.quarantineSendingChange(DOC, old.id, 'previous session');

    await (sync as any).syncDoc(DOC);
    await vi.waitFor(() => expect(ctx.quarantineEvents).toHaveLength(1));
    expect(ctx.quarantineEvents[0].entry.reason).toBe('previous session');

    // A second sync does not re-emit.
    await (sync as any).syncDoc(DOC);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(ctx.quarantineEvents).toHaveLength(1);
  });

  it('re-surfaces persisted entries even when the first sync attempt latches at error', async () => {
    // Session 2 opens on a doc that immediately fails definitively (data-less 403); the
    // change quarantined in session 1 must still surface.
    const ctx = await setup({ commitChanges: rejectingCommit(403) });
    sync = ctx.sync;
    await ctx.algorithm.handleDocChange(DOC, CLEAN_OPS, undefined, {});
    const [old] = (await ctx.algorithm.getPendingToSend(DOC))!;
    await ctx.store.quarantineSendingChange(DOC, old.id, 'previous session');
    await ctx.algorithm.handleDocChange(DOC, CLEAN_OPS, undefined, {});

    await (sync as any).syncDoc(DOC);

    await vi.waitFor(() => expect(ctx.quarantineEvents).toHaveLength(1));
    expect(ctx.quarantineEvents[0].entry.reason).toBe('previous session');
    expect(sync.docStates.state[DOC].syncStatus).toBe('error');
  });

  it('Patches.ejectPendingChange is the app-consent path: quarantines without corroboration and nudges sync', async () => {
    const ctx = await setup();
    sync = ctx.sync;
    await ctx.algorithm.handleDocChange(DOC, CLEAN_OPS, undefined, {});
    const [sending] = (await ctx.algorithm.getPendingToSend(DOC))!;
    const changeEvents: string[] = [];
    ctx.patches.onChange(docId => changeEvents.push(docId));

    const entry = await ctx.patches.ejectPendingChange(DOC, sending.id, 'user confirmed');

    expect(entry).toMatchObject({ docId: DOC, changeId: sending.id, reason: 'user confirmed' });
    expect(ctx.quarantineEvents.map(e => e.entry.changeId)).toEqual([sending.id]);
    expect(await ctx.store.getSendingChange(DOC)).toBeNull();
    expect(changeEvents).toEqual([DOC]);

    // The nudged sync is the doc's first attempt this session, so its resurface may
    // re-deliver the entry (at-least-once; consumers key on docId + changeId).
    await vi.waitFor(() => expect(sync!.docStates.state[DOC].syncStatus).toBe('synced'));
    expect(new Set(ctx.quarantineEvents.map(e => e.entry.changeId))).toEqual(new Set([sending.id]));

    // Unknown id: null, nothing emitted.
    const emitted = ctx.quarantineEvents.length;
    expect(await ctx.patches.ejectPendingChange(DOC, 'nope', 'user confirmed')).toBeNull();
    expect(ctx.quarantineEvents).toHaveLength(emitted);

    await ctx.patches.discardQuarantinedChange(DOC, sending.id);
    expect(await ctx.patches.listQuarantinedChanges(DOC)).toEqual([]);
  });
});
