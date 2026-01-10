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
vi.mock('../../src/algorithms/client/applyCommittedChanges', () => ({
  applyCommittedChanges: vi.fn(() => ({
    state: { content: 'updated' },
    rev: 6,
    changes: [],
  })),
}));
vi.mock('../../src/algorithms/client/batching', () => ({
  breakIntoBatches: vi.fn(changes => [changes]),
}));

describe('PatchesSync', () => {
  let mockPatches: any;
  let mockStore: any;
  let mockWebSocket: any;
  let sync: PatchesSync;

  beforeEach(() => {
    // Mock PatchesStore
    mockStore = {
      listDocs: vi.fn().mockResolvedValue([]),
      getPendingChanges: vi.fn().mockResolvedValue([]),
      getLastRevs: vi.fn().mockResolvedValue([0, 0]),
      saveDoc: vi.fn().mockResolvedValue(undefined),
      saveCommittedChanges: vi.fn().mockResolvedValue(undefined),
      replacePendingChanges: vi.fn().mockResolvedValue(undefined),
      confirmDeleteDoc: vi.fn().mockResolvedValue(undefined),
      getDoc: vi.fn().mockResolvedValue({
        state: { content: 'test' },
        rev: 5,
        changes: [],
      }),
    };

    // Mock Patches
    mockPatches = {
      store: mockStore,
      trackedDocs: ['doc1', 'doc2'],
      docOptions: { maxPayloadBytes: 1000 },
      getOpenDoc: vi.fn().mockReturnValue(null),
      onTrackDocs: vi.fn(),
      onUntrackDocs: vi.fn(),
      onDeleteDoc: vi.fn(),
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
    };

    // Mock constructors - use function expressions for Vitest 4 compatibility
    vi.mocked(Patches).mockImplementation(function() { return mockPatches; });
    vi.mocked(PatchesWebSocket).mockImplementation(function() { return mockWebSocket; });

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

      mockStore.listDocs.mockResolvedValue(activeDocs);

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

      mockStore.listDocs.mockResolvedValue(docs);

      await sync['syncAllKnownDocs']();

      expect(mockWebSocket.subscribe).toHaveBeenCalledWith(['doc1']);
      expect(mockWebSocket.deleteDoc).toHaveBeenCalledWith('doc2');
      expect(mockStore.confirmDeleteDoc).toHaveBeenCalledWith('doc2');
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
      const pendingChanges: Change[] = [{ id: 'c1', rev: 1, baseRev: 0, ops: [], createdAt: '2024-01-01T00:00:00.000Z', committedAt: '2024-01-01T00:00:00.000Z' }];

      mockStore.getPendingChanges.mockResolvedValue(pendingChanges);

      const flushDocSpy = vi.spyOn(sync as any, 'flushDoc').mockResolvedValue(undefined);

      await sync['syncDoc']('doc1');

      expect(flushDocSpy).toHaveBeenCalledWith('doc1');
    });

    it('should sync document without pending changes', async () => {
      mockStore.getPendingChanges.mockResolvedValue([]);
      mockStore.getLastRevs.mockResolvedValue([5, 3]);

      const serverChanges: Change[] = [{ id: 'c2', rev: 6, baseRev: 5, ops: [], createdAt: '2024-01-01T00:00:00.000Z', committedAt: '2024-01-01T00:00:00.000Z' }];

      mockWebSocket.getChangesSince.mockResolvedValue(serverChanges);

      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);

      await sync['syncDoc']('doc1');

      expect(mockWebSocket.getChangesSince).toHaveBeenCalledWith('doc1', 5);
      expect(applySpy).toHaveBeenCalledWith('doc1', serverChanges);
    });

    it('should get full document snapshot if no committed rev', async () => {
      mockStore.getPendingChanges.mockResolvedValue([]);
      mockStore.getLastRevs.mockResolvedValue([0, 0]); // No committed rev

      const snapshot = { state: { content: 'new' }, rev: 1 };
      mockWebSocket.getDoc.mockResolvedValue(snapshot);

      await sync['syncDoc']('doc1');

      expect(mockWebSocket.getDoc).toHaveBeenCalledWith('doc1');
      expect(mockStore.saveDoc).toHaveBeenCalledWith('doc1', snapshot);
    });

    it('should update open document syncing state', async () => {
      const mockDoc = {
        updateSyncing: vi.fn(),
        import: vi.fn(),
      };

      const snapshot = { state: { content: 'new' }, rev: 1 };
      mockWebSocket.getDoc.mockResolvedValue(snapshot);

      mockPatches.getOpenDoc.mockReturnValue(mockDoc);
      mockStore.getPendingChanges.mockResolvedValue([]);
      mockStore.getLastRevs.mockResolvedValue([0, 0]);

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
      mockStore.getPendingChanges.mockResolvedValue([]);
      mockStore.getLastRevs.mockResolvedValue([0, 0]);

      await sync['syncDoc']('doc1');

      expect(mockDoc.import).toHaveBeenCalledWith({ ...snapshot, changes: [] });
    });

    it('should not sync if not connected', async () => {
      sync['updateState']({ connected: false });

      await sync['syncDoc']('doc1');

      expect(mockStore.getPendingChanges).not.toHaveBeenCalled();
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
      mockStore.getPendingChanges.mockResolvedValue([]);

      await sync['flushDoc']('doc1');

      expect(mockWebSocket.commitChanges).not.toHaveBeenCalled();
    });

    it('should flush pending changes in batches', async () => {
      const pendingChanges: Change[] = [
        { id: 'c1', rev: 1, baseRev: 0, ops: [], createdAt: '2024-01-01T00:00:00.000Z', committedAt: '2024-01-01T00:00:00.000Z' },
        { id: 'c2', rev: 2, baseRev: 1, ops: [], createdAt: '2024-01-01T00:00:01.000Z', committedAt: '2024-01-01T00:00:01.000Z' },
      ];

      mockStore.getPendingChanges
        .mockResolvedValueOnce(pendingChanges) // Initial call
        .mockResolvedValueOnce([]); // After flush

      const committed = pendingChanges.map(c => ({ ...c, rev: c.rev + 10 }));
      mockWebSocket.commitChanges.mockResolvedValue(committed);

      const applySpy = vi.spyOn(sync as any, '_applyServerChangesToDoc').mockResolvedValue(undefined);

      await sync['flushDoc']('doc1');

      expect(mockWebSocket.commitChanges).toHaveBeenCalledWith('doc1', pendingChanges);
      expect(applySpy).toHaveBeenCalledWith('doc1', committed, [1, 2]);
    });
  });

  describe('_applyServerChangesToDoc method', () => {
    it('should apply server changes to document', async () => {
      const serverChanges: Change[] = [{ id: 'c1', rev: 6, baseRev: 5, ops: [], createdAt: '2024-01-01T00:00:00.000Z', committedAt: '2024-01-01T00:00:00.000Z' }];

      const currentSnapshot = {
        state: { content: 'current' },
        rev: 5,
        changes: [],
      };

      mockStore.getDoc.mockResolvedValue(currentSnapshot);

      await sync['_applyServerChangesToDoc']('doc1', serverChanges);

      expect(mockStore.saveCommittedChanges).toHaveBeenCalledWith('doc1', serverChanges, undefined);
      expect(mockStore.replacePendingChanges).toHaveBeenCalledWith('doc1', []);
    });

    it('should handle non-existent documents', async () => {
      mockStore.getDoc.mockResolvedValue(null);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await sync['_applyServerChangesToDoc']('doc1', []);

      expect(consoleSpy).toHaveBeenCalledWith('Cannot apply server changes to non-existent doc: doc1');

      consoleSpy.mockRestore();
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
      expect(mockStore.confirmDeleteDoc).toHaveBeenCalledWith('doc1');
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

      const serverChanges: Change[] = [{ id: 'c1', rev: 6, baseRev: 5, ops: [], createdAt: '2024-01-01T00:00:00.000Z', committedAt: '2024-01-01T00:00:00.000Z' }];

      await changesHandler('doc1', serverChanges);

      expect(applySpy).toHaveBeenCalledWith('doc1', serverChanges);
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

      expect(mockStore.getPendingChanges).toHaveBeenCalledWith('doc1');
      expect(mockStore.getPendingChanges).toHaveBeenCalledWith('doc2');
    });
  });
});
