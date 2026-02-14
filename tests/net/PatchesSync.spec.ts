import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Patches } from '../../src/client/Patches';
import type { TrackedDoc } from '../../src/client/PatchesStore';
import { PatchesSync } from '../../src/net/PatchesSync';
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
vi.mock('../../src/algorithms/ot/client/applyCommittedChanges', () => ({
  applyCommittedChanges: vi.fn(() => ({
    state: { content: 'updated' },
    rev: 6,
    changes: [],
  })),
}));
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
      getPendingToSend: vi.fn().mockResolvedValue(null),
      applyServerChanges: vi.fn().mockResolvedValue([]),
      confirmSent: vi.fn().mockResolvedValue(undefined),
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
      commitChanges: vi.fn().mockResolvedValue([]),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
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
    vi.mocked(onlineState).onOnlineChange = vi.fn() as any;

    sync = new PatchesSync(mockPatches, 'ws://localhost:8080');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

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
      expect(sync.state.syncing).toBeNull();
    });

    it('should track existing docs from patches', () => {
      expect(sync['trackedDocs'].has('doc1')).toBe(true);
      expect(sync['trackedDocs'].has('doc2')).toBe(true);
    });
  });

  describe('state management', () => {
    it('should return current state', () => {
      const state = sync.state;
      expect(state).toEqual({
        online: true,
        connected: false,
        syncing: null,
      });
    });

    it('should emit state change when state updates', () => {
      const stateHandler = vi.fn();
      sync.onStateChange(stateHandler);

      sync['updateState']({ connected: true });

      expect(stateHandler).toHaveBeenCalledWith({
        online: true,
        connected: true,
        syncing: null,
      });
    });

    it('should not emit if state has not changed', () => {
      const stateHandler = vi.fn();
      sync.onStateChange(stateHandler);

      sync['updateState']({ online: true }); // Same as current state

      expect(stateHandler).not.toHaveBeenCalled();
    });

    it('should handle online state changes', () => {
      const onlineHandler = vi.mocked(onlineState.onOnlineChange).mock.calls[0][0];
      const stateHandler = vi.fn();
      sync.onStateChange(stateHandler);

      onlineHandler(false);

      expect(stateHandler).toHaveBeenCalledWith({
        online: false,
        connected: false,
        syncing: null,
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
      expect(sync.state.syncing).toBe(error);
    });

    it('should handle non-Error connection failures', async () => {
      mockWebSocket.connect.mockRejectedValue('string error');

      await expect(sync.connect()).rejects.toBe('string error');

      expect(sync.state.syncing).toBeInstanceOf(Error);
    });
  });

  describe('disconnect method', () => {
    it('should disconnect and reset state', () => {
      sync['updateState']({ connected: true, syncing: 'updating' });

      sync.disconnect();

      expect(mockWebSocket.disconnect).toHaveBeenCalled();
      expect(sync.state.connected).toBe(false);
      expect(sync.state.syncing).toBeNull();
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
      expect(sync.state.syncing).toBeNull();
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
        updateSyncing: vi.fn(),
        import: vi.fn(),
      };

      const snapshot = { state: { content: 'new' }, rev: 1 };
      mockWebSocket.getDoc.mockResolvedValue(snapshot);

      mockPatches.getOpenDoc.mockReturnValue(mockDoc);
      // Sync now calls algorithm methods
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(0);

      await sync['syncDoc']('doc1');

      expect(mockDoc.updateSyncing).toHaveBeenCalledWith('updating');
      expect(mockDoc.updateSyncing).toHaveBeenCalledWith(null);
    });

    it('should import snapshot into open doc when no committed rev', async () => {
      const mockDoc = {
        updateSyncing: vi.fn(),
        import: vi.fn(),
      };

      const snapshot = { state: { content: 'new' }, rev: 1 };
      mockWebSocket.getDoc.mockResolvedValue(snapshot);

      mockPatches.getOpenDoc.mockReturnValue(mockDoc);
      // Sync now calls algorithm methods
      mockAlgorithm.getPendingToSend.mockResolvedValue(null);
      mockAlgorithm.getCommittedRev.mockResolvedValue(0);

      await sync['syncDoc']('doc1');

      // Sync now calls doc.import directly (via BaseDoc cast)
      expect(mockDoc.import).toHaveBeenCalledWith({ ...snapshot, changes: [] });
    });

    it('should not sync if not connected', async () => {
      sync['updateState']({ connected: false });

      await sync['syncDoc']('doc1');

      // Sync now calls algorithm methods
      expect(mockAlgorithm.getPendingToSend).not.toHaveBeenCalled();
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
      mockWebSocket.commitChanges.mockResolvedValue(committed);

      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);

      await sync['flushDoc']('doc1');

      expect(mockWebSocket.commitChanges).toHaveBeenCalledWith('doc1', pendingChanges);
      expect(applySpy).toHaveBeenCalledWith('doc1', committed);
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
  });

  describe('connection state handling', () => {
    it('should handle connection state changes', () => {
      const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];

      const stateHandler = vi.fn();
      sync.onStateChange(stateHandler);

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
      sync['updateState']({ syncing: 'updating' });

      const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];

      connectionHandler('connecting');

      expect(sync.state.syncing).toBe('updating'); // Preserved
    });

    it('should reset syncing state when disconnected', () => {
      sync['updateState']({ connected: true, syncing: 'updating' });

      const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];

      connectionHandler('disconnected');

      expect(sync.state.connected).toBe(false);
      expect(sync.state.syncing).toBeNull(); // Reset
    });
  });

  describe('document tracking handlers', () => {
    beforeEach(() => {
      sync['updateState']({ connected: true });
    });

    it('should handle new tracked documents', async () => {
      const trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls[0][0];
      const syncDocSpy = vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

      await trackHandler(['doc3', 'doc4']);

      expect(sync['trackedDocs'].has('doc3')).toBe(true);
      expect(sync['trackedDocs'].has('doc4')).toBe(true);
      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['doc3', 'doc4']);
      expect(syncDocSpy).toHaveBeenCalledWith('doc3');
      expect(syncDocSpy).toHaveBeenCalledWith('doc4');
    });

    it('should handle already tracked documents', async () => {
      const trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls[0][0];

      await trackHandler(['doc1']); // Already tracked

      expect(mockWebSocket.subscribe).not.toHaveBeenCalled();
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
    let trackHandler: (docIds: string[]) => Promise<void>;
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
      await trackHandler(['users/u1']);

      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['users/u1']);
    });

    it('should not re-subscribe when tracking a subdoc under an already-tracked root', async () => {
      await trackHandler(['users/u1']);
      mockWebSocket.subscribe.mockClear();

      await trackHandler(['users/u1/preferences']);

      expect(mockWebSocket.subscribe).not.toHaveBeenCalled();
    });

    it('should subscribe once when tracking root and subdocs together', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences', 'users/u1/stats']);

      expect(mockWebSocket.subscribe).toHaveBeenCalledTimes(1);
      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['users/u1']);
    });

    it('should subscribe to a new root when tracking docs under a different root', async () => {
      await trackHandler(['users/u1']);
      mockWebSocket.subscribe.mockClear();

      await trackHandler(['projects/p1', 'projects/p1/tasks']);

      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['projects/p1']);
    });

    it('should not unsubscribe root when untracking a subdoc while root is still tracked', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences']);
      mockWebSocket.subscribe.mockClear();

      await untrackHandler(['users/u1/preferences']);

      expect(mockWebSocket.unsubscribe).not.toHaveBeenCalled();
    });

    it('should not unsubscribe root when untracking a subdoc while other subdocs remain', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences', 'users/u1/stats']);
      mockWebSocket.subscribe.mockClear();

      await untrackHandler(['users/u1/preferences']);

      expect(mockWebSocket.unsubscribe).not.toHaveBeenCalled();
    });

    it('should unsubscribe root when all docs under that root are untracked', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences']);
      mockWebSocket.subscribe.mockClear();

      await untrackHandler(['users/u1', 'users/u1/preferences']);

      expect(mockWebSocket.unsubscribe).toHaveBeenCalledWith(['users/u1']);
    });

    it('should only unsubscribe the root whose docs are all gone', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences', 'projects/p1']);
      mockWebSocket.subscribe.mockClear();

      await untrackHandler(['projects/p1']);

      expect(mockWebSocket.unsubscribe).toHaveBeenCalledWith(['projects/p1']);
    });

    it('should still sync all newly tracked docs regardless of subscribe filter', async () => {
      const syncDocSpy = vi.spyOn(syncWithFilter as any, 'syncDoc').mockResolvedValue(undefined);

      await trackHandler(['users/u1', 'users/u1/preferences']);

      expect(syncDocSpy).toHaveBeenCalledWith('users/u1');
      expect(syncDocSpy).toHaveBeenCalledWith('users/u1/preferences');
    });

    it('should still track all docs locally regardless of subscribe filter', async () => {
      await trackHandler(['users/u1', 'users/u1/preferences']);

      expect(syncWithFilter['trackedDocs'].has('users/u1')).toBe(true);
      expect(syncWithFilter['trackedDocs'].has('users/u1/preferences')).toBe(true);
    });
  });

  describe('synced doc status', () => {
    describe('initial state', () => {
      it('should initialize with empty synced map', () => {
        expect(sync.synced).toEqual({});
      });

      it('should have onSyncedChange signal', () => {
        expect(sync.onSyncedChange).toBeDefined();
        expect(typeof sync.onSyncedChange).toBe('function');
        expect(typeof sync.onSyncedChange.emit).toBe('function');
      });
    });

    describe('_updateSyncedDoc', () => {
      it('should add a new doc entry when it does not exist and emit', async () => {
        const handler = vi.fn();
        sync.onSyncedChange(handler);

        sync['_updateSyncedDoc']('doc1', { committedRev: 0, hasPending: false, status: 'unsynced' });

        expect(sync.synced).toEqual({
          doc1: { committedRev: 0, hasPending: false, status: 'unsynced' },
        });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(sync.synced));
      });

      it('should create new object reference on add', () => {
        const before = sync.synced;
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'synced' });
        expect(sync.synced).not.toBe(before);
      });

      it('should merge updates into an existing entry and emit', async () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 0, hasPending: false, status: 'unsynced' });

        const handler = vi.fn();
        sync.onSyncedChange(handler);

        sync['_updateSyncedDoc']('doc1', { status: 'syncing' });

        expect(sync.synced.doc1).toEqual({ committedRev: 0, hasPending: false, status: 'syncing' });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(sync.synced));
      });

      it('should no-op if nothing changed on existing entry', () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'synced' });

        const handler = vi.fn();
        sync.onSyncedChange(handler);

        sync['_updateSyncedDoc']('doc1', { committedRev: 5 });

        expect(handler).not.toHaveBeenCalled();
      });

      it('should create new object reference on update', () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 0, hasPending: false, status: 'unsynced' });
        const before = sync.synced;

        sync['_updateSyncedDoc']('doc1', { hasPending: true });

        expect(sync.synced).not.toBe(before);
      });

      it('should remove a doc entry when updates is undefined and emit', async () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'synced' });

        const handler = vi.fn();
        sync.onSyncedChange(handler);

        sync['_updateSyncedDoc']('doc1', undefined);

        expect(sync.synced).toEqual({});
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(sync.synced));
      });

      it('should no-op when removing a doc not in the map', () => {
        const handler = vi.fn();
        sync.onSyncedChange(handler);

        sync['_updateSyncedDoc']('nonexistent', undefined);

        expect(handler).not.toHaveBeenCalled();
      });

      it('should create new object reference on remove', () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'synced' });
        const before = sync.synced;

        sync['_updateSyncedDoc']('doc1', undefined);

        expect(sync.synced).not.toBe(before);
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

        expect(sync.synced.doc1).toEqual({ committedRev: 5, hasPending: false, status: 'synced' });
        expect(sync.synced.doc2).toEqual({ committedRev: 0, hasPending: false, status: 'unsynced' });
      });

      it('should set hasPending true when doc has pending changes', async () => {
        const activeDocs: TrackedDoc[] = [{ docId: 'doc1', committedRev: 3 }];
        mockAlgorithm.listDocs.mockResolvedValue(activeDocs);
        mockAlgorithm.getPendingToSend.mockResolvedValue([
          { id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 },
        ]);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        await sync['syncAllKnownDocs']();

        expect(sync.synced.doc1.hasPending).toBe(true);
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

        expect(sync.synced.doc1).toBeDefined();
        expect(sync.synced.doc2).toBeUndefined();
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
        sync.onSyncedChange(handler);

        await sync['syncAllKnownDocs']();

        // Should emit once for the bulk population (individual syncDoc updates are mocked out)
        expect(handler).toHaveBeenCalledTimes(1);
      });
    });

    describe('syncDoc status transitions', () => {
      beforeEach(() => {
        sync['updateState']({ connected: true });
        // Pre-populate synced entry so _updateSyncedDoc has something to update
        sync['_updateSyncedDoc']('doc1', { committedRev: 0, hasPending: false, status: 'unsynced' });
      });

      it('should set status to syncing at start of syncDoc', async () => {
        const statuses: string[] = [];
        sync.onSyncedChange(() => {
          statuses.push(sync.synced.doc1?.status);
        });

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

        expect(sync.synced.doc1.status).toBe('synced');
      });

      it('should set status to error on sync failure', async () => {
        mockAlgorithm.getPendingToSend.mockRejectedValue(new Error('store failure'));

        await sync['syncDoc']('doc1');

        expect(sync.synced.doc1.status).toBe('error');
      });

      it('should update committedRev when server changes are applied', async () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, status: 'synced' });

        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        mockAlgorithm.getCommittedRev.mockResolvedValue(5);
        const serverChanges = [{ id: 'c1', rev: 8, baseRev: 5, ops: [], createdAt: 0, committedAt: 0 }];
        mockWebSocket.getChangesSince.mockResolvedValue(serverChanges);

        await sync['syncDoc']('doc1');

        expect(sync.synced.doc1.committedRev).toBe(8);
      });
    });

    describe('flushDoc status transitions', () => {
      beforeEach(() => {
        sync['updateState']({ connected: true });
        sync['trackedDocs'].add('doc1');
        sync['_updateSyncedDoc']('doc1', { committedRev: 3, hasPending: true, status: 'syncing' });
      });

      it('should set hasPending false and status synced after successful flush', async () => {
        const pending = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        const committed = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        mockWebSocket.commitChanges.mockResolvedValue(committed);
        mockAlgorithm.getPendingToSend.mockResolvedValueOnce(null); // After confirm — no more pending

        await sync['flushDoc']('doc1', pending as Change[]);

        expect(sync.synced.doc1.hasPending).toBe(false);
        expect(sync.synced.doc1.status).toBe('synced');
      });

      it('should keep hasPending true if more pending remain after flush', async () => {
        const pending = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        const committed = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        mockWebSocket.commitChanges.mockResolvedValue(committed);
        mockAlgorithm.getPendingToSend.mockResolvedValueOnce([
          { id: 'c2', rev: 5, baseRev: 4, ops: [], createdAt: 0, committedAt: 0 },
        ]); // More pending

        await sync['flushDoc']('doc1', pending as Change[]);

        expect(sync.synced.doc1.hasPending).toBe(true);
      });

      it('should set status to error on flush failure', async () => {
        const pending = [{ id: 'c1', rev: 4, baseRev: 3, ops: [], createdAt: 0, committedAt: 0 }];
        mockWebSocket.commitChanges.mockRejectedValue(new Error('network error'));

        await expect(sync['flushDoc']('doc1', pending as Change[])).rejects.toThrow('network error');

        expect(sync.synced.doc1.status).toBe('error');
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

        await trackHandler(['doc3']);

        expect(sync.synced.doc3).toEqual({ committedRev: 5, hasPending: false, status: 'synced' });
      });

      it('should add unsynced entry for new doc with committedRev 0', async () => {
        const trackHandler = vi.mocked(mockPatches.onTrackDocs).mock.calls[0][0];
        mockAlgorithm.getCommittedRev.mockResolvedValue(0);
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        vi.spyOn(sync as any, 'syncDoc').mockResolvedValue(undefined);

        await trackHandler(['doc3']);

        expect(sync.synced.doc3).toEqual({ committedRev: 0, hasPending: false, status: 'unsynced' });
      });

      it('should remove synced entries when docs are untracked', async () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'synced' });
        sync['_updateSyncedDoc']('doc2', { committedRev: 3, hasPending: false, status: 'synced' });

        const untrackHandler = vi.mocked(mockPatches.onUntrackDocs).mock.calls[0][0];

        await untrackHandler(['doc1', 'doc2']);

        expect(sync.synced.doc1).toBeUndefined();
        expect(sync.synced.doc2).toBeUndefined();
      });

      it('should set hasPending true on doc change', async () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'synced' });
        sync['trackedDocs'].add('doc1');

        // Mock flushDoc to prevent actual flush
        vi.spyOn(sync as any, 'flushDoc').mockResolvedValue(undefined);

        const changeHandler = vi.mocked(mockPatches.onChange).mock.calls[0][0];
        await changeHandler('doc1');

        expect(sync.synced.doc1.hasPending).toBe(true);
        expect(sync.synced.doc1.status).toBe('syncing');
      });

      it('should set hasPending true on doc change while offline', async () => {
        sync['updateState']({ connected: false });
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'synced' });
        sync['trackedDocs'].add('doc1');

        const changeHandler = vi.mocked(mockPatches.onChange).mock.calls[0][0];
        await changeHandler('doc1');

        expect(sync.synced.doc1.hasPending).toBe(true);
        // Status stays synced (not syncing) since we're offline
        expect(sync.synced.doc1.status).toBe('synced');
      });

      it('should update committedRev when server pushes committed changes', async () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'synced' });

        const changesHandler = vi.mocked(mockWebSocket.onChangesCommitted).mock.calls[0][0];
        const serverChanges = [
          { id: 'c1', rev: 9, baseRev: 5, ops: [], createdAt: 0, committedAt: 0 },
          { id: 'c2', rev: 10, baseRev: 9, ops: [], createdAt: 0, committedAt: 0 },
        ];

        await changesHandler('doc1', serverChanges);

        expect(sync.synced.doc1.committedRev).toBe(10);
      });

      it('should reset syncing statuses on disconnect', () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: true, status: 'syncing' });
        sync['_updateSyncedDoc']('doc2', { committedRev: 0, hasPending: false, status: 'syncing' });
        sync['_updateSyncedDoc']('doc3', { committedRev: 3, hasPending: false, status: 'synced' });

        sync.disconnect();

        expect(sync.synced.doc1.status).toBe('synced');
        expect(sync.synced.doc2.status).toBe('unsynced');
        expect(sync.synced.doc3.status).toBe('synced'); // unchanged
      });

      it('should reset syncing statuses on connection loss', () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'syncing' });

        const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];
        connectionHandler('disconnected');

        expect(sync.synced.doc1.status).toBe('synced');
      });

      it('should re-populate synced map on reconnection', async () => {
        // Initial state with some docs
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: true, status: 'syncing' });

        // Simulate disconnect
        const connectionHandler = vi.mocked(mockWebSocket.onStateChange).mock.calls[0][0];
        connectionHandler('disconnected');

        expect(sync.synced.doc1.status).toBe('synced'); // Reset from syncing

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
        await vi.waitFor(() => expect(sync.state.syncing).toBeNull());

        // Synced map should be rebuilt from store
        expect(sync.synced.doc1).toEqual({ committedRev: 5, hasPending: false, status: 'synced' });
        expect(sync.synced.doc3).toEqual({ committedRev: 10, hasPending: false, status: 'synced' });
      });

      it('should remove synced entry on remote doc deleted', async () => {
        sync['_updateSyncedDoc']('doc1', { committedRev: 5, hasPending: false, status: 'synced' });
        sync['trackedDocs'].add('doc1');
        mockAlgorithm.getPendingToSend.mockResolvedValue(null);
        mockPatches.closeDoc = vi.fn().mockResolvedValue(undefined);

        await sync['_handleRemoteDocDeleted']('doc1');

        expect(sync.synced.doc1).toBeUndefined();
      });
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
});
