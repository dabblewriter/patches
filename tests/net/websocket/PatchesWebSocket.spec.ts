import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchesWebSocket } from '../../../src/net/websocket/PatchesWebSocket';

// Mock dependencies
const mockTransportInstance = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  onStateChange: vi.fn().mockReturnValue(vi.fn()),
};

const mockRPCInstance = {
  call: vi.fn(),
  on: vi.fn(),
};

vi.mock('../../../src/net/websocket/WebSocketTransport', () => ({
  WebSocketTransport: vi.fn(function () {
    return mockTransportInstance;
  }),
}));

vi.mock('../../../src/net/protocol/JSONRPCClient', () => ({
  JSONRPCClient: vi.fn(function () {
    return mockRPCInstance;
  }),
}));

describe('PatchesWebSocket', () => {
  let patchesWS: PatchesWebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    patchesWS = new PatchesWebSocket('ws://localhost:8080');
  });

  describe('constructor', () => {
    it('should create instances and register handlers', () => {
      expect(mockRPCInstance.on).toHaveBeenCalledWith('changesCommitted', expect.any(Function));
    });
  });

  describe('connection management', () => {
    it('should connect to transport', async () => {
      await patchesWS.connect();
      expect(mockTransportInstance.connect).toHaveBeenCalled();
    });

    it('should disconnect from transport', () => {
      patchesWS.disconnect();
      expect(mockTransportInstance.disconnect).toHaveBeenCalled();
    });
  });

  describe('API methods', () => {
    it('should call RPC methods with correct parameters', async () => {
      mockRPCInstance.call = vi.fn().mockResolvedValue(['doc1']);

      await patchesWS.subscribe('doc1');
      expect(mockRPCInstance.call).toHaveBeenCalledWith('subscribe', 'doc1');

      await patchesWS.unsubscribe(['doc1', 'doc2']);
      expect(mockRPCInstance.call).toHaveBeenCalledWith('unsubscribe', ['doc1', 'doc2']);

      mockRPCInstance.call = vi.fn().mockResolvedValue({ doc: {}, rev: 1 });
      await patchesWS.getDoc('doc1');
      expect(mockRPCInstance.call).toHaveBeenCalledWith('getDoc', 'doc1', undefined);

      mockRPCInstance.call = vi.fn().mockResolvedValue([]);
      await patchesWS.getChangesSince('doc1', 5);
      expect(mockRPCInstance.call).toHaveBeenCalledWith('getChangesSince', 'doc1', 5);

      const changes = [{ id: 'change1', ops: [], rev: 1, baseRev: 0, createdAt: '2024-01-01T00:00:00.000Z' }];
      await patchesWS.commitChanges('doc1', changes);
      expect(mockRPCInstance.call).toHaveBeenCalledWith('commitChanges', 'doc1', changes, undefined);

      mockRPCInstance.call = vi.fn().mockResolvedValue(undefined);
      await patchesWS.deleteDoc('doc1');
      expect(mockRPCInstance.call).toHaveBeenCalledWith('deleteDoc', 'doc1', undefined);
    });

    it('should handle version operations', async () => {
      mockRPCInstance.call = vi.fn().mockResolvedValue('version123');

      const metadata = { name: 'Version 1' };
      await patchesWS.createVersion('doc1', metadata);
      expect(mockRPCInstance.call).toHaveBeenCalledWith('createVersion', 'doc1', metadata);

      mockRPCInstance.call = vi.fn().mockResolvedValue([]);
      await patchesWS.listVersions('doc1');
      expect(mockRPCInstance.call).toHaveBeenCalledWith('listVersions', 'doc1', undefined);

      mockRPCInstance.call = vi.fn().mockResolvedValue({ doc: {}, rev: 1 });
      await patchesWS.getVersionState('doc1', 'v1');
      expect(mockRPCInstance.call).toHaveBeenCalledWith('getVersionState', 'doc1', 'v1');
    });

    it('should handle branch operations', async () => {
      mockRPCInstance.call = vi.fn().mockResolvedValue('branch123');

      await patchesWS.createBranch('doc1', 5);
      expect(mockRPCInstance.call).toHaveBeenCalledWith('createBranch', 'doc1', 5, undefined);

      mockRPCInstance.call = vi.fn().mockResolvedValue([]);
      await patchesWS.listBranches('doc1');
      expect(mockRPCInstance.call).toHaveBeenCalledWith('listBranches', 'doc1');

      mockRPCInstance.call = vi.fn().mockResolvedValue(undefined);
      await patchesWS.closeBranch('branch1');
      expect(mockRPCInstance.call).toHaveBeenCalledWith('closeBranch', 'branch1');

      await patchesWS.mergeBranch('branch1');
      expect(mockRPCInstance.call).toHaveBeenCalledWith('mergeBranch', 'branch1');
    });
  });

  describe('notifications', () => {
    it('should emit notifications from RPC events', () => {
      const mockListener = vi.fn();
      patchesWS.onChangesCommitted(mockListener);

      // Get the registered handler
      const handler = (mockRPCInstance.on as any).mock.calls.find(
        ([name]: [string, any]) => name === 'changesCommitted'
      )[1];

      const mockParams = {
        docId: 'doc1',
        changes: [{ id: 'change1', op: [] }],
      };
      handler(mockParams);

      expect(mockListener).toHaveBeenCalledWith('doc1', mockParams.changes);
    });
  });
});
