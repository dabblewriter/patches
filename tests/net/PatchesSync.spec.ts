import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Patches } from '../../src/client/Patches';
import type { AlgorithmName, TrackedDoc } from '../../src/client/PatchesStore';
import { MissingChangesError } from '../../src/algorithms/ot/client/applyCommittedChanges';
import { ApplyChangesError } from '../../src/algorithms/ot/shared/applyChanges';
import { PatchesSync } from '../../src/net/PatchesSync';
import { NetworkError, StatusError } from '../../src/net/error';
import { PatchesWebSocket } from '../../src/net/websocket/PatchesWebSocket';
import { onlineState } from '../../src/net/websocket/onlineState';
import type { Change } from '../../src/types';

// Mock all external dependencies
vi.mock('../../src/client/Patches');
vi.mock('../../src/net/websocket/PatchesWebSocket');
vi.mock('../../src/net/websocket/onlineState');
vi.mock('@dabble/delta', () => ({
  isEqual: vi.fn((a, b) => JSON.stringify(a) === JSON.stringify(b)),
}));
vi.mock('../../src/algorithms/ot/client/applyCommittedChanges', async importActual => {
  const actual = await importActual<typeof import('../../src/algorithms/ot/client/applyCommittedChanges')>();
  return {
    applyCommittedChanges: vi.fn(() => ({
      state: { content: 'updated' },
      rev: 6,
      changes: [],
    })),
    // Re-export the real typed error so `instanceof MissingChangesError` resolves in PatchesSync.
    MissingChangesError: actual.MissingChangesError,
  };
});
vi.mock('../../src/algorithms/ot/shared/changeBatching', () => ({
  breakChangesIntoBatches: vi.fn(changes => [changes]),
}));

