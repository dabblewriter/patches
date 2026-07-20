/**
 * An event stored for replay after reconnect. Ids are opaque strings assigned
 * by the store — the server never parses or compares them.
 */
export interface SSEStoredEvent {
  id: string;
  event: string;
  data: string;
}

/**
 * Result of a replay request.
 *
 * - `events`: a verified-complete continuation after `lastEventId` (possibly
 *   empty — the client is up to date).
 * - `resync`: continuity cannot be verified — the client must do a full sync.
 *   `id`, when set, is a store-assigned re-anchor: it is written on the resync
 *   frame so the client's Last-Event-ID cursor moves into the store's CURRENT
 *   id space. Without it a browser EventSource keeps its stale cursor forever
 *   (per spec an id-less frame leaves the cursor unchanged), and every later
 *   reconnect must resync — or worse, a stale cursor could ambiguously match
 *   ids from a new epoch. A store that returns a re-anchor id MUST treat it as
 *   a valid cursor: a later `replay(clientId, id)` must verify the events
 *   appended after it.
 *
 * How strong "verified" is depends on the store: {@link InMemorySSEEventStore}
 * deliberately reproduces the original single-instance buffering behavior and
 * can return a window-trimmed continuation with no gap detection. Consumers
 * whose clients TRUST an `events` result as gap-free must supply a verifying
 * store (e.g. a Redis stream store that resyncs when the cursor predates the
 * oldest retained entry).
 */
export type SSEReplayResult = { type: 'events'; events: SSEStoredEvent[] } | { type: 'resync'; id?: string | null };

/**
 * Pluggable event persistence for {@link SSEServer}. The store owns event ids,
 * the replay buffer, and the continuity decision on reconnect; the server owns
 * connections, fan-out, and timers.
 */
export interface SSEEventStore {
  /**
   * Store an event for the client and return its assigned id — the same id is
   * written on the SSE wire frame. Return null when the event could not be
   * stored (degraded): the frame is then delivered WITHOUT an id so the
   * client's cursor never advances past unstored events.
   */
  append(clientId: string, event: string, data: string): Promise<string | null>;

  /**
   * Return the verified continuation strictly after `lastEventId`, or
   * `resync` when continuity cannot be proven (no history for the client,
   * or retained events may have been trimmed past the cursor).
   */
  replay(clientId: string, lastEventId: string): Promise<SSEReplayResult>;

  /**
   * Return the client's current resume cursor — the id a fresh connection should
   * anchor to so a later reconnect (or a cross-tab successor) resumes from here
   * instead of full-syncing, even when the client never received an event. The
   * store MUST return an id its own {@link replay} accepts as an up-to-date cursor
   * (an empty continuation), minting a durable marker when none exists yet. Return
   * null when no cursor can be provided (degraded): the server then sends the
   * `connected` frame without an id and the client cold-syncs, exactly as before.
   *
   * Optional — a store that omits it disables the connect-time anchor, so clients
   * only ever obtain a cursor from a real delivered event.
   */
  currentId?(clientId: string): Promise<string | null>;

  /**
   * Record subscriptions so a later instance can rehydrate fan-out routing.
   *
   * Contract for add/remove (the server serializes them per client, so they
   * arrive in issue order): implementations must apply them in arrival order
   * and idempotently, and once the returned promise resolves the mutation must
   * be visible to a subsequent {@link loadSubscriptions} from ANY instance —
   * the server awaits the promise before acknowledging a subscribe/unsubscribe
   * so a reconnect elsewhere can't rehydrate a set the client was told no
   * longer holds.
   */
  addSubscriptions(clientId: string, docIds: string[]): Promise<void>;

  /** Remove recorded subscriptions. Same ordering/visibility contract as {@link addSubscriptions}. */
  removeSubscriptions(clientId: string, docIds: string[]): Promise<void>;

  /**
   * Load the client's recorded subscriptions (empty for unknown clients).
   * Also treated as a liveness touch: the server calls this on every connect,
   * so a TTL-based store should refresh the subscriptions' lifetime here.
   */
  loadSubscriptions(clientId: string): Promise<string[]>;

  /**
   * Discard all stored state for the client — events, cursor, subscriptions.
   * Called when the server's disconnect buffer expires for the client on ONE
   * instance; a shared multi-instance store may treat this as advisory and
   * rely on key TTLs instead, since the client can be live on another
   * instance the caller cannot see.
   */
  dropClient(clientId: string): Promise<void>;
}

/**
 * Options for the default in-memory event store.
 */
