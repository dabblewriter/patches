import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '../../src/client/InMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import { PatchesWebSocket } from '../../src/net/websocket/PatchesWebSocket.js';
import type { WebSocketOptions } from '../../src/net/websocket/WebSocketTransport.js';
import type { Change } from '../../src/types.js';

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
vi.mock('../../src/net/websocket/PatchesWebSocket.js', () => {
  const mockWebSocketInstance: any = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    getChangesSince: vi.fn().mockResolvedValue([]),
    commitChanges: vi.fn().mockImplementation((docId: string, changes: Change[]) => Promise.resolve(changes)),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    onStateChange: vi.fn(cb => {
      (mockWebSocketInstance as any)._onStateChangeCb = cb;
      return () => {
        (mockWebSocketInstance as any)._onStateChangeCb = undefined;
      };
    }),
    triggerStateChange: (state: any) => {
      if ((mockWebSocketInstance as any)._onStateChangeCb) {
        (mockWebSocketInstance as any)._onStateChangeCb(state);
      }
    },
    onChangesCommitted: vi.fn(cb => {
      (mockWebSocketInstance as any)._onChangesCommittedCb = cb;
      return () => {
        (mockWebSocketInstance as any)._onChangesCommittedCb = undefined;
      };
    }),
    triggerChangesCommitted: (docId: string, changes: Change[]) => {
      if ((mockWebSocketInstance as any)._onChangesCommittedCb) {
        (mockWebSocketInstance as any)._onChangesCommittedCb(docId, changes);
      }
    },
  };
  return {
    PatchesWebSocket: vi.fn().mockImplementation(() => mockWebSocketInstance),
  };
});

vi.mock('../../src/net/websocket/onlineState.js', () => ({
  onlineState: {
    isOnline: true,
    onOnlineChange: vi.fn(cb => {
      cb(true);
      return () => {};
    }),
  },
}));

