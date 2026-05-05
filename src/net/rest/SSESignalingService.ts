import { SignalingService, type JsonRpcMessage } from '../signaling/SignalingService.js';
import type { SSEServer } from './SSEServer.js';

/**
 * {@link SignalingService} that delivers WebRTC signaling frames over an
 * {@link SSEServer} stream as the multiplexed `signal` event.
 *
 * Wire it up in your routes alongside the existing SSE doc-sync handlers:
 *
 * ```typescript
 * const sse = new SSEServer();
 * const signaling = new SSESignalingService(sse);
 *
 * // GET /events/:clientId — after creating the SSE stream:
 * await signaling.onClientConnected(clientId);
 *
 * // POST /signal/:clientId
 * app.post('/signal/:clientId', async (c) => {
 *   const body = await c.req.text();
 *   const handled = await signaling.handleClientMessage(c.req.param('clientId'), body);
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
