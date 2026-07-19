import type { AuthContext, AuthorizationProvider } from '../websocket/AuthorizationProvider.js';
import { InMemorySSEEventStore, type SSEEventStore, type SSEReplayResult } from './SSEEventStore.js';

/**
 * Per-client connection state tracked by the SSEServer. Event buffering and
 * ids live in the {@link SSEEventStore}; this holds only what fan-out needs.
 */
interface ClientState {
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  encoder: TextEncoder;
  /** Local routing set — authoritative for which events this instance delivers. */
  subscriptions: Set<string>;
  /**
   * Non-null while connect()'s hydration task is pending: collects docIds
   * unsubscribed before the (possibly stale) store snapshot is applied, so the
   * apply can't resurrect them. Also tells notify() the routing set may still
   * grow, so routing must be decided inside the pipeline, not at notify time.
   */
  hydrating: Set<string> | null;
  /** Serializes this client's append→write pipeline and connect replay. */
  pipeline: Promise<void>;
  /**
   * Serializes this client's store subscription mutations so add/remove land
   * in issue order (see the {@link SSEEventStore.addSubscriptions} contract).
   */
  subOps: Promise<void>;
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
   * Used by the default in-memory event store; ignored when `eventStore` is
   * provided. Default: bufferTTLMs (matches the disconnect buffer lifetime).
   */
  bufferWindowMs?: number;
  /** Authorization provider for subscription access control. */
  auth?: AuthorizationProvider;
  /**
   * Event persistence backing replay across reconnects (and, for shared
   * stores, across instances). Default: an in-memory store reproducing the
   * original single-instance buffering behavior.
   */
  eventStore?: SSEEventStore;
  /**
   * Milliseconds to wait on an event store call before degrading it (append →
   * id-less frame, replay → resync, hydration → empty set). Store calls ride
   * each client's serialized pipeline, so a call that never settles (e.g. a
   * Redis client that queues commands across a reconnect indefinitely) would
   * otherwise wedge that client's event delivery permanently — and invisibly,
   * since heartbeats bypass the pipeline. Default: 10000.
   */
  storeTimeoutMs?: number;
}

