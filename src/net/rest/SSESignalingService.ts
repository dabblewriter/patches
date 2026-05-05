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
 * const clientId = c.get('auth').clientId; // authenticated, not URL-derived
 * await signaling.onClientConnected(clientId);
 *
 * // POST /signal/:clientId
 * app.post('/signal/:clientId', async (c) => {
 *   const fromId = c.get('auth').clientId; // authenticated, not URL-derived
 *   const body = await c.req.text();
 *   const handled = await signaling.handleClientMessage(fromId, body);
 *   return c.json({ ok: handled });
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

  send(id: string, message: JsonRpcMessage): void {
    this.sse.sendToClient(id, 'signal', JSON.stringify(message));
  }
}
