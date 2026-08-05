/**
 * The committed-poison skip floor in PatchesSync (DAB-946).
 *
 * A committed change whose ops can never apply (recorded against an index the document no
 * longer has) latches every client that must replay across it: the ApplyChangesError recovery
 * reloads the authoritative snapshot, the next catch-up re-delivers the same change, and it
 * throws again — forever, on every device. These tests pin the escape hatch: the first failure
 * still reloads (a diverged replica is the likelier cause, and the reload fixes it losslessly),
 * but a change that keeps failing on top of authoritative state is skipped with loud telemetry,
 * landing exactly the state the server's own `applyChangesForReconstruction` computes.
 *
 * Real client components (Patches, OTAlgorithm, OTInMemoryStore, OTDoc); only the network is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChangesForReconstruction } from '../../src/algorithms/ot/shared/applyChanges.js';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTDoc } from '../../src/client/OTDoc.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { createChange } from '../../src/data/change.js';
import { CommittedPoisonSkippedError } from '../../src/net/error.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change } from '../../src/types.js';
import { makeConnection } from './connectionMock.js';

interface TestDoc {
  title?: any;
  note?: string;
}

const DOC = 'doc1';
/** The server's last version boundary — clean, and behind the poisoned tail. */
const SNAPSHOT = { state: { title: 'x' }, rev: 2 };
/** Descends through a primitive: fails strict apply against the server's own state, forever. */
const POISON_OPS = [{ op: 'replace', path: '/title/a/b', value: 1 }];

const committed = (rev: number, ops: any[]) => createChange(rev - 1, rev, ops, { committedAt: 1000 + rev });

async function setup(connectionOverrides: Record<string, any> = {}) {
  const store = new OTInMemoryStore();
  await store.saveDoc(DOC, SNAPSHOT);
  const algorithm = new OTAlgorithm(store);
  const patches = new Patches({ algorithms: { ot: algorithm } });
  const connection = makeConnection({
    getDoc: vi.fn(async () => ({ ...SNAPSHOT })),
    ...connectionOverrides,
  });
  const sync = new PatchesSync(patches, connection as unknown as PatchesConnection);

  await patches.trackDocs([DOC]);
  const doc = (await patches.openDoc<TestDoc>(DOC)) as OTDoc<TestDoc>;
  sync['updateState']({ connected: true });

  const skips: CommittedPoisonSkippedError[] = [];
  sync.onError(err => err instanceof CommittedPoisonSkippedError && skips.push(err));
  return { store, algorithm, patches, connection, sync, doc, skips };
}

