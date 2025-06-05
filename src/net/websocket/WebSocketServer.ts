import type { ServerTransport } from '../protocol/types.js';
import { denyAll, type AuthContext, type AuthorizationProvider } from './AuthorizationProvider.js';
import type { RPCServer } from './RPCServer.js';

/**
 * High-level client for the Patches real-time collaboration service.
 * This class provides document subscription, patch notification handling,
 * versioning, and other OT-specific functionality over a WebSocket connection.
 */
export class WebSocketServer {
  protected transport: ServerTransport;
  protected auth: AuthorizationProvider;

  /**
   * Creates a new Patches WebSocket client instance.
   *
   * @param transport - The transport layer implementation that will be used for sending/receiving messages
   */
  constructor(transport: ServerTransport, rpcServer: RPCServer) {
    this.transport = transport;
    const { rpc, auth } = rpcServer;
    this.auth = auth || denyAll;

    // Subscription operations
    rpc.registerMethod('subscribe', this.subscribe.bind(this));
    rpc.registerMethod('unsubscribe', this.unsubscribe.bind(this));

    rpc.onNotify(async msg => {
      if (!msg.params?.docId) return;
      const { docId } = msg.params;
      const msgString = JSON.stringify(msg);
      const clientIds = await this.transport.listSubscriptions(docId);
      clientIds.forEach(clientId => {
        this.transport.send(clientId, msgString);
      });
    });
  }

  /**
   * Subscribes the client to one or more documents to receive real-time updates.
   * @param connectionId - The ID of the connection making the request
   * @param params - The subscription parameters
   * @param params.ids - Document ID or IDs to subscribe to
   */
  async subscribe(params: { ids: string | string[] }, ctx?: AuthContext) {
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
        } catch {
          // Treat exceptions from the provider as a denial for this doc
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
   * @param connectionId - The ID of the connection making the request
   * @param params - The unsubscription parameters
   * @param params.ids - Document ID or IDs to unsubscribe from
   */
  async unsubscribe(params: { ids: string | string[] }, ctx?: AuthContext) {
    if (!ctx?.clientId) return [];
    const { ids } = params;
    // We deliberately do **not** enforce authorization here –
    // removing a subscription doesn't leak information and helps
    // clean up server-side state if a client has lost access mid-session.
    return this.transport.removeSubscription(ctx?.clientId, Array.isArray(ids) ? ids : [ids]);
  }
}
