import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { PatchDoc } from '../../src/client/PatchDoc';
import { signal, type Signal } from '../../src/event-signal';
import { PatchesRealtime } from '../../src/net/PatchesRealtime'; // Import options type
import type { ConnectionState } from '../../src/net/protocol/types';
import { PatchesWebSocket } from '../../src/net/websocket/PatchesWebSocket';
import type { Change, PatchSnapshot } from '../../src/types';

// Define a type for the document state used in tests
interface TestDocState {
  count?: number;
  initial?: boolean;
  resynced?: boolean;
}

// Define the expected payload type for the onError signal
type OnErrorPayload = {
  type: 'sendFailed' | 'applyFailed' | 'syncError' | 'connectionError';
  docId?: string;
  error: Error;
  recoveryAttempted?: boolean;
  recoveryError?: Error;
};

// --- Mocks ---
vi.mock('../../src/net/websocket/PatchesWebSocket');
vi.mock('../../src/client/PatchDoc'); // Keep the module mock
vi.mock('../../src/event-signal', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/event-signal')>();
  // Keep the mock factory for signals used *inside* PatchDoc mock
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
    mockSignal.clear = () => listeners.clear();
    return mockSignal as unknown as Signal<any>;
  };
  return {
    ...actual,
    signal: vi.fn(createMockSignal), // Default mock uses the factory
  };
});

