import { AbstractTransport } from '../AbstractTransport.js';

/** WebSocket constructor options (subset) */
export interface WebSocketOptions {
  protocol?: string | string[];
}

/**
 * WebSocket-based transport implementation that provides communication over the WebSocket protocol.
 * Includes automatic reconnection with exponential backoff.
 */
export class WebSocketTransport extends AbstractTransport {
  private ws: WebSocket | null = null;
  private reconnectTimer: any = null;
  private backoff = 1000;
  private connecting: boolean = false;
  private connectionPromise: Promise<void> | null = null;

  /**
   * Creates a new WebSocket transport instance.
   * @param url - The WebSocket server URL to connect to
   * @param wsOptions - Optional configuration for the WebSocket connection
   */
  constructor(
    private url: string,
    private wsOptions?: WebSocketOptions
  ) {
    super();
  }

  /**
   * Establishes a connection to the WebSocket server.
   * If a connection is already open or in progress, this method returns immediately.
   * On connection failure, an automatic reconnection attempt will be scheduled.
   * @returns A promise that resolves when the connection is established or rejects on error
   */
  async connect(): Promise<void> {
    // Return existing connection if already connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    // Return pending connection promise if already connecting
    if (this.connecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connecting = true;
    this.state = 'connecting';

    // Create a new connection promise
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      try {
        // Pass protocol option if available (standard 2nd arg)
        // Other options like headers are not standard and require specific server/client handling
        // or a different WebSocket client library.
        this.ws = new WebSocket(this.url, this.wsOptions?.protocol);

        this.ws.onopen = () => {
          this.backoff = 1000; // Reset backoff on successful connection
          this.state = 'connected';
          this.connecting = false;
          resolve();
        };

        this.ws.onclose = () => {
          this.state = 'disconnected';

          // If we were in the process of connecting, reject the promise
          if (this.connecting) {
            reject(new Error('Connection closed'));
            this.connecting = false;
          }

          // Schedule reconnect regardless of whether it was a clean close
          // as WebSockets don't always emit error events before closing
          this.scheduleReconnect();
        };

        this.ws.onerror = error => {
          this.state = 'error';

          // If we're in the connection phase, reject the promise
          if (this.connecting) {
            this.connecting = false;
            reject(error);
          } else {
            // If error happens after established connection,
            // schedule a reconnect. The socket will likely close
            // right after this, but we schedule it anyway to be sure.
            this.scheduleReconnect();
          }

          // Log the error for debugging
          console.error('WebSocket error:', error);
        };

        this.ws.onmessage = event => {
          this.onMessage.emit(event.data);
        };
      } catch (error) {
        this.state = 'error';
        this.connecting = false;
        reject(error);
        this.scheduleReconnect();
      }
    });

    return this.connectionPromise;
  }

  /**
   * Terminates the WebSocket connection and cancels any pending reconnection attempts.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connecting = false;

    if (this.ws) {
      // Only attempt to close if not already closed
      if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.state = 'disconnected';
  }

  /**
   * Sends data through the WebSocket connection.
   * @param data - The string data to send
   * @throws {Error} If the WebSocket is not connected
   */
  send(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(data);
  }

  /**
   * Schedules a reconnection attempt using exponential backoff.
   * The backoff time increases with each failed attempt, up to a maximum of 30 seconds.
   * @private
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => {
        console.error('WebSocket reconnect failed:', err);
      });
    }, this.backoff);

    this.backoff = Math.min(this.backoff * 1.5, 30000);
  }
}