/**
 * Framework-agnostic SSE server for the Patches real-time collaboration service.
 *
 * Manages SSE connections, document subscriptions, per-client event buffering
 * (via a pluggable {@link SSEEventStore}), and heartbeats. Does NOT create HTTP
 * routes — the framework calls these methods from its route handlers.
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
  /**
   * Pending close callbacks for streams force-closed while their ClientState
   * was being discarded (releaseClient / buffer-TTL cleanup). The per-state
   * staleCloses counter dies with the state, so without this a lagging
   * framework close for a released stream would mark a fresh reconnection
   * (new state, staleCloses 0) as disconnected.
   */
  private orphanedCloses = new Map<string, number>();
  private heartbeatInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private bufferTTLMs: number;
  private storeTimeoutMs: number;
  private auth?: AuthorizationProvider;
  private eventStore: SSEEventStore;

  constructor(options?: SSEServerOptions) {
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
    this.bufferTTLMs = options?.bufferTTLMs ?? 300_000;
    this.storeTimeoutMs = options?.storeTimeoutMs ?? 10_000;
    this.auth = options?.auth;
    this.eventStore =
      options?.eventStore ??
      new InMemorySSEEventStore({
        bufferWindowMs: options?.bufferWindowMs ?? this.bufferTTLMs,
        isClientConnected: clientId => !!this.clients.get(clientId)?.writer,
      });
    this._startHeartbeat();
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private static noop() {}

  /**
   * Opens an SSE connection for a client. Returns a ReadableStream that the
   * framework pipes to the HTTP response.
   *
   * If `lastEventId` is provided (from the Last-Event-ID header on reconnect),
   * the event store decides continuity: a verified continuation is replayed,
   * otherwise a `resync` event tells the client to do a full re-sync (carrying
   * a store-assigned re-anchor id when the store provides one).
   *
   * The framework MUST call `disconnect(clientId)` when the response closes.
   */
  connect(clientId: string, lastEventId?: string): ReadableStream<Uint8Array> {
    let existing = this.clients.get(clientId);
    const isNew = !existing;

    if (existing) {
      // Reconnecting — clean up previous connection
      if (existing.expiryTimer) {
        globalThis.clearTimeout(existing.expiryTimer);
        existing.expiryTimer = null;
      }
      if (existing.writer) {
        existing.writer.close().catch(SSEServer.noop);
        existing.writer = null;
        existing.staleCloses++;
      }
    } else {
      existing = {
        writer: null,
        encoder: new TextEncoder(),
        subscriptions: new Set(),
        hydrating: null,
        pipeline: Promise.resolve(),
        subOps: Promise.resolve(),
        expiryTimer: null,
        staleCloses: 0,
      };
      this.clients.set(clientId, existing);
    }
    const client = existing;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    client.writer = writer;

    // Set browser reconnect interval and flush response headers (some servers buffer until first body byte).
    writer.write(client.encoder.encode('retry: 5000\n\n')).catch(SSEServer.noop);

    if (isNew) {
      // No local state (e.g. the client's stream moved to this instance) —
      // hydrate the routing set from the store before replay so post-replay
      // events fan out. Unsubscribes racing the load are collected in
      // `hydrating` and excluded when the (stale) snapshot is applied.
      // Rehydration deliberately does NOT re-run the AuthorizationProvider:
      // only authorized subscribe() calls ever reach the store, and the
      // store's retention TTL bounds how long that grant can outlive a
      // revocation (matching base behavior, where revocation never stopped an
      // already-live feed).
      client.hydrating = new Set();
      const subscriptions = this._guardStoreCall(this.eventStore.loadSubscriptions(clientId), []);
      this._enqueue(client, async () => {
        const stored = await subscriptions;
        const removed = client.hydrating ?? new Set<string>();
        client.hydrating = null;
        for (const docId of stored) {
          if (!removed.has(docId)) client.subscriptions.add(docId);
        }
      });
    } else {
      // Reconnect onto existing local state: re-read the stored subscriptions
      // purely to refresh their lifetime in the store — a client whose
      // reconnects only ever land on instances that already hold its state
      // would otherwise never touch the store and its recorded subscriptions
      // could expire mid-session, silently emptying a later cross-instance
      // hydration. The result is deliberately unapplied: the local set is
      // authoritative.
      this.eventStore.loadSubscriptions(clientId).catch(SSEServer.noop);
    }

    if (lastEventId) {
      this._enqueue(client, async () => {
        // The read is ISSUED inside the pipeline task: it lands after every
        // append already queued (whose events the replay must cover — a read
        // issued at connect time could execute before an in-flight append
        // lands, permanently skipping an event that was committed to the
        // store but dropped from the replaced wire) and before anything
        // enqueued later (whose appends must not be double-delivered).
        const result = await this._guardStoreCall<SSEReplayResult>(this.eventStore.replay(clientId, lastEventId), {
          type: 'resync',
        });
        if (client.writer !== writer) return; // Replaced while awaiting
        if (result.type === 'resync') {
          // A store-assigned re-anchor id moves the client's cursor into the
          // store's current id space (see SSEReplayResult).
          this._writeFrame(writer, client.encoder, result.id ?? null, 'resync', '{}');
        } else {
          for (const event of result.events) {
            this._writeFrame(writer, client.encoder, event.id, event.event, event.data);
          }
        }
      });
    }

    return readable;
  }

  /**
   * Called when the SSE response stream closes. The framework MUST call this
   * when the HTTP response ends (e.g., on the response 'close' event).
   *
   * Starts the buffer expiry timer. If the client reconnects before it expires,
   * stored events are replayed.
   */
  disconnect(clientId: string): void {
    // A close reported for a stream that was force-closed while its state was
    // being discarded (releaseClient / TTL cleanup) — any state found now
    // belongs to a NEWER connection and must not absorb this close.
    const orphaned = this.orphanedCloses.get(clientId);
    if (orphaned !== undefined) {
      if (orphaned <= 1) this.orphanedCloses.delete(clientId);
      else this.orphanedCloses.set(clientId, orphaned - 1);
      return;
    }

    const client = this.clients.get(clientId);
    if (!client) return;

    // A close reported for a connection that connect() already replaced —
    // the current connection is alive, so ignore it.
    if (client.staleCloses > 0) {
      client.staleCloses--;
      return;
    }

    client.writer = null;

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
   * Resolves once the store mirror has settled (see {@link _mirrorSubs}).
   *
   * @returns The registered docIds, or null when the client is unknown on this
   *   instance — distinguishable from success so the caller can surface the
   *   failure (and the client can reconnect/retry) instead of the subscription
   *   being silently dropped.
   */
  async addSubscriptions(clientId: string, docIds: string[]): Promise<string[] | null> {
    const client = this.clients.get(clientId);
    if (!client) return null;
    for (const docId of docIds) {
      client.subscriptions.add(docId);
    }
    await this._mirrorSubs(client, () => this.eventStore.addSubscriptions(clientId, docIds));
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
      await this._mirrorSubs(client, () => this.eventStore.addSubscriptions(clientId, docIds));
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
    if (allowed.length) {
      await this._mirrorSubs(client, () => this.eventStore.addSubscriptions(clientId, allowed));
    }
    return allowed;
  }

  /**
   * Unsubscribe a client from documents.
   *
   * Resolves once the store mirror has settled — callers answering an HTTP
   * unsubscribe should await it, so a reconnect landing on a cold instance
   * after the response can't rehydrate a subscription the client was told is
   * gone.
   */
  unsubscribe(clientId: string, docIds: string[]): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return Promise.resolve();
    for (const docId of docIds) {
      client.subscriptions.delete(docId);
      // A pending hydration snapshot may still contain this docId — record the
      // removal so the apply can't resurrect it.
      client.hydrating?.add(docId);
    }
    return this._mirrorSubs(client, () => this.eventStore.removeSubscriptions(clientId, docIds));
  }

  /**
   * Send a notification event to all clients subscribed to the document.
   *
   * Connected clients receive the event via their SSE stream. Every event is
   * also appended to the event store (connected or not) so it can be replayed
   * after a reconnect. The store-assigned id is written on the wire frame; if
   * the store cannot persist the event, the frame is delivered without an id
   * so the client's cursor never advances past unstored events.
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
      // Routing is decided inside the pipeline task (behind any pending
      // hydration) so an event arriving while connect() is still filling the
      // routing set is neither dropped nor left out of the store. Clients that
      // are neither subscribed nor hydrating are skipped without a task.
      if (!client.subscriptions.has(docId) && !client.hydrating) continue;

      // The writer is captured at ENQUEUE time: a task that ends up running
      // after a reconnect must not write to the replacement stream, because
      // the reconnect's replay task is queued behind this append and would
      // deliver the same event again — the mismatch guard below drops the
      // direct write and lets the replay deliver it exactly once.
      const writer = client.writer;
      this._enqueue(client, async () => {
        // State replaced or discarded (releaseClient / TTL cleanup / destroy)
        // while queued — a released ghost must not keep appending to a shared
        // store for a client that is live on another instance.
        if (this.clients.get(clientId) !== client) return;
        if (!client.subscriptions.has(docId)) return;
        // Appends run inside the pipeline so each client's store order matches
        // its wire order — the replay cursor is the LAST id on the wire, so an
        // id appended out of order could leapfrog an undelivered event.
        const eventId = await this._guardStoreCall(this.eventStore.append(clientId, event, data), null);
        if (!writer || client.writer !== writer) return; // Disconnected at enqueue time, or replaced since
        this._writeFrame(writer, client.encoder, eventId, event, data);
      });
    }
  }

  /**
   * Send an event directly to a single connected client, bypassing subscription
   * routing. Used for client-targeted traffic like WebRTC signaling.
   *
   * Unlike {@link notify}, this is never stored and the frame carries no id
   * (ids belong to stored events — a fabricated id would corrupt the client's
   * replay cursor): if the client is currently disconnected, the call returns
   * false and the event is dropped. Stale signaling replayed after a buffer
   * expiry is harmful (peers gone, ICE candidates moot), so we deliberately do
   * not preserve it.
   *
   * @param clientId - Target client.
   * @param event - SSE event type (e.g. `'signal'`).
   * @param data - Pre-serialised event payload.
   * @returns true if the client was connected and the event was written.
   */
  sendToClient(clientId: string, event: string, data: string): boolean {
    const client = this.clients.get(clientId);
    if (!client?.writer) return false;

    // Written synchronously, NOT via the pipeline: these frames never touch
    // the store, so queueing them would couple signaling latency to store
    // latency and make the `true` return a promise the queued task might not
    // keep (a stream replaced before the task runs would silently drop a
    // frame that is never stored or replayed).
    this._writeFrame(client.writer, client.encoder, null, event, data);
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
   * Drop this instance's local state for a client whose live stream has been
   * claimed by ANOTHER instance (a multi-instance routing signal — e.g. pup
   * broadcasts a claim when a stream connects). Cancels the expiry timer and
   * closes any lingering local writer WITHOUT touching the event store: the
   * client is live elsewhere and its stored events and subscriptions must
   * survive for that stream to use. Without this, the abandoned instance's
   * retained ClientState keeps appending every relayed event to a shared store
   * (duplicates) until its buffer TTL fires — and that TTL cleanup would drop
   * the live client's store state.
   */
  releaseClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (client.expiryTimer) {
      globalThis.clearTimeout(client.expiryTimer);
    }
    this._retireClient(clientId, client);
  }

  /**
   * Clean up local resources (heartbeat interval, connections, timers). Does
   * NOT drop event store state — with a shared store, clients reconnect to
   * another instance and replay from where they left off.
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
    this.orphanedCloses.clear();
  }

  // --- Private Helpers ---

  private _enqueue(client: ClientState, task: () => Promise<void>): void {
    client.pipeline = client.pipeline.then(task).catch(SSEServer.noop);
  }

  /**
   * Bound a store call by `storeTimeoutMs`, resolving with `fallback` on
   * timeout or rejection. Store calls run inside per-client serialized chains;
   * a call that never settles would otherwise wedge the chain permanently
   * (and invisibly — heartbeats bypass the pipeline, so the stream still
   * looks healthy) with no recovery, since reconnects reuse the same chain.
   */
  private _guardStoreCall<T>(call: Promise<T>, fallback: T): Promise<T> {
    return new Promise<T>(resolve => {
      const timer = globalThis.setTimeout(() => resolve(fallback), this.storeTimeoutMs);
      call.then(
        value => {
          globalThis.clearTimeout(timer);
          resolve(value);
        },
        () => {
          globalThis.clearTimeout(timer);
          resolve(fallback);
        }
      );
    });
  }

  /**
   * Mirror a subscription mutation to the store on the client's serialized
   * subOps chain, so adds and removes land in issue order (the store contract
   * requires in-order application). Resolves when the mutation has settled —
   * or timed out — never rejects: the local routing set is authoritative and
   * a failed mirror only degrades cross-instance rehydration.
   */
  private _mirrorSubs(client: ClientState, op: () => Promise<void>): Promise<void> {
    client.subOps = client.subOps.then(() => this._guardStoreCall(op(), undefined)).catch(SSEServer.noop);
    return client.subOps;
  }

  private _writeFrame(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    encoder: TextEncoder,
    id: string | null,
    event: string,
    data: string
  ): void {
    const frame = `${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${data}\n\n`;
    writer.write(encoder.encode(frame)).catch(() => {
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
    this._retireClient(clientId, client);
    // Advisory for shared stores: this instance only knows the client hasn't
    // reconnected HERE — a shared store may no-op and rely on key TTLs
    // instead, since the client can be live on another instance.
    this.eventStore.dropClient(clientId).catch(SSEServer.noop);
  }

  /**
   * Discard a client's state, transferring any close callbacks the framework
   * still owes us (a force-closed live writer, plus closes already pending in
   * staleCloses) into {@link orphanedCloses} so they can't be misattributed to
   * a later reconnection's stream.
   */
  private _retireClient(clientId: string, client: ClientState): void {
    let pending = client.staleCloses;
    if (client.writer) {
      client.writer.close().catch(SSEServer.noop);
      pending++;
    }
    if (pending > 0) {
      this.orphanedCloses.set(clientId, (this.orphanedCloses.get(clientId) ?? 0) + pending);
    }
    this.clients.delete(clientId);
  }
}