describe('PatchesRealtime Error Handling', () => {
  let mockWsInstance: Mocked<PatchesWebSocket>;
  // mockDocInstance will be created *inside* tests or beforeEach where needed, using the factory
  let mockDocInstanceFactory: () => Mocked<PatchDoc<any>>;
  let patchesRealtime: PatchesRealtime;
  // Declare specific types for the signals we will spy on - Use Signal<any> here
  let mockOnErrorSignalInstance: Signal<any>;
  let mockOnStateChangeSignalInstance: Signal<any>;
  let wsOnChangesCommittedCallback: (data: { docId: string; changes: Change[] }) => void;
  let wsOnStateChangeCallback: (state: ConnectionState) => void;
  // docOnChangeCallback is now captured inside the factory per instance

  const DOC_ID = 'test-doc-1';
  const MOCK_URL = 'ws://localhost:8080';

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mocks for PatchesWebSocket
    const MockPatchesWebSocket = vi.mocked(PatchesWebSocket);
    MockPatchesWebSocket.mockImplementation(() => {
      const mockWsOnChangesCommitted = vi.fn((callback: any) => {
        wsOnChangesCommittedCallback = callback;
        return vi.fn();
      });
      const mockWsOnStateChange = vi.fn((callback: any) => {
        wsOnStateChangeCallback = callback;
        return vi.fn();
      });
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        getDoc: vi.fn().mockResolvedValue({ state: { initial: true }, rev: 0, changes: [] }),
        commitChanges: vi.fn().mockResolvedValue([]),
        disconnect: vi.fn(),
        onChangesCommitted: mockWsOnChangesCommitted,
        onStateChange: mockWsOnStateChange,
      } as unknown as Mocked<PatchesWebSocket>;
    });
    mockWsInstance = new MockPatchesWebSocket(MOCK_URL) as Mocked<PatchesWebSocket>;

    // --- Create a FACTORY for the enhanced PatchDoc mock ---
    const MockPatchDoc = vi.mocked(PatchDoc);
    mockDocInstanceFactory = () => {
      let _mockPendingChanges: Change[] = [];
      let _mockSendingChanges: Change[] = [];
      let _onChangeCallback: (() => void) | null = null;

      const instance = {
        state: { initial: true },
        committedRev: 0,
        get isSending() {
          return _mockSendingChanges.length > 0;
        },
        get hasPending() {
          return _mockPendingChanges.length > 0;
        },
        import: vi.fn(),
        change: vi.fn((mutator: (draft: any) => void) => {
          const newChange: Change = { id: `mock-${Math.random()}`, ops: [], rev: 0, baseRev: 0, created: Date.now() };
          _mockPendingChanges.push(newChange);
          if (_onChangeCallback) {
            setImmediate(_onChangeCallback);
          }
          return newChange;
        }),
        getUpdatesForServer: vi.fn(() => {
          if (_mockPendingChanges.length > 0) {
            _mockSendingChanges = _mockPendingChanges;
            _mockPendingChanges = [];
            return _mockSendingChanges;
          }
          return [];
        }),
        applyServerConfirmation: vi.fn((serverCommit: Change[]) => {
          if (serverCommit.length === 0) {
            _mockSendingChanges = [];
          } else {
            _mockSendingChanges = [];
          }
        }),
        applyExternalServerUpdate: vi.fn(),
        handleSendFailure: vi.fn(() => {
          _mockPendingChanges.unshift(..._mockSendingChanges);
          _mockSendingChanges = [];
        }),
        onChange: vi.fn((callback: any) => {
          _onChangeCallback = callback;
          return vi.fn(() => {
            _onChangeCallback = null;
          });
        }),
        onBeforeChange: signal(),
        onUpdate: signal(),
      } as unknown as Mocked<PatchDoc<any>>;

      vi.spyOn(instance, 'getUpdatesForServer');
      vi.spyOn(instance, 'handleSendFailure');
      vi.spyOn(instance, 'import');
      vi.spyOn(instance, 'applyServerConfirmation');
      vi.spyOn(instance, 'applyExternalServerUpdate');
      return instance;
    };
    MockPatchDoc.mockImplementation(mockDocInstanceFactory);
    // --- End of PatchDoc Mock Factory ---

    // Mock the signal factory *before* creating PatchesRealtime
    const mockSignalFactory = vi.mocked(signal);
    // Create the specific signal instances that PatchesRealtime will receive
    // Use the actual signal implementation for the instances we spy on
    mockOnErrorSignalInstance = signal<any>(); // Use Signal<any>
    mockOnStateChangeSignalInstance = signal<any>(); // Use Signal<any>
    // Set up the factory to return these specific instances in order
    mockSignalFactory
      .mockReturnValueOnce(mockOnErrorSignalInstance) // First call in constructor is for onError
      .mockReturnValueOnce(mockOnStateChangeSignalInstance); // Second call is for onStateChange

    // Instantiate PatchesRealtime - it will get the instances above
    patchesRealtime = new PatchesRealtime(MOCK_URL);
    (patchesRealtime as any).ws = mockWsInstance;

    // Now spy on the *emit* methods of the specific instances
    vi.spyOn(mockOnErrorSignalInstance, 'emit');
    vi.spyOn(mockOnStateChangeSignalInstance, 'emit');

    // Simulate initial connection state emission from WS
    if (wsOnStateChangeCallback) {
      wsOnStateChangeCallback('connected');
    }

    // Spy on console methods
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Test Cases ---

  it('should emit onError and attempt resync when applyExternalServerUpdate fails', async () => {
    const applyError = new Error('Failed to apply external update');
    const externalChanges: Change[] = [{ id: 'ext1', ops: [], rev: 1, baseRev: 0, created: Date.now() }];
    const resyncSnapshot: PatchSnapshot<any> = { state: { resynced: true }, rev: 1, changes: [] };

    const openedDoc = await patchesRealtime.openDoc<TestDocState>(DOC_ID);
    const mockDocInstance = vi.mocked(openedDoc);

    let resyncImportResolver: (value?: unknown) => void;
    const resyncImportPromise = new Promise(resolve => {
      resyncImportResolver = resolve;
    });
    mockDocInstance.import.mockImplementation(() => {
      resyncImportResolver();
    });

    mockDocInstance.applyExternalServerUpdate.mockImplementation(() => {
      throw applyError;
    });
    mockWsInstance.getDoc.mockResolvedValue(resyncSnapshot);

    wsOnChangesCommittedCallback({ docId: DOC_ID, changes: externalChanges });
    await resyncImportPromise;

    expect(mockOnErrorSignalInstance.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'applyFailed',
        docId: DOC_ID,
        error: applyError,
        recoveryAttempted: true,
      })
    );
    expect(console.error).toHaveBeenCalledWith(`Error applying external server update for doc ${DOC_ID}:`, applyError);
    expect(mockWsInstance.getDoc).toHaveBeenCalledWith(DOC_ID);
    expect(mockDocInstance.import).toHaveBeenCalledWith(resyncSnapshot);
  });

  it('should emit onError, call handleSendFailure, and attempt resync when commitChanges fails (online)', async () => {
    const commitError = new Error('Failed to commit changes');
    const resyncSnapshot: PatchSnapshot<any> = { state: { resynced: true }, rev: 0, changes: [] };

    const openedDoc = await patchesRealtime.openDoc<TestDocState>(DOC_ID);
    const mockDocInstance = vi.mocked(openedDoc);

    let onErrorResolver: (value?: unknown) => void;
    const onErrorPromise = new Promise(resolve => {
      onErrorResolver = resolve;
    });

    // ***** Attach listener BEFORE triggering action *****
    const emitSpy = vi.spyOn(mockOnErrorSignalInstance, 'emit');
    emitSpy.mockImplementation(async (payload: any) => {
      if (payload && payload.type === 'sendFailed') {
        onErrorResolver(); // Resolve the promise when the correct error is emitted
      }
    });

    // Setup mocks for the failure and recovery path
    mockWsInstance.commitChanges.mockRejectedValue(commitError);
    mockWsInstance.getDoc.mockResolvedValue(resyncSnapshot);

    // Trigger the action that leads to the error
    const changeMade = mockDocInstance.change(d => {
      d.count = 1;
    });
    expect(changeMade).toBeDefined();

    // Wait for the 'sendFailed' error emission promise to resolve
    await onErrorPromise;

    // Assertions about the immediate error handling
    expect(mockWsInstance.commitChanges).toHaveBeenCalledWith(DOC_ID, expect.any(Array));
    const sentChanges = mockWsInstance.commitChanges.mock.calls[0][1];
    expect(sentChanges).toHaveLength(1);
    expect(sentChanges[0].id).toEqual(changeMade!.id);

    expect(mockDocInstance.getUpdatesForServer).toHaveBeenCalled();
    expect(mockDocInstance.handleSendFailure).toHaveBeenCalled(); // Verify this was called
    expect(mockOnErrorSignalInstance.emit).toHaveBeenCalledWith(
      // Verify the specific emission
      expect.objectContaining({
        type: 'sendFailed',
        docId: DOC_ID,
        error: commitError,
        recoveryAttempted: true,
      })
    );
    expect(console.error).toHaveBeenCalledWith(`Error sending changes to server for doc ${DOC_ID}:`, commitError);

    // Allow microtasks/event loop turn for the async _resyncDoc call to proceed
    await new Promise(setImmediate);

    // Assertions about the recovery attempt
    expect(mockWsInstance.getDoc).toHaveBeenCalledWith(DOC_ID); // Resync attempted
    expect(mockDocInstance.import).toHaveBeenCalledWith(resyncSnapshot); // Resync succeeded
  });

  it('should emit onError, call handleSendFailure, but NOT resync when commitChanges fails (offline)', async () => {
    const commitError = new Error('Failed to commit changes - offline');

    const openedDoc = await patchesRealtime.openDoc<TestDocState>(DOC_ID);
    const mockDocInstance = vi.mocked(openedDoc);

    let handleFailureResolver: (value?: unknown) => void;
    const handleFailurePromise = new Promise(resolve => {
      handleFailureResolver = resolve;
    });
    mockDocInstance.handleSendFailure.mockImplementation(() => {
      handleFailureResolver();
    });

    // Setup mocks and state
    wsOnStateChangeCallback('disconnected');
    mockWsInstance.commitChanges.mockRejectedValue(commitError);

    // Trigger action
    const changeMade = mockDocInstance.change(d => {
      d.count = 1;
    });
    expect(changeMade).toBeDefined();

    // Wait for handleSendFailure promise
    await handleFailurePromise;

    // Assertions
    expect(mockWsInstance.commitChanges).toHaveBeenCalledWith(DOC_ID, expect.any(Array));
    const sentChanges = mockWsInstance.commitChanges.mock.calls[0][1];
    expect(sentChanges).toHaveLength(1);
    expect(sentChanges[0].id).toEqual(changeMade!.id);

    expect(mockDocInstance.getUpdatesForServer).toHaveBeenCalled();
    expect(mockDocInstance.handleSendFailure).toHaveBeenCalled();
    expect(mockOnErrorSignalInstance.emit).toHaveBeenCalledWith({
      type: 'sendFailed',
      docId: DOC_ID,
      error: commitError,
      recoveryAttempted: true,
    });
    expect(console.error).toHaveBeenCalledWith(`Error sending changes to server for doc ${DOC_ID}:`, commitError);
    expect(console.warn).toHaveBeenCalledWith(
      `Send failure for doc ${DOC_ID} while offline. Recovery deferred until reconnection.`
    );
  });

  it('should emit syncError when resync fails after applyExternalServerUpdate failure', async () => {
    const applyError = new Error('Failed to apply external update');
    const resyncError = new Error('Failed to get doc during resync');
    const externalChanges: Change[] = [{ id: 'ext1', ops: [], rev: 1, baseRev: 0, created: Date.now() }];

    const openedDoc = await patchesRealtime.openDoc<TestDocState>(DOC_ID);
    const mockDocInstance = vi.mocked(openedDoc);

    // Clear mock calls after initial setup
    mockDocInstance.import.mockClear();

    let onErrorResolver: (value?: unknown) => void;
    const onErrorPromise = new Promise(resolve => {
      onErrorResolver = resolve;
    });
    let onErrorCallCount = 0;
    const emitSpy = vi.spyOn(mockOnErrorSignalInstance, 'emit');
    emitSpy.mockImplementation(async (payload: any) => {
      onErrorCallCount++;
      if (onErrorCallCount === 2 && payload && payload.type === 'syncError') {
        onErrorResolver();
      }
    });

    // Setup mocks
    mockDocInstance.applyExternalServerUpdate.mockImplementation(() => {
      throw applyError;
    });
    mockWsInstance.getDoc.mockRejectedValue(resyncError);

    // Trigger action
    wsOnChangesCommittedCallback({ docId: DOC_ID, changes: externalChanges });

    // Wait for the second error emission
    await onErrorPromise;

    // Assertions
    expect(mockOnErrorSignalInstance.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'applyFailed',
        docId: DOC_ID,
        error: applyError,
        recoveryAttempted: true,
      })
    );
    expect(mockOnErrorSignalInstance.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'syncError',
        docId: DOC_ID,
        error: resyncError,
        recoveryAttempted: true,
        recoveryError: resyncError,
      })
    );
    expect(console.error).toHaveBeenCalledWith(`Error applying external server update for doc ${DOC_ID}:`, applyError);
    expect(console.error).toHaveBeenCalledWith(`Failed to resync doc ${DOC_ID}:`, resyncError);
    expect(mockDocInstance.import).not.toHaveBeenCalled();
  });

  it('should emit syncError when resync fails after commitChanges failure', async () => {
    const commitError = new Error('Failed to commit changes');
    const resyncError = new Error('Failed to get doc during resync');

    const openedDoc = await patchesRealtime.openDoc<TestDocState>(DOC_ID);
    const mockDocInstance = vi.mocked(openedDoc);

    // Clear mock calls after initial setup
    mockDocInstance.import.mockClear();

    let onErrorResolver: (value?: unknown) => void;
    const onErrorPromise = new Promise(resolve => {
      onErrorResolver = resolve;
    });
    let onErrorCallCount = 0;
    const emitSpy = vi.spyOn(mockOnErrorSignalInstance, 'emit');
    emitSpy.mockImplementation(async (payload: any) => {
      onErrorCallCount++;
      if (onErrorCallCount === 2 && payload && payload.type === 'syncError') {
        onErrorResolver();
      }
    });

    // Setup mocks
    mockWsInstance.commitChanges.mockRejectedValue(commitError);
    mockWsInstance.getDoc.mockRejectedValue(resyncError);

    // Trigger action
    const changeMade = mockDocInstance.change(d => {
      d.count = 1;
    });
    expect(changeMade).toBeDefined();

    // Wait for the second error emission
    await onErrorPromise;

    // Assertions
    expect(mockWsInstance.commitChanges).toHaveBeenCalledWith(DOC_ID, expect.any(Array));
    const sentChanges = mockWsInstance.commitChanges.mock.calls[0][1];
    expect(sentChanges).toHaveLength(1);
    expect(sentChanges[0].id).toEqual(changeMade!.id);

    expect(mockOnErrorSignalInstance.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sendFailed',
        docId: DOC_ID,
        error: commitError,
        recoveryAttempted: true,
      })
    );
    expect(mockOnErrorSignalInstance.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'syncError',
        docId: DOC_ID,
        error: resyncError,
        recoveryAttempted: true,
        recoveryError: resyncError,
      })
    );
    expect(console.error).toHaveBeenCalledWith(`Error sending changes to server for doc ${DOC_ID}:`, commitError);
    expect(console.error).toHaveBeenCalledWith(`Failed to resync doc ${DOC_ID}:`, resyncError);
    expect(mockDocInstance.import).not.toHaveBeenCalled();
  });
});