describe('PatchesSync', () => {
  let mockPatches: any;
  let mockStore: any;
  let mockAlgorithm: any;
  let mockWebSocket: any;
  let sync: PatchesSync;

  beforeEach(() => {
    // Mock PatchesStore
    mockStore = {
      listDocs: vi.fn().mockResolvedValue([]),
      getPendingChanges: vi.fn().mockResolvedValue([]),
      getCommittedRev: vi.fn().mockResolvedValue(0),
      saveDoc: vi.fn().mockResolvedValue(undefined),
      applyServerChanges: vi.fn().mockResolvedValue(undefined),
      confirmDeleteDoc: vi.fn().mockResolvedValue(undefined),
      getDoc: vi.fn().mockResolvedValue({
        state: { content: 'test' },
        rev: 5,
        changes: [],
      }),
      getLastAttemptedSubmissionRev: vi.fn().mockResolvedValue(undefined),
      setLastAttemptedSubmissionRev: vi.fn().mockResolvedValue(undefined),
    };

    // Mock algorithm
    mockAlgorithm = {
      name: 'ot',
      store: mockStore,
      hasPending: vi.fn().mockResolvedValue(false),
      getPendingToSend: vi.fn().mockResolvedValue(null),
      applyServerChanges: vi.fn().mockResolvedValue([]),
      confirmSent: vi.fn().mockResolvedValue(undefined),
      dropResolvedPending: vi.fn().mockResolvedValue(0),
      reconcilePending: vi.fn().mockResolvedValue(undefined),
      getCommittedRev: vi.fn().mockResolvedValue(0),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      confirmDeleteDoc: vi.fn().mockResolvedValue(undefined),
      loadDoc: vi.fn().mockResolvedValue(undefined),
      trackDocs: vi.fn().mockResolvedValue(undefined),
      untrackDocs: vi.fn().mockResolvedValue(undefined),
      listDocs: vi.fn().mockResolvedValue([]),
    };

    // Mock Patches
    mockPatches = {
      algorithms: { ot: mockAlgorithm },
      defaultAlgorithm: 'ot',
      trackedDocs: ['doc1', 'doc2'],
      docOptions: { maxPayloadBytes: 1000 },
      getOpenDoc: vi.fn().mockReturnValue(null),
      applySnapshot: vi.fn(),
      getDocAlgorithm: vi.fn().mockReturnValue(mockAlgorithm),
      onTrackDocs: vi.fn(),
      onUntrackDocs: vi.fn(),
      onDeleteDoc: vi.fn(),
      onChange: vi.fn(),
    };

    // Mock PatchesWebSocket
    mockWebSocket = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(['doc1', 'doc2']),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      getDoc: vi.fn().mockResolvedValue({
        state: { content: 'server' },
        rev: 10,
      }),
      getChangesSince: vi.fn().mockResolvedValue([]),
      commitChanges: vi.fn().mockResolvedValue({ changes: [] }),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      rpc: { call: vi.fn(), notify: vi.fn(), on: vi.fn() },
      onStateChange: vi.fn(),
      onChangesCommitted: vi.fn(),
      onDocDeleted: vi.fn(),
    };

    // Mock constructors - use function expressions for Vitest 4 compatibility
    vi.mocked(Patches).mockImplementation(function () {
      return mockPatches;
    });
    vi.mocked(PatchesWebSocket).mockImplementation(function () {
      return mockWebSocket;
    });

    // Mock onlineState
    Object.defineProperty(vi.mocked(onlineState), 'isOnline', {
      get: vi.fn().mockReturnValue(true),
      configurable: true,
    });
    Object.defineProperty(vi.mocked(onlineState), 'isOffline', {
      get: vi.fn().mockReturnValue(false),
      configurable: true,
    });
    vi.mocked(onlineState).onOnlineChange = vi.fn() as any;

    sync = new PatchesSync(mockPatches, 'ws://localhost:8080');
  });

  afterEach(() => {
    // Cancel any retry timer a test left scheduled so it can't fire into a later test.
    (sync as any)?._clearAllSyncRetries?.();
    vi.clearAllMocks();
  });

  function setOffline(offline: boolean) {
    Object.defineProperty(vi.mocked(onlineState), 'isOffline', {
      get: vi.fn().mockReturnValue(offline),
      configurable: true,
    });
    Object.defineProperty(vi.mocked(onlineState), 'isOnline', {
      get: vi.fn().mockReturnValue(!offline),
      configurable: true,
    });
  }

  describe('constructor', () => {
    it('should initialize with patches and websocket', () => {
      expect(sync).toBeInstanceOf(PatchesSync);
      expect(PatchesWebSocket).toHaveBeenCalledWith('ws://localhost:8080', undefined);
    });

    it('should initialize with websocket options', () => {
      const wsOptions = { authToken: 'token123' } as any;
      new PatchesSync(mockPatches, 'ws://localhost:8080', { websocket: wsOptions });

      expect(PatchesWebSocket).toHaveBeenCalledWith('ws://localhost:8080', wsOptions);
    });

    it('should set up event listeners', () => {
      expect(onlineState.onOnlineChange).toHaveBeenCalled();
      expect(mockWebSocket.onStateChange).toHaveBeenCalled();
      expect(mockWebSocket.onChangesCommitted).toHaveBeenCalled();
      expect(mockPatches.onTrackDocs).toHaveBeenCalled();
      expect(mockPatches.onUntrackDocs).toHaveBeenCalled();
      expect(mockPatches.onDeleteDoc).toHaveBeenCalled();
    });

    it('should initialize state with online status', () => {
      expect(sync.state.online).toBe(true);
      expect(sync.state.connected).toBe(false);
      expect(sync.state.syncStatus).toBe('unsynced');
    });

    it('should track existing docs from patches', () => {
      expect(sync['trackedDocs'].has('doc1')).toBe(true);
      expect(sync['trackedDocs'].has('doc2')).toBe(true);
    });

    it('should throw when branchStore is provided without branchApi', () => {
      expect(
        () =>
          new PatchesSync(mockPatches, 'ws://localhost:8080', {
            branchStore: {} as any,
          })
      ).toThrow('branchApi is required when branchStore is provided');
    });
  });

  describe('state management', () => {
    it('should return current state', () => {
      const state = sync.state;
      expect(state).toEqual({
        online: true,
        connected: false,
        syncStatus: 'unsynced',
        syncError: undefined,
      });
    });

    it('should emit state change when state updates', () => {
      const stateHandler = vi.fn();
      sync.subscribe(stateHandler, false);

      sync['updateState']({ connected: true });

      expect(stateHandler).toHaveBeenCalledWith({
        online: true,
        connected: true,
        syncStatus: 'unsynced',
        syncError: undefined,
      });
    });

    it('should not emit if state has not changed', () => {
      const stateHandler = vi.fn();
      sync.subscribe(stateHandler, false);

      sync['updateState']({ online: true }); // Same as current state

      expect(stateHandler).not.toHaveBeenCalled();
    });

    it('should handle online state changes', () => {
      const onlineHandler = vi.mocked(onlineState.onOnlineChange).mock.calls[0][0];
      const stateHandler = vi.fn();
      sync.subscribe(stateHandler, false);

      onlineHandler(false);

      expect(stateHandler).toHaveBeenCalledWith({
        online: false,
        connected: false,
        syncStatus: 'unsynced',
        syncError: undefined,
      });
    });
  });

  describe('connect method', () => {
    it('should connect via websocket', async () => {
      await sync.connect();

      expect(mockWebSocket.connect).toHaveBeenCalled();
    });

    it('should handle connection errors', async () => {
      const error = new Error('Connection failed');
      mockWebSocket.connect.mockRejectedValue(error);

      await expect(sync.connect()).rejects.toThrow('Connection failed');

      expect(sync.state.connected).toBe(false);
      expect(sync.state.syncStatus).toBe('error');
    });

    it('should handle non-Error connection failures', async () => {
      mockWebSocket.connect.mockRejectedValue('string error');

      await expect(sync.connect()).rejects.toBe('string error');

      expect(sync.state.syncStatus).toBe('error');
    });
  });

  describe('disconnect method', () => {
    it('should disconnect and reset state', () => {
      sync['updateState']({ connected: true, syncStatus: 'syncing' });

      sync.disconnect();

      expect(mockWebSocket.disconnect).toHaveBeenCalled();
      expect(sync.state.connected).toBe(false);
      expect(sync.state.syncStatus).toBe('unsynced');
    });
  });

  describe('syncAllKnownDocs method', () => {
    beforeEach(() => {
      sync['updateState']({ connected: true });
    });

    it('should sync all active documents', async () => {
      const activeDocs: TrackedDoc[] = [
        { docId: 'doc1', committedRev: 0 },
        { docId: 'doc2', committedRev: 0 },
      ];

      // Sync now calls algorithm.listDocs, not store.listDocs
      mockAlgorithm.listDocs.mockResolvedValue(activeDocs);

      const syncDocSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      await sync['syncAllKnownDocs']();

      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['doc1', 'doc2']);
      expect(syncDocSpy).toHaveBeenCalledWith('doc1');
      expect(syncDocSpy).toHaveBeenCalledWith('doc2');
      expect(sync.state.syncStatus).toBe('synced');
    });

    it('should handle deleted documents', async () => {
      const docs: TrackedDoc[] = [
        { docId: 'doc1', committedRev: 0 },
        { docId: 'doc2', deleted: true, committedRev: 0 },
      ];

      // Sync now calls algorithm.listDocs, not store.listDocs
      mockAlgorithm.listDocs.mockResolvedValue(docs);

      await sync['syncAllKnownDocs']();

      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['doc1']);
      expect(mockWebSocket.deleteDoc).toHaveBeenCalledWith('doc2');
      // Sync now calls algorithm.confirmDeleteDoc, not store.confirmDeleteDoc
      expect(mockAlgorithm.confirmDeleteDoc).toHaveBeenCalledWith('doc2');
    });

    it('should not sync if not connected', async () => {
      sync['updateState']({ connected: false });

      const syncDocSpy = vi.spyOn(sync as any, 'syncDoc');

      await sync['syncAllKnownDocs']();

      expect(syncDocSpy).not.toHaveBeenCalled();
    });

    it('should keep docs tracked concurrently during the rebuild window', async () => {
      let releaseListDocs!: () => void;
      const gate = new Promise<void>(resolve => (releaseListDocs = resolve));
      mockAlgorithm.listDocs.mockImplementation(async () => {
        await gate;
        return [{ docId: 'doc1', committedRev: 5 }];
      });
      vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      const syncAll = sync['syncAllKnownDocs']();
      // Tracked while the store snapshot read is in flight
      const trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls[0][0];
      await trackHandler(['docNew'], 'ot');
      expect(sync['trackedDocs'].has('docNew')).toBe(true);

      releaseListDocs();
      await syncAll;

      // The stale snapshot must not evict the concurrently tracked doc
      expect(sync['trackedDocs'].has('docNew')).toBe(true);
      expect(sync.docStates.state.docNew).toBeDefined();
      expect(sync['trackedDocs'].has('doc1')).toBe(true);
    });

    it('should not resurrect docs untracked during the rebuild window', async () => {
      let releaseListDocs!: () => void;
      const gate = new Promise<void>(resolve => (releaseListDocs = resolve));
      mockAlgorithm.listDocs.mockImplementation(async () => {
        await gate;
        // Stale snapshot: still lists doc2, untracked mid-rebuild below
        return [
          { docId: 'doc1', committedRev: 5 },
          { docId: 'doc2', committedRev: 3 },
        ];
      });
      vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      const syncAll = sync['syncAllKnownDocs']();
      const untrackHandler = vi.mocked(mockPatches.onUntrackDocs).mock.calls[0][0];
      await untrackHandler(['doc2']);

      releaseListDocs();
      await syncAll;

      expect(sync['trackedDocs'].has('doc2')).toBe(false);
      expect(sync.docStates.state.doc2).toBeUndefined();
      expect(sync.docStates.state.doc1).toBeDefined();
    });
  });

  describe('syncDoc method', () => {
    beforeEach(() => {
      sync['updateState']({ connected: true });
    });

    it('should sync document with pending changes', async () => {
      const pendingChanges: Change[] = [
        {
          id: 'c1',
          rev: 1,
          baseRev: 0,
          ops: [],
          createdAt: 0,
          committedAt: 0,
        },
      ];

      // Sync now calls algorithm methods
      mockAlgorithm.getPendingToSend.mockResolvedValue(pendingChanges);

      const flushDocSpy = vi.spyOn(sync as any, 'flushDoc').mockResolvedValue(undefined);

      await sync['syncDoc']('doc1');

      expect(flushDocSpy).toHaveBeenCalledWith('doc1', pendingChanges);
    });

    it('should sync document without pending changes', async () => {
      // Sync now calls algorithm methods
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);

      const serverChanges: Change[] = [
        {
          id: 'c2',
          rev: 6,
          baseRev: 5,
          ops: [],
          createdAt: 0,
          committedAt: 0,
        },
      ];

      mockWebSocket.getChangesSince.mockResolvedValue(serverChanges);

      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);

      await sync['syncDoc']('doc1');

      expect(mockWebSocket.getChangesSince).toHaveBeenCalledWith('doc1', 5);
      expect(applySpy).toHaveBeenCalledWith('doc1', serverChanges);
    });

    it('should get full document snapshot if no committed rev', async () => {
      // Sync now calls algorithm methods
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(0); // No committed rev

      const snapshot = { state: { content: 'new' }, rev: 1, changes: [] };
      mockWebSocket.getDoc.mockResolvedValue(snapshot);

      await sync['syncDoc']('doc1');

      expect(mockWebSocket.getDoc).toHaveBeenCalledWith('doc1');
      // Sync saves the doc via algorithm.store.saveDoc (no open doc, so no importDoc)
      expect(mockAlgorithm.store.saveDoc).toHaveBeenCalledWith('doc1', snapshot);
    });

    it('should update open document syncing state', async () => {
      const mockDoc = {
        updateSyncStatus: vi.fn(),
        import: vi.fn(),
      };

      const snapshot = { state: { content: 'new' }, rev: 1 };
      mockWebSocket.getDoc.mockResolvedValue(snapshot);

      mockPatches.getOpenDoc.mockReturnValue(mockDoc);
      // Sync now calls algorithm methods
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(0);

      await sync['syncDoc']('doc1');

      expect(mockDoc.updateSyncStatus).toHaveBeenCalledWith('syncing');
      expect(mockDoc.updateSyncStatus).toHaveBeenCalledWith('synced');
    });

    it('should route fresh-doc snapshot through patches.applySnapshot and reach the doc', async () => {
      const mockDoc = {
        updateSyncStatus: vi.fn(),
        import: vi.fn(),
      };

      const snapshot = { state: { content: 'new' }, rev: 1 };
      mockWebSocket.getDoc.mockResolvedValue(snapshot);

      mockPatches.getOpenDoc.mockReturnValue(mockDoc);
      // Wire applySnapshot to forward to the open doc, so the test verifies the full
      // delivery route (DAB-503), not just that PatchesSync called the right method.
      mockPatches.applySnapshot.mockImplementation((_docId: string, s: any) => mockDoc.import(s));
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(0);
      // After saveDoc, sync re-reads via loadDoc so import() sees any pending the store
      // preserved across saveDoc (DAB-507 fix). Mock loadDoc to return the snapshot with
      // a representative pending change to assert that path through.
      const storeSnapshot = { ...snapshot, changes: [{ id: 'p1', rev: 2, baseRev: 1, ops: [], created: 0 } as any] };
      mockAlgorithm.loadDoc.mockResolvedValue(storeSnapshot);

      await sync['syncDoc']('doc1');

      expect(mockAlgorithm.loadDoc).toHaveBeenCalledWith('doc1');
      expect(mockPatches.applySnapshot).toHaveBeenCalledWith('doc1', storeSnapshot);
      expect(mockDoc.import).toHaveBeenCalledWith(storeSnapshot);
    });

    it('should not sync if not connected', async () => {
      sync['updateState']({ connected: false });

      await sync['syncDoc']('doc1');

      // Sync now calls algorithm methods
      expect(mockAlgorithm.getPendingToSend).not.toHaveBeenCalled();
    });

    it('should not sync if offline even when connection state is stale-connected', async () => {
      // Worker: state.connected can stay stale-true; onlineState.isOffline gates it.
      setOffline(true);

      await sync['syncDoc']('doc1');

      expect(mockAlgorithm.getPendingToSend).not.toHaveBeenCalled();
    });
  });

  describe('committed-changes gap recovery (SSE-2)', () => {
    it('falls back to syncDoc when applying a non-contiguous server change throws MissingChangesError', async () => {
      const gapErr = new MissingChangesError(6, 9, 5);
      vi.spyOn(sync as any, '_applyServerChangesToDoc').mockRejectedValue(gapErr);
      const syncDocSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
      const onError = vi.fn();
      sync.onError(onError);

      await sync['_receiveCommittedChanges']('doc1', [
        { id: 'c', rev: 9, baseRev: 8, ops: [], createdAt: 1, committedAt: 1 },
      ]);

      // Gap recovered by pulling the authoritative tail — not silently dropped.
      expect(syncDocSpy).toHaveBeenCalledWith('doc1');
      expect(onError).not.toHaveBeenCalled();
    });

    it('emits onError without syncDoc for a non-gap apply error', async () => {
      const otherErr = new Error('some other failure');
      vi.spyOn(sync as any, '_applyServerChangesToDoc').mockRejectedValue(otherErr);
      const syncDocSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
      const onError = vi.fn();
      sync.onError(onError);

      await sync['_receiveCommittedChanges']('doc1', [
        { id: 'c', rev: 6, baseRev: 5, ops: [], createdAt: 1, committedAt: 1 },
      ]);

      expect(syncDocSpy).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(otherErr, { docId: 'doc1' });
    });
  });

  describe('apply-failure recovery (P-1)', () => {
    it('falls back to syncDoc when a committed change fails to apply (ApplyChangesError)', async () => {
      // A change that fails to apply must trigger recovery — silently skipping it would
      // diverge this client from every other client that applied it, with zero signal.
      const applyErr = new ApplyChangesError('c-bad', 6, 0, new Error('[op:add] invalid path'));
      vi.spyOn(sync as any, '_applyServerChangesToDoc').mockRejectedValue(applyErr);
      const syncDocSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
      const onError = vi.fn();
      sync.onError(onError);

      await expect(
        sync['_receiveCommittedChanges']('doc1', [
          { id: 'c-bad', rev: 6, baseRev: 5, ops: [], createdAt: 1, committedAt: 1 },
        ])
      ).resolves.toBeUndefined(); // recovered, not an unhandled rejection

      expect(syncDocSpy).toHaveBeenCalledWith('doc1');
    });

    it('syncDoc recovers from an ApplyChangesError during catch-up by reloading the authoritative snapshot', async () => {
      sync['updateState']({ connected: true });
      const applyErr = new ApplyChangesError('c-bad', 6, 0, new Error('bad op'));
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
      mockWebSocket.getChangesSince.mockResolvedValue([
        { id: 'c-bad', rev: 6, baseRev: 5, ops: [], createdAt: 1, committedAt: 1 },
      ]);
      mockAlgorithm.applyServerChanges.mockRejectedValue(applyErr);
      const snapshot = { state: { content: 'authoritative' }, rev: 6 };
      mockWebSocket.getDoc.mockResolvedValue(snapshot);
      const onError = vi.fn();
      sync.onError(onError);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await sync['syncDoc']('doc1');

      // Surfaced for telemetry even though recovery succeeded — a failed apply is a
      // corruption signal, unlike a benign rev gap.
      expect(onError).toHaveBeenCalledWith(applyErr, { docId: 'doc1' });
      // Recovered by pulling the full authoritative snapshot (incremental catch-up
      // would refetch the same changes and fail the same way).
      expect(mockWebSocket.getDoc).toHaveBeenCalledWith('doc1');
      expect(mockAlgorithm.store.saveDoc).toHaveBeenCalledWith('doc1', snapshot);
      expect(sync.docStates.state['doc1']?.syncStatus).toBe('synced');
      consoleSpy.mockRestore();
    });

    it('falls through to normal error handling when the snapshot reload also fails', async () => {
      sync['updateState']({ connected: true });
      const applyErr = new ApplyChangesError('c-bad', 6, 0, new Error('bad op'));
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
      mockWebSocket.getChangesSince.mockResolvedValue([
        { id: 'c-bad', rev: 6, baseRev: 5, ops: [], createdAt: 1, committedAt: 1 },
      ]);
      mockAlgorithm.applyServerChanges.mockRejectedValue(applyErr);
      mockWebSocket.getDoc.mockRejectedValue(new Error('network down'));
      const onError = vi.fn();
      sync.onError(onError);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await sync['syncDoc']('doc1');

      // Original apply failure still surfaced; the doc lands in error state (with a
      // scheduled transient retry) instead of crashing or silently dropping the batch.
      expect(onError).toHaveBeenCalledWith(applyErr, { docId: 'doc1' });
      expect(sync.docStates.state['doc1']?.syncStatus).toBe('error');
      consoleSpy.mockRestore();
    });
  });

  describe('recovery pending reconciliation (double-commit guard)', () => {
    beforeEach(() => {
      sync['updateState']({ connected: true });
    });

    it('reconciles just-committed pending against the tail before adopting the reloaded snapshot', async () => {
      // The dangerous shape: the commit SUCCEEDS on the wire (server tip now includes the
      // batch), but the echo fails to apply locally before anything persists — pending
      // still holds the batch. The reloaded snapshot's state already contains those edits,
      // so preserving pending verbatim would re-apply them (doubled content) and re-send
      // them past the server's idempotency window (permanent duplication).
      const pending: Change[] = [
        { id: 'b1', rev: 6, baseRev: 5, ops: [{ op: 'add', path: '/a', value: 1 }], createdAt: 1, committedAt: 0 },
      ];
      mockAlgorithm.getPendingToSend.mockResolvedValueOnce(pending);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
      const committedEcho = [{ ...pending[0], committedAt: 100 }];
      mockWebSocket.commitChanges.mockResolvedValue({ changes: committedEcho });
      mockAlgorithm.applyServerChanges.mockRejectedValue(new ApplyChangesError('b1', 6, 0, new Error('bad op')));
      mockWebSocket.getDoc.mockResolvedValue({ state: { a: 1 }, rev: 6 });
      mockWebSocket.getChangesSince.mockResolvedValue(committedEcho);
      // Pending exists going into recovery; reconciliation clears it (all committed).
      mockAlgorithm.hasPending.mockResolvedValueOnce(true).mockResolvedValue(false);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await sync['syncDoc']('doc1');

      // The committed tail is fetched from the pre-reload rev and pending reconciled
      // against it — dropping the already-committed batch by id.
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledWith('doc1', 5);
      expect(mockAlgorithm.reconcilePending).toHaveBeenCalledWith('doc1', committedEcho);
      // Reconciliation must complete before the snapshot is adopted, so doc.import can
      // never re-apply the committed batch on top of a state that already contains it.
      expect(mockAlgorithm.reconcilePending.mock.invocationCallOrder[0]).toBeLessThan(
        mockStore.saveDoc.mock.invocationCallOrder[0]
      );
      // Cleared pending is reflected in the doc's sync state, not left latched true.
      expect(sync.docStates.state['doc1']?.hasPending).toBe(false);
      expect(sync.docStates.state['doc1']?.syncStatus).toBe('synced');
      consoleSpy.mockRestore();
    });

    it('excludes tail changes past the snapshot rev — the catch-up path rebases against those', async () => {
      const pending: Change[] = [
        { id: 'b1', rev: 6, baseRev: 5, ops: [{ op: 'add', path: '/a', value: 1 }], createdAt: 1, committedAt: 0 },
      ];
      mockAlgorithm.getPendingToSend.mockResolvedValueOnce(pending);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
      const committedEcho = { ...pending[0], committedAt: 100 };
      mockWebSocket.commitChanges.mockResolvedValue({ changes: [committedEcho] });
      mockAlgorithm.applyServerChanges.mockRejectedValue(new ApplyChangesError('b1', 6, 0, new Error('bad op')));
      mockWebSocket.getDoc.mockResolvedValue({ state: { a: 1 }, rev: 6 });
      // A foreign change landed between getDoc and getChangesSince — not in the snapshot.
      const later = { id: 'f1', rev: 7, baseRev: 6, ops: [], createdAt: 2, committedAt: 101 };
      mockWebSocket.getChangesSince.mockResolvedValue([committedEcho, later]);
      mockAlgorithm.hasPending.mockResolvedValueOnce(true).mockResolvedValue(false);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await sync['syncDoc']('doc1');

      expect(mockAlgorithm.reconcilePending).toHaveBeenCalledWith('doc1', [committedEcho]);
      consoleSpy.mockRestore();
    });

    it('skips the tail fetch when recovery has nothing pending to reconcile', async () => {
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
      mockWebSocket.getChangesSince.mockResolvedValue([
        { id: 'c-bad', rev: 6, baseRev: 5, ops: [], createdAt: 1, committedAt: 1 },
      ]);
      mockAlgorithm.applyServerChanges.mockRejectedValue(new ApplyChangesError('c-bad', 6, 0, new Error('bad op')));
      mockWebSocket.getDoc.mockResolvedValue({ state: { content: 'authoritative' }, rev: 6 });
      mockAlgorithm.hasPending.mockResolvedValue(false);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await sync['syncDoc']('doc1');

      // Called once for the catch-up attempt; recovery doesn't refetch a tail it won't use.
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(1);
      expect(mockAlgorithm.reconcilePending).not.toHaveBeenCalled();
      expect(sync.docStates.state['doc1']?.syncStatus).toBe('synced');
      consoleSpy.mockRestore();
    });
  });

  describe('transient sync-error auto-retry', () => {
    // First backoff is SYNC_RETRY_BASE_MS (1000ms) in PatchesSync.
    const FIRST_RETRY_MS = 1000;

    beforeEach(() => {
      vi.useFakeTimers();
      sync['updateState']({ connected: true });
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries a doc that failed transiently and recovers without a refresh', async () => {
      mockWebSocket.getChangesSince.mockRejectedValueOnce(new Error('network blip')).mockResolvedValue([]);

      await sync['syncDoc']('doc1');
      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);

      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(2);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(sync.docStates.state['doc1'].syncError).toBeUndefined();
    });

    it('does not retry a terminal (403) sync error — it stays latched for the app to handle', async () => {
      const errors: Error[] = [];
      sync.onError((err: Error) => {
        errors.push(err);
      });
      mockWebSocket.getChangesSince.mockRejectedValue(new StatusError(403, 'Forbidden'));

      await sync['syncDoc']('doc1');
      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(1);
      // A definitive error has nothing to recover it, so it surfaces immediately.
      expect(errors).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(1);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');
    });

    it('stays quiet on a transient failure while a retry is still pending', async () => {
      const errors: Error[] = [];
      sync.onError((err: Error) => {
        errors.push(err);
      });
      mockWebSocket.getChangesSince.mockRejectedValueOnce(new Error('network blip')).mockResolvedValue([]);

      await sync['syncDoc']('doc1');
      // The doc reflects the error in its own sync state, but we don't surface it via
      // onError/logs while a retry that's expected to recover it is pending.
      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');
      expect(errors).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);

      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(errors).toHaveLength(0);
    });

    it('gives up after the attempt cap and surfaces the error exactly once', async () => {
      const errors: Error[] = [];
      sync.onError((err: Error) => {
        errors.push(err);
      });
      mockWebSocket.getChangesSince.mockRejectedValue(new Error('persistent blip'));

      await sync['syncDoc']('doc1');
      // Drain the full backoff schedule (1 + 2 + 4 + 8 + 16 + 30×5 ≈ 181s).
      await vi.advanceTimersByTimeAsync(200_000);

      // 1 initial attempt + SYNC_RETRY_MAX_ATTEMPTS (10) retries, then it stops.
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(11);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');
      // Quiet across every retry; a single emit when we exhaust retries and give up.
      expect(errors).toHaveLength(1);

      // Nothing left armed — advancing further does nothing.
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(11);
    });

    it('cancels a pending retry when the doc is untracked', async () => {
      mockWebSocket.getChangesSince.mockRejectedValue(new Error('blip'));

      await sync['syncDoc']('doc1');
      expect((sync as any)._syncRetryTimers.size).toBe(1);

      await sync['_handleDocsUntracked'](['doc1']);
      expect((sync as any)._syncRetryTimers.size).toBe(0);
      expect((sync as any)._syncRetryAttempts.size).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(1);
    });

    it('cancels pending retries on disconnect', async () => {
      mockWebSocket.getChangesSince.mockRejectedValue(new Error('blip'));

      await sync['syncDoc']('doc1');
      expect((sync as any)._syncRetryTimers.size).toBe(1);

      sync.disconnect();
      expect((sync as any)._syncRetryTimers.size).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(1);
    });

    it('backs off across repeated failures, then recovers', async () => {
      mockWebSocket.getChangesSince
        .mockRejectedValueOnce(new Error('blip 1'))
        .mockRejectedValueOnce(new Error('blip 2'))
        .mockResolvedValue([]);

      await sync['syncDoc']('doc1');
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(1);

      // 1st retry at 1s fails again
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(2);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');

      // 2nd retry waits 2s (backoff) then succeeds
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(3);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
    });
  });

  describe('error-latch background re-probe', () => {
    const REPROBE_EXHAUSTED_MS = 5 * 60_000;
    const REPROBE_TERMINAL_MS = 10 * 60_000;
    const pendingChanges: Change[] = [{ id: 'p1', rev: 6, baseRev: 5, ops: [], createdAt: 0, committedAt: 0 }];
    let pendingRef: { current: Change[] | null };

    beforeEach(() => {
      vi.useFakeTimers();
      sync['updateState']({ connected: true });
      pendingRef = { current: pendingChanges };
      mockAlgorithm.getPendingToSend.mockImplementation(async () => pendingRef.current);
      // A successful commit confirms the sent changes, leaving nothing pending
      mockAlgorithm.confirmSent.mockImplementation(async () => {
        pendingRef.current = null;
      });
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('schedules a 5-minute re-probe after retry exhaustion and recovers when the server does', async () => {
      mockWebSocket.commitChanges.mockRejectedValue(new Error('commit outage'));

      await sync['syncDoc']('doc1');
      // Drain the full backoff ladder (≈181s): initial attempt + 10 retries, then exhaustion.
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(11);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');
      expect((sync as any)._syncReprobeTimers.size).toBe(1);

      // The outage ends after the ladder gave up — only the re-probe can notice.
      mockWebSocket.commitChanges.mockResolvedValue({ changes: pendingChanges });
      await vi.advanceTimersByTimeAsync(REPROBE_EXHAUSTED_MS);

      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(12);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect((sync as any)._syncReprobeTimers.size).toBe(0);
    });

    it('schedules a 10-minute re-probe after a terminal 403 latch', async () => {
      mockWebSocket.commitChanges.mockRejectedValue(new StatusError(403, 'Forbidden'));

      await sync['syncDoc']('doc1');
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(1);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');
      // Terminal codes get no fast ladder, only the slow probe
      expect((sync as any)._syncRetryTimers.size).toBe(0);
      expect((sync as any)._syncReprobeTimers.size).toBe(1);

      // Lazier than the exhaustion probe — nothing at 5 minutes
      await vi.advanceTimersByTimeAsync(REPROBE_EXHAUSTED_MS);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(1);

      // A server-side policy fix makes the pending change valid; the probe picks it up
      mockWebSocket.commitChanges.mockResolvedValue({ changes: pendingChanges });
      await vi.advanceTimersByTimeAsync(REPROBE_TERMINAL_MS - REPROBE_EXHAUSTED_MS);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(2);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
    });

    it('re-latches and schedules another probe while the terminal error persists', async () => {
      mockWebSocket.commitChanges.mockRejectedValue(new StatusError(403, 'Forbidden'));

      await sync['syncDoc']('doc1');
      await vi.advanceTimersByTimeAsync(REPROBE_TERMINAL_MS);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(2);
      expect((sync as any)._syncReprobeTimers.size).toBe(1);

      await vi.advanceTimersByTimeAsync(REPROBE_TERMINAL_MS);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(3);
    });

    it('surfaces a persistent terminal error once, not on every background probe', async () => {
      mockWebSocket.commitChanges.mockRejectedValue(new StatusError(403, 'Forbidden'));
      const onError = vi.fn();
      sync.onError(onError);

      await sync['syncDoc']('doc1');
      expect(onError).toHaveBeenCalledTimes(1);

      // Two more background probes fail identically — no repeat log/emit spam.
      await vi.advanceTimersByTimeAsync(REPROBE_TERMINAL_MS);
      await vi.advanceTimersByTimeAsync(REPROBE_TERMINAL_MS);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalledTimes(1);

      // A reconnect is a fresh session: a still-failing doc may surface once more.
      sync.disconnect();
      sync['updateState']({ connected: true });
      await sync['syncDoc']('doc1');
      expect(onError).toHaveBeenCalledTimes(2);
    });

    it('clears the re-probe timer when the doc is untracked', async () => {
      mockWebSocket.commitChanges.mockRejectedValue(new StatusError(403, 'Forbidden'));

      await sync['syncDoc']('doc1');
      expect((sync as any)._syncReprobeTimers.size).toBe(1);

      await sync['_handleDocsUntracked'](['doc1']);
      expect((sync as any)._syncReprobeTimers.size).toBe(0);

      await vi.advanceTimersByTimeAsync(REPROBE_TERMINAL_MS);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(1);
    });

    it('clears re-probe timers on disconnect and does not re-arm without a sync', async () => {
      mockWebSocket.commitChanges.mockRejectedValue(new StatusError(403, 'Forbidden'));

      await sync['syncDoc']('doc1');
      expect((sync as any)._syncReprobeTimers.size).toBe(1);

      sync.disconnect();
      expect((sync as any)._syncReprobeTimers.size).toBe(0);

      await vi.advanceTimersByTimeAsync(REPROBE_TERMINAL_MS);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(1);
    });

    it('clears a pending re-probe when a sync succeeds first', async () => {
      mockWebSocket.commitChanges.mockRejectedValueOnce(new StatusError(403, 'Forbidden'));

      await sync['syncDoc']('doc1');
      expect((sync as any)._syncReprobeTimers.size).toBe(1);

      // e.g. a local edit re-triggers syncDoc before the probe fires
      mockWebSocket.commitChanges.mockResolvedValue({ changes: pendingChanges });
      await sync['syncDoc']('doc1');
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect((sync as any)._syncReprobeTimers.size).toBe(0);

      await vi.advanceTimersByTimeAsync(REPROBE_TERMINAL_MS);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(2);
    });

    it('does not schedule a re-probe when the doc has no pending changes', async () => {
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockWebSocket.getChangesSince.mockRejectedValue(new StatusError(403, 'Forbidden'));

      await sync['syncDoc']('doc1');

      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');
      expect((sync as any)._syncReprobeTimers.size).toBe(0);
    });
  });

  describe('network-class failures defer to connection recovery (no per-doc error latch)', () => {
    // The class behind Sentry's `sync_doc_error_latched: … (unknown)` issues: a
    // status-less "Failed to fetch" (server unreachable for this client, network blip,
    // CORS-opaque failure) flowed into the per-doc error path, the ladder exhausted
    // while `connected` still read true (SSE alive, or a half-open stream), and N docs
    // latched 'error' — the amber-indicator + latch-telemetry state — for what is ONE
    // connection-level problem.
    const REPROBE_EXHAUSTED_MS = 5 * 60_000;
    let observedStatuses: string[];
    let errors: Error[];

    beforeEach(() => {
      vi.useFakeTimers();
      sync['updateState']({ connected: true });
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
      // Record every docStates emission for doc1 — consumers broadcast every
      // transition, so not even an intermediate 'error' may appear.
      observedStatuses = [];
      sync.docStates.subscribe(state => {
        const status = state['doc1']?.syncStatus;
        if (status) observedStatuses.push(status);
      }, false);
      errors = [];
      sync.onError((err: Error) => {
        errors.push(err);
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('recovers a network-failed pull through the retry ladder without ever reporting error', async () => {
      mockWebSocket.getChangesSince
        .mockRejectedValueOnce(new NetworkError('GET /docs/doc1/_changes failed without a response'))
        .mockResolvedValue([]);

      await sync['syncDoc']('doc1');
      // Parked at the stable disconnect posture, not 'error'; the ladder is armed.
      expect(sync.docStates.state['doc1'].syncStatus).not.toBe('error');
      expect(sync.docStates.state['doc1'].syncError).toBeUndefined();
      expect((sync as any)._syncRetryTimers.size).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(2);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(observedStatuses).not.toContain('error');
      expect(errors).toHaveLength(0);
    });

    it('classifies a raw request timeout (TimeoutError) the same way', async () => {
      mockWebSocket.getChangesSince
        .mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))
        .mockResolvedValue([]);

      await sync['syncDoc']('doc1');
      expect(sync.docStates.state['doc1'].syncStatus).not.toBe('error');

      await vi.advanceTimersByTimeAsync(1000);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(observedStatuses).not.toContain('error');
      expect(errors).toHaveLength(0);
    });

    it('parks a brand-new doc at unsynced when its hydration dies at the network level', async () => {
      mockAlgorithm.getCommittedRev.mockResolvedValue(0);
      mockWebSocket.getDoc.mockRejectedValue(new NetworkError('GET /docs/doc1 failed without a response'));

      await sync['syncDoc']('doc1');

      expect(sync.docStates.state['doc1'].syncStatus).toBe('unsynced');
      expect(observedStatuses).not.toContain('error');
    });

    it('exhausted retries park the doc and arm the re-probe even with nothing pending', async () => {
      sync['_initDocSyncState']('doc1', { committedRev: 5, syncStatus: 'synced' });
      mockWebSocket.getChangesSince.mockRejectedValue(new NetworkError('fetch failed'));

      await sync['syncDoc']('doc1');
      // Drain the full backoff ladder (≈181s): initial attempt + 10 retries, then exhaustion.
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(11);

      // Waiting-for-connection posture, quiet, with the background probe armed — the
      // connection can still read up (SSE alive, fetches failing), so without the
      // probe nothing would ever re-attempt this pending-less doc.
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(sync.docStates.state['doc1'].syncError).toBeUndefined();
      expect(observedStatuses).not.toContain('error');
      expect(errors).toHaveLength(0);
      expect((sync as any)._syncReprobeTimers.size).toBe(1);

      // The network heals after the ladder gave up — the probe recovers the doc.
      mockWebSocket.getChangesSince.mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(REPROBE_EXHAUSTED_MS);
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(12);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect((sync as any)._syncReprobeTimers.size).toBe(0);
    });

    it('keeps a doc with unsent work at synced+hasPending across a network-failed flush', async () => {
      const pendingChanges: Change[] = [{ id: 'p1', rev: 6, baseRev: 5, ops: [], createdAt: 0, committedAt: 0 }];
      const pendingRef: { current: Change[] | null } = { current: pendingChanges };
      mockAlgorithm.getPendingToSend.mockImplementation(async () => pendingRef.current);
      mockAlgorithm.hasPending.mockImplementation(async () => pendingRef.current !== null);
      mockAlgorithm.confirmSent.mockImplementation(async () => {
        pendingRef.current = null;
      });
      sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: true, syncStatus: 'synced' });
      mockWebSocket.commitChanges.mockRejectedValue(new NetworkError('POST /docs/doc1/_changes failed'));

      await sync['syncDoc']('doc1');
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(11);

      // The unsent work stays visible via hasPending; the posture never reads 'error'.
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(sync.docStates.state['doc1'].hasPending).toBe(true);
      expect(observedStatuses).not.toContain('error');
      expect(errors).toHaveLength(0);
      expect((sync as any)._syncReprobeTimers.size).toBe(1);

      // Heal: the probe flushes the pending change through.
      mockWebSocket.commitChanges.mockResolvedValue({ changes: pendingChanges });
      await vi.advanceTimersByTimeAsync(REPROBE_EXHAUSTED_MS);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(sync.docStates.state['doc1'].hasPending).toBe(false);
    });

    it('a reconnect re-syncs a parked doc through syncAllKnownDocs', async () => {
      sync['_initDocSyncState']('doc1', { committedRev: 5, syncStatus: 'synced' });
      mockAlgorithm.listDocs.mockResolvedValue([{ docId: 'doc1', committedRev: 5 }]);
      mockWebSocket.getChangesSince.mockRejectedValue(new NetworkError('fetch failed'));

      await sync['syncDoc']('doc1');
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(11);

      // The transport notices the dead connection (e.g. SSE liveness watchdog) and
      // cycles: disconnect clears the probe, reconnect re-syncs everything.
      sync['_handleConnectionChange']('disconnected');
      expect((sync as any)._syncReprobeTimers.size).toBe(0);

      mockWebSocket.getChangesSince.mockResolvedValue([]);
      sync['_handleConnectionChange']('connected');
      await vi.advanceTimersByTimeAsync(0);

      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(observedStatuses).not.toContain('error');
      expect(errors).toHaveLength(0);
    });

    it('still latches and surfaces a coded 403 — interruption handling must not widen', async () => {
      mockWebSocket.getChangesSince.mockRejectedValue(new StatusError(403, 'Forbidden'));

      await sync['syncDoc']('doc1');

      expect(sync.docStates.state['doc1'].syncStatus).toBe('error');
      expect(errors).toHaveLength(1);
    });
  });

  describe('aborted requests (DOMException AbortError, code 20)', () => {
    // The class behind Sentry's `sync_doc_error_latched: … (20)` issues: fetches abort
    // when the page/worker is torn down mid-sync (app quit, navigation, update reload)
    // and IndexedDB transactions abort under storage pressure. Neither says anything
    // about the doc or the server, so the doc must never latch per-doc 'error' (the
    // amber-indicator + latch-telemetry state) — pending data is safe locally and the
    // retry ladder / reprobe / reconnect machinery finishes the job.
    const FIRST_RETRY_MS = 1000;
    const REPROBE_EXHAUSTED_MS = 5 * 60_000;
    const pendingChanges: Change[] = [{ id: 'p1', rev: 6, baseRev: 5, ops: [], createdAt: 0, committedAt: 0 }];

    const fetchAbort = () => new DOMException('The user aborted a request.', 'AbortError');
    const idbAbort = () => new DOMException('The transaction was aborted.', 'AbortError');

    beforeEach(() => {
      vi.useFakeTimers();
      sync['updateState']({ connected: true });
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not latch an aborted pull as a doc error and recovers via the retry ladder', async () => {
      const errors: Error[] = [];
      sync.onError((err: Error) => errors.push(err));
      mockWebSocket.getChangesSince.mockRejectedValueOnce(fetchAbort()).mockResolvedValue([]);

      await sync['syncDoc']('doc1');

      expect(sync.docStates.state['doc1'].syncStatus).not.toBe('error');
      expect(sync.docStates.state['doc1'].syncError).toBeUndefined();
      expect(errors).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);

      expect(mockWebSocket.getChangesSince).toHaveBeenCalledTimes(2);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(errors).toHaveLength(0);
    });

    it('never paints a transient per-doc error into the docStates stream on an aborted flush', async () => {
      // The consuming hub broadcasts EVERY docStates transition to its tabs, where a
      // momentary 'error' fires latch telemetry and the amber indicator — so not even
      // an intermediate transition may show 'error'.
      const seenStatuses: string[] = [];
      sync.docStates.subscribe(states => {
        const status = states['doc1']?.syncStatus;
        if (status) seenStatuses.push(status);
      });
      const pendingRef = { current: pendingChanges as Change[] | null };
      mockAlgorithm.getPendingToSend.mockImplementation(async () => pendingRef.current);
      mockAlgorithm.confirmSent.mockImplementation(async () => {
        pendingRef.current = null;
      });
      mockWebSocket.commitChanges.mockRejectedValueOnce(fetchAbort()).mockResolvedValue({ changes: pendingChanges });

      await sync['syncDoc']('doc1');

      // Pending survived the abort untouched — nothing was confirmed away.
      expect(mockAlgorithm.confirmSent).not.toHaveBeenCalled();
      expect(seenStatuses).not.toContain('error');
      // Stable status while interrupted: local data exists, so 'synced' (same rule as
      // the disconnect reset), with the retry ladder armed to finish the flush.
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');

      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);

      expect(mockAlgorithm.confirmSent).toHaveBeenCalledTimes(1);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect(seenStatuses).not.toContain('error');
    });

    it('treats an aborted IndexedDB read like an aborted request (storage abort, same DOMException)', async () => {
      const errors: Error[] = [];
      sync.onError((err: Error) => errors.push(err));
      mockAlgorithm.getPendingToSend.mockRejectedValueOnce(idbAbort()).mockResolvedValue(null);

      await sync['syncDoc']('doc1');

      expect(sync.docStates.state['doc1'].syncStatus).not.toBe('error');
      expect(errors).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
    });

    it('leaves a brand-new empty doc as unsynced when its first pull aborts', async () => {
      mockAlgorithm.getCommittedRev.mockResolvedValue(0);
      mockWebSocket.getDoc.mockRejectedValue(fetchAbort());

      await sync['syncDoc']('doc1');

      expect(sync.docStates.state['doc1'].syncStatus).toBe('unsynced');
      expect(sync.docStates.state['doc1'].syncError).toBeUndefined();
    });

    it('stays quiet with nothing armed when the abort coincides with teardown/disconnect', async () => {
      const errors: Error[] = [];
      sync.onError((err: Error) => errors.push(err));
      mockWebSocket.getChangesSince.mockImplementation(async () => {
        // The same teardown that aborted the fetch also dropped the connection.
        sync['updateState']({ connected: false });
        throw fetchAbort();
      });

      await sync['syncDoc']('doc1');

      expect(sync.docStates.state['doc1'].syncStatus).not.toBe('error');
      expect(errors).toHaveLength(0);
      expect((sync as any)._syncRetryTimers.size).toBe(0);
      expect((sync as any)._syncReprobeTimers.size).toBe(0);
    });

    it('bounds retries on persistent aborts, surfaces once, keeps reprobing — never latches', async () => {
      const errors: Error[] = [];
      sync.onError((err: Error) => errors.push(err));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const pendingRef = { current: pendingChanges as Change[] | null };
      mockAlgorithm.getPendingToSend.mockImplementation(async () => pendingRef.current);
      mockAlgorithm.confirmSent.mockImplementation(async () => {
        pendingRef.current = null;
      });
      mockWebSocket.commitChanges.mockRejectedValue(fetchAbort());

      await sync['syncDoc']('doc1');
      // Drain the full backoff ladder (≈181s): initial attempt + 10 retries, then exhaustion.
      await vi.advanceTimersByTimeAsync(200_000);

      expect(mockWebSocket.commitChanges).toHaveBeenCalledTimes(11);
      // A persistent abort while connected+online is a real environment problem
      // (storage pressure, wedged network stack): telemetry hears about it once…
      expect(errors).toHaveLength(1);
      expect(errors[0].name).toBe('AbortError');
      // …but the doc still never latches, and the slow reprobe keeps working the pending.
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect((sync as any)._syncReprobeTimers.size).toBe(1);

      mockWebSocket.commitChanges.mockResolvedValue({ changes: pendingChanges });
      await vi.advanceTimersByTimeAsync(REPROBE_EXHAUSTED_MS);

      expect(mockAlgorithm.confirmSent).toHaveBeenCalledTimes(1);
      expect(sync.docStates.state['doc1'].syncStatus).toBe('synced');
      expect((sync as any)._syncReprobeTimers.size).toBe(0);
      expect(errors).toHaveLength(1);
      consoleSpy.mockRestore();
    });
  });

  describe('docStates untrack race (no resurrection)', () => {
    it('does not resurrect a docStates entry when an in-flight sync fails after untrack', async () => {
      sync['updateState']({ connected: true });
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
      let rejectPull!: (err: Error) => void;
      mockWebSocket.getChangesSince.mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectPull = reject;
          })
      );

      const inFlight = sync['syncDoc']('doc1');
      await vi.waitFor(() => expect(mockWebSocket.getChangesSince).toHaveBeenCalled());
      expect(sync.docStates.state['doc1'].syncStatus).toBe('syncing');

      await sync['_handleDocsUntracked'](['doc1']);
      expect(sync.docStates.state['doc1']).toBeUndefined();

      rejectPull(new StatusError(403, 'Forbidden'));
      await inFlight;

      // The late failure must not re-create the entry — it would be unreachable
      // by any cleanup until the next reconnect.
      expect(sync.docStates.state['doc1']).toBeUndefined();
    });
  });

  describe('applyMergeChanges', () => {
    const mergeChanges: Change[] = [
      { id: 'm1', rev: 6, baseRev: 5, ops: [], createdAt: 0, committedAt: 1000 },
      { id: 'm2', rev: 7, baseRev: 6, ops: [], createdAt: 0, committedAt: 1001 },
    ];

    it('should be a no-op for an empty merge', async () => {
      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);
      const syncSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      await sync.applyMergeChanges('doc1', []);

      expect(applySpy).not.toHaveBeenCalled();
      expect(syncSpy).not.toHaveBeenCalled();
      expect(mockAlgorithm.getCommittedRev).not.toHaveBeenCalled();
    });

    it('should be a no-op when the merge is already applied (committedRev >= lastRev)', async () => {
      mockAlgorithm.getCommittedRev.mockResolvedValue(7);
      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);
      const syncSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      await sync.applyMergeChanges('doc1', mergeChanges);

      expect(applySpy).not.toHaveBeenCalled();
      expect(syncSpy).not.toHaveBeenCalled();
    });

    it('should apply contiguous merge changes (committedRev === firstRev - 1)', async () => {
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);
      const syncSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      await sync.applyMergeChanges('doc1', mergeChanges);

      expect(applySpy).toHaveBeenCalledTimes(1);
      expect(applySpy).toHaveBeenCalledWith('doc1', mergeChanges);
      expect(syncSpy).not.toHaveBeenCalled();
    });

    it('should fall back to syncDoc when there is a gap (committedRev < firstRev - 1)', async () => {
      mockAlgorithm.getCommittedRev.mockResolvedValue(3);
      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);
      const syncSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      await sync.applyMergeChanges('doc1', mergeChanges);

      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith('doc1');
      expect(applySpy).not.toHaveBeenCalled();
    });

    it('should fall back to syncDoc on a partial overlap (firstRev <= committedRev < lastRev)', async () => {
      // committedRev sits inside the merge block (e.g. only the first merge rev landed).
      // The old subclass impl did nothing here, stranding the doc behind the tail.
      mockAlgorithm.getCommittedRev.mockResolvedValue(6);
      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);
      const syncSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      await sync.applyMergeChanges('doc1', mergeChanges);

      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith('doc1');
      expect(applySpy).not.toHaveBeenCalled();
    });
  });

  describe('flushDoc method', () => {
    beforeEach(() => {
      sync['updateState']({ connected: true });
      sync['trackedDocs'].add('doc1');
    });

    it('should throw if document not tracked', async () => {
      await expect(sync['flushDoc']('untracked-doc')).rejects.toThrow('Document untracked-doc is not tracked');
    });

    it('should throw if not connected', async () => {
      sync['updateState']({ connected: false });

      await expect(sync['flushDoc']('doc1')).rejects.toThrow('Not connected to server');
    });

    it('should throw if offline even when connection state is stale-connected', async () => {
      setOffline(true);

      await expect(sync['flushDoc']('doc1')).rejects.toThrow('Not connected to server');
      expect(mockWebSocket.commitChanges).not.toHaveBeenCalled();
    });

    it('should return early if no pending changes', async () => {
      // Sync now calls algorithm.getPendingToSend
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);

      await sync['flushDoc']('doc1');

      expect(mockWebSocket.commitChanges).not.toHaveBeenCalled();
    });

    it('should flush pending changes in batches', async () => {
      const pendingChanges: Change[] = [
        {
          id: 'c1',
          rev: 1,
          baseRev: 0,
          ops: [],
          createdAt: 0,
          committedAt: 0,
        },
        {
          id: 'c2',
          rev: 2,
          baseRev: 1,
          ops: [],
          createdAt: 1000,
          committedAt: 1000,
        },
      ];

      // Sync now calls algorithm.getPendingToSend
      mockAlgorithm.getPendingToSend
        .mockResolvedValueOnce(pendingChanges) // Initial call
        .mockResolvedValueOnce(null); // After flush

      const committed = pendingChanges.map(c => ({ ...c, rev: c.rev + 10 }));
      mockWebSocket.commitChanges.mockResolvedValue({ changes: committed });

      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);

      await sync['flushDoc']('doc1');

      expect(mockWebSocket.commitChanges).toHaveBeenCalledWith('doc1', pendingChanges);
      expect(applySpy).toHaveBeenCalledWith('doc1', committed);
    });

    it('drops sent changes the server rebased away and re-syncs the open doc', async () => {
      const sent: Change[] = [
        { id: 'root', rev: 1, baseRev: 0, ops: [{ op: 'replace', path: '', value: {} }], createdAt: 0, committedAt: 0 },
      ];
      mockAlgorithm.getPendingToSend.mockResolvedValueOnce(sent).mockResolvedValueOnce(null);

      // Server returned only an unrelated catchup change — `sent` was rebased away (absent).
      const committed: Change[] = [{ id: 'srv', rev: 11, baseRev: 10, ops: [], createdAt: 0, committedAt: 0 }];
      mockWebSocket.commitChanges.mockResolvedValue({ changes: committed });
      vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);

      // One pending dropped + an open doc → re-import from store to stay consistent.
      mockAlgorithm.dropResolvedPending.mockResolvedValue(1);
      mockPatches.getOpenDoc.mockReturnValue({} as any);
      const reimported = { state: {}, rev: 11, changes: [] };
      mockAlgorithm.loadDoc.mockResolvedValue(reimported);

      await sync['flushDoc']('doc1');

      expect(mockAlgorithm.dropResolvedPending).toHaveBeenCalledWith('doc1', sent, committed);
      expect(mockPatches.applySnapshot).toHaveBeenCalledWith('doc1', reimported);
    });

    it('does not re-sync when nothing was rebased away', async () => {
      const sent: Change[] = [{ id: 'c1', rev: 1, baseRev: 0, ops: [], createdAt: 0, committedAt: 0 }];
      mockAlgorithm.getPendingToSend.mockResolvedValueOnce(sent).mockResolvedValueOnce(null);
      mockWebSocket.commitChanges.mockResolvedValue({ changes: sent.map(c => ({ ...c, rev: c.rev + 10 })) });
      vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);
      mockAlgorithm.dropResolvedPending.mockResolvedValue(0);
      mockPatches.getOpenDoc.mockReturnValue({} as any);

      await sync['flushDoc']('doc1');

      expect(mockPatches.applySnapshot).not.toHaveBeenCalled();
    });

    it('creates a docStates entry when flushDoc is reached before _initDocSyncState ran', async () => {
      // beforeEach only does trackedDocs.add('doc1') — no docStates entry — mirroring a
      // subclass calling the protected flushDoc directly without going through syncDoc first.
      expect(sync.docStates.state['doc1']).toBeUndefined();
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);

      await sync['flushDoc']('doc1');

      expect(sync.docStates.state['doc1']).toBeDefined();
    });
  });

  describe('_applyServerChangesToDoc method', () => {
    it('should apply server changes to document', async () => {
      const serverChanges: Change[] = [
        {
          id: 'c1',
          rev: 6,
          baseRev: 5,
          ops: [],
          createdAt: 0,
          committedAt: 0,
        },
      ];

      await sync['_applyServerChangesToDoc']('doc1', serverChanges);

      // Sync now calls algorithm.applyServerChanges, not store.applyServerChanges
      // Third arg is the open doc (or null if not open)
      expect(mockAlgorithm.applyServerChanges).toHaveBeenCalledWith('doc1', serverChanges, null);
    });

    it('should handle empty changes array', async () => {
      // Empty changes should still call applyServerChanges (algorithm handles the empty case)
      await sync['_applyServerChangesToDoc']('doc1', []);

      expect(mockAlgorithm.applyServerChanges).toHaveBeenCalledWith('doc1', [], null);
    });

    it('creates a docStates entry for a tracked doc reached before _initDocSyncState ran', async () => {
      // doc1 is tracked (constructor seeds trackedDocs from patches.trackedDocs) but has no
      // docStates entry yet — the shape reached via applyMergeChanges or a raw
      // onChangesCommitted push before syncDoc/flushDoc ever initialized it.
      expect(sync.docStates.state['doc1']).toBeUndefined();

      const serverChanges: Change[] = [{ id: 'c1', rev: 6, baseRev: 5, ops: [], createdAt: 0, committedAt: 0 }];
      await sync['_applyServerChangesToDoc']('doc1', serverChanges);

      expect(sync.docStates.state['doc1']?.committedRev).toBe(6);
    });
  });

  describe('connection state handling', () => {
    it('should handle connection state changes', () => {
      const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];

      const stateHandler = vi.fn();
      sync.subscribe(stateHandler, false);

      connectionHandler('connected');

      expect(sync.state.connected).toBe(true);
      expect(stateHandler).toHaveBeenCalled();
    });

    it('should sync all docs when connected', () => {
      const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];
      const syncAllSpy = vi.spyOn(sync as any, 'syncAllKnownDocs').mockResolvedValue(undefined);

      connectionHandler('connected');

      expect(syncAllSpy).toHaveBeenCalled();
    });

    it('should preserve syncing state when connecting', () => {
      sync['updateState']({ syncStatus: 'syncing' });

      const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];

      connectionHandler('connecting');

      expect(sync.state.syncStatus).toBe('syncing'); // Preserved
    });

    it('should reset syncing state when disconnected', () => {
      sync['updateState']({ connected: true, syncStatus: 'syncing' });

      const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];

      connectionHandler('disconnected');

      expect(sync.state.connected).toBe(false);
      expect(sync.state.syncStatus).toBe('unsynced'); // Reset
    });
  });

  describe('document tracking handlers', () => {
    beforeEach(() => {
      sync['updateState']({ connected: true });
    });

    it('should handle new tracked documents', async () => {
      const trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls[0][0];
      const syncDocSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      await trackHandler(['doc3', 'doc4'], 'ot');

      expect(sync['trackedDocs'].has('doc3')).toBe(true);
      expect(sync['trackedDocs'].has('doc4')).toBe(true);
      expect(sync['docAlgorithms'].get('doc3')).toBe('ot');
      expect(sync['docAlgorithms'].get('doc4')).toBe('ot');
      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['doc3', 'doc4']);
      expect(syncDocSpy).toHaveBeenCalledWith('doc3');
      expect(syncDocSpy).toHaveBeenCalledWith('doc4');
    });

    it('should handle already tracked documents', async () => {
      const trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls[0][0];

      await trackHandler(['doc1'], 'ot'); // Already tracked

      expect(mockWebSocket.subscribe).not.toHaveBeenCalled();
    });

    it('should still run the initial syncDoc when subscribe fails for newly tracked docs', async () => {
      const trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls[0][0];
      const syncDocSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);
      const errors: Error[] = [];
      sync.onError(err => errors.push(err));
      mockWebSocket.subscribe.mockRejectedValue(new Error('transient subscribe failure'));

      await trackHandler(['doc3', 'doc4'], 'ot');

      // A failed subscribe surfaces but must not skip the initial sync — offline pending
      // changes would otherwise never be sent (nothing retries a skipped syncDoc).
      expect(errors).toHaveLength(1);
      expect(syncDocSpy).toHaveBeenCalledWith('doc3');
      expect(syncDocSpy).toHaveBeenCalledWith('doc4');
    });

    it('should handle untracked documents', async () => {
      const untrackHandler = vi.mocked(mockPatches.onUntrackDocs).mock.calls[0][0];

      await untrackHandler(['doc1', 'doc2']);

      expect(sync['trackedDocs'].has('doc1')).toBe(false);
      expect(sync['trackedDocs'].has('doc2')).toBe(false);
      expect(mockWebSocket.unsubscribe).toHaveBeenCalledWith(['doc1', 'doc2']);
    });

    it('should handle non-existent untracked documents', async () => {
      const untrackHandler = vi.mocked(mockPatches.onUntrackDocs).mock.calls[0][0];

      await untrackHandler(['nonexistent']);

      expect(mockWebSocket.unsubscribe).not.toHaveBeenCalled();
    });
  });

  describe('document deletion handling', () => {
    beforeEach(() => {
      sync['updateState']({ connected: true });
    });

    it('should delete document on server when connected', async () => {
      const deleteHandler = vi.mocked(mockPatches.onDeleteDoc).mock.calls[0][0];

      await deleteHandler('doc1');

      expect(mockWebSocket.deleteDoc).toHaveBeenCalledWith('doc1');
      // Sync now calls algorithm.confirmDeleteDoc, not store.confirmDeleteDoc
      expect(mockAlgorithm.confirmDeleteDoc).toHaveBeenCalledWith('doc1');
    });

    it('should defer deletion when offline', async () => {
      sync['updateState']({ connected: false });

      const deleteHandler = vi.mocked(mockPatches.onDeleteDoc).mock.calls[0][0];
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await deleteHandler('doc1');

      expect(consoleSpy).toHaveBeenCalledWith('Offline: Server delete for doc doc1 deferred.');
      expect(mockWebSocket.deleteDoc).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('committed changes handling', () => {
    it('should receive and apply committed changes', async () => {
      const changesHandler = vi.mocked(mockWebSocket.onChangesCommitted).mock.calls[0][0];
      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);

      const serverChanges: Change[] = [
        {
          id: 'c1',
          rev: 6,
          baseRev: 5,
          ops: [],
          createdAt: 0,
          committedAt: 0,
        },
      ];

      await changesHandler('doc1', serverChanges);

      expect(applySpy).toHaveBeenCalledWith('doc1', serverChanges);
    });
  });

  describe('subscribeFilter', () => {
    // Simulates a hierarchical doc database: subscribing to a root doc (e.g. 'users/:uid')
    // covers all subdocs (e.g. 'users/:uid/preferences', 'users/:uid/stats/2026-02').
    // The filter maps any doc ID to its root subscription endpoint.
    const hierarchicalFilter = (docIds: string[]) => {
      const roots = new Set<string>();
      for (const id of docIds) {
        // Extract root: first two path segments (e.g. 'users/:uid')
        const parts = id.split('/');
        roots.add(parts.slice(0, 2).join('/'));
      }
      return [...roots];
    };

    let syncWithFilter: PatchesSync;
    let trackHandler: (docIds: string[], algorithmName?: AlgorithmName) => Promise<void>;
    let untrackHandler: (docIds: string[]) => Promise<void>;

    beforeEach(() => {
      mockPatches.trackedDocs = [];
      syncWithFilter = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        subscribeFilter: hierarchicalFilter,
      });
      syncWithFilter['updateState']({ connected: true });

      trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls.at(-1)![0];
      untrackHandler = vi.mocked(mockPatches.onUntrackDocs).mock.calls.at(-1)![0];

      vi.spyOn(syncWithFilter as any, 'syncDoc').mockResolvedValue(undefined);
    });

    it('should subscribe to root when tracking root doc', async () => {
      await trackHandler(['users/u1'], 'ot');

      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['users/u1']);
    });

    it('should not re-subscribe when tracking a subdoc under an already-tracked root', async () => {
      await trackHandler(['users/u1'], 'ot');
      mockWebSocket.subscribe.mockClear();

      await trackHandler(['users/u1/preferences'], 'ot');

      expect(mockWebSocket.subscribe).not.toHaveBeenCalled();
    });

    it('should subscribe once when tracking root and subdocs together', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences', 'users/u1/stats'], 'ot');

      expect(mockWebSocket.subscribe).toHaveBeenCalledTimes(1);
      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['users/u1']);
    });

    it('should subscribe to a new root when tracking docs under a different root', async () => {
      await trackHandler(['users/u1'], 'ot');
      mockWebSocket.subscribe.mockClear();

      await trackHandler(['projects/p1', 'projects/p1/tasks'], 'ot');

      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['projects/p1']);
    });

    it('should not unsubscribe root when untracking a subdoc while root is still tracked', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences'], 'ot');
      mockWebSocket.subscribe.mockClear();

      await untrackHandler(['users/u1/preferences']);

      expect(mockWebSocket.unsubscribe).not.toHaveBeenCalled();
    });

    it('should not unsubscribe root when untracking a subdoc while other subdocs remain', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences', 'users/u1/stats'], 'ot');
      mockWebSocket.subscribe.mockClear();

      await untrackHandler(['users/u1/preferences']);

      expect(mockWebSocket.unsubscribe).not.toHaveBeenCalled();
    });

    it('should unsubscribe root when all docs under that root are untracked', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences'], 'ot');
      mockWebSocket.subscribe.mockClear();

      await untrackHandler(['users/u1', 'users/u1/preferences']);

      expect(mockWebSocket.unsubscribe).toHaveBeenCalledWith(['users/u1']);
    });

    it('should only unsubscribe the root whose docs are all gone', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences', 'projects/p1'], 'ot');
      mockWebSocket.subscribe.mockClear();

      await untrackHandler(['projects/p1']);

      expect(mockWebSocket.unsubscribe).toHaveBeenCalledWith(['projects/p1']);
    });

    it('should still sync all newly tracked docs regardless of subscribe filter', async () => {
      const syncDocSpy = vi.spyOn(syncWithFilter as any, 'syncDoc').mockResolvedValue(undefined);

      await trackHandler(['users/u1', 'users/u1/preferences'], 'ot');

      expect(syncDocSpy).toHaveBeenCalledWith('users/u1');
      expect(syncDocSpy).toHaveBeenCalledWith('users/u1/preferences');
    });

    it('should still track all docs locally regardless of subscribe filter', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences'], 'ot');

      expect(syncWithFilter['trackedDocs'].has('users/u1')).toBe(true);
      expect(syncWithFilter['trackedDocs'].has('users/u1/preferences')).toBe(true);
    });
  });

  describe('synced doc status', () => {
    describe('initial state', () => {
      it('should initialize with empty synced map', () => {
        expect(sync.docStates.state).toEqual({});
      });

      it('should have docStates store with subscribe', () => {
        expect(sync.docStates).toBeDefined();
        expect(typeof sync.docStates.subscribe).toBe('function');
      });
    });

    describe('_updateDocSyncState', () => {
      it('should add a new doc entry via _initDocSyncState and emit', async () => {
        const handler = vi.fn();
        sync.docStates.subscribe(handler, false);

        sync['_initDocSyncState']('doc1', { committedRev: 0, hasPending: false, syncStatus: 'unsynced' });

        expect(sync.docStates.state).toEqual({
          doc1: { committedRev: 0, hasPending: false, syncStatus: 'unsynced', syncError: undefined, isLoaded: false },
        });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(sync.docStates.state));
      });

      it('should no-op a partial update for a doc not in the map', () => {
        const handler = vi.fn();
        sync.docStates.subscribe(handler, false);

        sync['_updateDocSyncState']('ghost', { syncStatus: 'error', syncError: new Error('late failure') });

        expect(sync.docStates.state.ghost).toBeUndefined();
        expect(handler).not.toHaveBeenCalled();
      });

      it('should create new object reference on add', () => {
        const before = sync.docStates.state;
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });
        expect(sync.docStates.state).not.toBe(before);
      });

      it('should merge updates into an existing entry and emit', async () => {
        sync['_initDocSyncState']('doc1', { committedRev: 0, hasPending: false, syncStatus: 'unsynced' });

        const handler = vi.fn();
        sync.docStates.subscribe(handler, false);

        sync['_updateDocSyncState']('doc1', { syncStatus: 'syncing' });

        expect(sync.docStates.state.doc1).toEqual({
          committedRev: 0,
          hasPending: false,
          syncStatus: 'syncing',
          syncError: undefined,
          isLoaded: false,
        });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(sync.docStates.state));
      });

      it('should no-op if nothing changed on existing entry', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });

        const handler = vi.fn();
        sync.docStates.subscribe(handler, false);

        sync['_updateDocSyncState']('doc1', { committedRev: 5 });

        expect(handler).not.toHaveBeenCalled();
      });

      it('should create new object reference on update', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 0, hasPending: false, syncStatus: 'unsynced' });
        const before = sync.docStates.state;

        sync['_updateDocSyncState']('doc1', { hasPending: true });

        expect(sync.docStates.state).not.toBe(before);
      });

      it('should remove a doc entry when updates is undefined and emit', async () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });

        const handler = vi.fn();
        sync.docStates.subscribe(handler, false);

        sync['_updateDocSyncState']('doc1', undefined);

        expect(sync.docStates.state).toEqual({});
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(sync.docStates.state));
      });

      it('should no-op when removing a doc not in the map', () => {
        const handler = vi.fn();
        sync.docStates.subscribe(handler, false);

        sync['_updateDocSyncState']('nonexistent', undefined);

        expect(handler).not.toHaveBeenCalled();
      });

      it('should not resurrect the entry when a doc is untracked mid-sync', async () => {
        sync['updateState']({ connected: true });
        let resolveGetChanges!: (changes: Change[]) => void;
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        mockAlgorithm.getCommittedRev.mockResolvedValue(5);
        mockWebSocket.getChangesSince.mockImplementation(
          () => new Promise<Change[]>(resolve => (resolveGetChanges = resolve))
        );

        const syncPromise = sync['syncDoc']('doc1');
        await vi.waitFor(() => expect(sync.docStates.state.doc1?.syncStatus).toBe('syncing'));

        const untrackHandler = vi.mocked(mockPatches.onUntrackDocs).mock.calls[0][0];
        await untrackHandler(['doc1']);
        expect(sync.docStates.state.doc1).toBeUndefined();

        resolveGetChanges([]);
        await syncPromise;

        // The 'synced' continuation must not recreate a ghost entry for the untracked doc
        expect(sync.docStates.state.doc1).toBeUndefined();
      });

      it('should create new object reference on remove', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });
        const before = sync.docStates.state;

        sync['_updateDocSyncState']('doc1', undefined);

        expect(sync.docStates.state).not.toBe(before);
      });
    });

    describe('isLoaded stickiness', () => {
      it('should set isLoaded true when committedRev > 0', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);
      });

      it('should set isLoaded true when hasPending is true', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 0, hasPending: true, syncStatus: 'unsynced' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);
      });

      it('should set isLoaded true when syncStatus is synced', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 0, hasPending: false, syncStatus: 'synced' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);
      });

      it('should set isLoaded true when syncStatus is error', () => {
        sync['_initDocSyncState']('doc1', {
          committedRev: 0,
          hasPending: false,
          syncStatus: 'error',
          syncError: new Error('fail'),
        });
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);
      });

      it('should start isLoaded false for fresh unsynced doc', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 0, hasPending: false, syncStatus: 'unsynced' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(false);
      });

      it('should keep isLoaded true when syncStatus changes to syncing (reconnect)', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 0, hasPending: false, syncStatus: 'synced' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);

        sync['_updateDocSyncState']('doc1', { syncStatus: 'syncing' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);
      });

      it('should keep isLoaded true when status resets to unsynced on disconnect', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: true, syncStatus: 'syncing' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);

        sync.disconnect();
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);
      });

      it('should reset isLoaded when doc is untracked and re-tracked', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);

        sync['_updateDocSyncState']('doc1', undefined);
        expect(sync.docStates.state.doc1).toBeUndefined();

        sync['_initDocSyncState']('doc1', { committedRev: 0, hasPending: false, syncStatus: 'unsynced' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(false);
      });

      it('should preserve isLoaded true across syncAllKnownDocs reconnect', async () => {
        sync['updateState']({ connected: true });
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);

        const activeDocs: TrackedDoc[] = [{ docId: 'doc1', committedRev: 5 }];
        mockAlgorithm.listDocs.mockResolvedValue(activeDocs);
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        await sync['syncAllKnownDocs']();
        expect(sync.docStates.state.doc1.isLoaded).toBe(true);
      });
    });

    describe('syncAllKnownDocs integration', () => {
      beforeEach(() => {
        sync['updateState']({ connected: true });
      });

      it('should populate synced map for active docs', async () => {
        const activeDocs: TrackedDoc[] = [
          { docId: 'doc1', committedRev: 5 },
          { docId: 'doc2', committedRev: 0 },
        ];
        mockAlgorithm.listDocs.mockResolvedValue(activeDocs);
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        await sync['syncAllKnownDocs']();

        expect(sync.docStates.state.doc1).toEqual({
          committedRev: 5,
          hasPending: false,
          syncStatus: 'synced',
          syncError: undefined,
          isLoaded: true,
        });
        expect(sync.docStates.state.doc2).toEqual({
          committedRev: 0,
          hasPending: false,
          syncStatus: 'unsynced',
          syncError: undefined,
          isLoaded: false,
        });
      });

      it('should set hasPending true when doc has pending changes', async () => {
        const activeDocs: TrackedDoc[] = [{ docId: 'doc1', committedRev: 3 }];
        mockAlgorithm.listDocs.mockResolvedValue(activeDocs);
        mockAlgorithm.hasPending.mockResolvedValue(true);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        await sync['syncAllKnownDocs']();

        expect(sync.docStates.state.doc1.hasPending).toBe(true);
      });

      it('should not include deleted docs in synced map', async () => {
        const docs: TrackedDoc[] = [
          { docId: 'doc1', committedRev: 5 },
          { docId: 'doc2', committedRev: 3, deleted: true },
        ];
        mockAlgorithm.listDocs.mockResolvedValue(docs);
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        await sync['syncAllKnownDocs']();

        expect(sync.docStates.state.doc1).toBeDefined();
        expect(sync.docStates.state.doc2).toBeUndefined();
      });

      it('should emit onSyncedChange once for bulk population', async () => {
        const activeDocs: TrackedDoc[] = [
          { docId: 'doc1', committedRev: 5 },
          { docId: 'doc2', committedRev: 0 },
        ];
        mockAlgorithm.listDocs.mockResolvedValue(activeDocs);
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        const handler = vi.fn();
        sync.docStates.subscribe(handler, false);

        await sync['syncAllKnownDocs']();

        // Should emit once for the bulk population (individual syncDoc updates are mocked out)
        expect(handler).toHaveBeenCalledTimes(1);
      });
    });

    describe('syncDoc status transitions', () => {
      beforeEach(() => {
        sync['updateState']({ connected: true });
        // Pre-populate synced entry so _updateDocSyncState has something to update
        sync['_initDocSyncState']('doc1', { committedRev: 0, hasPending: false, syncStatus: 'unsynced' });
      });

      it('should set status to syncing at start of syncDoc', async () => {
        const statuses: string[] = [];
        sync.docStates.subscribe(() => {
          statuses.push(sync.docStates.state.doc1?.syncStatus);
        }, false);

        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        mockAlgorithm.getCommittedRev.mockResolvedValue(5);
        mockWebSocket.getChangesSince.mockResolvedValue([]);

        await sync['syncDoc']('doc1');

        expect(statuses[0]).toBe('syncing');
      });

      it('should set status to synced on successful sync', async () => {
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        mockAlgorithm.getCommittedRev.mockResolvedValue(5);
        mockWebSocket.getChangesSince.mockResolvedValue([]);

        await sync['syncDoc']('doc1');

        expect(sync.docStates.state.doc1.syncStatus).toBe('synced');
      });

      it('should set status to error on sync failure', async () => {
        mockAlgorithm.getPendingToSend.mockRejectedValue(new Error('store failure'));

        await sync['syncDoc']('doc1');

        expect(sync.docStates.state.doc1.syncStatus).toBe('error');
      });

      it('should update committedRev when server changes are applied', async () => {
        sync['_updateDocSyncState']('doc1', { committedRev: 5, syncStatus: 'synced' });

        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        mockAlgorithm.getCommittedRev.mockResolvedValue(5);
        const serverChanges = [{ id: 'c1', rev: 8, baseRev: 5, ops: [], createdAt: 0, committedAt: 0 }];
        mockWebSocket.getChangesSince.mockResolvedValue(serverChanges);

        await sync['syncDoc']('doc1');

        expect(sync.docStates.state.doc1.committedRev).toBe(8);
      });
    });

    describe('flushDoc status transitions', () => {
      beforeEach(() => {
        sync['updateState']({ connected: true });
        sync['trackedDocs'].add('doc1');
        sync['_initDocSyncState']('doc1', { committedRev: 3, hasPending: true, syncStatus: 'syncing' });
      });

      it('should set hasPending false and status synced after successful flush', async () => {
        const pending = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        const committed = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        mockWebSocket.commitChanges.mockResolvedValue({ changes: committed });
        mockAlgorithm.hasPending.mockResolvedValueOnce(false); // After confirm — no more pending

        await sync['flushDoc']('doc1', pending as Change[]);

        expect(sync.docStates.state.doc1.hasPending).toBe(false);
        expect(sync.docStates.state.doc1.syncStatus).toBe('synced');
      });

      it('should keep hasPending true if more pending remain after flush', async () => {
        const pending = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        const committed = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        mockWebSocket.commitChanges.mockResolvedValue({ changes: committed });
        mockAlgorithm.hasPending.mockResolvedValueOnce(true); // More pending

        await sync['flushDoc']('doc1', pending as Change[]);

        expect(sync.docStates.state.doc1.hasPending).toBe(true);
      });

      it('should set status to error on flush failure', async () => {
        const pending = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        mockWebSocket.commitChanges.mockRejectedValue(new Error('network error'));

        await expect(sync['flushDoc']('doc1', pending as Change[])).rejects.toThrow('network error');

        expect(sync.docStates.state.doc1.syncStatus).toBe('error');
      });
    });

    describe('tracking handler integration', () => {
      beforeEach(() => {
        sync['updateState']({ connected: true });
      });

      it('should add synced entries when docs are tracked', async () => {
        const trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls[0][0];
        mockAlgorithm.getCommittedRev.mockResolvedValue(5);
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        await trackHandler(['doc3'], 'ot');

        expect(sync.docStates.state.doc3).toEqual({
          committedRev: 5,
          hasPending: false,
          syncStatus: 'synced',
          syncError: undefined,
          isLoaded: true,
        });
      });

      it('should add unsynced entry for new doc with committedRev 0', async () => {
        const trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls[0][0];
        mockAlgorithm.getCommittedRev.mockResolvedValue(0);
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        await trackHandler(['doc3'], 'ot');

        expect(sync.docStates.state.doc3).toEqual({
          committedRev: 0,
          hasPending: false,
          syncStatus: 'unsynced',
          syncError: undefined,
          isLoaded: false,
        });
      });

      it('should remove synced entries when docs are untracked', async () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });
        sync['_initDocSyncState']('doc2', { committedRev: 3, hasPending: false, syncStatus: 'synced' });

        const untrackHandler = vi.mocked(mockPatches.onUntrackDocs).mock.calls[0][0];

        await untrackHandler(['doc1', 'doc2']);

        expect(sync.docStates.state.doc1).toBeUndefined();
        expect(sync.docStates.state.doc2).toBeUndefined();
      });

      it('should set hasPending true on doc change', async () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });
        sync['trackedDocs'].add('doc1');

        // Mock syncDoc to prevent actual sync
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        const changeHandler = vi.mocked(mockPatches.onChange).mock.calls[0][0];
        await changeHandler('doc1');

        expect(sync.docStates.state.doc1.hasPending).toBe(true);
      });

      it('should set hasPending true on doc change while offline', async () => {
        sync['updateState']({ connected: false });
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });
        sync['trackedDocs'].add('doc1');

        const changeHandler = vi.mocked(mockPatches.onChange).mock.calls[0][0];
        await changeHandler('doc1');

        expect(sync.docStates.state.doc1.hasPending).toBe(true);
        // Status stays synced (not syncing) since we're offline
        expect(sync.docStates.state.doc1.syncStatus).toBe('synced');
      });

      it('should update committedRev when server pushes committed changes', async () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });

        const changesHandler = vi.mocked(mockWebSocket.onChangesCommitted).mock.calls[0][0];
        const serverChanges = [
          { id: 'c1', rev: 9, baseRev: 5, ops: [], createdAt: 0, committedAt: 0 },
          { id: 'c2', rev: 10, baseRev: 9, ops: [], createdAt: 0, committedAt: 0 },
        ];

        await changesHandler('doc1', serverChanges);

        expect(sync.docStates.state.doc1.committedRev).toBe(10);
      });

      it('should reset syncing statuses on disconnect', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: true, syncStatus: 'syncing' });
        sync['_initDocSyncState']('doc2', { committedRev: 0, hasPending: false, syncStatus: 'syncing' });
        sync['_initDocSyncState']('doc3', { committedRev: 3, hasPending: false, syncStatus: 'synced' });

        sync.disconnect();

        expect(sync.docStates.state.doc1.syncStatus).toBe('synced');
        expect(sync.docStates.state.doc2.syncStatus).toBe('unsynced');
        expect(sync.docStates.state.doc3.syncStatus).toBe('synced'); // unchanged
      });

      it('should reset syncing statuses on connection loss', () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'syncing' });

        const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];
        connectionHandler('disconnected');

        expect(sync.docStates.state.doc1.syncStatus).toBe('synced');
      });

      it('should re-populate synced map on reconnection', async () => {
        // Initial state with some docs
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: true, syncStatus: 'syncing' });

        // Simulate disconnect
        const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];
        connectionHandler('disconnected');

        expect(sync.docStates.state.doc1.syncStatus).toBe('synced'); // Reset from syncing

        // Set up mocks for reconnection sync
        const activeDocs: TrackedDoc[] = [
          { docId: 'doc1', committedRev: 5 },
          { docId: 'doc3', committedRev: 10 },
        ];
        mockAlgorithm.listDocs.mockResolvedValue(activeDocs);
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        // Simulate reconnect
        connectionHandler('connected');
        // Wait for syncAllKnownDocs to complete
        await vi.waitFor(() => expect(sync.state.syncStatus).toBe('synced'));

        // Synced map should be rebuilt from store
        expect(sync.docStates.state.doc1).toEqual({
          committedRev: 5,
          hasPending: false,
          syncStatus: 'synced',
          syncError: undefined,
          isLoaded: true,
        });
        expect(sync.docStates.state.doc3).toEqual({
          committedRev: 10,
          hasPending: false,
          syncStatus: 'synced',
          syncError: undefined,
          isLoaded: true,
        });
      });

      it('should remove synced entry on remote doc deleted', async () => {
        sync['_initDocSyncState']('doc1', { committedRev: 5, hasPending: false, syncStatus: 'synced' });
        sync['trackedDocs'].add('doc1');
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        mockPatches.closeDoc = vi.fn().mockResolvedValue(undefined);

        await sync['_handleRemoteDocDeleted']('doc1');

        expect(sync.docStates.state.doc1).toBeUndefined();
      });
    });
  });

  describe('PatchesConnection constructor overload', () => {
    it('should accept a PatchesConnection instead of a URL', () => {
      const mockConnection = {
        url: 'https://api.example.com',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockResolvedValue([]),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        getDoc: vi.fn().mockResolvedValue({ state: {}, rev: 0 }),
        getChangesSince: vi.fn().mockResolvedValue([]),
        commitChanges: vi.fn().mockResolvedValue({ changes: [] }),
        deleteDoc: vi.fn().mockResolvedValue(undefined),
        createVersion: vi.fn().mockResolvedValue(''),
        listVersions: vi.fn().mockResolvedValue([]),
        getVersionState: vi.fn().mockResolvedValue({ state: {}, rev: 0 }),
        getVersionChanges: vi.fn().mockResolvedValue([]),
        updateVersion: vi.fn().mockResolvedValue(undefined),
        onStateChange: vi.fn(),
        onChangesCommitted: vi.fn(),
        onDocDeleted: vi.fn(),
      };

      const connectionSync = new PatchesSync(mockPatches, mockConnection as any);
      expect(connectionSync).toBeInstanceOf(PatchesSync);
      // Should NOT have created a PatchesWebSocket
      expect(connectionSync['connection']).toBe(mockConnection);
    });

    it('should still work with URL string (backward compat)', () => {
      const urlSync = new PatchesSync(mockPatches, 'ws://localhost:8080');
      expect(PatchesWebSocket).toHaveBeenCalledWith('ws://localhost:8080', undefined);
    });

    it('should return undefined for rpc when using non-WebSocket connection', () => {
      const mockConnection = {
        url: 'https://api.example.com',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
        subscribe: vi.fn().mockResolvedValue([]),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        getDoc: vi.fn().mockResolvedValue({ state: {}, rev: 0 }),
        getChangesSince: vi.fn().mockResolvedValue([]),
        commitChanges: vi.fn().mockResolvedValue({ changes: [] }),
        deleteDoc: vi.fn().mockResolvedValue(undefined),
        createVersion: vi.fn().mockResolvedValue(''),
        listVersions: vi.fn().mockResolvedValue([]),
        getVersionState: vi.fn().mockResolvedValue({ state: {}, rev: 0 }),
        getVersionChanges: vi.fn().mockResolvedValue([]),
        updateVersion: vi.fn().mockResolvedValue(undefined),
        onStateChange: vi.fn(),
        onChangesCommitted: vi.fn(),
        onDocDeleted: vi.fn(),
      };

      const connectionSync = new PatchesSync(mockPatches, mockConnection as any);
      expect(connectionSync.rpc).toBeUndefined();
    });

    it('should return rpc when using WebSocket connection (URL constructor)', () => {
      // mockWebSocket has an rpc property via PatchesClient
      expect(sync.rpc).toBeDefined();
    });
  });

  describe('edge cases and robustness', () => {
    it('should handle empty tracked docs list', async () => {
      mockPatches.trackedDocs = [];
      const newSync = new PatchesSync(mockPatches, 'ws://localhost:8080');

      expect(newSync['trackedDocs'].size).toBe(0);
    });

    it('should handle missing docOptions', () => {
      mockPatches.docOptions = undefined;
      const newSync = new PatchesSync(mockPatches, 'ws://localhost:8080');

      expect(newSync['maxPayloadBytes']).toBeUndefined();
    });

    it('should handle concurrent sync operations', async () => {
      sync['updateState']({ connected: true });

      const syncPromise1 = sync['syncDoc']('doc1');
      const syncPromise2 = sync['syncDoc']('doc2');

      await Promise.all([syncPromise1, syncPromise2]);

      // Sync now calls algorithm.getPendingToSend, not store.getPendingChanges
      expect(mockAlgorithm.getPendingToSend).toHaveBeenCalledWith('doc1');
      expect(mockAlgorithm.getPendingToSend).toHaveBeenCalledWith('doc2');
    });
  });

  describe('syncDoc serialGate: one in-flight at a time per doc', () => {
    beforeEach(() => {
      sync['updateState']({ connected: true });
      sync['trackedDocs'].add('doc1');
    });

    it('should run exactly one follow-up sync when changes arrive during in-flight', async () => {
      let resolveFirst!: () => void;
      const callCount = { value: 0 };

      // Spy on flushDoc (called inside syncDoc) to track actual send attempts
      // Since syncDoc is the gate, we count via flushDoc invocations
      const flushSpy = vi.spyOn(sync as any, 'flushDoc').mockResolvedValue(undefined);
      mockAlgorithm.getPendingToSend
        .mockResolvedValueOnce([{ id: 'a', rev: 1, baseRev: 0, ops: [], createdAt: 0, committedAt: 0 }])
        .mockResolvedValueOnce([{ id: 'b', rev: 2, baseRev: 1, ops: [], createdAt: 0, committedAt: 0 }])
        .mockResolvedValue(null);

      // Gate is on syncDoc itself now; hold it open via flushDoc
      let resolveFlush!: () => void;
      flushSpy.mockImplementationOnce(
        () =>
          new Promise<void>(r => {
            resolveFlush = r;
          })
      );

      // First call: in-flight (blocked inside flushDoc)
      const p1 = sync['syncDoc']('doc1');
      // Two more: should collapse to one queued follow-up
      sync['syncDoc']('doc1');
      sync['syncDoc']('doc1');

      await Promise.resolve();
      // Only one flush started
      expect(flushSpy).toHaveBeenCalledTimes(1);

      // Unblock the first
      resolveFlush();
      await p1;
      await vi.waitFor(() => flushSpy.mock.calls.length === 2);

      // Exactly one follow-up flush (not two)
      expect(flushSpy).toHaveBeenCalledTimes(2);
    });

    it('should not run a follow-up when no additional triggers arrived', async () => {
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(5);
      mockWebSocket.getChangesSince.mockResolvedValue([]);

      await sync['syncDoc']('doc1');

      await Promise.resolve();
      await Promise.resolve();

      // getCommittedRev called exactly once (one syncDoc run, no follow-up)
      expect(mockAlgorithm.getCommittedRev).toHaveBeenCalledTimes(1);
    });

    it('should be a no-op after disconnect (syncDoc returns early)', async () => {
      let resolveFlush!: () => void;
      const flushSpy = vi.spyOn(sync as any, 'flushDoc').mockImplementation(
        () =>
          new Promise<void>(r => {
            resolveFlush = r;
          })
      );
      mockAlgorithm.getPendingToSend.mockResolvedValue([
        { id: 'a', rev: 1, baseRev: 0, ops: [], createdAt: 0, committedAt: 0 },
      ]);

      const p1 = sync['syncDoc']('doc1'); // in-flight
      sync['syncDoc']('doc1'); // queued

      // Wait for getPendingToSend to resolve so flushDoc is actually called
      await vi.waitFor(() => flushSpy.mock.calls.length > 0);

      const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];
      connectionHandler('disconnected');

      resolveFlush();
      await p1;
      // Let follow-up attempt settle
      await vi.waitFor(() => true);
      await Promise.resolve();
      await Promise.resolve();

      // Follow-up ran but returned early (not connected), so only one flush
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('should be a no-op after doc is untracked (syncDoc returns early)', async () => {
      let resolveFlush!: () => void;
      const flushSpy = vi.spyOn(sync as any, 'flushDoc').mockImplementation(
        () =>
          new Promise<void>(r => {
            resolveFlush = r;
          })
      );
      mockAlgorithm.getPendingToSend.mockResolvedValue([
        { id: 'a', rev: 1, baseRev: 0, ops: [], createdAt: 0, committedAt: 0 },
      ]);

      const p1 = sync['syncDoc']('doc1'); // in-flight
      sync['syncDoc']('doc1'); // queued

      const untrackHandler = vi.mocked(mockPatches.onUntrackDocs).mock.calls[0][0];
      await untrackHandler(['doc1']); // removes doc1 from trackedDocs

      resolveFlush();
      await p1;
      await vi.waitFor(() => true);
      await Promise.resolve();
      await Promise.resolve();

      // Follow-up ran but returned early (not tracked), so only one flush
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('should gate each docId independently', async () => {
      let resolveDoc1!: () => void;
      const flushCalls: string[] = [];

      vi.spyOn(sync as any, 'flushDoc').mockImplementation(function (this: any, ...args: unknown[]) {
        const [docId] = args as [string];
        flushCalls.push(docId);
        if (docId === 'doc1' && flushCalls.filter(id => id === 'doc1').length === 1) {
          return new Promise<void>(resolve => {
            resolveDoc1 = resolve;
          });
        }
        return Promise.resolve();
      });
      mockAlgorithm.getPendingToSend.mockResolvedValue([
        { id: 'a', rev: 1, baseRev: 0, ops: [], createdAt: 0, committedAt: 0 },
      ]);

      sync['trackedDocs'].add('doc2');

      const doc1Promise = sync['syncDoc']('doc1');
      await sync['syncDoc']('doc2');

      // doc2 completed; doc1 still in-flight
      expect(flushCalls.filter(id => id === 'doc1').length).toBe(1);
      expect(flushCalls.filter(id => id === 'doc2').length).toBe(1);

      resolveDoc1();
      await doc1Promise;
    });
  });

  describe('syncPendingBranchMetas', () => {
    let mockBranchStore: any;
    let mockBranchApi: any;

    beforeEach(() => {
      mockBranchStore = {
        listBranches: vi.fn().mockResolvedValue([]),
        createBranch: vi.fn().mockResolvedValue('branch-id'),
        updateBranch: vi.fn().mockResolvedValue(undefined),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
        loadBranch: vi.fn().mockResolvedValue(undefined),
        saveBranches: vi.fn().mockResolvedValue(undefined),
        removeBranches: vi.fn().mockResolvedValue(undefined),
        listPendingBranches: vi.fn().mockResolvedValue([]),
        getLastModifiedAt: vi.fn().mockResolvedValue(undefined),
      };
      mockBranchApi = {
        listBranches: vi.fn().mockResolvedValue([]),
        createBranch: vi.fn().mockResolvedValue('branch-id'),
        updateBranch: vi.fn().mockResolvedValue(undefined),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
        mergeBranch: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('should do nothing without branchStore', async () => {
      sync['updateState']({ connected: true });
      await sync['syncPendingBranchMetas']();
      // No errors, no calls
    });

    it('should create pending branches on server and clear pendingOp', async () => {
      const pendingBranch = {
        id: 'my-branch',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: 1000,
        modifiedAt: 1000,

        contentStartRev: 2,
        name: 'Feature',
        pendingOp: 'create' as const,
      };
      mockBranchStore.listPendingBranches.mockResolvedValue([pendingBranch]);

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      syncWithBranches['updateState']({ connected: true });

      await syncWithBranches['syncPendingBranchMetas']();

      // Should create on server with metadata (no docId/branchedAtRev/createdAt/modifiedAt/pendingOp)
      expect(mockBranchApi.createBranch).toHaveBeenCalledWith('doc1', 5, {
        id: 'my-branch',
        contentStartRev: 2,
        name: 'Feature',
      });

      // Should save without pendingOp
      const savedBranches = mockBranchStore.saveBranches.mock.calls[0][1];
      expect(savedBranches[0].id).toBe('my-branch');
      expect(savedBranches[0]).not.toHaveProperty('pendingOp');
    });

    it('should stop processing on API error', async () => {
      const branch1 = {
        id: 'b1',
        docId: 'doc1',
        branchedAtRev: 3,
        createdAt: 100,
        modifiedAt: 100,

        contentStartRev: 2,
        pendingOp: 'create' as const,
      };
      const branch2 = {
        id: 'b2',
        docId: 'doc1',
        branchedAtRev: 4,
        createdAt: 200,
        modifiedAt: 200,

        contentStartRev: 2,
        pendingOp: 'create' as const,
      };
      mockBranchStore.listPendingBranches.mockResolvedValue([branch1, branch2]);
      mockBranchApi.createBranch.mockRejectedValueOnce(new Error('Network error'));

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      syncWithBranches['updateState']({ connected: true });

      await syncWithBranches['syncPendingBranchMetas']();

      // Should have tried first but not second
      expect(mockBranchApi.createBranch).toHaveBeenCalledTimes(1);
      expect(mockBranchStore.saveBranches).not.toHaveBeenCalled();
    });

    it('should stop if disconnected mid-sync', async () => {
      const branch = {
        id: 'b1',
        docId: 'doc1',
        branchedAtRev: 3,
        createdAt: 100,
        modifiedAt: 100,

        contentStartRev: 2,
        pendingOp: 'create' as const,
      };
      mockBranchStore.listPendingBranches.mockResolvedValue([branch]);

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      // Not connected
      syncWithBranches['updateState']({ connected: false });

      await syncWithBranches['syncPendingBranchMetas']();

      expect(mockBranchApi.createBranch).not.toHaveBeenCalled();
    });

    it('should query all pending branches regardless of docId', async () => {
      const branch1 = {
        id: 'b1',
        docId: 'doc1',
        branchedAtRev: 3,
        createdAt: 100,
        modifiedAt: 100,

        contentStartRev: 2,
        pendingOp: 'create' as const,
      };
      const branch2 = {
        id: 'b2',
        docId: 'doc2',
        branchedAtRev: 1,
        createdAt: 200,
        modifiedAt: 200,

        contentStartRev: 2,
        pendingOp: 'create' as const,
      };
      mockBranchStore.listPendingBranches.mockResolvedValue([branch1, branch2]);

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      syncWithBranches['updateState']({ connected: true });

      await syncWithBranches['syncPendingBranchMetas']();

      // Should create both branches from different docs
      expect(mockBranchApi.createBranch).toHaveBeenCalledTimes(2);
      expect(mockBranchApi.createBranch).toHaveBeenCalledWith('doc1', 3, expect.objectContaining({ id: 'b1' }));
      expect(mockBranchApi.createBranch).toHaveBeenCalledWith('doc2', 1, expect.objectContaining({ id: 'b2' }));
    });

    it('should sync pending branch deletions to server and remove tombstone', async () => {
      const deletedBranch = {
        id: 'del-branch',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: 1000,
        modifiedAt: 2000,

        contentStartRev: 2,
        pendingOp: 'delete' as const,
        deleted: true as const,
      };
      mockBranchStore.listPendingBranches.mockResolvedValue([deletedBranch]);

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      syncWithBranches['updateState']({ connected: true });

      await syncWithBranches['syncPendingBranchMetas']();

      // Should call deleteBranch on server
      expect(mockBranchApi.deleteBranch).toHaveBeenCalledWith('del-branch');
      // Should NOT call createBranch
      expect(mockBranchApi.createBranch).not.toHaveBeenCalled();
      // Should physically remove tombstone from local store
      expect(mockBranchStore.removeBranches).toHaveBeenCalledWith(['del-branch']);
    });

    it('should process creations before deletions', async () => {
      const callOrder: string[] = [];
      const createdBranch = {
        id: 'new-branch',
        docId: 'doc1',
        branchedAtRev: 3,
        createdAt: 100,
        modifiedAt: 100,

        contentStartRev: 2,
        pendingOp: 'create' as const,
      };
      const deletedBranch = {
        id: 'old-branch',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: 500,
        modifiedAt: 600,

        contentStartRev: 2,
        pendingOp: 'delete' as const,
        deleted: true as const,
      };
      mockBranchStore.listPendingBranches.mockResolvedValue([deletedBranch, createdBranch]);
      mockBranchApi.createBranch.mockImplementation(() => {
        callOrder.push('create');
        return Promise.resolve('new-branch');
      });
      mockBranchApi.deleteBranch.mockImplementation(() => {
        callOrder.push('delete');
        return Promise.resolve();
      });

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      syncWithBranches['updateState']({ connected: true });

      await syncWithBranches['syncPendingBranchMetas']();

      expect(callOrder).toEqual(['create', 'delete']);
    });

    it('should emit onBranchMetasSynced after syncing pending branches', async () => {
      const pendingBranch = {
        id: 'b1',
        docId: 'doc1',
        branchedAtRev: 3,
        createdAt: 100,
        modifiedAt: 100,

        contentStartRev: 2,
        pendingOp: 'create' as const,
      };
      mockBranchStore.listPendingBranches.mockResolvedValue([pendingBranch]);

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      syncWithBranches['updateState']({ connected: true });

      const handler = vi.fn();
      syncWithBranches.onBranchMetasSynced(handler);

      await syncWithBranches['syncPendingBranchMetas']();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not emit onBranchMetasSynced when no pending branches', async () => {
      mockBranchStore.listPendingBranches.mockResolvedValue([]);

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      syncWithBranches['updateState']({ connected: true });

      const handler = vi.fn();
      syncWithBranches.onBranchMetasSynced(handler);

      await syncWithBranches['syncPendingBranchMetas']();

      expect(handler).not.toHaveBeenCalled();
    });

    it('should stop processing deletions on error and keep tombstone', async () => {
      const deletedBranch = {
        id: 'del-branch',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: 1000,
        modifiedAt: 2000,

        contentStartRev: 2,
        pendingOp: 'delete' as const,
        deleted: true as const,
      };
      mockBranchStore.listPendingBranches.mockResolvedValue([deletedBranch]);
      mockBranchApi.deleteBranch.mockRejectedValueOnce(new Error('Network error'));

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      syncWithBranches['updateState']({ connected: true });

      await syncWithBranches['syncPendingBranchMetas']();

      // Should have tried to delete
      expect(mockBranchApi.deleteBranch).toHaveBeenCalledWith('del-branch');
      // Should NOT have removed the tombstone (kept for retry)
      expect(mockBranchStore.removeBranches).not.toHaveBeenCalled();
    });

    it('should sync pending update operations', async () => {
      const updatedBranch = {
        id: 'update-branch',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: 1000,
        modifiedAt: 2000,

        contentStartRev: 2,
        lastMergedRev: 10,
        pendingOp: 'update' as const,
      };
      mockBranchStore.listPendingBranches.mockResolvedValue([updatedBranch]);

      const syncWithBranches = new PatchesSync(mockPatches, 'ws://localhost:8080', {
        branchStore: mockBranchStore,
        branchApi: mockBranchApi,
      });
      syncWithBranches['updateState']({ connected: true });

      await syncWithBranches['syncPendingBranchMetas']();

      // Should call updateBranch with editable metadata (lastMergedRev, name, etc.)
      expect(mockBranchApi.updateBranch).toHaveBeenCalledWith(
        'update-branch',
        expect.objectContaining({
          lastMergedRev: 10,
        })
      );
      const savedBranches = mockBranchStore.saveBranches.mock.calls[0][1];
      expect(savedBranches[0]).not.toHaveProperty('pendingOp');
    });
  });
});
