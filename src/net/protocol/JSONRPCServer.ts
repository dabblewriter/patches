import { signal, type Signal, type Unsubscriber } from '../../event-signal.js';
import { PatchesServer } from '../../server/PatchesServer.js';
import type { Message, Notification, Request, Response, ServerTransport } from './types.js';

export type ConnectionSignalSubscriber = (connectionId: string, ...args: any[]) => any;
export type MessageHandler<P = any, R = any> = (connectionId: string, params: P) => Promise<R> | R;

/**
 * Lightweight JSON-RPC 2.0 server adapter for {@link PatchesServer}.
 *
 * The class is intentionally transport-agnostic: it only needs an object that
 * fulfils the {@link Transport} contract (i.e. something that can exchange
 * string messages and notify when one arrives).  This makes it suitable for
 * WebSocket, TCP, or even `postMessage` usage.
 *
 * A new instance is typically created per connected client.  You therefore
 * pass in:
 *   • the {@link Transport} that represents this client connection
 *   • a shared (singleton) {@link PatchesServer}
 *   • the unique `clientId` that identifies the connection in subscription
 *     calls.  How you generate that ID (auth token, random GUID, etc.) is left
 *     to the host application.
 */
export class JSONRPCServer {
  /** Map of fully-qualified JSON-RPC method → handler function */
  private readonly handlers = new Map<string, MessageHandler>();
  /** Allow external callers to emit server-initiated notifications. */
  private readonly notificationSignals = new Map<string, Signal>();

  constructor(protected transport: ServerTransport) {
    transport.onMessage(this._onMessage.bind(this));
  }

  // -------------------------------------------------------------------------
  // Registration API
  // -------------------------------------------------------------------------

  /**
   * Registers a JSON-RPC method.
   *
   * @param method   Fully-qualified method name (e.g. "patches.subscribe").
   * @param handler  Function that performs the work and returns the result.
   */
  registerMethod<TParams = any, TResult = any>(method: string, handler: MessageHandler<TParams, TResult>): void {
    if (this.handlers.has(method)) {
      throw new Error(`A handler for method '${method}' is already registered.`);
    }
    this.handlers.set(method, handler as any);
  }

  // -------------------------------------------------------------------------
  // Public helpers
  // -------------------------------------------------------------------------

  /**
   * Subscribes to server-sent notifications for a specific method.
   *
   * @param method - The notification method name to subscribe to
   * @param handler - The callback function that will be invoked when notifications are received
   * @returns A function that can be called to unsubscribe from the notifications
   * @template T - The type of the handler function
   */
  on<T extends ConnectionSignalSubscriber = ConnectionSignalSubscriber>(method: string, handler: T): Unsubscriber {
    let thisSignal = this.notificationSignals.get(method);
    if (!thisSignal) {
      thisSignal = signal();
      this.notificationSignals.set(method, thisSignal);
    }
    return thisSignal(handler);
  }

  /**
   * Sends a JSON-RPC notification (no `id`, therefore no response expected) to
   * the connected client.
   */
  async notify(method: string, params?: any, exceptConnectionId?: string): Promise<void> {
    const msg: Notification = { jsonrpc: '2.0', method, params };
    const msgStr = JSON.stringify(msg);
    const connectionIds = this.transport.getConnectionIds();
    await Promise.all(connectionIds.map(id => exceptConnectionId !== id && this.transport.send(id, msgStr)));
  }

  /**
   * Handles incoming messages from the client.
   * @param connectionId - The WebSocket transport object.
   * @param raw - The raw message string.
   */
  protected async _onMessage(connectionId: string, raw: string): Promise<void> {
    let message: Message;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      this._sendError(connectionId, null, -32700, 'Parse error', err);
      return;
    }

    if (message && typeof message === 'object' && 'method' in message) {
      // Notification or request either way--delegate.
      if ('id' in message && message.id !== undefined) {
        await this._handleRequest(connectionId, message as Request);
      } else {
        await this._handleNotification(connectionId, message as Notification);
      }
    } else {
      // Client sent something we do not understand.
      this._sendError(connectionId, (message as any)?.id ?? null, -32600, 'Invalid Request');
    }
  }

  /**
   * Handles incoming JSON-RPC requests from the client.
   * @param connectionId - The WebSocket transport object.
   * @param req - The JSON-RPC request object.
   */
  protected async _handleRequest(connectionId: string, req: Request): Promise<void> {
    try {
      const result = await this._dispatch(connectionId, req.method, req.params);
      const response: Response = { jsonrpc: '2.0', id: req.id as number, result };
      this.transport.send(connectionId, JSON.stringify(response));
    } catch (err: any) {
      this._sendError(connectionId, req.id as number, -32000, err?.message ?? 'Server error', err?.stack);
    }
  }

  /**
   * Handles incoming JSON-RPC notifications from the client.
   * @param connectionId - The WebSocket transport object.
   * @param note - The JSON-RPC notification object.
   */
  protected async _handleNotification(connectionId: string, note: Notification): Promise<void> {
    const thisSignal = this.notificationSignals.get(note.method);
    if (thisSignal) {
      thisSignal.emit(connectionId, note.params);
    }
  }

  /**
   * Maps JSON-RPC method names to {@link PatchesServer} calls.
   * @param connectionId - The WebSocket transport object.
   * @param method - The JSON-RPC method name.
   * @param params - The JSON-RPC parameters.
   * @returns The result of the {@link PatchesServer} call.
   */
  protected async _dispatch(connectionId: string, method: string, params: any): Promise<any> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`Unknown method '${method}'.`);
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error(`Invalid parameters for method '${method}'.`);
    }
    return handler(connectionId, params);
  }

  /**
   * Sends a JSON-RPC error object back to the client.
   */
  private _sendError(connectionId: string, id: number | null, code: number, message: string, data?: any): void {
    const errorObj: Response = {
      jsonrpc: '2.0',
      id: id as any,
      error: { code, message, data },
    } as Response; // type cast because TS cannot narrow when error present
    this.transport.send(connectionId, JSON.stringify(errorObj));
  }
}
