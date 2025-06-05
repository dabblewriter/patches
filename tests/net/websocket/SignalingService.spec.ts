import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SignalingService,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SendFn,
} from '../../../src/net/websocket/SignalingService';

describe('SignalingService', () => {
  let service: SignalingService;
  let mockSendFn: SendFn;
  let sentMessages: any[];

  beforeEach(() => {
    service = new SignalingService();
    sentMessages = [];
    mockSendFn = vi.fn(message => {
      sentMessages.push(message);
    });
  });

  describe('onClientConnected', () => {
    it('should register a new client and assign an ID', () => {
      const clientId = service.onClientConnected(mockSendFn);

      expect(clientId).toBeDefined();
      expect(typeof clientId).toBe('string');
      expect(clientId.length).toBeGreaterThan(0);
    });

    it('should send peer-welcome message to new client', () => {
      const clientId = service.onClientConnected(mockSendFn);

      expect(mockSendFn).toHaveBeenCalledTimes(1);
      const welcomeMessage = sentMessages[0];

      expect(welcomeMessage).toEqual({
        jsonrpc: '2.0',
        method: 'peer-welcome',
        params: {
          id: clientId,
          peers: [],
        },
      });
    });

    it('should include existing peers in welcome message', () => {
      // Add first client
      const client1Id = service.onClientConnected(vi.fn());

      // Add second client
      sentMessages.length = 0; // Clear previous messages
      const client2Id = service.onClientConnected(mockSendFn);

      const welcomeMessage = sentMessages[0];
      expect(welcomeMessage.params.peers).toEqual([client1Id]);
    });

    it('should use provided client ID if given', () => {
      const customId = 'custom-client-id';
      const clientId = service.onClientConnected(mockSendFn, customId);

      expect(clientId).toBe(customId);
      expect(sentMessages[0].params.id).toBe(customId);
    });

    it('should handle multiple clients correctly', () => {
      const client1Send = vi.fn();
      const client2Send = vi.fn();
      const client3Send = vi.fn();

      const client1Id = service.onClientConnected(client1Send);
      const client2Id = service.onClientConnected(client2Send);
      const client3Id = service.onClientConnected(client3Send);

      // Each client should have received a welcome message
      expect(client1Send).toHaveBeenCalledTimes(1);
      expect(client2Send).toHaveBeenCalledTimes(1);
      expect(client3Send).toHaveBeenCalledTimes(1);

      // Third client should see first two clients in peers list
      const client3Welcome = client3Send.mock.calls[0][0];
      expect(client3Welcome.params.peers).toEqual(expect.arrayContaining([client1Id, client2Id]));
    });
  });

  describe('onClientDisconnected', () => {
    it('should remove client and broadcast disconnection', () => {
      const client1Send = vi.fn();
      const client2Send = vi.fn();

      const client1Id = service.onClientConnected(client1Send);
      const client2Id = service.onClientConnected(client2Send);

      // Clear previous calls
      vi.mocked(client1Send).mockClear();
      vi.mocked(client2Send).mockClear();

      // Disconnect client1
      service.onClientDisconnected(client1Id);

      // Client2 should receive disconnection notification
      expect(client2Send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'peer-disconnected',
        params: { id: client1Id },
      });

      // Client1 should not receive notification (already disconnected)
      expect(client1Send).not.toHaveBeenCalled();
    });

    it('should handle disconnection of non-existent client', () => {
      const client1Send = vi.fn();
      service.onClientConnected(client1Send);

      client1Send.mockClear();

      // Try to disconnect non-existent client
      service.onClientDisconnected('non-existent-id');

      // Should broadcast disconnection message even for non-existent clients
      expect(client1Send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'peer-disconnected',
        params: { id: 'non-existent-id' },
      });
    });

    it('should not send disconnection to the disconnecting client', () => {
      const client1Send = vi.fn();
      const client2Send = vi.fn();
      const client3Send = vi.fn();

      const client1Id = service.onClientConnected(client1Send);
      const client2Id = service.onClientConnected(client2Send);
      const client3Id = service.onClientConnected(client3Send);

      // Clear previous calls
      vi.mocked(client1Send).mockClear();
      vi.mocked(client2Send).mockClear();
      client3Send.mockClear();

      // Disconnect client2
      service.onClientDisconnected(client2Id);

      // Only client1 and client3 should receive notification
      expect(client1Send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'peer-disconnected',
        params: { id: client2Id },
      });
      expect(client3Send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'peer-disconnected',
        params: { id: client2Id },
      });
      expect(client2Send).not.toHaveBeenCalled();
    });
  });

  describe('handleClientMessage', () => {
    let client1Send: SendFn;
    let client2Send: SendFn;
    let client1Id: string;
    let client2Id: string;

    beforeEach(() => {
      client1Send = vi.fn();
      client2Send = vi.fn();
      client1Id = service.onClientConnected(client1Send);
      client2Id = service.onClientConnected(client2Send);

      // Clear welcome messages
      vi.mocked(client1Send).mockClear();
      vi.mocked(client2Send).mockClear();
    });

    it('should handle valid peer-signal messages', () => {
      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 1,
        params: {
          to: client2Id,
          data: { type: 'offer', sdp: 'test-sdp' },
        },
      };

      const result = service.handleClientMessage(client1Id, signalMessage);

      expect(result).toBe(true);
      expect(client2Send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'signal',
        params: {
          from: client1Id,
          data: { type: 'offer', sdp: 'test-sdp' },
        },
      });
    });

    it('should send success response for valid signaling messages with ID', () => {
      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 123,
        params: {
          to: client2Id,
          data: { type: 'answer' },
        },
      };

      service.handleClientMessage(client1Id, signalMessage);

      expect(client1Send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        result: 'ok',
        id: 123,
      });
    });

    it('should not send response for signaling messages without ID', () => {
      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        params: {
          to: client2Id,
          data: { type: 'answer' },
        },
      };

      service.handleClientMessage(client1Id, signalMessage);

      // Should only call client2Send (target), not client1Send (sender response)
      expect(client1Send).not.toHaveBeenCalled();
      expect(client2Send).toHaveBeenCalledTimes(1);
    });

    it('should handle string messages by parsing JSON', () => {
      const signalMessage = JSON.stringify({
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 1,
        params: {
          to: client2Id,
          data: { type: 'offer' },
        },
      });

      const result = service.handleClientMessage(client1Id, signalMessage);

      expect(result).toBe(true);
      expect(client2Send).toHaveBeenCalled();
    });

    it('should return false for invalid JSON strings', () => {
      const result = service.handleClientMessage(client1Id, 'invalid json');

      expect(result).toBe(false);
      expect(client1Send).not.toHaveBeenCalled();
      expect(client2Send).not.toHaveBeenCalled();
    });

    it('should return false for non-signaling messages', () => {
      const nonSignalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'other-method',
        params: {},
      };

      const result = service.handleClientMessage(client1Id, nonSignalMessage);

      expect(result).toBe(false);
      expect(client1Send).not.toHaveBeenCalled();
      expect(client2Send).not.toHaveBeenCalled();
    });

    it('should return false for malformed signaling messages', () => {
      const malformedMessage = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        // Missing 'to' parameter
        params: { data: {} },
      };

      const result = service.handleClientMessage(client1Id, malformedMessage as JsonRpcRequest);

      expect(result).toBe(false);
    });

    it('should handle signaling to non-existent target', () => {
      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 1,
        params: {
          to: 'non-existent-client',
          data: { type: 'offer' },
        },
      };

      const result = service.handleClientMessage(client1Id, signalMessage);

      expect(result).toBe(true); // Still a valid signaling message
      expect(client1Send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Target not connected' },
        id: 1,
      });
    });

    it('should not send error response for notifications to non-existent target', () => {
      const signalNotification: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        // No id - this is a notification
        params: {
          to: 'non-existent-client',
          data: { type: 'offer' },
        },
      };

      const result = service.handleClientMessage(client1Id, signalNotification);

      expect(result).toBe(true);
      expect(client1Send).not.toHaveBeenCalled(); // No response for notifications
    });

    it('should handle wrong JSON-RPC version', () => {
      const wrongVersionMessage = {
        jsonrpc: '1.0', // Wrong version
        method: 'peer-signal',
        params: { to: client2Id, data: {} },
      };

      const result = service.handleClientMessage(client1Id, wrongVersionMessage as JsonRpcRequest);

      expect(result).toBe(false);
    });

    it('should handle missing method', () => {
      const noMethodMessage = {
        jsonrpc: '2.0',
        params: { to: client2Id, data: {} },
      };

      const result = service.handleClientMessage(client1Id, noMethodMessage as JsonRpcRequest);

      expect(result).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle send function errors gracefully', () => {
      // The SignalingService doesn't currently handle send errors gracefully
      // This test documents the current behavior
      const errorSendFn = vi.fn().mockImplementation(() => {
        throw new Error('Send failed');
      });

      // onClientConnected calls send immediately, which will throw
      expect(() => {
        service.onClientConnected(errorSendFn);
      }).toThrow('Send failed');
    });

    it('should handle errors in broadcast', () => {
      // This test documents that the current SignalingService doesn't handle broadcast errors
      const errorSendFn = vi.fn().mockImplementation(() => {
        throw new Error('Broadcast failed');
      });
      const normalSendFn = vi.fn();

      // onClientConnected will throw for the error client
      expect(() => {
        service.onClientConnected(errorSendFn);
      }).toThrow('Broadcast failed');

      // But normal client should work fine
      const normalClientId = service.onClientConnected(normalSendFn);
      expect(normalClientId).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle rapid connect/disconnect cycles', () => {
      const sends: SendFn[] = [];
      const ids: string[] = [];

      // Connect multiple clients rapidly
      for (let i = 0; i < 10; i++) {
        const sendFn = vi.fn();
        sends.push(sendFn);
        ids.push(service.onClientConnected(sendFn));
      }

      // Disconnect half of them
      for (let i = 0; i < 5; i++) {
        service.onClientDisconnected(ids[i]);
      }

      // Connect a new client - should see remaining peers
      const newSend = vi.fn();
      service.onClientConnected(newSend);

      const welcomeMessage = newSend.mock.calls[0][0];
      expect(welcomeMessage.params.peers).toHaveLength(5); // Remaining 5 clients
    });

    it('should handle empty signaling data', () => {
      const client1Send = vi.fn();
      const client2Send = vi.fn();
      const client1Id = service.onClientConnected(client1Send);
      const client2Id = service.onClientConnected(client2Send);

      client2Send.mockClear();

      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        params: {
          to: client2Id,
          data: null,
        },
      };

      const result = service.handleClientMessage(client1Id, signalMessage);

      expect(result).toBe(true);
      expect(client2Send).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'signal',
        params: {
          from: client1Id,
          data: null,
        },
      });
    });

    it('should maintain unique client IDs', () => {
      const ids = new Set();

      // Create many clients
      for (let i = 0; i < 100; i++) {
        const id = service.onClientConnected(vi.fn());
        expect(ids.has(id)).toBe(false); // Should be unique
        ids.add(id);
      }

      expect(ids.size).toBe(100);
    });

    it('should handle concurrent operations', () => {
      const client1Send = vi.fn();
      const client2Send = vi.fn();
      const client3Send = vi.fn();

      const client1Id = service.onClientConnected(client1Send);
      const client2Id = service.onClientConnected(client2Send);
      const client3Id = service.onClientConnected(client3Send);

      // Clear setup calls
      vi.mocked(client1Send).mockClear();
      vi.mocked(client2Send).mockClear();
      client3Send.mockClear();

      // Simulate concurrent signaling
      const signal1to2: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 1,
        params: { to: client2Id, data: { from: '1to2' } },
      };

      const signal2to3: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 2,
        params: { to: client3Id, data: { from: '2to3' } },
      };

      const signal3to1: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 3,
        params: { to: client1Id, data: { from: '3to1' } },
      };

      // Process signals "simultaneously"
      service.handleClientMessage(client1Id, signal1to2);
      service.handleClientMessage(client2Id, signal2to3);
      service.handleClientMessage(client3Id, signal3to1);

      // Each client should receive their targeted signal
      expect(client2Send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'signal',
          params: expect.objectContaining({ data: { from: '1to2' } }),
        })
      );

      expect(client3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'signal',
          params: expect.objectContaining({ data: { from: '2to3' } }),
        })
      );

      expect(client1Send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'signal',
          params: expect.objectContaining({ data: { from: '3to1' } }),
        })
      );
    });
  });
});
