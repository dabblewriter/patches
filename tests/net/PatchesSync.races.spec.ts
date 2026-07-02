import { signal } from 'easy-signal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { Patches } from '../../src/client/Patches';
import { PatchesSync } from '../../src/net/PatchesSync';
import type { Change, PatchesSnapshot } from '../../src/types';

// Races between PatchesSync and concurrent tracking/broadcast/edit activity, exercised
// with real Patches/OTAlgorithm/store components and a fake connection.

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

/** Mirrors OTIndexedDBStore: getDoc returns undefined for a tracked-but-empty doc. */
class UndefinedWhenEmptyStore extends OTInMemoryStore {
  async getDoc(docId: string): Promise<PatchesSnapshot | undefined> {
    const snap = await super.getDoc(docId);
    if (snap && snap.state == null && snap.rev === 0 && snap.changes.length === 0) return undefined;
    return snap;
  }
}

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

function makeChange(rev: number, baseRev: number, path: string, value: any): Change {
  return {
    id: `c${rev}`,
    rev,
    baseRev,
    ops: [{ op: 'replace', path, value }],
    createdAt: rev,
    committedAt: rev,
  };
}

describe('PatchesSync races', () => {
  let sync: PatchesSync | undefined;

  afterEach(() => {
    sync?.disconnect();
    sync = undefined;
  });

  describe('broadcast during initial snapshot fetch', () => {
    it('applies a contiguous broadcast that lands while getDoc is in flight', async () => {
      const store = new UndefinedWhenEmptyStore();
      const algorithm = new OTAlgorithm(store);
      const patches = new Patches({ algorithms: { ot: algorithm } });
      await patches.trackDocs(['doc1']);

      let resolveGetDoc!: (snapshot: any) => void;
      const connection = makeConnection({
        getDoc: vi.fn(() => new Promise(resolve => (resolveGetDoc = resolve))),
      });
      sync = new PatchesSync(patches, connection as any);
      const errors: Error[] = [];
      sync.onError(err => errors.push(err));

      connection.onStateChange.emit('connected');
      await vi.waitFor(() => expect(connection.getDoc).toHaveBeenCalled());

      // Server commits rev 6 and broadcasts it while the rev-5 snapshot fetch is in flight
      connection.onChangesCommitted.emit('doc1', [makeChange(6, 5, '/title', 'v6')]);
      await tick();
      resolveGetDoc({ state: { title: 'v5' }, rev: 5 });

      await vi.waitFor(async () => expect((await store.getDoc('doc1'))?.rev).toBe(6));
      expect((await store.getDoc('doc1'))?.state).toEqual({ title: 'v6' });
      expect(sync.docStates.state.doc1.committedRev).toBe(6);
      expect(sync.docStates.state.doc1.syncStatus).toBe('synced');
      expect(errors).toEqual([]);
      // Contiguous tail applied directly — no extra round trip needed
      expect(connection.getChangesSince).not.toHaveBeenCalled();
    });

    it('pulls the authoritative tail when the buffered broadcast has a gap', async () => {
      const store = new UndefinedWhenEmptyStore();
      const algorithm = new OTAlgorithm(store);
      const patches = new Patches({ algorithms: { ot: algorithm } });
      await patches.trackDocs(['doc1']);

      const c6 = makeChange(6, 5, '/title', 'v6');
      const c7 = makeChange(7, 6, '/title', 'v7');
      let resolveGetDoc!: (snapshot: any) => void;
      const connection = makeConnection({
        getDoc: vi.fn(() => new Promise(resolve => (resolveGetDoc = resolve))),
        getChangesSince: vi.fn(async (_id: string, rev: number) => [c6, c7].filter(c => c.rev > rev)),
      });
      sync = new PatchesSync(patches, connection as any);

      connection.onStateChange.emit('connected');
      await vi.waitFor(() => expect(connection.getDoc).toHaveBeenCalled());

      // Only rev 7 reaches the client mid-fetch (rev 6 was dropped by the transport)
      connection.onChangesCommitted.emit('doc1', [c7]);
      await tick();
      resolveGetDoc({ state: { title: 'v5' }, rev: 5 });

      await vi.waitFor(async () => expect((await store.getDoc('doc1'))?.rev).toBe(7));
      expect((await store.getDoc('doc1'))?.state).toEqual({ title: 'v7' });
      expect(connection.getChangesSince).toHaveBeenCalledWith('doc1', 5);
      expect(sync.docStates.state.doc1.syncStatus).toBe('synced');
    });
  });

  describe('local edit minted during initial snapshot fetch', () => {
    it('never commits a root-replace re-stamped past the server baseRev-0 guard', async () => {
      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store);
      const patches = new Patches({ algorithms: { ot: algorithm } });
      const doc = await patches.openDoc<any>('doc1');

      const commitBaseRevs: number[] = [];
      let resolveGetDoc!: (snapshot: any) => void;
      const connection = makeConnection({
        getDoc: vi.fn(() => new Promise(resolve => (resolveGetDoc = resolve))),
        commitChanges: vi.fn(async (_docId: string, changes: Change[]) => {
          commitBaseRevs.push(changes[0].baseRev);
          // Mirror the server guard (commitChanges.ts): a root op at baseRev 0 on an
          // existing doc is rejected; it only fires when the true baseRev 0 is sent.
          if (changes[0].baseRev === 0 && changes.some(c => c.ops.some(op => op.path === ''))) {
            throw new Error('Document doc1 already exists');
          }
          throw new Error(`guard bypassed: commit arrived at baseRev ${changes[0].baseRev}`);
        }),
      });
      sync = new PatchesSync(patches, connection as any);
      sync.onError(() => {});

      connection.onStateChange.emit('connected');
      await vi.waitFor(() => expect(connection.getDoc).toHaveBeenCalled());

      // The classic "init the empty doc" pattern racing the initial load
      doc.change(patch => patch.replace('', { title: 'Fresh from device B' }));
      await vi.waitFor(async () => expect(await algorithm.hasPending('doc1')).toBe(true));

      resolveGetDoc({ state: { title: 'Existing novel' }, rev: 2 });
      await vi.waitFor(() => expect(connection.commitChanges).toHaveBeenCalled());
      await tick(20);

      // Every attempt kept the true baseRev 0, so the server guard stayed in the loop
      // (previously the change was re-stamped to baseRev 2 and wiped the server doc).
      expect(commitBaseRevs.length).toBeGreaterThan(0);
      expect(commitBaseRevs.every(baseRev => baseRev === 0)).toBe(true);
    });

    it('heals a non-root change minted mid-fetch through the server baseRev-0 reload path', async () => {
      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store);
      const patches = new Patches({ algorithms: { ot: algorithm } });
      const doc = await patches.openDoc<any>('doc1');

      const serverLog: Change[] = [makeChange(1, 0, '/title', 'Existing')];
      let gateFirstGetDoc = true;
      let resolveGetDoc!: (snapshot: any) => void;
      const connection = makeConnection({
        getDoc: vi.fn(async () => {
          if (gateFirstGetDoc) {
            gateFirstGetDoc = false;
            return new Promise(resolve => (resolveGetDoc = resolve));
          }
          return { state: applyChanges(null, serverLog), rev: serverLog.at(-1)!.rev };
        }),
        commitChanges: vi.fn(async (_docId: string, changes: Change[]) => {
          let rev = serverLog.at(-1)!.rev;
          const docReloadRequired = changes[0].baseRev === 0 && rev > 0 ? true : undefined;
          const committed = changes.map(c => ({ ...c, baseRev: rev, rev: ++rev, committedAt: Date.now() }));
          serverLog.push(...committed);
          return { changes: committed, docReloadRequired };
        }),
      });
      sync = new PatchesSync(patches, connection as any);

      connection.onStateChange.emit('connected');
      await vi.waitFor(() => expect(connection.getDoc).toHaveBeenCalled());

      doc.change(patch => patch.replace('/note', 'minted mid-fetch'));
      await vi.waitFor(async () => expect(await algorithm.hasPending('doc1')).toBe(true));

      resolveGetDoc({ state: { title: 'Existing' }, rev: 1 });

      await vi.waitFor(async () => expect(await algorithm.hasPending('doc1')).toBe(false));
      await vi.waitFor(async () => expect((await store.getDoc('doc1'))?.rev).toBe(2));
      expect((await store.getDoc('doc1'))?.state).toEqual({ title: 'Existing', note: 'minted mid-fetch' });
      expect(sync.docStates.state.doc1.syncStatus).toBe('synced');
    });
  });

  describe('broadcast parked during a flush-pending-first reload', () => {
    it('reconciles a broadcast parked while the reload flushed pending instead of destroying it', async () => {
      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store);
      const patches = new Patches({ algorithms: { ot: algorithm } });

      // The doc already exists on the server at rev 1.
      const serverLog: Change[] = [makeChange(1, 0, '/title', 'Existing')];
      const connection = makeConnection({
        getDoc: vi.fn(async () => ({ state: applyChanges(null, serverLog), rev: serverLog.at(-1)!.rev })),
        getChangesSince: vi.fn(async (_id: string, rev: number) => serverLog.filter(c => c.rev > rev)),
        commitChanges: vi.fn(async (_docId: string, changes: Change[]) => {
          // Commit at the tip. A transport is not required to signal docReloadRequired for
          // a non-root baseRev-0 batch (LWW servers never do, OT batched continuations
          // don't), so the flush-pending-first path can return without a snapshot reload.
          const catchup = serverLog.filter(c => c.rev > (changes[0].baseRev ?? 0));
          let rev = serverLog.at(-1)!.rev;
          const committed = changes.map(c => ({ ...c, baseRev: rev, rev: ++rev, committedAt: Date.now() }));
          serverLog.push(...committed);
          // A foreign client commits right behind ours — its broadcast beats our RPC response.
          const foreign = makeChange(rev + 1, rev, '/foreign', 'landed-during-flush');
          serverLog.push(foreign);
          connection.onChangesCommitted.emit('doc1', [foreign]);
          await tick(); // let the broadcast park in the reload buffer before the RPC resolves
          return { changes: [...catchup, ...committed] };
        }),
      });
      sync = new PatchesSync(patches, connection as any);
      // Focused on the reload path: block the auto syncDoc triggers so a queued follow-up's
      // getChangesSince catch-up can't mask the buffer destruction this test guards against.
      vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
      sync['updateState']({ connected: true });
      await patches.trackDocs(['doc1']);

      // A local edit exists before the reload flushes (the brand-new-doc hydration race).
      await algorithm.handleDocChange(
        'doc1',
        [{ op: 'replace', path: '/note', value: 'minted before reload' }],
        undefined,
        {}
      );

      await sync['_reloadDocFromServer']('doc1', algorithm, true);

      // The parked broadcast was reconciled by the reload itself — contiguous with the
      // flush's commit echo, so applied directly without a getChangesSince round trip.
      expect((await store.getDoc('doc1'))?.rev).toBe(3);
      expect((await store.getDoc('doc1'))?.state).toEqual({
        title: 'Existing',
        note: 'minted before reload',
        foreign: 'landed-during-flush',
      });
      expect(connection.getChangesSince).not.toHaveBeenCalled();
    });
  });

  describe('tracking racing syncAllKnownDocs', () => {
    function gateFirstListDocs(algorithm: OTAlgorithm) {
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      const origListDocs = algorithm.listDocs.bind(algorithm);
      let gated = false;
      vi.spyOn(algorithm, 'listDocs').mockImplementation(async includeDeleted => {
        const docs = await origListDocs(includeDeleted);
        if (!gated && includeDeleted) {
          gated = true;
          await gate; // snapshot taken, rebuild stalled — the race window
        }
        return docs;
      });
      return release;
    }

    it('keeps a doc tracked during the rebuild window and still flushes its edits', async () => {
      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store);
      const patches = new Patches({ algorithms: { ot: algorithm } });
      await patches.trackDocs(['docA']);

      const commitCalls: string[] = [];
      const connection = makeConnection({
        commitChanges: vi.fn(async (docId: string, changes: Change[]) => {
          commitCalls.push(docId);
          return { changes: changes.map(c => ({ ...c, committedAt: Date.now() })) };
        }),
      });
      const releaseListDocs = gateFirstListDocs(algorithm);
      sync = new PatchesSync(patches, connection as any);

      connection.onStateChange.emit('connected');
      await tick();

      // Tracked while syncAllKnownDocs holds a stale store snapshot
      await patches.trackDocs(['docB']);
      await tick();

      releaseListDocs();
      await vi.waitFor(() => expect(sync!.state.syncStatus).toBe('synced'));

      expect((sync as any).trackedDocs.has('docB')).toBe(true);
      expect(sync.docStates.state.docB).toBeDefined();

      // Edits to the concurrently tracked doc must reach the server
      const doc = await patches.openDoc<{ text?: string }>('docB');
      doc.change(patch => patch.replace('/text', 'hello'));
      await vi.waitFor(() => expect(commitCalls).toContain('docB'));
    });

    it('keeps a doc untracked then re-tracked during the rebuild window syncing', async () => {
      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store);
      const patches = new Patches({ algorithms: { ot: algorithm } });
      await patches.trackDocs(['docA', 'docB']);

      const commitCalls: string[] = [];
      const connection = makeConnection({
        commitChanges: vi.fn(async (docId: string, changes: Change[]) => {
          commitCalls.push(docId);
          return { changes: changes.map(c => ({ ...c, committedAt: Date.now() })) };
        }),
      });
      const releaseListDocs = gateFirstListDocs(algorithm);
      sync = new PatchesSync(patches, connection as any);

      connection.onStateChange.emit('connected');
      await tick();

      // Untracked, then re-tracked, while syncAllKnownDocs holds a stale store snapshot.
      await patches.untrackDocs(['docB']);
      await tick();
      await patches.trackDocs(['docB']);
      await tick();

      // Re-tracking must clear the untracked-during-resync mark — a stale mark makes the
      // rebuild treat docB as still untracked and silently stop syncing it.
      expect((sync as any)._untrackedDuringResync?.has('docB')).toBe(false);

      releaseListDocs();
      await vi.waitFor(() => expect(sync!.state.syncStatus).toBe('synced'));

      expect((sync as any).trackedDocs.has('docB')).toBe(true);
      expect(sync.docStates.state.docB).toBeDefined();

      // Edits to the re-tracked doc must still reach the server
      const doc = await patches.openDoc<{ text?: string }>('docB');
      doc.change(patch => patch.replace('/text', 'back again'));
      await vi.waitFor(() => expect(commitCalls).toContain('docB'));
    });

    it('does not resurrect a doc untracked during the rebuild window', async () => {
      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store);
      const patches = new Patches({ algorithms: { ot: algorithm } });
      await patches.trackDocs(['docA', 'docB']);

      const connection = makeConnection();
      const releaseListDocs = gateFirstListDocs(algorithm);
      sync = new PatchesSync(patches, connection as any);

      connection.onStateChange.emit('connected');
      await tick();

      // Untracked while syncAllKnownDocs holds a stale snapshot that still lists docB
      await patches.untrackDocs(['docB']);
      await tick();

      releaseListDocs();
      await vi.waitFor(() => expect(sync!.state.syncStatus).toBe('synced'));

      expect((sync as any).trackedDocs.has('docB')).toBe(false);
      expect(sync.docStates.state.docB).toBeUndefined();
      expect((sync as any).trackedDocs.has('docA')).toBe(true);
      expect(sync.docStates.state.docA).toBeDefined();
    });
  });
});
