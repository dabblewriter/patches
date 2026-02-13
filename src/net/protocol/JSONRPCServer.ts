import { signal, type Signal, type Unsubscriber } from '../../event-signal.js';
import { StatusError } from '../error.js';
import { clearAuthContext, getAuthContext, setAuthContext } from '../serverContext.js';
import type { AuthContext, AuthorizationProvider } from '../websocket/AuthorizationProvider.js';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, Message } from './types.js';
import { rpcError, rpcNotification, rpcResponse } from './utils.js';

export type ConnectionSignalSubscriber = (params: any, clientId?: string) => any;
export type MessageHandler<R = any> = (...args: any[]) => Promise<R> | R;

/** Access level for API methods */
export type AccessLevel = 'read' | 'write';

/** Static API definition mapping method names to access levels */
export type ApiDefinition = Record<string, AccessLevel>;

/** Options for creating a JSONRPCServer */
export interface JSONRPCServerOptions {
  /** Authorization provider for document access control */
  auth?: AuthorizationProvider;
}

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

  /** Authorization provider for document access control */
  readonly auth?: AuthorizationProvider;

  /** Allow external callers to emit server-initiated notifications. */
  public readonly onNotify = signal<(msg: JsonRpcNotification, exceptConnectionId?: string) => void>();

  /**
   * Creates a new JSONRPCServer instance.
   * @param options - Configuration options
   */
  constructor(options: JSONRPCServerOptions = {}) {
    this.auth = options.auth;
  }

  // -------------------------------------------------------------------------
  // Registration API
  // -------------------------------------------------------------------------

  /**
   * Registers a JSON-RPC method.
   *
   * @param method   Fully-qualified method name (e.g. "patches.subscribe").
   * @param handler  Function that performs the work and returns the result.
   *                 Receives spread arguments followed by AuthContext.
   */
  registerMethod<TResult = any>(method: string, handler: MessageHandler<TResult>): void {
    if (this.handlers.has(method)) {
      throw new Error(`A handler for method '${method}' is already registered.`);
    }
    this.handlers.set(method, handler);
  }

  /**
   * Registers all methods from an object that has a static `api` property.
   * The `api` property should map method names to access levels ('read' | 'write').
   *
   * @param obj - Object instance with methods to register
   * @throws Error if the object's constructor doesn't have a static `api` property
   */
  register<T extends object>(obj: T): void {
    const api = (obj.constructor as any).api as ApiDefinition | undefined;
    if (!api) {
      throw new Error('Object must have static api property');
    }

    for (const [method, access] of Object.entries(api)) {
      if (typeof (obj as any)[method] !== 'function') {
        throw new Error(`Method '${method}' not found on object`);
      }

      this.registerMethod(method, async (...args: any[]) => {
        const docId = args[0];
        if (typeof docId !== 'string' || !docId) {
          throw new StatusError(400, `INVALID_REQUEST: docId is required (got ${docId === '' ? 'empty string' : String(docId)})`);
        }
        const ctx = getAuthContext();
        await this.assertAccess(access, ctx, method, args);
        return (obj as any)[method](...args);
      });
    }
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
    const msg: JsonRpcNotification = rpcNotification(method, params);
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
  public async processMessage(message: Message, ctx?: AuthContext): Promise<JsonRpcResponse | undefined>;
  public async processMessage(raw: string | Message, ctx?: AuthContext): Promise<string | JsonRpcResponse | undefined> {
    let message: Message;
    const respond = typeof raw === 'string' ? JSON.stringify : (r: JsonRpcResponse) => r;

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
        const result = await this._dispatch(message.method, (message as JsonRpcRequest).params, ctx);
        const response = rpcResponse(result, message.id);
        return respond(response);
      } catch (err: any) {
        return respond(
          rpcError(err?.code ?? -32000, err?.message ?? 'Server error', err?.code ? undefined : err?.stack, message.id)
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
   * Checks access control before method invocation.
   * Called before each method invocation when using `register()`.
   *
   * @param access - The required access level ('read' or 'write')
   * @param ctx - The authentication context
   * @param method - The method being called
   * @param args - The method arguments (first arg is typically docId)
   * @throws StatusError if access is denied
   */
  protected async assertAccess(
    access: AccessLevel,
    ctx: AuthContext | undefined,
    method: string,
    args?: any[]
  ): Promise<void> {
    if (!this.auth) return; // No auth provider = allow all

    const docId = args?.[0];
    if (typeof docId !== 'string' || !docId) {
      throw new StatusError(400, `INVALID_REQUEST: docId is required (got ${docId === '' ? 'empty string' : String(docId)})`);
    }
    const ok = await this.auth.canAccess(ctx, docId, access, method);
    if (!ok) {
      throw new StatusError(401, `${access.toUpperCase()}_FORBIDDEN:${docId}`);
    }
  }

  /**
   * Maps JSON-RPC method names to handler calls.
   * @param method - The JSON-RPC method name.
   * @param params - The JSON-RPC parameters (array of arguments).
   * @param ctx - The authentication context.
   * @returns The result of the handler call.
   */
  protected async _dispatch(method: string, params: any, ctx?: AuthContext): Promise<any> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`Unknown method '${method}'.`);
    }

    // Normalize params to an array
    const args = Array.isArray(params) ? params : params === undefined ? [] : [params];

    // Make ctx available synchronously via getAuthContext() during handler execution
    setAuthContext(ctx);
    try {
      return await handler(...args);
    } finally {
      clearAuthContext();
    }
  }
}
