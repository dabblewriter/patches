import type { AuthContext, AuthorizationProvider } from '../websocket/AuthorizationProvider.js';

/**
 * A buffered SSE event waiting to be sent or replayed.
 */
export interface BufferedEvent {
  id: number;
  event: string;
  data: string;
  timestamp: number;
}

/**
 * Per-client connection state tracked by the SSEServer.
 */
interface ClientState {
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  encoder: TextEncoder;
  subscriptions: Set<string>;
  buffer: BufferedEvent[];
  nextEventId: number;
  disconnectedAt: number | null;
  expiryTimer: ReturnType<typeof globalThis.setTimeout> | null;
}

/**
 * Options for creating an SSEServer instance.
 */
export interface SSEServerOptions {
  /** Heartbeat interval in milliseconds. Default: 30000 (30 seconds). */
  heartbeatIntervalMs?: number;
  /** How long to keep client state after disconnect. Default: 300000 (5 minutes). */
  bufferTTLMs?: number;
  /**
   * Sliding window for the event buffer while connected, in milliseconds.
   * Must cover the worst-case gap between a silent network failure and
   * TCP detecting it (heartbeat interval + TCP retransmission timeout).
   * Default: bufferTTLMs (matches the disconnect buffer lifetime).
   */
  bufferWindowMs?: number;
  /** Authorization provider for subscription access control. */
  auth?: AuthorizationProvider;
}

/**
 * Framework-agnostic SSE server for the Patches real-time collaboration service.
 *
 * Manages SSE connections, document subscriptions, per-client event buffering,
 * and heartbeats. Does NOT create HTTP routes — the framework calls these methods
 * from its route handlers.
 *
 * Returns standard ReadableStream from connect(), compatible with any Web Standard
 * framework (Hono, Express + node:stream, Cloudflare Workers, Deno, etc.).
 *
 * @example
 * ```typescript
 * const sse = new SSEServer();
 *
 * // GET /events/:clientId
 * app.get('/events/:clientId', (c) => {
 *   const stream = sse.connect(
 *     c.req.param('clientId'),
 *     c.req.header('Last-Event-ID')
 *   );
 *   return new Response(stream, {
 *     headers: {
 *       'Content-Type': 'text/event-stream',
 *       'Cache-Control': 'no-cache',
 *       'Connection': 'keep-alive',
 *       'X-Accel-Buffering': 'no',
 *     },
 *   });
 * });
 *
 * // POST /subscriptions/:clientId
 * app.post('/subscriptions/:clientId', async (c) => {
 *   const { docIds } = await c.req.json();
 *   const ctx = { clientId: c.req.param('clientId'), ...authData };
 *   const subscribed = await sse.subscribe(c.req.param('clientId'), docIds, ctx);
 *   return c.json({ docIds: subscribed });
 * });
 * ```
 */
export class SSEServer {
  private clients = new Map<string, ClientState>();
  private heartbeatInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private bufferTTLMs: number;
  private bufferWindowMs: number;
  private auth?: AuthorizationProvider;

  constructor(options?: SSEServerOptions) {
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
    this.bufferTTLMs = options?.bufferTTLMs ?? 300_000;
    this.bufferWindowMs = options?.bufferWindowMs ?? this.bufferTTLMs;
    this.auth = options?.auth;
    this._startHeartbeat();
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private static noop() {}

  /**
   * Opens an SSE connection for a client. Returns a ReadableStream that the
   * framework pipes to the HTTP response.
   *
   * If `lastEventId` is provided (from the Last-Event-ID header on reconnect),
   * buffered events are replayed. If the buffer has expired, a `resync` event
   * is sent so the client knows to do a full re-sync.
   *
   * The framework MUST call `disconnect(clientId)` when the response closes.
   */
  connect(clientId: string, lastEventId?: string): ReadableStream<Uint8Array> {
    let client = this.clients.get(clientId);

    if (client) {
      // Reconnecting — clean up previous connection
      if (client.expiryTimer) {
        globalThis.clearTimeout(client.expiryTimer);
        client.expiryTimer = null;
      }
      if (client.writer) {
        client.writer.close().catch(SSEServer.noop);
        client.writer = null;
      }
      client.disconnectedAt = null;
    } else {
      // New client
      client = {
        writer: null,
        encoder: new TextEncoder(),
        subscriptions: new Set(),
        buffer: [],
        nextEventId: 1,
        disconnectedAt: null,
        expiryTimer: null,
      };
      this.clients.set(clientId, client);
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    client.writer = writable.getWriter();

    // Replay buffered events or send resync
    if (lastEventId) {
      const lastId = parseInt(lastEventId, 10);
      if (isNaN(lastId)) {
        // Invalid ID — force resync
        this._writeEvent(client, { id: client.nextEventId++, event: 'resync', data: '{}', timestamp: Date.now() });
        client.buffer = [];
      } else {
        // Trim confirmed events — the client has acknowledged receipt up to lastId
        const knownClient = client.nextEventId > 1;
        client.buffer = client.buffer.filter(e => e.id > lastId);

        if (!knownClient && lastId > 0) {
          // Client claims a lastEventId but we have no history — buffer expired or server restarted
          this._writeEvent(client, { id: client.nextEventId++, event: 'resync', data: '{}', timestamp: Date.now() });
        } else {
          // Replay remaining buffered events (these are unconfirmed)
          for (const event of client.buffer) {
            this._writeEvent(client, event);
          }
        }
      }
    }

    return readable;
  }

  /**
   * Called when the SSE response stream closes. The framework MUST call this
   * when the HTTP response ends (e.g., on the response 'close' event).
   *
   * Starts the buffer expiry timer. If the client reconnects before it expires,
   * buffered events are replayed.
   */
  disconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.writer = null;
    client.disconnectedAt = Date.now();

    // Start buffer expiry timer
    client.expiryTimer = globalThis.setTimeout(() => {
      this._cleanupClient(clientId);
    }, this.bufferTTLMs);
  }

  /**
   * Subscribe a client to documents.
   *
   * @param clientId - The client to subscribe.
   * @param docIds - Document IDs to subscribe to.
   * @param ctx - Auth context for authorization checks.
   * @returns The list of document IDs successfully subscribed.
   */
  async subscribe(clientId: string, docIds: string[], ctx?: AuthContext): Promise<string[]> {
    const client = this.clients.get(clientId);
    if (!client) return [];

    const allowed: string[] = [];
    for (const docId of docIds) {
      if (this.auth) {
        try {
          const ok = await this.auth.canAccess(ctx, docId, 'read', 'subscribe');
          if (!ok) continue;
        } catch {
          continue;
        }
      }
      allowed.push(docId);
      client.subscriptions.add(docId);
    }
    return allowed;
  }

  /**
   * Unsubscribe a client from documents.
   */
  unsubscribe(clientId: string, docIds: string[]): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    for (const docId of docIds) {
      client.subscriptions.delete(docId);
    }
  }

