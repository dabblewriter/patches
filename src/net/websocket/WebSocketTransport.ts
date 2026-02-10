import { signal, type Unsubscriber } from '../../event-signal.js';
import { deferred, type Deferred } from '../../utils/deferred.js';
import type { ClientTransport, ConnectionState } from '../protocol/types.js';
import { onlineState } from './onlineState.js';

/** WebSocket constructor options (subset) */
export interface WebSocketOptions {
  protocol?: string | string[];
}

/**
 * WebSocket-based transport implementation that provides communication over the WebSocket protocol.
 * Includes automatic reconnection with exponential backoff.
 */
export class WebSocketTransport implements ClientTransport {
  protected _state: ConnectionState = 'disconnected';
  protected ws: WebSocket | null = null;
  protected reconnectTimer: any = null;
  protected backoff = 1000;
  protected connecting: boolean = false;
  protected connectionDeferred: Deferred | null = null;
  protected onlineUnsubscriber: Unsubscriber | null = null;

  /** Flag representing the *intent* to be connected. It is set by `connect()` and cleared by `disconnect()`. */
  protected shouldBeConnected = false;

  /**
   * Signal that emits when the connection state changes.
   * Subscribers will receive the new connection state as an argument.
   */
  public readonly onStateChange = signal<(state: ConnectionState) => void>();

  /**
   * Signal that emits when a message is received from the transport.
   * Subscribers will receive the message data as a string.
   */
  public readonly onMessage = signal<(data: string) => void>();

  /**
   * Creates a new WebSocket transport instance.
   * @param url - The WebSocket server URL to connect to
   * @param wsOptions - Optional configuration for the WebSocket connection
   */
  constructor(
    public url: string,
    public wsOptions?: WebSocketOptions
  ) {}

  /**
   * Gets the current connection state of the transport.
   * @returns The current connection state ('connecting', 'connected', 'disconnected', or 'error')
   */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Sets the connection state and emits a state change event.
   * This method is protected and should only be called by subclasses.
   * @param state - The new connection state
   */
  protected set state(state: ConnectionState) {
    if (state === this._state) return;
    this._state = state;
    this.onStateChange.emit(state);
  }

  /**
   * Establishes a connection to the WebSocket server.
   * If a connection is already open or in progress, this method returns immediately.
   * On connection failure, an automatic reconnection attempt will be scheduled.
   * @returns A promise that resolves when the connection is established or rejects on error
   */
  async connect(): Promise<void> {
    // Record the caller's intent.
    this.shouldBeConnected = true;

    // Make sure we react to browser connectivity changes
    this._ensureOnlineOfflineListeners();

    // If the browser is known to be offline, defer the actual connection until
    // it comes back online.  We still return a promise that resolves once the
    // connection is eventually established, so callers can `await` safely.
    if (onlineState.isOffline) {
      if (!this.connectionDeferred) {
        this.connectionDeferred = deferred();
      }
      return this.connectionDeferred.promise;
    }

    // Return existing connection if already connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    // Return pending connection promise if already connecting
    if (this.connecting && this.connectionDeferred) {
      return this.connectionDeferred.promise;
    }

    this.connecting = true;
    this.state = 'connecting';

    // Create a new connection promise
    this.connectionDeferred = deferred();
    const { resolve, reject } = this.connectionDeferred;

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
        this._scheduleReconnect();
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
          this._scheduleReconnect();
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
      this._scheduleReconnect();
    }

    return this.connectionDeferred.promise;
  }

  /**
   * Terminates the WebSocket connection and cancels any pending reconnection attempts.
   */
  disconnect(): void {
    // Clearing the intent stops automatic reconnection attempts.
    this.shouldBeConnected = false;

    // Remove listener now that we no longer intend to stay connected.
    this._removeOnlineOfflineListeners();

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
   * @protected
   */
  protected _scheduleReconnect(): void {
    // Only schedule a reconnect if the caller still wants to be connected.
    if (!this.shouldBeConnected || onlineState.isOffline) {
      return;
    }

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

  /**
   * Internal helper that adds (once) listeners for the browser's online/offline
   * events so we can automatically attempt to connect when the network comes
   * back and forcibly close when it goes away.
   */
  protected _ensureOnlineOfflineListeners(): void {
    if (!this.onlineUnsubscriber) {
      this.onlineUnsubscriber = onlineState.onOnlineChange(isOnline => {
        if (isOnline && this.shouldBeConnected && !this.connecting && this.state !== 'connected') {
          const oldDeferred = this.connectionDeferred;
          this.connectionDeferred = null;
          const connectPromise = this.connect();
          if (oldDeferred) {
            connectPromise.then(oldDeferred.resolve, oldDeferred.reject);
          }
        } else if (!isOnline && this.ws) {
          this.ws.close();
        }
      });
    }
  }

  /** Removes previously registered online/offline listeners (if any) */
  protected _removeOnlineOfflineListeners(): void {
    if (this.onlineUnsubscriber) {
      this.onlineUnsubscriber();
      this.onlineUnsubscriber = null;
    }
  }
}
