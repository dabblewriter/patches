/**
 * FINDING-5 unit pin: PatchesSync._reloadDocFromServer must reconcile pending changes against
 * EVERYTHING the getDoc envelope installs as committed — through the envelope's last change
 * (the server head), not just through snapshot.rev (the last version boundary).
 *
 * saveDoc installs the envelope's whole changes tail as committed, so committedRev jumps to
 * the head and normal catch-up never redelivers (snapshot.rev, head]. Gating the reconcile on
 * `snapshot.rev > baseRev` therefore skipped it whenever the last version boundary sat at or
 * below the client's committedRev while the tail extended past it — pending minted below head
 * was imported on top of the head state un-rebased: strict apply threw (ApplyChangesError
 * crash-loop through the reload recovery path) or surviving ops landed at stale offsets.
 *
 * The fuzz suite's FINDING-5 regression seed exercises the harness's MIRROR of this logic, not
 * PatchesSync itself — this test pins the production code path directly with a fake connection.
 */
import { signal } from 'easy-signal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change, PatchesState } from '../../src/types.js';

function makeConnection(overrides: Record<string, any> = {}) {
  return {
    url: 'mock://server',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    subscribe: vi.fn(async (ids: string[]) => ids),
    unsubscribe: vi.fn(async () => {}),
    getDoc: vi.fn(async () => ({ state: null, rev: 0 })),
    getChangesSince: vi.fn(async () => []),
    commitChanges: vi.fn(async (_docId: string, changes: Change[]) => ({ changes })),
    deleteDoc: vi.fn(async () => {}),
    onStateChange: signal<(state: string) => void>(),
    onChangesCommitted: signal<(docId: string, changes: Change[]) => void>(),
    onDocDeleted: signal<(docId: string) => void>(),
    ...overrides,
  };
}

const mkChange = (id: string, rev: number, baseRev: number, path: string, value: any): Change => ({
  id,
  rev,
  baseRev,
  ops: [{ op: 'replace', path, value }],
  createdAt: rev,
  committedAt: rev,
});

describe('PatchesSync._reloadDocFromServer — reconcile window (FINDING-5)', () => {
  let sync: PatchesSync | undefined;

  afterEach(() => {
    sync?.disconnect();
    sync = undefined;
  });

  it('reconciles pending through the installed envelope tail when version rev <= baseRev < head', async () => {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    const patches = new Patches({ algorithms: { ot: algorithm } });
    await patches.trackDocs(['doc1']);

    // Local committed state sits at rev 5 with one pending change minted on it.
    await store.saveDoc('doc1', { state: { title: 'v5', n: 0 }, rev: 5 } as PatchesState);
    const pending = { ...mkChange('p1', 6, 5, '/n', 1), committedAt: undefined } as unknown as Change;
    await store.savePendingChanges('doc1', [pending]);

    // Server envelope: the last VERSION boundary is rev 5 (<= the client's baseRev), but the
    // changes tail extends to the head at rev 7 — saveDoc installs ALL of it as committed.
    const c6 = mkChange('c6', 6, 5, '/title', 'v6');
    const c7 = mkChange('c7', 7, 6, '/title', 'v7');
    // c8 committed after the envelope was cut: it is NOT installed by saveDoc and will arrive
    // through normal catch-up — it must be excluded from the reconcile window.
    const c8 = mkChange('c8', 8, 7, '/title', 'v8');
    const connection = makeConnection({
      getDoc: vi.fn(async () => ({ state: { title: 'v5', n: 0 }, rev: 5, changes: [c6, c7] })),
      getChangesSince: vi.fn(async (_id: string, rev: number) => [c6, c7, c8].filter(c => c.rev > rev)),
    });
    sync = new PatchesSync(patches, connection as any);
    const reconcileSpy = vi.spyOn(algorithm, 'reconcilePending');

    await (sync as any)._reloadDocFromServer('doc1', algorithm);

    // The reconcile window covers the FULL installed tail — (baseRev, installed head] — and
    // nothing past it.
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledWith('doc1', [c6, c7]);
    expect(connection.getChangesSince).toHaveBeenCalledWith('doc1', 5);

    // The store lands at the installed head with the pending change rebased into its frame —
    // never re-imported un-rebased on top of the head state.
    expect(await store.getCommittedRev('doc1')).toBe(7);
    const rebased = await store.getPendingChanges('doc1');
    expect(rebased.map(c => c.id)).toEqual(['p1']);
    expect(rebased[0].baseRev).toBe(7);
    expect(rebased[0].rev).toBe(8);
  });

  it('still skips the reconcile when the envelope installs nothing past the local committedRev', async () => {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    const patches = new Patches({ algorithms: { ot: algorithm } });
    await patches.trackDocs(['doc1']);

    await store.saveDoc('doc1', { state: { title: 'v5', n: 0 }, rev: 5 } as PatchesState);
    await store.savePendingChanges('doc1', [
      { ...mkChange('p1', 6, 5, '/n', 1), committedAt: undefined } as unknown as Change,
    ]);

    // Envelope head == local committedRev: nothing new is installed, pending needs no rebase.
    const connection = makeConnection({
      getDoc: vi.fn(async () => ({ state: { title: 'v5', n: 0 }, rev: 5, changes: [] })),
    });
    sync = new PatchesSync(patches, connection as any);
    const reconcileSpy = vi.spyOn(algorithm, 'reconcilePending');

    await (sync as any)._reloadDocFromServer('doc1', algorithm);

    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(connection.getChangesSince).not.toHaveBeenCalled();
    expect((await store.getPendingChanges('doc1')).map(c => c.id)).toEqual(['p1']);
  });
});