  /**
   * Send a notification event to all clients subscribed to the document.
   *
   * Connected clients receive the event immediately via their SSE stream.
   * Disconnected clients (within buffer TTL) get the event buffered for replay.
   *
   * @param event - The SSE event type (e.g. 'changesCommitted', 'docDeleted').
   * @param params - Event data. Must include `docId` for subscription routing.
   * @param exceptClientId - Client ID to exclude (typically the one who made the change).
   */
  notify(event: string, params: { docId: string; [k: string]: any }, exceptClientId?: string): void {
    const { docId } = params;
    const data = JSON.stringify(params);

    for (const [clientId, client] of this.clients) {
      if (clientId === exceptClientId) continue;
      if (!client.subscriptions.has(docId)) continue;

      const now = Date.now();
      const buffered: BufferedEvent = {
        id: client.nextEventId++,
        event,
        data,
        timestamp: now,
      };

      // Always buffer — covers the gap between network death and heartbeat detection.
      // Trim events older than the buffer window to prevent unbounded growth.
      client.buffer.push(buffered);
      this._trimBuffer(client, now);

      if (client.writer) {
        this._writeEvent(client, buffered);
      }
    }
  }

  /**
   * List all client IDs subscribed to a document.
   */
  listSubscriptions(docId: string): string[] {
    const result: string[] = [];
    for (const [clientId, client] of this.clients) {
      if (client.subscriptions.has(docId)) {
        result.push(clientId);
      }
    }
    return result;
  }

  /**
   * Get all active (connected) client IDs.
   */
  getConnectionIds(): string[] {
    const result: string[] = [];
    for (const [clientId, client] of this.clients) {
      if (client.writer) {
        result.push(clientId);
      }
    }
    return result;
  }

  /**
   * Clean up all resources (heartbeat interval, client buffers, timers).
   */
  destroy(): void {
    if (this.heartbeatInterval) {
      globalThis.clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [, client] of this.clients) {
      if (client.expiryTimer) {
        globalThis.clearTimeout(client.expiryTimer);
      }
      if (client.writer) {
        client.writer.close().catch(SSEServer.noop);
      }
    }
    this.clients.clear();
  }

  // --- Private Helpers ---

  /**
   * Trim buffer to keep only events within the sliding window (while connected)
   * or all events (while disconnected — those are managed by the TTL timer).
   */
  private _trimBuffer(client: ClientState, now: number): void {
    if (client.disconnectedAt !== null) return; // Disconnected — keep everything for replay
    const cutoff = now - this.bufferWindowMs;
    const idx = client.buffer.findIndex(e => e.timestamp >= cutoff);
    if (idx > 0) {
      client.buffer = client.buffer.slice(idx);
    } else if (idx === -1) {
      // All events are older than the window
      client.buffer = [];
    }
  }

  private _writeEvent(client: ClientState, event: BufferedEvent): void {
    if (!client.writer) return;
    const msg = `id: ${event.id}\nevent: ${event.event}\ndata: ${event.data}\n\n`;
    client.writer.write(client.encoder.encode(msg)).catch(() => {
      // Write failed — connection is dead, will be cleaned up via disconnect()
    });
  }

  private _startHeartbeat(): void {
    this.heartbeatInterval = globalThis.setInterval(() => {
      const heartbeat = ': heartbeat\n\n';
      for (const client of this.clients.values()) {
        if (client.writer) {
          client.writer.write(client.encoder.encode(heartbeat)).catch(() => {
            // Write failed — connection dead
          });
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private _cleanupClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (client.expiryTimer) {
      globalThis.clearTimeout(client.expiryTimer);
    }
    if (client.writer) {
      client.writer.close().catch(SSEServer.noop);
    }
    this.clients.delete(clientId);
  }
}
