import { signal } from '../event-signal.js';
import type { ConnectionState, Transport } from '../net/protocol/types.js';

/**
 * Abstract base class that implements common functionality for various transport implementations.
 * Provides state management and event signaling for connection state changes and message reception.
 * Concrete transport implementations must extend this class and implement the abstract methods.
 */
export abstract class AbstractTransport implements Transport {
  private _state: ConnectionState = 'disconnected';

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
   * Establishes the connection for this transport.
   * Must be implemented by concrete subclasses.
   * @returns A promise that resolves when the connection is established
   */
  abstract connect(): Promise<void>;

  /**
   * Terminates the connection for this transport.
   * Must be implemented by concrete subclasses.
   */
  abstract disconnect(): void;

  /**
   * Sends data through this transport.
   * Must be implemented by concrete subclasses.
   * @param data - The string data to send
   */
  abstract send(data: string): void;
}
