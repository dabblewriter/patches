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
  /**
   * Number of old connections force-closed by a reconnect whose close the
   * framework hasn't reported yet. disconnect() swallows that many calls so a
   * lagging close of a replaced stream doesn't mark the fresh one disconnected.
   */
  staleCloses: number;
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
 *   const clientId = c.req.param('clientId');
 *   if (!sse.hasClient(clientId)) {
 *     // Multi-instance: forward to the stream-owning instance, or when no
 *     // instance owns it answer 409 { data: { code: 'UNKNOWN_CLIENT' } }.
 *     // This gate MUST run before any `denied` accounting is derived — see
 *     // "Multi-instance deployments" in docs/sse-rest.md.
 *   }
 *   const { docIds } = await c.req.json();
 *   const ctx = { clientId, ...authData };
 *   const subscribed = await sse.subscribe(clientId, docIds, ctx);
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
        client.staleCloses++;
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
        staleCloses: 0,
      };
      this.clients.set(clientId, client);
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    client.writer = writable.getWriter();

    // Set browser reconnect interval and flush response headers (some servers buffer until first body byte).
    client.writer.write(client.encoder.encode('retry: 5000\n\n'));

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

    // A close reported for a connection that connect() already replaced —
    // the current connection is alive, so ignore it.
    if (client.staleCloses > 0) {
      client.staleCloses--;
      return;
    }

    client.writer = null;
    client.disconnectedAt = Date.now();

    // Start buffer expiry timer
    client.expiryTimer = globalThis.setTimeout(() => {
      this._cleanupClient(clientId);
    }, this.bufferTTLMs);
  }

  /**
   * Whether this server instance currently holds state for the client — a live
   * SSE stream, or a disconnected client still within its buffer TTL.
   *
   * In a multi-instance deployment each SSEServer only knows its own clients:
   * a subscribe request load-balanced to a different instance than the one
   * holding the client's stream would silently register nothing (see
   * {@link subscribe}). Callers routing between instances should use this to
   * decide whether to handle a subscribe locally or forward it to the
   * stream-owning instance ({@link addSubscriptions}).
   *
   * Treat `true` as "may hold state", NOT "owns the live stream": a
   * disconnected client stays claimable for up to `bufferTTLMs` (default 5
   * minutes), and a reconnect routinely lands on a different instance — so for
   * that window two instances can both truthfully answer `true` for the same
   * client. A router that picks the stale claimant registers subscriptions on
   * an instance the client will never return to (events buffer there
   * silently). When more than one instance claims a client, prefer the one
   * with the live stream (`getConnectionIds()` lists connected clients only).
   */
  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  /**
   * Register subscriptions for a client WITHOUT authorization checks.
   *
   * For trusted server-to-server use only — e.g. a multi-instance deployment
   * forwarding an already-authorized subscribe from the instance that handled
   * the HTTP request to the instance that owns the client's event stream.
   * Never call this with client-supplied docIds that haven't passed
   * authorization.
   *
   * @returns The registered docIds, or null when the client is unknown on this
   *   instance — distinguishable from success so the caller can surface the
   *   failure (and the client can reconnect/retry) instead of the subscription
   *   being silently dropped.
   */
  addSubscriptions(clientId: string, docIds: string[]): string[] | null {
    const client = this.clients.get(clientId);
    if (!client) return null;
    for (const docId of docIds) {
      client.subscriptions.add(docId);
    }
    return [...docIds];
  }

  /**
   * Subscribe a client to documents.
   *
   * @param clientId - The client to subscribe.
   * @param docIds - Document IDs to subscribe to.
   * @param ctx - Auth context for authorization checks.
   * @returns The list of document IDs successfully subscribed. NOTE: an
   *   unknown clientId (no stream state on this instance) also returns [] —
   *   indistinguishable from every docId being denied. Callers that need to
   *   tell the two apart (e.g. to route a misdirected subscribe to the right
   *   instance) should check {@link hasClient} first.
   */
  async subscribe(clientId: string, docIds: string[], ctx?: AuthContext): Promise<string[]> {
    const client = this.clients.get(clientId);
    if (!client) return [];

    if (!this.auth) {
      for (const docId of docIds) {
        client.subscriptions.add(docId);
      }
      return [...docIds];
    }

    const checks = await Promise.allSettled(
      docIds.map(async docId => {
        const ok = await this.auth!.canAccess(ctx, docId, 'read', 'subscribe');
        if (!ok) throw new Error('access denied');
        return docId;
      })
    );

    const allowed: string[] = [];
    for (const result of checks) {
      if (result.status === 'fulfilled') {
        allowed.push(result.value);
        client.subscriptions.add(result.value);
      }
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
   * @param docId - The document ID used for subscription routing. This may differ
   *   from `params.docId` — for example, when subscriptions are stored by root
   *   document path (e.g. `users/abc`) but the event payload contains a sub-path
   *   (e.g. `users/abc/settings`).
   * @param event - The SSE event type (e.g. 'changesCommitted', 'docDeleted').
   * @param params - Event data sent to clients.
   * @param exceptClientId - Client ID to exclude (typically the one who made the change).
   */
  notify(docId: string, event: string, params: Record<string, any>, exceptClientId?: string): void {
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
   * Send an event directly to a single connected client, bypassing subscription
   * routing. Used for client-targeted traffic like WebRTC signaling.
   *
   * Unlike {@link notify}, this does NOT buffer through expiry: if the client
   * is currently disconnected, the call returns false and the event is dropped.
   * Stale signaling replayed after a buffer expiry is harmful (peers gone, ICE
   * candidates moot), so we deliberately do not preserve it.
   *
   * @param clientId - Target client.
   * @param event - SSE event type (e.g. `'signal'`).
   * @param data - Pre-serialised event payload.
   * @returns true if the client was connected and the event was written.
   */
  sendToClient(clientId: string, event: string, data: string): boolean {
    const client = this.clients.get(clientId);
    if (!client || !client.writer) return false;

    this._writeEvent(client, {
      id: client.nextEventId++,
      event,
      data,
      timestamp: Date.now(),
    });

    return true;
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
      // Named event (not a `:` comment) so the EventSource client can observe it and
      // distinguish a healthy-but-idle stream from a half-open one. A comment is invisible
      // to EventSource handlers, which left clients unable to detect a silently dead stream.
      //
      // WIRE-FORMAT CHANGE — REQUIRES SERVER-FIRST DEPLOY ORDERING. Earlier releases
      // (<= 0.9.13) emitted `: heartbeat` (an SSE comment) here. A client running the
      // 75s liveness watchdog in PatchesREST only resets on *observable* frames, so an
      // idle doc served by an old comment-heartbeat server receives zero observable frames
      // and the watchdog tears the stream down to `error` (then reconnects) every ~75s.
      // Deploy this named-heartbeat server build BEFORE shipping any watchdog client
      // (e.g. bump and deploy pup's @dabble/patches first, then release the app).
      const heartbeat = 'event: heartbeat\ndata: \n\n';
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
