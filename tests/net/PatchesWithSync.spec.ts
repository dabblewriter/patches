import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchDoc } from '../../src/client/PatchDoc';
import { Patches } from '../../src/net/Patches';
import { PatchesSync } from '../../src/net/PatchesSync';
import { PatchesWebSocket } from '../../src/net/websocket/PatchesWebSocket';
import { InMemoryStore } from '../../src/persist/InMemoryStore';
import { Change } from '../../src/types';

// Mock the PatchesWebSocket
vi.mock('../../src/net/websocket/PatchesWebSocket', () => {
  const mockWebSocket = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    getChangesSince: vi.fn().mockResolvedValue([]),
    commitChanges: vi.fn().mockImplementation((docId: string, changes: Change[]) => {
      // Default: Echo back the changes as committed
      return Promise.resolve(changes);
    }),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    onStateChange: vi.fn().mockReturnValue(() => {}),
    onChangesCommitted: vi.fn().mockReturnValue(() => {}),
  };
  return {
    PatchesWebSocket: vi.fn().mockImplementation(() => mockWebSocket),
  };
});

vi.mock('../../src/net/websocket/onlineState', () => {
  return {
    onlineState: {
      isOnline: true,
      onOnlineChange: vi.fn().mockReturnValue(() => {}),
    },
  };
});

