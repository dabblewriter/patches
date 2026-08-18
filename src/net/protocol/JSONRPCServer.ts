import { signal, type Signal, type Unsubscriber } from 'easy-signal';
import { StatusError } from '../error.js';
import { clearAuthContext, getAuthContext, setAuthContext } from '../serverContext.js';
import type { Access, AuthContext, AuthorizationProvider } from '../websocket/AuthorizationProvider.js';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, Message } from './types.js';
import { rpcError, rpcNotification, rpcResponse } from './utils.js';

export type ConnectionSignalSubscriber = (params: any, clientId?: string) => any;
export type MessageHandler<R = any> = (...args: any[]) => Promise<R> | R;

/**
 * Access level for a method, optionally naming its positional wire parameters.
 * When `params` is declared, `register()` zips the names with the call arguments and
 * passes the resulting object to `AuthorizationProvider.canAccess` — required for
 * providers that validate request payloads (e.g. role-scoped commit rules on `changes`).
 *
 * `authDoc` names the document whose access governs the call when it is NOT the first
 * argument. The access check defaults to authorizing `args[0]`, which is correct for
 * `commitChanges(docId, …)` and friends; but branch `merge`/`update`/`delete` take the
 * *branch* id as `args[0]` while they write into (merge) or govern (update/delete) the
 * *source* document, so authorizing the branch would let anyone with branch access act on
 * the source. When `authDoc` is present, `register()` resolves it (with the call args and
 * the registered instance) and authorizes the returned docId instead. It may be async — a
 * branch resolver reads the branch record to find its source — and a throw fails the access
 * check closed.
 *
 * `params` and `authDoc` describe different things and never interfere: `params` reflects the
 * request *payload* (built from the real, unresolved args, so a provider validating e.g.
 * `changes` sees exactly what the client sent), while `authDoc` only redirects *which docId*
 * the check governs. A method may in principle declare both.
 *
 * `authDoc` runs *before* any authorization check, so its throw reaches an as-yet-unauthorized
 * caller: keep a resolver to a single cheap record read, and throw a `StatusError` (whose code
 * and data are returned verbatim) rather than a bare `Error` (which leaks a server stack trace).
 * Do not make it more expensive or more revealing than looking up the governed doc.
 */
export type ApiMethodDefinition =
  | Access
  | {
      access: Access;
      params?: readonly string[];
      authDoc?: (args: readonly any[], target: any) => string | Promise<string>;
    };

/** Static API definition mapping method names to access levels */
export type ApiDefinition = Record<string, ApiMethodDefinition>;

/** Options for creating a JSONRPCServer */
export interface JSONRPCServerOptions {
  /** Authorization provider for document access control */
  auth?: AuthorizationProvider;
}

/**
 * Zip declared positional param names with call args into the named object providers receive.
 * `undefined` args are intentionally dropped, so an omitted trailing arg is absent from the
 * object rather than present-and-undefined — providers key on presence (e.g. `params.changes`).
 */
function buildNamedParams(names: readonly string[] | undefined, args: any[]): Record<string, any> | undefined {
  if (!names) return undefined;
  const params: Record<string, any> = {};
  names.forEach((name, i) => {
    if (args[i] !== undefined) params[name] = args[i];
  });
  return params;
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
 *
 * Authorization is opt-in by design: without an {@link AuthorizationProvider}
 * every registered method is callable by any connected client. Patches is a
 * toolkit, not an end solution — production servers must supply `options.auth`.
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

    for (const [method, definition] of Object.entries(api)) {
      if (typeof (obj as any)[method] !== 'function') {
        throw new Error(`Method '${method}' not found on object`);
      }
      const access = typeof definition === 'string' ? definition : definition.access;
      const paramNames = typeof definition === 'string' ? undefined : definition.params;
      const authDoc = typeof definition === 'string' ? undefined : definition.authDoc;

      this.registerMethod(method, async (...args: any[]) => {
        const docId = args[0];
        if (typeof docId !== 'string' || !docId) {
          throw new StatusError(
            400,
            `INVALID_REQUEST: docId is required (got ${docId === '' ? 'empty string' : String(docId)})`
          );
        }
        const ctx = getAuthContext();
        // assertAccess no-ops immediately when there's no auth provider, so skip
        // building the named-params object (allocated on every call otherwise) in
        // that case — it would just be discarded unused.
        const params = this.auth ? buildNamedParams(paramNames, args) : undefined;
        // The document whose access governs this call is args[0] by default, but a
        // method may resolve it from the args instead (branch merge/update/delete take
        // the branch id as arg 0 yet are governed by the source doc). Only the docId in
        // slot 0 is read by assertAccess, so hand it an args list with the resolved id
        // there — the method itself still runs on the real, unmodified args. Skip the
        // (possibly async) resolve when there's no auth provider to consult.
        const authArgs = this.auth && authDoc ? [await authDoc(args, obj), ...args.slice(1)] : args;
        await this.assertAccess(access, ctx, method, authArgs, params);
        // _dispatch cleared the context during the await above; re-establish it
        // around the method's synchronous start so getClientId() works inside.
        setAuthContext(ctx);
        try {
          return (obj as any)[method](...args);
        } finally {
          clearAuthContext();
        }
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

        // Handle ReadableStream results (streaming server methods like getDoc)
        if (result && typeof result === 'object' && typeof result.getReader === 'function') {
          const reader = (result as ReadableStream<string>).getReader();
          const chunks: string[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const json = chunks.join('');

          if (typeof raw === 'string') {
            // Fast path: embed raw JSON directly without parse/re-stringify
            return `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":${json}}`;
          } else {
            // Object path: parse for structured response
            return { jsonrpc: '2.0' as const, id: message.id, result: JSON.parse(json) } as JsonRpcResponse;
          }
        }

        const response = rpcResponse(result, message.id);
        return respond(response);
      } catch (err: any) {
        return respond(
          rpcError(err?.code ?? -32000, err?.message ?? 'Server error', err?.code ? err?.data : err?.stack, message.id)
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
   * @param params - Named request params for providers that validate payloads
   *                 (built from the api definition's declared param names)
   * @throws StatusError if access is denied
   */
  protected async assertAccess(
    access: Access,
    ctx: AuthContext | undefined,
    method: string,
    args?: any[],
    params?: Record<string, any>
  ): Promise<void> {
    if (!this.auth) return; // No auth provider = allow all

    const docId = args?.[0];
    if (typeof docId !== 'string' || !docId) {
      throw new StatusError(
        400,
        `INVALID_REQUEST: docId is required (got ${docId === '' ? 'empty string' : String(docId)})`
      );
    }
    const ok = params
      ? await this.auth.canAccess(ctx, docId, access, method, params)
      : await this.auth.canAccess(ctx, docId, access, method);
    if (!ok) {
      throw new StatusError(403, `${access.toUpperCase()}_FORBIDDEN:${docId}`);
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

    // Make ctx available synchronously via getAuthContext() during handler execution.
    // Context is cleared immediately after the synchronous portion of the handler runs,
    // so handlers must capture it before any await.
    setAuthContext(ctx);
    const promise = handler(...args);
    clearAuthContext();
    return await promise;
  }
}
