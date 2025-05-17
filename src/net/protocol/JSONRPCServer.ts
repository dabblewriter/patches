import { signal, type Signal, type Unsubscriber } from '../../event-signal.js';
import type { AuthContext } from '../websocket/AuthorizationProvider.js';
import type { Message, Notification, Request, Response } from './types.js';

export type ConnectionSignalSubscriber = (params: any, clientId?: string) => any;
export type MessageHandler<P = any, R = any> = (params: P, ctx?: AuthContext) => Promise<R> | R;

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
  private readonly notificationSignals = new Map<string, Signal<ConnectionSignalSubscriber>>();

  /** Allow external callers to emit server-initiated notifications. */
  public readonly onNotify = signal<(msg: Notification, exceptConnectionId?: string) => void>();

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
    this.onNotify.emit(msg, exceptConnectionId);
  }

  /**
   * Synchronously processes a raw JSON-RPC frame from a client and returns the
   * encoded response frame – or `undefined` when the message is a notification
   * (no response expected).
   *
   * This helper makes the RPC engine usable for stateless transports such as
   * HTTP: the host simply passes the request body and sends back the returned
   * string (if any).
   *
   * WebSocket and other bidirectional transports delegate to the same logic
   * internally; the returned string is forwarded over the socket.
   */
  public async processMessage(raw: string, ctx?: AuthContext): Promise<string | undefined>;
  public async processMessage(message: Message, ctx?: AuthContext): Promise<Response | undefined>;
  public async processMessage(raw: string | Message, ctx?: AuthContext): Promise<string | Response | undefined> {
    let message: Message;
    const respond = typeof raw === 'string' ? JSON.stringify : (r: Response) => r;

    // --- Parse & basic validation ------------------------------------------------
    if (typeof raw === 'string') {
      try {
        message = JSON.parse(raw);
      } catch (err) {
        return respond(rpcError(-32700, 'Parse error', err));
      }
    } else {
      message = raw;
    }

    // Ensure it looks like a JSON-RPC call (must have a method field)
    if (!message || typeof message !== 'object' || !('method' in message)) {
      const invalidId: number | null = (message as any)?.id ?? null;
      return respond(rpcError(-32600, 'Invalid Request', invalidId));
    }

    // --- Distinguish request vs. notification -----------------------------------
    if ('id' in message && message.id !== undefined) {
      // -> Request ----------------------------------------------------------------
      try {
        const result = await this._dispatch(message.method, (message as Request).params, ctx);
        const response: Response = { jsonrpc: '2.0', id: message.id as number, result };
        return respond(response);
      } catch (err: any) {
        return respond(
          rpcError(err?.code ?? -32000, err?.message ?? 'Server error', err?.code ? undefined : err?.stack)
        );
      }
    } else {
      // -> Notification -----------------------------------------------------------
      // Forward the notification to any listeners and return nothing.
      const thisSignal = this.notificationSignals.get(message.method);
      if (thisSignal) {
        thisSignal.emit(message.params, ctx?.clientId);
      }
      return undefined;
    }
  }

  /**
   * Maps JSON-RPC method names to {@link PatchesServer} calls.
   * @param connectionId - The WebSocket transport object.
   * @param method - The JSON-RPC method name.
   * @param params - The JSON-RPC parameters.
   * @returns The result of the {@link PatchesServer} call.
   */
  protected async _dispatch(method: string, params: any, ctx?: AuthContext): Promise<any> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`Unknown method '${method}'.`);
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error(`Invalid parameters for method '${method}'.`);
    }
    return handler(params, ctx);
  }
}

function rpcError(code: number, message: string, data?: any): Response {
  return { jsonrpc: '2.0', id: null as any, error: { code, message, data } };
}
