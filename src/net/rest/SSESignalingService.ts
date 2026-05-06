import { SignalingService, type JsonRpcMessage } from '../signaling/SignalingService.js';
import type { SSEServer } from './SSEServer.js';

/**
 * {@link SignalingService} that delivers WebRTC signaling frames over an
 * {@link SSEServer} stream as the multiplexed `signal` event.
 *
 * Wire it up in your routes alongside the existing SSE doc-sync handlers.
 *
 * **Security:** the `fromId` passed to {@link handleClientMessage} MUST come
 * from your authenticated session, not from the request URL. If you trust the
 * URL `:clientId`, client A can POST to `/signal/B` and impersonate B in the
 * WebRTC mesh, redirecting peer connections. Treat the URL parameter as
 * untrusted input and bind sender identity to auth.
 *
 * ```typescript
 * const sse = new SSEServer();
 * const signaling = new SSESignalingService(sse);
 *
 * // GET /events/:clientId — after creating the SSE stream:
 * const clientId = req.auth.clientId; // authenticated, not URL-derived
 * await signaling.onClientConnected(clientId);
 *
 * // POST /signal/:clientId
 * app.post('/signal/:clientId', async (req, res) => {
 *   if (req.auth.clientId !== req.params.clientId) return res.status(403).end();
 *   const body = await readBody(req);
 *   await signaling.handleClientMessage(req.auth.clientId, body);
 *   res.status(204).end();
 * });
 *
 * // On SSE stream close:
 * await signaling.onClientDisconnected(clientId);
 * ```
 */
export class SSESignalingService extends SignalingService {
  constructor(private sse: SSEServer) {
    super();
  }

  /**
   * Derived from the live SSE connection set rather than tracked separately,
   * so peer-routing decisions can't drift from actual writer liveness. If a
   * client's SSE stream silently dies, `getConnectionIds()` excludes it
   * immediately and `handleClientMessage` will respond with "Target not
   * connected" instead of relaying into the void.
   */
  override async getClients(): Promise<Set<string>> {
    return new Set(this.sse.getConnectionIds());
  }

  /** No-op: the SSEServer's connection set is the source of truth. */
  override async setClients(_clients: Set<string>): Promise<void> {
    // intentional no-op — see getClients()
  }

  send(id: string, message: JsonRpcMessage): void {
    this.sse.sendToClient(id, 'signal', JSON.stringify(message));
  }
}