describe('PatchesSync committed-poison skip floor', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reloads the authoritative snapshot on the first failure instead of skipping', async () => {
    const poison = committed(3, POISON_OPS);
    const good = committed(4, [{ op: 'add', path: '/note', value: 'kept' }]);
    const ctx = await setup({ getChangesSince: vi.fn(async () => [poison, good]) });

    await ctx.sync['syncDoc'](DOC);

    expect(ctx.connection.getDoc).toHaveBeenCalledTimes(1);
    expect(ctx.skips).toEqual([]);
    // Nothing past the poison was applied — the doc sits on the reloaded snapshot.
    expect(ctx.doc.committedRev).toBe(2);
    expect(ctx.doc.state).toEqual(SNAPSHOT.state);
    expect(ctx.sync.docStates.state[DOC].syncStatus).toBe('synced');
  });

  it('skips a committed change that keeps failing after a reload, and applies the rest of the batch', async () => {
    const poison = committed(3, POISON_OPS);
    const good = committed(4, [{ op: 'add', path: '/note', value: 'kept' }]);
    const ctx = await setup({ getChangesSince: vi.fn(async () => [poison, good]) });

    // Each lap re-delivers the same tail: fail, reload, fail again, then the floor lets it past.
    await ctx.sync['syncDoc'](DOC);
    await ctx.sync['syncDoc'](DOC);
    await ctx.sync['syncDoc'](DOC);

    // The batch landed on exactly the state the server computes when it replays this history.
    expect(ctx.doc.state).toEqual(
      applyChangesForReconstruction(SNAPSHOT.state, [poison, good], { onSkippedChange() {} })
    );
    expect(ctx.doc.state).toEqual({ title: 'x', note: 'kept' });
    expect(ctx.doc.committedRev).toBe(4);
    expect(ctx.sync.docStates.state[DOC].syncStatus).toBe('synced');
    expect(ctx.sync.docStates.state[DOC].committedRev).toBe(4);

    // Loud, once, and carrying everything a repair sweep needs.
    expect(ctx.skips).toHaveLength(1);
    expect(ctx.skips[0]).toMatchObject({ docId: DOC, changeId: poison.id, rev: 3 });
    expect((ctx.skips[0].cause as Error).name).toBe('ApplyChangesError');

    // The neutered change is what got persisted, so a rebuild from the store can't resurrect it.
    const rebuilt = await ctx.store.getDoc(DOC);
    expect(rebuilt?.state).toEqual({ title: 'x', note: 'kept' });

    // A re-delivery of the same batch never re-reports it.
    await ctx.sync['_applyServerChangesToDoc'](DOC, [poison, good]);
    expect(ctx.skips).toHaveLength(1);
  });

  it('skips the same poison arriving as commit-response catch-up (the flush vector)', async () => {
    const poison = committed(3, POISON_OPS);
    const ctx = await setup({
      commitChanges: vi.fn(async (_docId: string, changes: Change[]) => ({
        changes: [poison, { ...changes[0], rev: 4, committedAt: 2000 }],
      })),
    });

    ctx.doc.change(patch => patch.add('/note', 'mine'));
    await ctx.doc.flush();

    await ctx.sync['syncDoc'](DOC);
    await ctx.sync['syncDoc'](DOC);
    await ctx.sync['syncDoc'](DOC);
    await vi.waitFor(() => expect(ctx.sync.docStates.state[DOC].syncStatus).toBe('synced'));

    expect(ctx.skips).toHaveLength(1);
    expect(ctx.skips[0].changeId).toBe(poison.id);
    expect(ctx.doc.state).toEqual({ title: 'x', note: 'mine' });
    expect(ctx.doc.committedRev).toBe(4);
    expect(ctx.doc.getPendingChanges()).toEqual([]);
  });

  it('repairs a reload snapshot whose own committed tail cannot materialize', async () => {
    // The recovery of last resort: nothing else is left to try, so every retry re-fetches the
    // identical bytes. Both the state and the changes came straight from the server, so the
    // two-strike evidence bar is met by construction — skip on the first failure here.
    const poison = committed(3, POISON_OPS);
    const good = committed(4, [{ op: 'add', path: '/note', value: 'kept' }]);
    const ctx = await setup({ getDoc: vi.fn(async () => ({ ...SNAPSHOT, changes: [poison, good] })) });

    await ctx.sync['_reloadDocFromServer'](DOC, ctx.algorithm);

    expect(ctx.doc.state).toEqual({ title: 'x', note: 'kept' });
    expect(ctx.doc.committedRev).toBe(4);
    expect(ctx.skips).toHaveLength(1);
    expect(ctx.skips[0]).toMatchObject({ docId: DOC, changeId: poison.id, rev: 3 });
    // The repaired envelope was re-installed, so the store no longer holds unappliable history.
    expect((await ctx.store.getDoc(DOC))?.state).toEqual({ title: 'x', note: 'kept' });
  });

  it('never skips a failure the reload actually fixed — one strike is not the floor', async () => {
    // This replica's committed state drifted: `title` is a primitive here, an object on the
    // server. The change fails locally, then applies cleanly once the snapshot is installed.
    const note = committed(3, [{ op: 'add', path: '/note', value: 'n' }]);
    const drifted = committed(4, POISON_OPS);
    const ctx = await setup({
      getChangesSince: vi.fn(async (_docId: string, rev: number) => [note, drifted].filter(c => c.rev > rev)),
      getDoc: vi.fn(async () => ({ state: { title: { a: { b: 0 } }, note: 'n' }, rev: 3 })),
    });

    await ctx.sync['syncDoc'](DOC);
    await ctx.sync['syncDoc'](DOC);

    expect(ctx.skips).toEqual([]);
    // The once-failing change kept its content — nothing was neutered.
    expect(ctx.doc.state).toEqual({ title: { a: { b: 1 } }, note: 'n' });
    expect(ctx.doc.committedRev).toBe(4);
    expect(ctx.sync.docStates.state[DOC].syncStatus).toBe('synced');
  });
});