export interface InMemorySSEEventStoreOptions {
  /** Sliding window for buffered events, in milliseconds. Default: 300000 (5 minutes). */
  bufferWindowMs?: number;
  /**
   * When provided, buffers are only window-trimmed while the client is
   * connected — a disconnected client's buffer is kept intact for replay until
   * dropClient(). Without it, every append trims.
   */
  isClientConnected?: (clientId: string) => boolean;
}

interface StoredClient {
  nextEventId: number;
  events: { id: number; event: string; data: string; timestamp: number }[];
  subscriptions: Set<string>;
}

/**
 * Default single-instance store: numeric-string ids from a per-client counter
 * and a time-window-trimmed buffer, matching SSEServer's original inline
 * buffering behavior exactly.
 *
 * That parity includes its one known gap: replay only checks that the client
 * has assigned ids at all, so events trimmed out of the window while the
 * client was silently dead are skipped WITHOUT a resync. Today's consumers
 * full-sync on reconnect regardless, so nothing is lost — but a client that
 * trusts replay as a verified continuation must not be paired with this store.
 */
export class InMemorySSEEventStore implements SSEEventStore {
  private clients = new Map<string, StoredClient>();
  private bufferWindowMs: number;
  private isClientConnected?: (clientId: string) => boolean;

  constructor(options?: InMemorySSEEventStoreOptions) {
    this.bufferWindowMs = options?.bufferWindowMs ?? 300_000;
    this.isClientConnected = options?.isClientConnected;
  }

  async append(clientId: string, event: string, data: string): Promise<string | null> {
    const client = this._ensure(clientId);
    const id = client.nextEventId++;
    const now = Date.now();
    client.events.push({ id, event, data, timestamp: now });
    if (this.isClientConnected?.(clientId) ?? true) {
      this._trim(client, now);
    }
    return String(id);
  }

  async replay(clientId: string, lastEventId: string): Promise<SSEReplayResult> {
    const client = this.clients.get(clientId);
    const lastId = parseInt(lastEventId, 10);
    // A cursor this store never assigned cannot verify: unparsable, non-zero
    // while the client has no ids yet (buffer expired or server restarted), or
    // at/past the counter (a pre-restart epoch — the entry was recreated after
    // the restart, so small old-epoch cursors would ambiguously match new
    // ids). Resync, and re-anchor the client's cursor with a fresh id so the
    // next reconnect verifies against the current epoch. The full sync the
    // resync triggers covers everything up to the anchor, so buffered events
    // are cleared rather than replayed.
    const known = (client?.nextEventId ?? 1) > 1;
    if (isNaN(lastId) || (!known && lastId > 0) || (client && lastId >= client.nextEventId)) {
      const anchored = this._ensure(clientId);
      anchored.events = [];
      return { type: 'resync', id: String(anchored.nextEventId++) };
    }

    if (client) client.events = client.events.filter(e => e.id > lastId);
    const events = (client?.events ?? []).map(({ id, event, data }) => ({ id: String(id), event, data }));
    return { type: 'events', events };
  }

  async currentId(clientId: string): Promise<string | null> {
    // The last id this client was assigned, or "0" (one below the first real id,
    // 1) when it has none — replay() accepts either as a verified-current cursor.
    return String((this.clients.get(clientId)?.nextEventId ?? 1) - 1);
  }

  async addSubscriptions(clientId: string, docIds: string[]): Promise<void> {
    const client = this._ensure(clientId);
    for (const docId of docIds) {
      client.subscriptions.add(docId);
    }
  }

  async removeSubscriptions(clientId: string, docIds: string[]): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    for (const docId of docIds) {
      client.subscriptions.delete(docId);
    }
  }

  async loadSubscriptions(clientId: string): Promise<string[]> {
    return [...(this.clients.get(clientId)?.subscriptions ?? [])];
  }

  async dropClient(clientId: string): Promise<void> {
    this.clients.delete(clientId);
  }

  private _ensure(clientId: string): StoredClient {
    let client = this.clients.get(clientId);
    if (!client) {
      client = { nextEventId: 1, events: [], subscriptions: new Set() };
      this.clients.set(clientId, client);
    }
    return client;
  }

  private _trim(client: StoredClient, now: number): void {
    const cutoff = now - this.bufferWindowMs;
    const idx = client.events.findIndex(e => e.timestamp >= cutoff);
    if (idx > 0) {
      client.events = client.events.slice(idx);
    } else if (idx === -1) {
      client.events = [];
    }
  }
}