describe('Patches with PatchesSync', () => {
  let store: InMemoryStore;
  let patches: Patches;
  let patchesSync: PatchesSync | undefined;
  let mockWebSocketInstance: any;
  const MOCK_URL = 'wss://example.com';
  const wsOptionsForTest: WebSocketOptions | undefined = undefined;

  beforeEach(() => {
    const MockedPatchesWebSocket = vi.mocked(PatchesWebSocket);
    mockWebSocketInstance = new MockedPatchesWebSocket(MOCK_URL, wsOptionsForTest);
    MockedPatchesWebSocket.mockImplementation(() => mockWebSocketInstance);

    store = new InMemoryStore();
    store.confirmDeleteDoc = vi.fn().mockResolvedValue(undefined);
    store.replacePendingChanges = vi.fn().mockResolvedValue(undefined);
    (store as any).savePendingChanges = vi.fn().mockResolvedValue(undefined);

    patches = new Patches({ store });
    patchesSync = new PatchesSync(patches, MOCK_URL, wsOptionsForTest);

    if (mockWebSocketInstance) {
      mockWebSocketInstance.connect = vi.fn().mockResolvedValue(undefined);
      mockWebSocketInstance.commitChanges = vi
        .fn()
        .mockImplementation((docId: string, changes: Change[]) => Promise.resolve(changes));
      mockWebSocketInstance.getChangesSince = vi.fn().mockResolvedValue([]);
      const onStateChangeCbHolder: { cb?: (state: any) => void } = {};
      mockWebSocketInstance.onStateChange = vi.fn(cb => {
        onStateChangeCbHolder.cb = cb;
        return () => {};
      });
      mockWebSocketInstance.triggerStateChange = (state: any) => {
        if (onStateChangeCbHolder.cb) onStateChangeCbHolder.cb(state);
      };

      const onChangesCommittedCbHolder: { cb?: (data: any) => void } = {};
      mockWebSocketInstance.onChangesCommitted = vi.fn(cb => {
        onChangesCommittedCbHolder.cb = cb;
        return () => {};
      });
      mockWebSocketInstance.triggerChangesCommitted = (docId: string, changes: Change[]) => {
        if (onChangesCommittedCbHolder.cb) (onChangesCommittedCbHolder.cb as any)(docId, changes);
      };
    }
  });

  afterEach(() => {
    patches.close();
    if (patchesSync) {
      patchesSync.disconnect();
    }
    vi.restoreAllMocks();
  });

  it('should initialize PatchesSync with a Patches instance', () => {
    expect(patches).toBeInstanceOf(Patches);
    expect(patchesSync).toBeInstanceOf(PatchesSync);
    expect(vi.mocked(PatchesWebSocket)).toHaveBeenCalledTimes(1);
  });

  it('should open and sync a document', async () => {
    await patchesSync!.connect();
    mockWebSocketInstance.triggerStateChange('connected');
    expect(mockWebSocketInstance.connect).toHaveBeenCalled();

    const docId = 'test-doc';
    await patches.trackDocs([docId]);
    const doc = await patches.openDoc<{ name: string }>(docId);
    doc.change(draft => {
      draft.name = 'Test Document';
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const storedChanges = await store.getPendingChanges(docId);
    expect(storedChanges.length).toBe(1);

    await (patchesSync! as any).flushDoc(docId);
    expect(mockWebSocketInstance.commitChanges).toHaveBeenCalled();
    const pendingAfterSync = await store.getPendingChanges(docId);
    expect(pendingAfterSync.length).toBe(0);
  });

  it('should properly propagate server changes to client documents', async () => {
    await patchesSync!.connect();
    mockWebSocketInstance.triggerStateChange('connected');
    const docId = 'test-doc-2';
    await patches.trackDocs([docId]);
    const doc = await patches.openDoc<{ title: string }>(docId);
    doc.change(draft => {
      draft.title = '';
    });
    await (patchesSync! as any).flushDoc(docId);

    const serverChanges: Change[] = [
      {
        id: 'server-1',
        rev: 2,
        baseRev: 1,
        ops: [{ op: 'replace', path: '/title', value: 'Server Title' }],
        created: Date.now(),
      },
    ];

    mockWebSocketInstance.triggerChangesCommitted(docId, serverChanges);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(doc.state).toEqual({ title: 'Server Title' });
    expect(doc.committedRev).toBe(2);
  });

  it('should work with multiple documents', async () => {
    await patchesSync!.connect();
    mockWebSocketInstance.triggerStateChange('connected');

    const docIds = ['doc-1', 'doc-2', 'doc-3'];
    await patches.trackDocs(docIds);
    const docs = await Promise.all(docIds.map(id => patches.openDoc<{ value: number }>(id)));
    docs.forEach((doc, i) => {
      doc.change(draft => {
        draft.value = i + 1;
      });
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.all(docIds.map(id => (patchesSync! as any).flushDoc(id)));
    expect(mockWebSocketInstance.commitChanges).toHaveBeenCalledTimes(3);
  });

  it('should handle commit failure and retry upon reconnection/flush', async () => {
    await patchesSync!.connect();
    mockWebSocketInstance.triggerStateChange('connected');

    const docId = 'offline-doc';
    await patches.trackDocs([docId]);
    const doc = await patches.openDoc<{ count: number }>(docId);
    doc.change(draft => {
      draft.count = 1;
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const commitError = new Error('Network error during commit');
    mockWebSocketInstance.commitChanges.mockRejectedValueOnce(commitError);

    await expect((patchesSync! as any).flushDoc(docId)).rejects.toThrow(commitError);
    expect(mockWebSocketInstance.commitChanges).toHaveBeenCalledTimes(1);

    mockWebSocketInstance.commitChanges.mockImplementation((_docId: string, changesToCommit: Change[]) => {
      return Promise.resolve(changesToCommit);
    });

    await (patchesSync! as any).flushDoc(docId);
    expect(mockWebSocketInstance.commitChanges).toHaveBeenCalledTimes(2);
    const pendingAfterSuccessfulCommit = await store.getPendingChanges(docId);
    expect(pendingAfterSuccessfulCommit.length).toBe(0);
  });
});
