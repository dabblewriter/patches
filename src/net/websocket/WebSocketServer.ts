import { ErrorCodes, StatusError } from '../error.js';
import type { JSONRPCServer } from '../protocol/JSONRPCServer.js';
import type { ServerTransport } from '../protocol/types.js';
import { getAuthContext } from '../serverContext.js';
import { denyAll, type AuthContext, type AuthorizationProvider } from './AuthorizationProvider.js';

/**
 * Options for creating a WebSocketServer instance.
 */
export interface WebSocketServerOptions {
  /** The transport layer for WebSocket connections */
  transport: ServerTransport;
  /** The JSON-RPC server for handling RPC calls */
  rpc: JSONRPCServer;
  /** Authorization provider for subscription access control */
  auth?: AuthorizationProvider;
}

/**
 * High-level WebSocket server for the Patches real-time collaboration service.
 * This class provides document subscription and notification routing over a WebSocket connection.
 * It works with a JSONRPCServer instance that handles the RPC protocol and has servers registered.
 */
export class WebSocketServer {
  readonly rpc: JSONRPCServer;
  protected transport: ServerTransport;
  protected auth: AuthorizationProvider;

  /**
   * Creates a new Patches WebSocket server instance.
   *
   * @param options - Configuration options including transport, rpc, and optional auth
   */
  constructor({ transport, rpc, auth = denyAll }: WebSocketServerOptions) {
    this.transport = transport;
    this.rpc = rpc;
    this.auth = auth;

    // Subscription operations (WebSocket-specific)
    rpc.registerMethod('subscribe', this.subscribe.bind(this));
    rpc.registerMethod('unsubscribe', this.unsubscribe.bind(this));

    // Forward notifications to subscribed clients
    rpc.onNotify(async (msg, exceptConnectionId) => {
      if (!msg.params?.docId) return;
      const { docId } = msg.params;
      const msgString = JSON.stringify(msg);
      const clientIds = await this.transport.listSubscriptions(docId);
      clientIds.forEach(clientId => {
        if (clientId !== exceptConnectionId) {
          this.transport.send(clientId, msgString);
        }
      });
    });
  }

  /**
   * Process an incoming message from a client.
   * Delegates to the RPC server for handling.
   */
  async processMessage(raw: string, ctx?: AuthContext): Promise<string | undefined> {
    return this.rpc.processMessage(raw, ctx);
  }

  /**
   * Subscribes the client to one or more documents to receive real-time updates.
   * If a document has been deleted (tombstone exists), sends immediate docDeleted notification.
   * @param params - The subscription parameters
   * @param params.ids - Document ID or IDs to subscribe to
   */
  async subscribe(params: { ids: string | string[] }) {
    const ctx = getAuthContext();
    if (!ctx?.clientId) return [];
    const { ids } = params;
    const allIds = Array.isArray(ids) ? ids : [ids];
    const allowed: string[] = [];

    await Promise.all(
      allIds.map(async id => {
        try {
          if (await this.auth.canAccess(ctx, id, 'read', 'subscribe', params)) {
            allowed.push(id);
          }
        } catch (err) {
          // Treat exceptions from the provider as a denial for this doc
          if (err instanceof StatusError && err.code === ErrorCodes.DOC_DELETED) {
            // For 410 (document deleted), send docDeleted notification
            this.transport.send(
              ctx.clientId!,
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'docDeleted',
                params: { docId: id },
              })
            );
          }
        }
      })
    );

    if (allowed.length === 0) {
      return [];
    }

    return this.transport.addSubscription(ctx.clientId, allowed);
  }

  /**
   * Unsubscribes the client from one or more documents.
   * @param params - The unsubscription parameters
   * @param params.ids - Document ID or IDs to unsubscribe from
   */
  async unsubscribe(params: { ids: string | string[] }) {
    const ctx = getAuthContext();
    if (!ctx?.clientId) return [];
    const { ids } = params;
    // We deliberately do **not** enforce authorization here –
    // removing a subscription doesn't leak information and helps
    // clean up server-side state if a client has lost access mid-session.
    return this.transport.removeSubscription(ctx.clientId, Array.isArray(ids) ? ids : [ids]);
  }
}
