import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PatchesWebSocket } from '../../../src/net/websocket/PatchesWebSocket';

// Mock dependencies
const mockTransportInstance = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  onStateChange: vi.fn().mockReturnValue(vi.fn()),
};

const mockRPCInstance = {
  request: vi.fn(),
  on: vi.fn(),
};

vi.mock('../../../src/net/websocket/WebSocketTransport', () => ({
  WebSocketTransport: vi.fn(() => mockTransportInstance),
}));

vi.mock('../../../src/net/protocol/JSONRPCClient', () => ({
  JSONRPCClient: vi.fn(() => mockRPCInstance),
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
      mockRPCInstance.request = vi.fn().mockResolvedValue(['doc1']);

      await patchesWS.subscribe('doc1');
      expect(mockRPCInstance.request).toHaveBeenCalledWith('subscribe', { ids: 'doc1' });

      await patchesWS.unsubscribe(['doc1', 'doc2']);
      expect(mockRPCInstance.request).toHaveBeenCalledWith('unsubscribe', { ids: ['doc1', 'doc2'] });

      mockRPCInstance.request = vi.fn().mockResolvedValue({ doc: {}, rev: 1 });
      await patchesWS.getDoc('doc1');
      expect(mockRPCInstance.request).toHaveBeenCalledWith('getDoc', { docId: 'doc1', atRev: undefined });

      mockRPCInstance.request = vi.fn().mockResolvedValue([]);
      await patchesWS.getChangesSince('doc1', 5);
      expect(mockRPCInstance.request).toHaveBeenCalledWith('getChangesSince', { docId: 'doc1', rev: 5 });

      const changes = [{ id: 'change1', ops: [], rev: 1, baseRev: 0, created: Date.now() }];
      await patchesWS.commitChanges('doc1', changes);
      expect(mockRPCInstance.request).toHaveBeenCalledWith('commitChanges', { docId: 'doc1', changes });

      mockRPCInstance.request = vi.fn().mockResolvedValue(undefined);
      await patchesWS.deleteDoc('doc1');
      expect(mockRPCInstance.request).toHaveBeenCalledWith('deleteDoc', { docId: 'doc1' });
    });

    it('should handle version operations', async () => {
      mockRPCInstance.request = vi.fn().mockResolvedValue('version123');
      
      const metadata = { name: 'Version 1' };
      await patchesWS.createVersion('doc1', metadata);
      expect(mockRPCInstance.request).toHaveBeenCalledWith('createVersion', { docId: 'doc1', metadata });

      mockRPCInstance.request = vi.fn().mockResolvedValue([]);
      await patchesWS.listVersions('doc1');
      expect(mockRPCInstance.request).toHaveBeenCalledWith('listVersions', { docId: 'doc1', options: undefined });

      mockRPCInstance.request = vi.fn().mockResolvedValue({ doc: {}, rev: 1 });
      await patchesWS.getVersionState('doc1', 'v1');
      expect(mockRPCInstance.request).toHaveBeenCalledWith('getVersionState', { docId: 'doc1', versionId: 'v1' });
    });

    it('should handle branch operations', async () => {
      mockRPCInstance.request = vi.fn().mockResolvedValue('branch123');
      
      await patchesWS.createBranch('doc1', 5);
      expect(mockRPCInstance.request).toHaveBeenCalledWith('createBranch', { docId: 'doc1', rev: 5, metadata: undefined });

      mockRPCInstance.request = vi.fn().mockResolvedValue([]);
      await patchesWS.listBranches('doc1');
      expect(mockRPCInstance.request).toHaveBeenCalledWith('listBranches', { docId: 'doc1' });

      mockRPCInstance.request = vi.fn().mockResolvedValue(undefined);
      await patchesWS.closeBranch('branch1');
      expect(mockRPCInstance.request).toHaveBeenCalledWith('closeBranch', { branchId: 'branch1' });

      await patchesWS.mergeBranch('branch1');
      expect(mockRPCInstance.request).toHaveBeenCalledWith('mergeBranch', { branchId: 'branch1' });
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
        changes: [{ id: 'change1', op: [] }]
      };
      handler(mockParams);

      expect(mockListener).toHaveBeenCalledWith('doc1', mockParams.changes);
    });
  });
});