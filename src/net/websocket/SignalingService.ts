import { createId } from 'crypto-id';
import type { JsonRpcRequest, JsonRpcResponse } from '../protocol/types';

/** Union type for all possible JSON-RPC message types */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

/**
 * Service that facilitates WebRTC connection establishment by relaying signaling messages.
 * Acts as a central hub for WebRTC peers to exchange connection information.
 */
export abstract class SignalingService {
  protected clients = new Set<string>();

  abstract send(id: string, message: JsonRpcMessage): void | Promise<void>;

  /**
   * Returns the list of all connected client IDs.
   * @returns Array of client IDs
   */
  async getClients(): Promise<Set<string>> {
    return new Set(this.clients);
  }

  /**
   * Sets the list of all connected client IDs.
   * @param clients - Set of client IDs
   */
  async setClients(clients: Set<string>): Promise<void> {
    this.clients = clients;
  }

  /**
   * Registers a new client connection with the signaling service.
   * Assigns a unique ID to the client and informs them of other connected peers.
   *
   * @param id - Optional client ID (generated if not provided)
   * @returns The client's assigned ID
   */
  async onClientConnected(id: string = createId(14)): Promise<string> {
    const clients = await this.getClients();
    clients.add(id);
    await this.setClients(clients);

    const welcome: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'peer-welcome',
      params: {
        id,
        peers: Array.from(this.clients).filter(pid => pid !== id),
      },
    };

    this.send(id, welcome);
    return id;
  }

  /**
   * Handles a client disconnection by removing them from the registry
   * and notifying all other connected clients.
   *
   * @param id - ID of the disconnected client
   */
  async onClientDisconnected(id: string): Promise<void> {
    const clients = await this.getClients();
    clients.delete(id);
    await this.setClients(clients);

    // Notify others
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'peer-disconnected',
      params: { id },
    };

    await Promise.all(Array.from(clients).map(clientId => this.send(clientId, message)));
  }

  /**
   * Handles a signaling message from a client, relaying WebRTC session data
   * between peers to facilitate connection establishment.
   *
   * @param fromId - ID of the client sending the message
   * @param message - The JSON-RPC message or its string representation
   * @returns True if the message was a valid signaling message and was handled, false otherwise
   */
  async handleClientMessage(fromId: string, message: string | JsonRpcRequest): Promise<boolean> {
    let parsed: JsonRpcRequest;

    try {
      parsed = typeof message === 'string' ? JSON.parse(message) : message;
    } catch {
      return false;
    }

    if (parsed.jsonrpc !== '2.0' || parsed.method !== 'peer-signal' || !parsed.params?.to) return false;

    const { params, id } = parsed;

    const { to, data } = params as { to: string; data: any };

    const clients = await this.getClients();
    if (!clients.has(to)) {
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

    await this.send(to, outbound);

    if (id !== undefined) {
      await this.respond(fromId, id, 'ok');
    }

    return true;
  }

  /**
   * Sends a successful JSON-RPC response to a client.
   *
   * @protected
   * @param toId - ID of the client to send the response to
   * @param id - Request ID to match in the response
   * @param result - Result data to include in the response
   */
  protected async respond(toId: string, id: number, result: any): Promise<void> {
    const clients = await this.getClients();
    if (!clients.has(toId)) return;

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      result,
      id,
    };

    await this.send(toId, response);
  }

  /**
   * Sends an error JSON-RPC response to a client.
   *
   * @protected
   * @param toId - ID of the client to send the error response to
   * @param id - Request ID to match in the response, or undefined for notifications
   * @param message - Error message to include
   */
  protected async respondError(toId: string, id: number | undefined, message: string): Promise<void> {
    if (id === undefined) return;
    const clients = await this.getClients();
    if (!clients.has(toId)) return;

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id,
    };

    await this.send(toId, response);
  }
}