describe('Patches with PatchesSync', () => {
  let store: InMemoryStore;
  let patches: Patches;
  let patchesSync: PatchesSync;
  let mockWebSocketInstance: ReturnType<typeof vi.mocked<any>>;

  beforeEach(() => {
    store = new InMemoryStore();
    // Add missing confirmDeleteDoc method to InMemoryStore
    store.confirmDeleteDoc = vi.fn().mockResolvedValue(undefined);
    patches = new Patches({ store });
    patchesSync = new PatchesSync('wss://example.com', patches);
    // Get the instance created by PatchesSync constructor
    mockWebSocketInstance = vi.mocked(PatchesWebSocket).mock.results[0]?.value;
  });

  afterEach(() => {
    patches.close();
    patchesSync.disconnect();
    vi.clearAllMocks();
    // Reset mocks specifically added in tests
    if (mockWebSocketInstance) {
      vi.mocked(mockWebSocketInstance.commitChanges).mockRestore();
      vi.mocked(mockWebSocketInstance.onChangesCommitted).mockRestore();
    }
  });

  it('should initialize PatchesSync with a Patches instance', () => {
    expect(patches).toBeDefined();
    expect(patchesSync).toBeDefined();
  });

  it('should open and sync a document', async () => {
    // Connect to sync
    await patchesSync.connect();
    expect(mockWebSocketInstance.connect).toHaveBeenCalled();

    // Open doc and make a change
    const docId = 'test-doc';
    await patches.trackDocs([docId]);
    const doc = await patches.openDoc<{ name: string }>(docId);
    expect(doc).toBeInstanceOf(PatchDoc);

    // Make a change
    doc.change(draft => {
      draft.name = 'Test Document';
    });

    // Verify change was stored
    const storedChanges = await store.getPendingChanges(docId);
    expect(storedChanges.length).toBe(1);
    expect(storedChanges[0].ops).toEqual(
      expect.arrayContaining([expect.objectContaining({ op: 'replace', path: '/name', value: 'Test Document' })])
    );

    // Flush to server
    await patchesSync.flushDoc(docId);
    expect(mockWebSocketInstance.commitChanges).toHaveBeenCalled();

    // After flush, pending changes should be gone
    const pendingAfterSync = await store.getPendingChanges(docId);
    expect(pendingAfterSync.length).toBe(0);
  });

  it('should properly propagate server changes to client documents', async () => {
    // Mock server sending changes
    const mockCommittedSignal = vi.fn();
    const docId = 'test-doc-2';

    // Set up the mock for onChangesCommitted on the specific instance
    vi.mocked(mockWebSocketInstance.onChangesCommitted).mockImplementation(
      (cb: (data: { docId: string; changes: Change[] }) => void) => {
        mockCommittedSignal.mockImplementation(changes => {
          cb({ docId, changes });
        });
        return () => {}; // Return a cleanup function
      }
    );

    // Connect and open doc
    await patchesSync.connect();
    await patches.trackDocs([docId]);
    const doc = await patches.openDoc<{ title: string }>(docId);

    // Initialize doc with empty state
    doc.change(draft => {
      draft.title = '';
    });

    // Simulate server sending changes
    const serverChanges = [
      {
        id: 'server-1',
        rev: 1,
        baseRev: 0,
        ops: [{ op: 'replace', path: '/title', value: 'Server Title' }],
        created: Date.now(),
        userId: 'server-user',
      },
    ];

    mockCommittedSignal(serverChanges);

    // Verify doc was updated
    expect(doc.state).toEqual({ title: 'Server Title' });
    expect(doc.committedRev).toBe(1);
  });

  it('should work with multiple documents', async () => {
    await patchesSync.connect();

    // Track and open multiple docs
    const docIds = ['doc-1', 'doc-2', 'doc-3'];
    await patches.trackDocs(docIds);

    const docs = await Promise.all(docIds.map(id => patches.openDoc<{ value: number }>(id)));

    // Make changes to each doc
    docs.forEach((doc, i) => {
      doc.change(draft => {
        draft.value = i + 1;
      });
    });

    // Flush all
    await Promise.all(docIds.map(id => patchesSync.flushDoc(id)));

    // Verify all were committed
    expect(mockWebSocketInstance.commitChanges).toHaveBeenCalledTimes(3);

    // All should have no pending changes
    const allPending = await Promise.all(docIds.map(id => store.getPendingChanges(id)));
    allPending.forEach(changes => {
      expect(changes.length).toBe(0);
    });
  });

  it('should handle commit failure and retry upon reconnection/flush', async () => {
    // Start connected
    await patchesSync.connect();
    expect(mockWebSocketInstance.connect).toHaveBeenCalledTimes(1);

    // Open a doc and make changes
    const docId = 'offline-doc';
    await patches.trackDocs([docId]);
    const doc = await patches.openDoc<{ count: number }>(docId);
    doc.change(draft => {
      draft.count = 1;
    });
    expect(doc.state).toEqual({ count: 1 });

    // Verify pending changes exist
    const initialPending = await store.getPendingChanges(docId);
    expect(initialPending.length).toBe(1);

    // --- Simulate commit failure (e.g., network error during commit) ---
    const commitError = new Error('Network error during commit');
    vi.mocked(mockWebSocketInstance.commitChanges).mockRejectedValueOnce(commitError);

    // Try to flush - expect it to handle the error gracefully (not throw)
    await expect(patchesSync.flushDoc(docId)).rejects.toThrow('Network error during commit');

    // Changes should still be pending because commit failed
    const pendingAfterFailedCommit = await store.getPendingChanges(docId);
    expect(pendingAfterFailedCommit.length).toBe(1);
    expect(mockWebSocketInstance.commitChanges).toHaveBeenCalledTimes(1); // Ensure commit was attempted

    // --- Simulate reconnection / network recovery ---
    // Restore the default mock implementation (success)
    vi.mocked(mockWebSocketInstance.commitChanges).mockImplementation((_docId: string, changes: Change[]) => {
      return Promise.resolve(changes); // Simulate successful commit
    });

    // Try flushing again, now expecting success
    await patchesSync.flushDoc(docId);

    // Commit should have been called again
    expect(mockWebSocketInstance.commitChanges).toHaveBeenCalledTimes(2);

    // No more pending changes after successful sync
    const pendingAfterSuccessfulCommit = await store.getPendingChanges(docId);
    expect(pendingAfterSuccessfulCommit.length).toBe(0);

    // Verify document state remains correct
    expect(doc.state).toEqual({ count: 1 });
    expect(doc.committedRev).toBeGreaterThan(0); // Should have a committed rev now
  });
});
