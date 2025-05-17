import { beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { signal, type Signal } from '../../../src/event-signal.js';
import { JSONRPCClient } from '../../../src/net/protocol/JSONRPCClient.js';
import type { ConnectionState } from '../../../src/net/protocol/types.js';
import { PatchesWebSocket } from '../../../src/net/websocket/PatchesWebSocket.js';
import { WebSocketTransport } from '../../../src/net/websocket/WebSocketTransport.js';
import {
  type Change,
  type ListVersionsOptions,
  type PatchesSnapshot,
  type VersionMetadata,
} from '../../../src/types.js';

// Mock dependencies
vi.mock('../../../src/net/websocket/WebSocketTransport.js');
vi.mock('../../../src/net/protocol/JSONRPCClient.js');

describe('PatchesWebSocket', () => {
  const MOCK_URL = 'ws://localhost:8080';
  let patchesWs: PatchesWebSocket;

  // Remove explicit type definitions for mock implementation objects
  let mockTransportImplementation: any; // Use 'any' or let TS infer
  let mockRpcImplementation: any; // Use 'any' or let TS infer

  let mockStateChangeSignal: Mocked<Signal<(state: ConnectionState) => void>>;

  // Helper to capture RPC notification handlers
  let rpcNotificationHandlers: Record<string, (params: any) => void> = {};

  beforeEach(() => {
    // Reset mocks and captured handlers for each test
    vi.clearAllMocks();
    rpcNotificationHandlers = {};

    // Create the signal instance first
    mockStateChangeSignal = signal<(state: ConnectionState) => void>() as Mocked<
      Signal<(state: ConnectionState) => void>
    >;
    vi.spyOn(mockStateChangeSignal, 'emit');

    // Define the object that WebSocketTransport mock will return
    mockTransportImplementation = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      send: vi.fn(),
      onStateChange: mockStateChangeSignal,
      url: MOCK_URL,
      state: 'disconnected' as ConnectionState,
      onMessage: signal<(message: string) => void>(),
      onError: signal<(error: Event) => void>(),
      getUnderlyingSocket: vi.fn().mockReturnValue(null),
    };
    vi.mocked(WebSocketTransport).mockImplementation(
      () => mockTransportImplementation as unknown as WebSocketTransport
    );

    // Define the object that JSONRPCClient mock will return
    mockRpcImplementation = {
      request: vi.fn(), // Let TS infer spy type
      on: vi.fn((event: string, handler: (params: any) => void) => {
        rpcNotificationHandlers[event] = handler;
      }), // Let TS infer spy type
    };
    vi.mocked(JSONRPCClient).mockImplementation(() => mockRpcImplementation as unknown as JSONRPCClient);

    // Instantiate the class under test AFTER mocks are configured
    patchesWs = new PatchesWebSocket(MOCK_URL);
  });

  it('should instantiate WebSocketTransport and JSONRPCClient with the correct URL and transport', () => {
    expect(WebSocketTransport).toHaveBeenCalledTimes(1);
    expect(WebSocketTransport).toHaveBeenCalledWith(MOCK_URL, undefined);
    expect(JSONRPCClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(JSONRPCClient).mock.calls[0][0]).toBe(mockTransportImplementation);
  });

  it("should expose the transport's onStateChange signal", () => {
    expect(patchesWs.onStateChange).toBe(mockStateChangeSignal);
  });

  it('should register notification handlers with the RPC client', () => {
    expect(mockRpcImplementation.on).toHaveBeenCalledWith('changesCommitted', expect.any(Function));
  });

  describe('Connection Management', () => {
    it('connect() should call transport.connect()', async () => {
      await patchesWs.connect();
      expect(mockTransportImplementation.connect).toHaveBeenCalledTimes(1);
    });

    it('disconnect() should call transport.disconnect()', () => {
      patchesWs.disconnect();
      expect(mockTransportImplementation.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('Patches API Methods', () => {
    const DOC_ID = 'doc1';
    const DOC_IDS = ['doc1', 'doc2'];
    const REV = 10;
    const CHANGES: Change[] = [{ id: 'change-1', ops: [], baseRev: 10, rev: 11, created: Date.now() }];
    const VERSION_NAME = 'v1.0';
    const VERSION_ID = 'version-abc';
    const LIST_OPTIONS: ListVersionsOptions = { limit: 10 };

    it('subscribe(id) should call rpc.request with correct params', async () => {
      const expectedResult = [DOC_ID];
      mockRpcImplementation.request.mockResolvedValue(expectedResult);
      const result = await patchesWs.subscribe(DOC_ID);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('subscribe', {
        ids: DOC_ID,
      });
      expect(result).toBe(expectedResult);
    });

    it('subscribe(ids) should call rpc.request with correct params', async () => {
      const expectedResult = DOC_IDS;
      mockRpcImplementation.request.mockResolvedValue(expectedResult);
      const result = await patchesWs.subscribe(DOC_IDS);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('subscribe', {
        ids: DOC_IDS,
      });
      expect(result).toBe(expectedResult);
    });

    it('unsubscribe(id) should call rpc.request with correct params', async () => {
      mockRpcImplementation.request.mockResolvedValue(undefined);
      await patchesWs.unsubscribe(DOC_ID);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('unsubscribe', {
        ids: DOC_ID,
      });
    });

    it('unsubscribe(ids) should call rpc.request with correct params', async () => {
      mockRpcImplementation.request.mockResolvedValue(undefined);
      await patchesWs.unsubscribe(DOC_IDS);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('unsubscribe', {
        ids: DOC_IDS,
      });
    });

    it('getDoc should call rpc.request with correct params', async () => {
      const expectedSnapshot: PatchesSnapshot = { rev: REV, state: 'content', changes: [] };
      mockRpcImplementation.request.mockResolvedValue(expectedSnapshot);
      const result = await patchesWs.getDoc(DOC_ID);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('getDoc', {
        docId: DOC_ID,
      });
      expect(result).toBe(expectedSnapshot);
    });

    it('getChangesSince should call rpc.request with correct params', async () => {
      const expectedChanges: Change[] = CHANGES;
      mockRpcImplementation.request.mockResolvedValue(expectedChanges);
      const result = await patchesWs.getChangesSince(DOC_ID, REV);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('getChangesSince', { docId: DOC_ID, rev: REV });
      expect(result).toBe(expectedChanges);
    });

    it('patchesDoc should call rpc.request with correct params', async () => {
      const committedChanges = [...CHANGES];
      mockRpcImplementation.request.mockResolvedValue(committedChanges);
      const result = await patchesWs.commitChanges(DOC_ID, CHANGES);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('commitChanges', {
        docId: DOC_ID,
        changes: CHANGES,
      });
      expect(result).toBe(committedChanges);
    });

    it('deleteDoc should call rpc.request with correct params', async () => {
      mockRpcImplementation.request.mockResolvedValue(undefined);
      await patchesWs.deleteDoc(DOC_ID);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('deleteDoc', {
        docId: DOC_ID,
      });
    });

    it('createVersion should call rpc.request with correct params', async () => {
      const expectedVersionId = VERSION_ID;
      mockRpcImplementation.request.mockResolvedValue(expectedVersionId);
      const result = await patchesWs.createVersion(DOC_ID, { name: VERSION_NAME });
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('createVersion', {
        docId: DOC_ID,
        metadata: { name: VERSION_NAME },
      });
      expect(result).toBe(expectedVersionId);
    });

    it('listVersions should call rpc.request with correct params', async () => {
      const expectedMetadata: VersionMetadata[] = [
        {
          id: VERSION_ID,
          origin: 'main',
          startDate: Date.now() - 1000,
          endDate: Date.now(),
          rev: REV,
          baseRev: REV - 5,
        },
      ];
      mockRpcImplementation.request.mockResolvedValue(expectedMetadata);
      const result = await patchesWs.listVersions(DOC_ID, LIST_OPTIONS);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('listVersions', {
        docId: DOC_ID,
        options: LIST_OPTIONS,
      });
      expect(result).toBe(expectedMetadata);
    });

    it('listVersions should call rpc.request with default options if none provided', async () => {
      const expectedMetadata: VersionMetadata[] = [];
      mockRpcImplementation.request.mockResolvedValue(expectedMetadata);
      const result = await patchesWs.listVersions(DOC_ID);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('listVersions', {
        docId: DOC_ID,
      });
      expect(result).toBe(expectedMetadata);
    });

    it('getVersionState should call rpc.request with correct params', async () => {
      const expectedSnapshot: PatchesSnapshot = { rev: REV, state: 'version content', changes: [] };
      mockRpcImplementation.request.mockResolvedValue(expectedSnapshot);
      const result = await patchesWs.getVersionState(DOC_ID, VERSION_ID);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('getVersionState', {
        docId: DOC_ID,
        versionId: VERSION_ID,
      });
      expect(result).toBe(expectedSnapshot);
    });

    it('getVersionChanges should call rpc.request with correct params', async () => {
      const expectedChanges: Change[] = CHANGES;
      mockRpcImplementation.request.mockResolvedValue(expectedChanges);
      const result = await patchesWs.getVersionChanges(DOC_ID, VERSION_ID);
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('getVersionChanges', {
        docId: DOC_ID,
        versionId: VERSION_ID,
      });
      expect(result).toBe(expectedChanges);
    });

    it('updateVersion should call rpc.request with correct params', async () => {
      const newName = 'v1.1';
      mockRpcImplementation.request.mockResolvedValue(undefined);
      await patchesWs.updateVersion(DOC_ID, VERSION_ID, { name: newName });
      expect(mockRpcImplementation.request).toHaveBeenCalledWith('updateVersion', {
        docId: DOC_ID,
        versionId: VERSION_ID,
        metadata: { name: newName },
      });
    });
  });

  describe('Notifications', () => {
    beforeEach(() => {
      // Spy on the emit methods of the actual signal instances
      vi.spyOn(patchesWs.onChangesCommitted, 'emit');
    });

    it('should emit onChangesCommitted when receiving a changesCommitted notification', () => {
      const params = { docId: 'test-doc', changes: [{ id: 'change-a', ops: [], rev: 1, created: Date.now() }] };
      rpcNotificationHandlers['changesCommitted'](params);
      expect(patchesWs.onChangesCommitted.emit).toHaveBeenCalledTimes(1);
      expect(patchesWs.onChangesCommitted.emit).toHaveBeenCalledWith(params);
    });
  });
});
