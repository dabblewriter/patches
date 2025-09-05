import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RPCServer } from '../../../src/net/websocket/RPCServer';
import { StatusError } from '../../../src/net/error';

// Mock dependencies
const mockJSONRPCServer = {
  registerMethod: vi.fn(),
  notify: vi.fn(),
  onNotify: vi.fn(),
};

const mockPatches = {
  getDoc: vi.fn(),
  getChangesSince: vi.fn(),
  commitChanges: vi.fn(),
  deleteDoc: vi.fn(),
  onChangesCommitted: vi.fn(),
  onDocDeleted: vi.fn(),
};

const mockHistory = {
  listVersions: vi.fn(),
  createVersion: vi.fn(),
  updateVersion: vi.fn(),
  getStateAtVersion: vi.fn(),
  getChangesForVersion: vi.fn(),
  listServerChanges: vi.fn(),
};

const mockBranches = {
  listBranches: vi.fn(),
  createBranch: vi.fn(),
  closeBranch: vi.fn(),
  mergeBranch: vi.fn(),
};

const mockAuth = {
  canAccess: vi.fn().mockResolvedValue(true),
};

vi.mock('../../../src/net/protocol/JSONRPCServer', () => ({
  JSONRPCServer: vi.fn(() => mockJSONRPCServer),
}));

describe('RPCServer', () => {
  let rpcServer: RPCServer;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset mock implementations
    mockAuth.canAccess.mockResolvedValue(true);

    rpcServer = new RPCServer({
      patches: mockPatches as any,
      history: mockHistory as any,
      branches: mockBranches as any,
      auth: mockAuth as any,
    });
  });

  describe('constructor', () => {
    it('should register core methods', () => {
      expect(mockJSONRPCServer.registerMethod).toHaveBeenCalledWith('getDoc', expect.any(Function));
      expect(mockJSONRPCServer.registerMethod).toHaveBeenCalledWith('commitChanges', expect.any(Function));
      expect(mockJSONRPCServer.registerMethod).toHaveBeenCalledWith('deleteDoc', expect.any(Function));
    });

    it('should set up event forwarding', () => {
      expect(mockPatches.onChangesCommitted).toHaveBeenCalled();
      expect(mockPatches.onDocDeleted).toHaveBeenCalled();
    });
  });

  describe('document operations', () => {
    const mockCtx = { clientId: 'client1' };

    it('should handle getDoc with authorization', async () => {
      const mockDoc = { doc: { content: 'test' }, rev: 5 };
      mockPatches.getDoc.mockResolvedValue(mockDoc);

      const result = await rpcServer.getDoc({ docId: 'doc1' }, mockCtx);

      expect(mockAuth.canAccess).toHaveBeenCalledWith(mockCtx, 'doc1', 'read', 'getDoc', { docId: 'doc1' });
      expect(mockPatches.getDoc).toHaveBeenCalledWith('doc1', undefined);
      expect(result).toBe(mockDoc);
    });

    it('should handle commitChanges with authorization', async () => {
      const changes = [{ id: 'change1', ops: [], rev: 1, baseRev: 0, created: Date.now() }];
      const priorChanges: any[] = [];
      const newChanges = [{ id: 'change2', ops: [], rev: 2, baseRev: 1, created: Date.now() }];
      mockPatches.commitChanges.mockResolvedValue([priorChanges, newChanges]);

      const result = await rpcServer.commitChanges({ docId: 'doc1', changes }, mockCtx);

      expect(mockAuth.canAccess).toHaveBeenCalledWith(mockCtx, 'doc1', 'write', 'commitChanges', { docId: 'doc1', changes });
      expect(mockPatches.commitChanges).toHaveBeenCalledWith('doc1', changes, 'client1');
      expect(result).toEqual([...priorChanges, ...newChanges]);
    });

    it('should throw authorization errors', async () => {
      mockAuth.canAccess.mockResolvedValue(false);

      await expect(rpcServer.getDoc({ docId: 'doc1' }, mockCtx))
        .rejects.toThrow(new StatusError(401, 'READ_FORBIDDEN:doc1'));
    });
  });

  describe('feature availability', () => {
    it('should check if history is enabled', async () => {
      const rpcServerNoHistory = new RPCServer({ patches: mockPatches as any });

      await expect(rpcServerNoHistory.listVersions({ docId: 'doc1' }))
        .rejects.toThrow(new StatusError(404, 'History is not enabled'));
    });

    it('should check if branching is enabled', async () => {
      const rpcServerNoBranches = new RPCServer({ patches: mockPatches as any });

      await expect(rpcServerNoBranches.listBranches({ docId: 'doc1' }))
        .rejects.toThrow(new StatusError(404, 'Branching is not enabled'));
    });
  });

  describe('history operations', () => {
    const mockCtx = { clientId: 'client1' };

    it('should handle version operations with authorization', async () => {
      mockHistory.listVersions.mockResolvedValue([]);
      
      await rpcServer.listVersions({ docId: 'doc1' }, mockCtx);
      
      expect(mockAuth.canAccess).toHaveBeenCalledWith(mockCtx, 'doc1', 'read', 'listVersions', { docId: 'doc1' });
      expect(mockHistory.listVersions).toHaveBeenCalledWith('doc1', {});
    });
  });

  describe('branch operations', () => {
    const mockCtx = { clientId: 'client1' };

    it('should handle branch operations with authorization', async () => {
      mockBranches.listBranches.mockResolvedValue([]);
      
      await rpcServer.listBranches({ docId: 'doc1' }, mockCtx);
      
      expect(mockAuth.canAccess).toHaveBeenCalledWith(mockCtx, 'doc1', 'read', 'listBranches', { docId: 'doc1' });
      expect(mockBranches.listBranches).toHaveBeenCalledWith('doc1');
    });
  });

  describe('authorization helpers', () => {
    const mockCtx = { clientId: 'client1' };

    it('should pass authorization checks', async () => {
      await expect(rpcServer.assertRead(mockCtx, 'doc1', 'getDoc')).resolves.toBeUndefined();
      await expect(rpcServer.assertWrite(mockCtx, 'doc1', 'commitChanges')).resolves.toBeUndefined();
    });

    it('should fail authorization checks', async () => {
      mockAuth.canAccess.mockResolvedValue(false);

      await expect(rpcServer.assertRead(mockCtx, 'doc1', 'getDoc'))
        .rejects.toThrow('READ_FORBIDDEN:doc1');
      
      await expect(rpcServer.assertWrite(mockCtx, 'doc1', 'commitChanges'))
        .rejects.toThrow('WRITE_FORBIDDEN:doc1');
    });
  });
});