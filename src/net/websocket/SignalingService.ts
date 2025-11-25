import { createId } from 'crypto-id';
import type { JsonRpcRequest, JsonRpcResponse } from '../protocol/types';

/** Union type for all possible JSON-RPC message types */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

/** Function type for sending JSON-RPC messages */
export type SendFn = (message: JsonRpcMessage) => void;

/**
 * Represents a connected client in the signaling service.
 */
interface Client {
  /** Function to send messages to this client */
  send: SendFn;
}

/**
 * Service that facilitates WebRTC connection establishment by relaying signaling messages.
 * Acts as a central hub for WebRTC peers to exchange connection information.
 */
export class SignalingService {
  private clients = new Map<string, Client>();

  /**
   * Registers a new client connection with the signaling service.
   * Assigns a unique ID to the client and informs them of other connected peers.
   *
   * @param send - Function to send messages to this client
   * @param id - Optional client ID (generated if not provided)
   * @returns The client's assigned ID
   */
  onClientConnected(send: SendFn, id: string = createId(14)): string {
    this.clients.set(id, { send });

    const welcome: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'peer-welcome',
      params: {
        id,
        peers: Array.from(this.clients.keys()).filter(pid => pid !== id),
      },
    };

    send(welcome);
    return id;
  }

  /**
   * Handles a client disconnection by removing them from the registry
   * and notifying all other connected clients.
   *
   * @param id - ID of the disconnected client
   */
  onClientDisconnected(id: string): void {
    this.clients.delete(id);

    // Broadcast to all others
    this.broadcast({
      jsonrpc: '2.0',
      method: 'peer-disconnected',
      params: { id },
    });
  }

  /**
   * Handles a signaling message from a client, relaying WebRTC session data
   * between peers to facilitate connection establishment.
   *
   * @param fromId - ID of the client sending the message
   * @param message - The JSON-RPC message or its string representation
   * @returns True if the message was a valid signaling message and was handled, false otherwise
   */
  handleClientMessage(fromId: string, message: string | JsonRpcRequest): boolean {
    let parsed: JsonRpcRequest;

    try {
      parsed = typeof message === 'string' ? JSON.parse(message) : message;
    } catch {
      return false;
    }

    if (parsed.jsonrpc !== '2.0' || parsed.method !== 'peer-signal' || !parsed.params?.to) return false;

    const { params, id } = parsed;

    const { to, data } = params as { to: string; data: any };

    const target = this.clients.get(to);
    if (!target) {
      this.respondError(fromId, id, 'Target not connected');
      // Was a signaling message, even if the target is not connected
      return true;
    }

    const outbound: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'signal',
      params: {
        from: fromId,
        data,
      },
    };

    target.send(outbound);

    if (id !== undefined) {
      this.respond(fromId, id, 'ok');
    }

    return true;
  }

  /**
   * Sends a successful JSON-RPC response to a client.
   *
   * @private
   * @param toId - ID of the client to send the response to
   * @param id - Request ID to match in the response
   * @param result - Result data to include in the response
   */
  private respond(toId: string, id: number, result: any): void {
    const client = this.clients.get(toId);
    if (!client) return;

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      result,
      id,
    };

    client.send(response);
  }

  /**
   * Sends an error JSON-RPC response to a client.
   *
   * @private
   * @param toId - ID of the client to send the error response to
   * @param id - Request ID to match in the response, or undefined for notifications
   * @param message - Error message to include
   */
  private respondError(toId: string, id: number | undefined, message: string): void {
    if (id === undefined) return;
    const client = this.clients.get(toId);
    if (!client) return;

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id,
    };

    client.send(response);
  }

  /**
   * Broadcasts a message to all connected clients, optionally excluding one.
   *
   * @private
   * @param message - The message to broadcast
   * @param excludeId - Optional ID of a client to exclude from the broadcast
   */
  private broadcast(message: JsonRpcMessage, excludeId?: string) {
    for (const [id, client] of this.clients.entries()) {
      if (id !== excludeId) {
        client.send(message);
      }
    }
  }
}
