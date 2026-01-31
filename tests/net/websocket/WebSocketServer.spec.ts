import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketServer } from '../../../src/net/websocket/WebSocketServer';
import * as serverContext from '../../../src/net/serverContext';

// Mock the serverContext module
vi.mock('../../../src/net/serverContext', () => ({
  getAuthContext: vi.fn(),
}));

// Mock dependencies
const mockTransport = {
  listSubscriptions: vi.fn(),
  addSubscription: vi.fn(),
  removeSubscription: vi.fn(),
  send: vi.fn(),
};

const mockAuth = {
  canAccess: vi.fn().mockResolvedValue(true),
};

const mockRPC = {
  registerMethod: vi.fn(),
  onNotify: vi.fn(),
};

describe('WebSocketServer', () => {
  let webSocketServer: WebSocketServer;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    mockAuth.canAccess.mockResolvedValue(true);
    vi.mocked(serverContext.getAuthContext).mockReturnValue(undefined);

    webSocketServer = new WebSocketServer({
      transport: mockTransport as any,
      rpc: mockRPC as any,
      auth: mockAuth,
    });
  });

  describe('constructor', () => {
    it('should register subscription methods', () => {
      expect(mockRPC.registerMethod).toHaveBeenCalledWith('subscribe', expect.any(Function));
      expect(mockRPC.registerMethod).toHaveBeenCalledWith('unsubscribe', expect.any(Function));
    });

    it('should set up notification forwarding', () => {
      expect(mockRPC.onNotify).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('subscription management', () => {
    const mockCtx = { clientId: 'client1' };

    it('should handle subscribe with authorization', async () => {
      vi.mocked(serverContext.getAuthContext).mockReturnValue(mockCtx);
      mockTransport.addSubscription.mockResolvedValue(['doc1']);

      const result = await webSocketServer.subscribe({ ids: 'doc1' });

      expect(mockAuth.canAccess).toHaveBeenCalledWith(mockCtx, 'doc1', 'read', 'subscribe', { ids: 'doc1' });
      expect(mockTransport.addSubscription).toHaveBeenCalledWith('client1', ['doc1']);
      expect(result).toEqual(['doc1']);
    });

    it('should filter unauthorized documents', async () => {
      vi.mocked(serverContext.getAuthContext).mockReturnValue(mockCtx);
      mockAuth.canAccess
        .mockResolvedValueOnce(true) // doc1 allowed
        .mockResolvedValueOnce(false); // doc2 denied

      mockTransport.addSubscription.mockResolvedValue(['doc1']);

      const result = await webSocketServer.subscribe({ ids: ['doc1', 'doc2'] });

      expect(mockTransport.addSubscription).toHaveBeenCalledWith('client1', ['doc1']);
      expect(result).toEqual(['doc1']);
    });

    it('should handle unsubscribe without authorization check', async () => {
      vi.mocked(serverContext.getAuthContext).mockReturnValue(mockCtx);
      mockTransport.removeSubscription.mockResolvedValue(['doc1']);

      const result = await webSocketServer.unsubscribe({ ids: 'doc1' });

      expect(mockAuth.canAccess).not.toHaveBeenCalled();
      expect(mockTransport.removeSubscription).toHaveBeenCalledWith('client1', ['doc1']);
      expect(result).toEqual(['doc1']);
    });

    it('should return empty array when no client ID', async () => {
      vi.mocked(serverContext.getAuthContext).mockReturnValue(undefined);
      const result = await webSocketServer.subscribe({ ids: 'doc1' });
      expect(result).toEqual([]);

      const result2 = await webSocketServer.unsubscribe({ ids: 'doc1' });
      expect(result2).toEqual([]);
    });
  });

  describe('notification forwarding', () => {
    it('should forward notifications to subscribed clients', async () => {
      const clientIds = ['client1', 'client2'];
      mockTransport.listSubscriptions.mockResolvedValue(clientIds);

      // Get the notification handler
      const notifyHandler = mockRPC.onNotify.mock.calls[0][0];

      const mockMessage = {
        method: 'changesCommitted',
        params: { docId: 'doc1', changes: [] },
      };

      await notifyHandler(mockMessage);

      expect(mockTransport.listSubscriptions).toHaveBeenCalledWith('doc1');
      expect(mockTransport.send).toHaveBeenCalledWith('client1', JSON.stringify(mockMessage));
      expect(mockTransport.send).toHaveBeenCalledWith('client2', JSON.stringify(mockMessage));
    });

    it('should ignore notifications without docId', async () => {
      const notifyHandler = mockRPC.onNotify.mock.calls[0][0];

      const mockMessage = {
        method: 'someMethod',
        params: { otherField: 'value' },
      };

      await notifyHandler(mockMessage);

      expect(mockTransport.listSubscriptions).not.toHaveBeenCalled();
      expect(mockTransport.send).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    const mockCtx = { clientId: 'client1' };

    it('should handle authorization exceptions', async () => {
      vi.mocked(serverContext.getAuthContext).mockReturnValue(mockCtx);
      mockAuth.canAccess.mockRejectedValue(new Error('Auth error'));

      const result = await webSocketServer.subscribe({ ids: 'doc1' });

      expect(result).toEqual([]);
      expect(mockTransport.addSubscription).not.toHaveBeenCalled();
    });

    it('should propagate transport errors', async () => {
      vi.mocked(serverContext.getAuthContext).mockReturnValue(mockCtx);
      const error = new Error('Transport error');
      mockTransport.addSubscription.mockRejectedValue(error);

      await expect(webSocketServer.subscribe({ ids: 'doc1' })).rejects.toThrow('Transport error');
    });
  });
});
