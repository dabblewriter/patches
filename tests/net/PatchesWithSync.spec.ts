import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '../../src/client/InMemoryStore';
import { Patches } from '../../src/client/Patches';
import { PatchesDoc } from '../../src/client/PatchesDoc';
import { PatchesSync } from '../../src/net/PatchesSync';
import { PatchesWebSocket } from '../../src/net/websocket/PatchesWebSocket';
import type { Change } from '../../src/types';

interface MockWebSocket {
  connect: Mock;
  disconnect: Mock;
  subscribe: Mock;
  unsubscribe: Mock;
  getChangesSince: Mock;
  commitChanges: Mock;
  deleteDoc: Mock;
  onStateChange: Mock;
  onChangesCommitted: Mock;
  triggerChangesCommitted: Mock;
}

// Mock the PatchesWebSocket
vi.mock('../../src/net/websocket/PatchesWebSocket', () => {
  const mockWebSocket: MockWebSocket = {
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
    onStateChange: vi.fn().mockImplementation(cb => {
      // Immediately trigger 'connected' state as a string
      cb('connected');
      return () => {};
    }),
    onChangesCommitted: vi.fn().mockImplementation(cb => {
      // Store the callback for later use
      mockWebSocket.triggerChangesCommitted = vi.fn((docId: string, changes: Change[]) => {
        cb({ docId, changes });
      });
      return () => {};
    }),
    triggerChangesCommitted: vi.fn(),
  };
  return {
    PatchesWebSocket: vi.fn().mockImplementation(() => mockWebSocket),
  };
});

vi.mock('../../src/net/websocket/onlineState', () => {
  return {
    onlineState: {
      isOnline: true,
      onOnlineChange: vi.fn().mockImplementation(cb => {
        cb(true);
        return () => {};
      }),
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

    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  afterEach(() => {
    patches.close();
    patchesSync.disconnect();
    vi.clearAllMocks();
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
    expect(doc).toBeInstanceOf(PatchesDoc);

    // Make a change
    doc.change(draft => {
      draft.name = 'Test Document';
    });

    // Wait for changes to be processed
    await new Promise(resolve => setTimeout(resolve, 0));

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
    // Connect and open doc
    await patchesSync.connect();
    const docId = 'test-doc-2';
    await patches.trackDocs([docId]);
    const doc = await patches.openDoc<{ title: string }>(docId);

    // Initialize doc with empty state
    doc.change(draft => {
      draft.title = '';
    });

    // Flush initial state
    await patchesSync.flushDoc(docId);

    // Simulate server sending changes
    const serverChanges = [
      {
        id: 'server-1',
        rev: 2,
        baseRev: 1,
        ops: [{ op: 'replace', path: '/title', value: 'Server Title' }],
        created: Date.now(),
        userId: 'server-user',
      },
    ];

    // Trigger server changes
    mockWebSocketInstance.triggerChangesCommitted(docId, serverChanges);
    await new Promise(resolve => setTimeout(resolve, 10)); // allow async update

    // Wait for changes to be processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify doc was updated
    expect(doc.state).toEqual({ title: 'Server Title' });
    expect(doc.committedRev).toBe(2);
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

    // Wait for changes to be processed
    await new Promise(resolve => setTimeout(resolve, 0));

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

    // Wait for changes to be processed
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(doc.state).toEqual({ count: 1 });

    // Verify pending changes exist
    const initialPending = await store.getPendingChanges(docId);
    expect(initialPending.length).toBe(1);

    // --- Simulate commit failure (e.g., network error during commit) ---
    const commitError = new Error('Network error during commit');
    mockWebSocketInstance.commitChanges.mockRejectedValueOnce(commitError);

    // Try to flush - expect it to handle the error gracefully (not throw)
    await expect(patchesSync.flushDoc(docId)).rejects.toThrow('Network error during commit');

    // Changes should still be pending because commit failed
    const pendingAfterFailedCommit = await store.getPendingChanges(docId);
    expect(pendingAfterFailedCommit.length).toBe(1);
    expect(mockWebSocketInstance.commitChanges).toHaveBeenCalledTimes(1); // Ensure commit was attempted

    // --- Simulate reconnection / network recovery ---
    // Restore the default mock implementation (success)
    mockWebSocketInstance.commitChanges.mockImplementation((_docId: string, changes: Change[]) => {
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
