import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { Patches } from '../../src/client/Patches';
import { signal, type Signal } from '../../src/event-signal';
import { PatchesSync } from '../../src/net/PatchesSync';
import type { ConnectionState } from '../../src/net/protocol/types';
import { PatchesWebSocket } from '../../src/net/websocket/PatchesWebSocket';
import { onlineState } from '../../src/net/websocket/onlineState';
import type { PatchesStore, TrackedDoc } from '../../src/persist/PatchesStore';
import type { Change } from '../../src/types';

// --- Mocks ---
vi.mock('../../src/net/websocket/PatchesWebSocket');
vi.mock('../../src/Patches');
vi.mock('../../src/net/websocket/onlineState', () => ({
  onlineState: {
    isOnline: true,
    onOnlineChange: vi.fn(),
  },
}));
vi.mock('../../src/event-signal', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/event-signal')>();
  // Create mock signals that we can control
  const createMockSignal = () => {
    const listeners = new Set<(data: any) => void>();
    const mockSignal = (listener: (data: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    mockSignal.emit = (data: any) => {
      listeners.forEach(fn => {
        try {
          fn(data);
        } catch (e) {
          console.error('Error in mock signal listener:', e);
        }
      });
    };
    return mockSignal as unknown as Signal<any>;
  };
  return {
    ...actual,
    signal: vi.fn(() => createMockSignal()),
  };
});

describe('PatchesSync', () => {
  let mockWsInstance: Mocked<PatchesWebSocket>;
  let mockStore: Mocked<PatchesStore>;
  let mockPatches: Mocked<Patches>;
  let patchesSync: PatchesSync;
  let wsOnChangesCommittedCallback: (data: { docId: string; changes: Change[] }) => void;
  let wsOnStateChangeCallback: (state: ConnectionState) => void;
  let onlineChangeCallback: (isOnline: boolean) => void;

  // Define a holder for shared spies for PatchesWebSocket methods
  let wsSpies: {
    connect: Mocked<PatchesWebSocket['connect']>;
    disconnect: Mocked<PatchesWebSocket['disconnect']>;
    subscribe: Mocked<PatchesWebSocket['subscribe']>;
    unsubscribe: Mocked<PatchesWebSocket['unsubscribe']>;
    getDoc: Mocked<PatchesWebSocket['getDoc']>;
    getChangesSince: Mocked<PatchesWebSocket['getChangesSince']>;
    commitChanges: Mocked<PatchesWebSocket['commitChanges']>;
    deleteDoc: Mocked<PatchesWebSocket['deleteDoc']>;
    onStateChange: Mocked<PatchesWebSocket['onStateChange']>;
    onChangesCommitted: Mocked<PatchesWebSocket['onChangesCommitted']>;
  };

  const DOC_ID = 'test-doc-1';
  const MOCK_URL = 'ws://localhost:8080';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock store
    mockStore = {
      getDoc: vi.fn().mockResolvedValue({ state: { initial: true }, rev: 0, changes: [] }),
      getPendingChanges: vi.fn().mockResolvedValue([]),
      getLastRevs: vi.fn().mockResolvedValue([0, 0]),
      listDocs: vi.fn().mockResolvedValue([]),
      savePendingChanges: vi.fn().mockResolvedValue(undefined),
      saveCommittedChanges: vi.fn().mockResolvedValue(undefined),
      trackDocs: vi.fn().mockResolvedValue(undefined),
      untrackDocs: vi.fn().mockResolvedValue(undefined),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      confirmDeleteDoc: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      onPendingChanges: signal(),
    } as unknown as Mocked<PatchesStore>;

    // Setup mock signals with spies
    const createSpiedSignal = () => {
      const listeners = new Set<(data: any) => void>();
      const emit = vi.fn((data: any) => {
        listeners.forEach(fn => {
          try {
            fn(data);
          } catch (e) {
            console.error('Error in mock signal listener:', e);
          }
        });
      });
      const signal = (listener: (data: any) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      signal.emit = emit;
      return signal;
    };

    // Setup mock Patches
    mockPatches = {
      onTrackDocs: createSpiedSignal(),
      onUntrackDocs: createSpiedSignal(),
      onDeleteDoc: createSpiedSignal(),
      onError: createSpiedSignal(),
      onServerCommit: createSpiedSignal(),
      store: mockStore,
      trackedDocs: new Set(),
      handleSendFailure: vi.fn(),
      applyServerChanges: vi.fn(),
    } as unknown as Mocked<Patches>;

    // Initialize shared spies for PatchesWebSocket methods
    // For signals, we'll create a structure that satisfies Mocked<Signal<T>>
    // by being a callable function (for subscription) and having mock emit/error/clear methods.
    // This also preserves the wsOnStateChangeCallback/wsOnChangesCommittedCallback pattern for triggering.

    const onStateChangeMock = vi.fn((listener: (state: ConnectionState) => void) => {
      wsOnStateChangeCallback = listener;
      return vi.fn(); // unsubscribe
    });
    (onStateChangeMock as any).emit = vi.fn((state: ConnectionState) => {
      if (wsOnStateChangeCallback) wsOnStateChangeCallback(state);
    });
    (onStateChangeMock as any).error = vi.fn();
    (onStateChangeMock as any).clear = vi.fn();

    const onChangesCommittedMock = vi.fn((listener: (data: { docId: string; changes: Change[] }) => void) => {
      wsOnChangesCommittedCallback = listener;
      return vi.fn(); // unsubscribe
    });
    (onChangesCommittedMock as any).emit = vi.fn((data: { docId: string; changes: Change[] }) => {
      if (wsOnChangesCommittedCallback) wsOnChangesCommittedCallback(data);
    });
    (onChangesCommittedMock as any).error = vi.fn();
    (onChangesCommittedMock as any).clear = vi.fn();

    wsSpies = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      getDoc: vi.fn().mockResolvedValue({ state: { initial: true }, rev: 0, changes: [] }),
      getChangesSince: vi.fn().mockResolvedValue([]),
      commitChanges: vi.fn().mockResolvedValue([]),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      onStateChange: onStateChangeMock as unknown as Mocked<PatchesWebSocket['onStateChange']>,
      onChangesCommitted: onChangesCommittedMock as unknown as Mocked<PatchesWebSocket['onChangesCommitted']>,
    };

    // Setup mock PatchesWebSocket constructor to return the shared spies object
    const MockPatchesWebSocket = vi.mocked(PatchesWebSocket);
    MockPatchesWebSocket.mockImplementation(() => wsSpies as unknown as Mocked<PatchesWebSocket>);

    // mockWsInstance will be the wsSpies object, useful for controlling behavior in other tests
    mockWsInstance = new PatchesWebSocket(MOCK_URL) as Mocked<PatchesWebSocket>;

    // Setup online state mock
    // onlineState.onOnlineChange is already a vi.fn() due to the module mock at the top.
    // We further refine its implementation here to capture the callback.
    vi.mocked(onlineState.onOnlineChange).mockImplementation((callback: any) => {
      onlineChangeCallback = callback;
      return vi.fn(); // Return mock unsubscribe function
    });

    // Create PatchesSync instance. Its constructor will use a PatchesWebSocket
    // instance that is effectively wsSpies, so its onStateChange/onChangesCommitted calls
    // will hit our shared spies.
    patchesSync = new PatchesSync(MOCK_URL, mockPatches);

    // Assign mockWsInstance (which is wsSpies) to patchesSync.ws.
    // This ensures that subsequent interactions with patchesSync.ws in tests
    // use the shared spies, consistent with the constructor's usage.
    (patchesSync as any).ws = mockWsInstance;

    // Initialize state to avoid undefined errors
    (patchesSync as any)._state = { connected: false, online: true, syncing: null };

    // Spy on console methods
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Test Cases ---

  describe('Initialization', () => {
    it('should initialize with the provided store and WebSocket', () => {
      expect(patchesSync['store']).toBe(mockStore);
      expect(patchesSync['ws']).toBeDefined();
      expect(PatchesWebSocket).toHaveBeenCalledWith(MOCK_URL, undefined);
    });

    // This test is failing because the mocks are set up after the constructor runs
    // In a real scenario, these would be called
    it('should register event handlers', () => {
      expect(onlineState.onOnlineChange).toHaveBeenCalled();
      expect(wsSpies.onStateChange).toHaveBeenCalled();
      expect(wsSpies.onChangesCommitted).toHaveBeenCalled();
    });
  });

  describe('Connection Management', () => {
    it('should connect to WebSocket', async () => {
      await patchesSync.connect();
      expect(mockWsInstance.connect).toHaveBeenCalled();
    });

    it('should disconnect from WebSocket', () => {
      patchesSync.disconnect();
      expect(mockWsInstance.disconnect).toHaveBeenCalled();
    });

    it('should update state when connection state changes', () => {
      const stateSpy = vi.spyOn(patchesSync.onStateChange, 'emit');

      // Simulate connection state change
      if (wsOnStateChangeCallback) {
        wsOnStateChangeCallback('connected');
      }

      expect(stateSpy).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
      expect(patchesSync.state.connected).toBe(true);
    });

    it('should update state when online state changes', () => {
      const stateSpy = vi.spyOn(patchesSync.onStateChange, 'emit');

      // Simulate online state change
      if (onlineChangeCallback) {
        onlineChangeCallback(false);
      }

      expect(stateSpy).toHaveBeenCalledWith(expect.objectContaining({ online: false }));
      expect(patchesSync.state.online).toBe(false);
    });

    it('should trigger global sync when connected', async () => {
      // Mock syncAllKnownDocs
      const syncAllSpy = vi.spyOn(patchesSync as any, 'syncAllKnownDocs').mockResolvedValue(undefined);

      // Simulate connection
      if (wsOnStateChangeCallback) {
        wsOnStateChangeCallback('connected');
      }

      expect(syncAllSpy).toHaveBeenCalled();
    });
  });

  describe('Document Tracking', () => {
    it('should track documents in store and subscribe if connected', async () => {
      // Set connected state
      (patchesSync as any)._state.connected = true;

      // Mock the store's trackDocs to resolve immediately
      mockStore.trackDocs.mockImplementation(async () => {
        mockPatches.onTrackDocs.emit([DOC_ID]);
        return Promise.resolve();
      });

      await mockStore.trackDocs([DOC_ID]);

      expect(mockStore.trackDocs).toHaveBeenCalledWith([DOC_ID]);
      expect(mockWsInstance.subscribe).toHaveBeenCalledWith([DOC_ID]);
      expect((patchesSync as any).trackedDocs.has(DOC_ID)).toBe(true);
    });

    it('should untrack documents from store and unsubscribe if connected', async () => {
      // Setup tracked doc
      (patchesSync as any).trackedDocs.add(DOC_ID);
      (patchesSync as any)._state.connected = true;

      // Mock the store's untrackDocs to resolve immediately
      mockStore.untrackDocs.mockImplementation(async () => {
        mockPatches.onUntrackDocs.emit([DOC_ID]);
        return Promise.resolve();
      });

      await mockStore.untrackDocs([DOC_ID]);

      expect(mockWsInstance.unsubscribe).toHaveBeenCalledWith([DOC_ID]);
      expect(mockStore.untrackDocs).toHaveBeenCalledWith([DOC_ID]);
      expect((patchesSync as any).trackedDocs.has(DOC_ID)).toBe(false);
    });
  });

  describe('Syncing Logic', () => {
    beforeEach(() => {
      // Set connected state
      (patchesSync as any)._state.connected = true;
      (patchesSync as any).trackedDocs.add(DOC_ID);
    });

    it('should sync a document with pending changes', async () => {
      const pendingChanges: Change[] = [{ id: 'change-1', ops: [], rev: 1, baseRev: 0, created: Date.now() }];
      mockStore.getPendingChanges.mockResolvedValue(pendingChanges);

      // Mock flushDoc
      const flushSpy = vi.spyOn(patchesSync as any, 'flushDoc').mockResolvedValue(undefined);

      await patchesSync.syncDoc(DOC_ID);

      expect(mockStore.getPendingChanges).toHaveBeenCalledWith(DOC_ID);
      expect(flushSpy).toHaveBeenCalledWith(DOC_ID);
    });

    it('should sync a document without pending changes', async () => {
      mockStore.getPendingChanges.mockResolvedValue([]);
      mockStore.getLastRevs.mockResolvedValue([5, 5]);

      const serverChanges: Change[] = [{ id: 'server-1', ops: [], rev: 6, baseRev: 5, created: Date.now() }];
      mockWsInstance.getChangesSince.mockResolvedValue(serverChanges);

      await patchesSync.syncDoc(DOC_ID);

      expect(mockStore.getPendingChanges).toHaveBeenCalledWith(DOC_ID);
      expect(mockWsInstance.getChangesSince).toHaveBeenCalledWith(DOC_ID, 5);
      expect(mockStore.saveCommittedChanges).toHaveBeenCalledWith(DOC_ID, serverChanges);
    });

    it('should flush pending changes to server', async () => {
      const pendingChanges: Change[] = [{ id: 'change-1', ops: [], rev: 1, baseRev: 0, created: Date.now() }];
      mockStore.getPendingChanges.mockResolvedValue(pendingChanges);

      const committedChanges: Change[] = [{ id: 'server-1', ops: [], rev: 1, baseRev: 0, created: Date.now() }];
      mockWsInstance.commitChanges.mockResolvedValue(committedChanges);

      await patchesSync.flushDoc(DOC_ID);

      expect(mockStore.getPendingChanges).toHaveBeenCalledWith(DOC_ID);
      expect(mockWsInstance.commitChanges).toHaveBeenCalledWith(DOC_ID, pendingChanges);
      expect(mockStore.saveCommittedChanges).toHaveBeenCalledWith(DOC_ID, committedChanges, [1, 1]);
    });

    it('should sync all known docs', async () => {
      const trackedDocs: TrackedDoc[] = [
        { docId: 'doc-1', committedRev: 0 },
        { docId: 'doc-2', committedRev: 0 },
        { docId: 'doc-3', committedRev: 0, deleted: true },
      ];
      mockStore.listDocs.mockResolvedValue(trackedDocs);

      // Mock syncDoc
      const syncDocSpy = vi.spyOn(patchesSync, 'syncDoc').mockResolvedValue(undefined);

      await (patchesSync as any).syncAllKnownDocs();

      expect(mockStore.listDocs).toHaveBeenCalledWith(true);
      expect(mockWsInstance.subscribe).toHaveBeenCalledWith(['doc-1', 'doc-2']);
      expect(syncDocSpy).toHaveBeenCalledTimes(2);
      expect(mockWsInstance.deleteDoc).toHaveBeenCalledWith('doc-3');
    });
  });

  describe('Server Operations', () => {
    it('should handle server commits', async () => {
      const serverChanges: Change[] = [{ id: 'server-1', ops: [], rev: 1, baseRev: 0, created: Date.now() }];

      // Mock the store's saveCommittedChanges to resolve immediately
      mockStore.saveCommittedChanges.mockImplementation(async () => {
        mockPatches.onServerCommit.emit(DOC_ID, serverChanges);
        return Promise.resolve();
      });

      // Simulate server commit
      if (wsOnChangesCommittedCallback) {
        await wsOnChangesCommittedCallback({ docId: DOC_ID, changes: serverChanges });
      }

      expect(mockStore.saveCommittedChanges).toHaveBeenCalledWith(DOC_ID, serverChanges);
      expect(mockPatches.onServerCommit.emit).toHaveBeenCalledWith(DOC_ID, serverChanges);
    });

    it('should delete a document', async () => {
      // Setup tracked doc
      (patchesSync as any).trackedDocs.add(DOC_ID);
      (patchesSync as any)._state.connected = true;

      // Mock the store's deleteDoc to resolve immediately
      mockStore.deleteDoc.mockImplementation(async () => {
        return Promise.resolve();
      });

      // Trigger delete through PatchesSync's handler
      await (patchesSync as any)._handleDocDeleted(DOC_ID);

      expect(mockWsInstance.deleteDoc).toHaveBeenCalledWith(DOC_ID);
      expect(mockStore.confirmDeleteDoc).toHaveBeenCalledWith(DOC_ID);
    });
  });

  describe('Error Handling', () => {
    it('should emit errors when server operations fail', async () => {
      const error = new Error('Server operation failed');
      mockWsInstance.commitChanges.mockRejectedValue(error);

      const errorSpy = vi.spyOn(patchesSync.onError, 'emit');

      // Setup for flush
      (patchesSync as any)._state.connected = true;
      (patchesSync as any).trackedDocs.add(DOC_ID);
      mockStore.getPendingChanges.mockResolvedValue([
        { id: 'change-1', ops: [], rev: 1, baseRev: 0, created: Date.now() },
      ]);

      await expect(patchesSync.flushDoc(DOC_ID)).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(error, { docId: DOC_ID });
    });

    it('should emit errors when store operations fail', async () => {
      const error = new Error('Store operation failed');
      mockStore.saveCommittedChanges.mockRejectedValue(error);

      // Create a new signal instance for testing
      const testSignal = signal<(error: Error, context?: { docId?: string }) => void>();
      const errorSpy = vi.spyOn(testSignal, 'emit');
      (patchesSync as any).onError = testSignal;

      // Simulate server commit
      if (wsOnChangesCommittedCallback) {
        await wsOnChangesCommittedCallback({
          docId: DOC_ID,
          changes: [{ id: 'server-1', ops: [], rev: 1, baseRev: 0, created: Date.now() }],
        });
      }

      // Wait for the promise to reject and error to be emitted
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(errorSpy).toHaveBeenCalledWith(error, { docId: DOC_ID });
    });
  });
});
