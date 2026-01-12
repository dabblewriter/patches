import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonRpcRequest } from '../../../src/net';
import { SignalingService, type JsonRpcMessage } from '../../../src/net/websocket/SignalingService';

/**
 * Concrete implementation of SignalingService for testing.
 * Tracks all messages sent to each client.
 */
class TestSignalingService extends SignalingService {
  /** Messages sent to each client, keyed by client ID */
  sentMessages = new Map<string, JsonRpcMessage[]>();

  send(id: string, message: JsonRpcMessage): void {
    const messages = this.sentMessages.get(id) ?? [];
    messages.push(message);
    this.sentMessages.set(id, messages);
  }

  /** Helper to get messages sent to a specific client */
  getMessages(id: string): JsonRpcMessage[] {
    return this.sentMessages.get(id) ?? [];
  }

  /** Helper to clear all tracked messages */
  clearMessages(): void {
    this.sentMessages.clear();
  }
}

describe('SignalingService', () => {
  let service: TestSignalingService;

  beforeEach(() => {
    service = new TestSignalingService();
  });

  describe('onClientConnected', () => {
    it('should register a new client and assign an ID', async () => {
      const clientId = await service.onClientConnected();

      expect(clientId).toBeDefined();
      expect(typeof clientId).toBe('string');
      expect(clientId.length).toBeGreaterThan(0);
    });

    it('should send peer-welcome message to new client', async () => {
      const clientId = await service.onClientConnected();

      const messages = service.getMessages(clientId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        jsonrpc: '2.0',
        method: 'peer-welcome',
        params: {
          id: clientId,
          peers: [],
        },
      });
    });

    it('should include existing peers in welcome message', async () => {
      const client1Id = await service.onClientConnected();
      const client2Id = await service.onClientConnected();

      const messages = service.getMessages(client2Id);
      expect(messages[0].params.peers).toEqual([client1Id]);
    });

    it('should use provided client ID if given', async () => {
      const customId = 'custom-client-id';
      const clientId = await service.onClientConnected(customId);

      expect(clientId).toBe(customId);
      const messages = service.getMessages(customId);
      expect(messages[0].params.id).toBe(customId);
    });

    it('should handle multiple clients correctly', async () => {
      const client1Id = await service.onClientConnected();
      const client2Id = await service.onClientConnected();
      const client3Id = await service.onClientConnected();

      // Each client should have received a welcome message
      expect(service.getMessages(client1Id)).toHaveLength(1);
      expect(service.getMessages(client2Id)).toHaveLength(1);
      expect(service.getMessages(client3Id)).toHaveLength(1);

      // Third client should see first two clients in peers list
      const client3Welcome = service.getMessages(client3Id)[0];
      expect(client3Welcome.params.peers).toEqual(expect.arrayContaining([client1Id, client2Id]));
    });
  });

  describe('onClientDisconnected', () => {
    it('should remove client and broadcast disconnection', async () => {
      const client1Id = await service.onClientConnected();
      const client2Id = await service.onClientConnected();

      service.clearMessages();

      await service.onClientDisconnected(client1Id);

      // Client2 should receive disconnection notification
      const client2Messages = service.getMessages(client2Id);
      expect(client2Messages).toContainEqual({
        jsonrpc: '2.0',
        method: 'peer-disconnected',
        params: { id: client1Id },
      });

      // Client1 should not receive notification (already disconnected)
      expect(service.getMessages(client1Id)).toHaveLength(0);
    });

    it('should handle disconnection of non-existent client', async () => {
      const client1Id = await service.onClientConnected();
      service.clearMessages();

      // Try to disconnect non-existent client
      await service.onClientDisconnected('non-existent-id');

      // Should broadcast disconnection message even for non-existent clients
      expect(service.getMessages(client1Id)).toContainEqual({
        jsonrpc: '2.0',
        method: 'peer-disconnected',
        params: { id: 'non-existent-id' },
      });
    });

    it('should not send disconnection to the disconnecting client', async () => {
      const client1Id = await service.onClientConnected();
      const client2Id = await service.onClientConnected();
      const client3Id = await service.onClientConnected();

      service.clearMessages();

      await service.onClientDisconnected(client2Id);

      // Only client1 and client3 should receive notification
      expect(service.getMessages(client1Id)).toContainEqual({
        jsonrpc: '2.0',
        method: 'peer-disconnected',
        params: { id: client2Id },
      });
      expect(service.getMessages(client3Id)).toContainEqual({
        jsonrpc: '2.0',
        method: 'peer-disconnected',
        params: { id: client2Id },
      });
      expect(service.getMessages(client2Id)).toHaveLength(0);
    });
  });

  describe('handleClientMessage', () => {
    let client1Id: string;
    let client2Id: string;

    beforeEach(async () => {
      client1Id = await service.onClientConnected();
      client2Id = await service.onClientConnected();
      service.clearMessages();
    });

    it('should handle valid peer-signal messages', async () => {
      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 1,
        params: {
          to: client2Id,
          data: { type: 'offer', sdp: 'test-sdp' },
        },
      };

      const result = await service.handleClientMessage(client1Id, signalMessage);

      expect(result).toBe(true);
      expect(service.getMessages(client2Id)).toContainEqual({
        jsonrpc: '2.0',
        method: 'signal',
        params: {
          from: client1Id,
          data: { type: 'offer', sdp: 'test-sdp' },
        },
      });
    });

    it('should send success response for valid signaling messages with ID', async () => {
      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 123,
        params: {
          to: client2Id,
          data: { type: 'answer' },
        },
      };

      await service.handleClientMessage(client1Id, signalMessage);

      expect(service.getMessages(client1Id)).toContainEqual({
        jsonrpc: '2.0',
        result: 'ok',
        id: 123,
      });
    });

    it('should not send response for signaling messages without ID', async () => {
      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        params: {
          to: client2Id,
          data: { type: 'answer' },
        },
      };

      await service.handleClientMessage(client1Id, signalMessage);

      // Should only send to client2 (target), not client1 (sender response)
      expect(service.getMessages(client1Id)).toHaveLength(0);
      expect(service.getMessages(client2Id)).toHaveLength(1);
    });

    it('should handle string messages by parsing JSON', async () => {
      const signalMessage = JSON.stringify({
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 1,
        params: {
          to: client2Id,
          data: { type: 'offer' },
        },
      });

      const result = await service.handleClientMessage(client1Id, signalMessage);

      expect(result).toBe(true);
      expect(service.getMessages(client2Id)).toHaveLength(1);
    });

    it('should return false for invalid JSON strings', async () => {
      const result = await service.handleClientMessage(client1Id, 'invalid json');

      expect(result).toBe(false);
      expect(service.getMessages(client1Id)).toHaveLength(0);
      expect(service.getMessages(client2Id)).toHaveLength(0);
    });

    it('should return false for non-signaling messages', async () => {
      const nonSignalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'other-method',
        params: {},
      };

      const result = await service.handleClientMessage(client1Id, nonSignalMessage);

      expect(result).toBe(false);
      expect(service.getMessages(client1Id)).toHaveLength(0);
      expect(service.getMessages(client2Id)).toHaveLength(0);
    });

    it('should return false for malformed signaling messages', async () => {
      const malformedMessage = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        // Missing 'to' parameter
        params: { data: {} },
      };

      const result = await service.handleClientMessage(client1Id, malformedMessage as JsonRpcRequest);

      expect(result).toBe(false);
    });

    it('should handle signaling to non-existent target', async () => {
      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        id: 1,
        params: {
          to: 'non-existent-client',
          data: { type: 'offer' },
        },
      };

      const result = await service.handleClientMessage(client1Id, signalMessage);

      expect(result).toBe(true); // Still a valid signaling message
      expect(service.getMessages(client1Id)).toContainEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Target not connected' },
        id: 1,
      });
    });

    it('should not send error response for notifications to non-existent target', async () => {
      const signalNotification: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        // No id - this is a notification
        params: {
          to: 'non-existent-client',
          data: { type: 'offer' },
        },
      };

      const result = await service.handleClientMessage(client1Id, signalNotification);

      expect(result).toBe(true);
      expect(service.getMessages(client1Id)).toHaveLength(0); // No response for notifications
    });

    it('should handle wrong JSON-RPC version', async () => {
      const wrongVersionMessage = {
        jsonrpc: '1.0', // Wrong version
        method: 'peer-signal',
        params: { to: client2Id, data: {} },
      };

      const result = await service.handleClientMessage(client1Id, wrongVersionMessage as JsonRpcRequest);

      expect(result).toBe(false);
    });

    it('should handle missing method', async () => {
      const noMethodMessage = {
        jsonrpc: '2.0',
        params: { to: client2Id, data: {} },
      };

      const result = await service.handleClientMessage(client1Id, noMethodMessage as JsonRpcRequest);

      expect(result).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle send function errors gracefully', async () => {
      class ErrorSignalingService extends SignalingService {
        send(): void {
          throw new Error('Send failed');
        }
      }

      const errorService = new ErrorSignalingService();

      // onClientConnected calls send immediately, which will throw
      await expect(errorService.onClientConnected()).rejects.toThrow('Send failed');
    });
  });

  describe('edge cases', () => {
    it('should handle rapid connect/disconnect cycles', async () => {
      const ids: string[] = [];

      // Connect multiple clients rapidly
      for (let i = 0; i < 10; i++) {
        ids.push(await service.onClientConnected());
      }

      // Disconnect half of them
      for (let i = 0; i < 5; i++) {
        await service.onClientDisconnected(ids[i]);
      }

      // Connect a new client - should see remaining peers
      service.clearMessages();
      const newClientId = await service.onClientConnected();

      const welcomeMessage = service.getMessages(newClientId)[0];
      expect(welcomeMessage.params.peers).toHaveLength(5); // Remaining 5 clients
    });

    it('should handle empty signaling data', async () => {
      const client1Id = await service.onClientConnected();
      const client2Id = await service.onClientConnected();
      service.clearMessages();

      const signalMessage: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'peer-signal',
        params: {
          to: client2Id,
          data: null,
        },
      };

      const result = await service.handleClientMessage(client1Id, signalMessage);

      expect(result).toBe(true);
      expect(service.getMessages(client2Id)).toContainEqual({
        jsonrpc: '2.0',
        method: 'signal',
        params: {
          from: client1Id,
          data: null,
        },
      });
    });

    it('should maintain unique client IDs', async () => {
      const ids = new Set<string>();

      // Create many clients
      for (let i = 0; i < 100; i++) {
        const id = await service.onClientConnected();
        expect(ids.has(id)).toBe(false); // Should be unique
        ids.add(id);
      }

      expect(ids.size).toBe(100);
    });

    it('should handle concurrent operations', async () => {
      const client1Id = await service.onClientConnected();
      const client2Id = await service.onClientConnected();
      const client3Id = await service.onClientConnected();

      service.clearMessages();

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
      await service.handleClientMessage(client1Id, signal1to2);
      await service.handleClientMessage(client2Id, signal2to3);
      await service.handleClientMessage(client3Id, signal3to1);

      // Each client should receive their targeted signal
      expect(service.getMessages(client2Id)).toContainEqual(
        expect.objectContaining({
          method: 'signal',
          params: expect.objectContaining({ data: { from: '1to2' } }),
        })
      );

      expect(service.getMessages(client3Id)).toContainEqual(
        expect.objectContaining({
          method: 'signal',
          params: expect.objectContaining({ data: { from: '2to3' } }),
        })
      );

      expect(service.getMessages(client1Id)).toContainEqual(
        expect.objectContaining({
          method: 'signal',
          params: expect.objectContaining({ data: { from: '3to1' } }),
        })
      );
    });
  });

  describe('getClients/setClients', () => {
    it('should return current clients via getClients', async () => {
      const client1Id = await service.onClientConnected();
      const client2Id = await service.onClientConnected();

      const clients = await service.getClients();
      expect(clients.has(client1Id)).toBe(true);
      expect(clients.has(client2Id)).toBe(true);
      expect(clients.size).toBe(2);
    });

    it('should allow overriding getClients/setClients for persistence', async () => {
      // Simulate a persistent store
      const persistentStorage = new Set<string>();

      class PersistentSignalingService extends SignalingService {
        send(id: string, message: JsonRpcMessage): void {
          // Track messages (simplified)
        }

        async getClients(): Promise<Set<string>> {
          return new Set(persistentStorage);
        }

        async setClients(clients: Set<string>): Promise<void> {
          persistentStorage.clear();
          for (const id of clients) {
            persistentStorage.add(id);
          }
        }
      }

      const persistentService = new PersistentSignalingService();

      const clientId = await persistentService.onClientConnected('test-client');

      // Client should be in persistent storage
      expect(persistentStorage.has('test-client')).toBe(true);

      await persistentService.onClientDisconnected('test-client');

      // Client should be removed from persistent storage
      expect(persistentStorage.has('test-client')).toBe(false);
    });
  });
});
