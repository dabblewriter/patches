import { type Signal } from '../../event-signal.js';
import { PatchesClient } from '../PatchesClient.js';
import type { ConnectionState } from '../protocol/types.js';
import { WebSocketTransport, type WebSocketOptions } from './WebSocketTransport.js';

/**
 * High-level client for the Patches real-time collaboration service.
 * This class provides document subscription, patch notification handling,
 * versioning, and other OT-specific functionality
 * over a WebSocket connection.
 */
export class PatchesWebSocket extends PatchesClient {
  transport: WebSocketTransport;

  // --- Public Signals ---

  /** Signal emitted when the underlying WebSocket connection state changes. */
  public readonly onStateChange: Signal<(state: ConnectionState) => void>;

  /**
   * Creates a new Patches WebSocket client instance.
   * @param url - The WebSocket server URL to connect to
   * @param wsOptions - Optional configuration for the underlying WebSocket connection
   */
  constructor(url: string, wsOptions?: WebSocketOptions) {
    const transport = new WebSocketTransport(url, wsOptions);
    super(transport);
    this.transport = transport;
    this.onStateChange = this.transport.onStateChange;
  }

  // --- Connection Management ---

  /**
   * Establishes a connection to the Patches server.
   * @returns A promise that resolves when the connection is established
   */
  async connect(): Promise<void> {
    await this.transport.connect();
  }

  /**
   * Terminates the connection to the Patches server.
   */
  disconnect(): void {
    // Unsubscribe rpc listeners? JSONRPCClient should handle this if transport disconnects.
    this.transport.disconnect();
    // Consider clearing signal listeners here if needed, though they are instance-based.
  }
}
