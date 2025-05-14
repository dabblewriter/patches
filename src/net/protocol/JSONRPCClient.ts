import { signal, type Signal, type SignalSubscriber, type Unsubscriber } from '../../event-signal.js';
import type { ClientTransport, Notification, Request, Response } from './types.js';

/**
 * Implementation of a JSON-RPC 2.0 client that communicates over a provided transport layer.
 * This client handles sending requests, notifications, and processing responses from a server.
 * It also supports subscription to server-sent notifications.
 */
export class JSONRPCClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private notificationSignals = new Map<string, Signal>();

  /**
   * Creates a new JSON-RPC client instance.
   *
   * @param transport - The transport layer implementation that will be used for sending/receiving messages
   */
  constructor(private transport: ClientTransport) {
    transport.onMessage(this.handleMessage.bind(this));
  }

  /**
   * Sends a JSON-RPC request to the server and returns a promise for the response.
   *
   * @param method - The name of the remote procedure to call
   * @param params - The parameters to pass to the remote procedure (optional)
   * @returns A promise that resolves with the result of the procedure call or rejects with an error
   * @template T - The expected return type of the remote procedure
   */
  async request<T = any>(method: string, params?: any): Promise<T> {
    const id = this.nextId++;
    const message: Request = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(JSON.stringify(message));
    });
  }

  /**
   * Sends a JSON-RPC notification to the server (no response expected).
   *
   * @param method - The name of the remote procedure to call
   * @param params - The parameters to pass to the remote procedure (optional)
   */
  notify(method: string, params?: any): void {
    const message: Notification = { jsonrpc: '2.0', method, params };
    this.transport.send(JSON.stringify(message));
  }

  /**
   * Subscribes to server-sent notifications for a specific method.
   *
   * @param method - The notification method name to subscribe to
   * @param handler - The callback function that will be invoked when notifications are received
   * @returns A function that can be called to unsubscribe from the notifications
   * @template T - The type of the handler function
   */
  on<T extends SignalSubscriber = SignalSubscriber>(method: string, handler: T): Unsubscriber {
    let thisSignal = this.notificationSignals.get(method);
    if (!thisSignal) {
      thisSignal = signal();
      this.notificationSignals.set(method, thisSignal);
    }
    return thisSignal(handler);
  }

  /**
   * Processes incoming messages from the transport layer.
   * Handles three types of messages:
   * - Notifications: Emitted to registered subscribers
   * - Responses: Resolved/rejected to the corresponding pending promise
   * - Invalid messages: Logged as warnings
   *
   * @private
   * @param data - The raw message data received from the transport
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      // Check if it's a notification (has method but no id)
      if (typeof message === 'object' && message !== null && 'method' in message && !('id' in message)) {
        const thisSignal = this.notificationSignals.get(message.method);
        if (thisSignal) thisSignal.emit(message.params);
        return;
      }

      // Must be a response (has id)
      if (typeof message === 'object' && message !== null && 'id' in message) {
        const response = message as Response;
        const pending = this.pending.get(response.id as number);
        if (pending) {
          this.pending.delete(response.id as number);
          if ('error' in response) {
            pending.reject(response.error);
          } else {
            pending.resolve(response.result);
          }
        } else {
          console.warn(`Received response for unknown id: ${response.id}`);
        }
        return;
      }

      console.warn('Received unexpected message format:', message);
    } catch (error) {
      console.error('Failed to parse incoming message:', data, error);
    }
  }
}
