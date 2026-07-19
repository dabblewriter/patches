import { createId } from 'crypto-id';
import { signal, type Unsubscriber } from 'easy-signal';
import type {
  Branch,
  Change,
  ChangeInput,
  CommitChangesOptions,
  DeleteDocOptions,
  CreateBranchMetadata,
  EditableBranchMetadata,
  EditableVersionMetadata,
  ListVersionsOptions,
  PatchesSnapshot,
  PatchesState,
  VersionMetadata,
} from '../../types.js';
import { NetworkError, StatusError } from '../error.js';
import type { PatchesConnection } from '../PatchesConnection.js';
import type { ConnectionState } from '../protocol/types.js';
import { onlineState } from '../websocket/onlineState.js';
import { normalizeIds } from './utils.js';

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
/**
 * If no SSE frame (a committed-change/signal/resync event OR the server's periodic
 * `heartbeat` event) arrives within this window, the watchdog treats the stream as
 * half-open and forces a reconnect. A half-open EventSource can stay `connected`
 * forever without ever firing `onerror`, silently freezing the client.
 *
 * INVARIANT: this must be >= ~2x the server's `heartbeatIntervalMs` (SSEServer default
 * 30s) plus margin for jitter/proxies, so a single dropped/late heartbeat on a healthy
 * idle stream never false-fires the watchdog. The server interval is configurable and
 * lives in a different module (no shared constant); if it is ever raised above ~37s,
 * raise this in step.
 */
const LIVENESS_TIMEOUT_MS = 75_000;
/** How often the liveness watchdog checks for a stalled stream. */
const LIVENESS_CHECK_MS = 15_000;
/** Initial reconnect backoff after a fatal error / watchdog teardown. */
const INITIAL_RECONNECT_BACKOFF_MS = 1_000;
/** Cap on the exponential reconnect backoff. */
const MAX_RECONNECT_BACKOFF_MS = 30_000;
/** Max characters of a malformed SSE payload included in the surfaced error message. */
const MALFORMED_EVENT_SNIPPET_CHARS = 200;
/**
 * Total attempts for a subscribe whose response registered nothing. On a
 * multi-instance server without subscribe routing, a POST that lands on an
 * instance that doesn't own this client's event stream silently registers
 * nothing and returns an empty list — indistinguishable from every docId being
 * denied. Each retry re-rolls the load balancer, so a small budget recovers
 * most misdirected subscribes while an all-denied response stays cheap.
 */
const SUBSCRIBE_MAX_ATTEMPTS = 4;
/** Base delay between subscribe attempts; doubles each retry (500ms, 1s, 2s). */
const SUBSCRIBE_RETRY_BASE_DELAY_MS = 500;

/**
 * Options for creating a PatchesREST instance.
 */
export interface PatchesRESTOptions {
  /**
   * Explicit client ID. If not provided, a random id is generated per instance.
   * Sent as a `clientId` query parameter on mutating requests so the server can
   * exclude this client from SSE notifications about its own commits/deletes, so
   * it must be unique per live connection: two connected clients sharing an id
   * would each be excluded from the other's changes.
   */
  clientId?: string;

  /** Static headers added to every fetch request (e.g. Authorization). */
  headers?: Record<string, string>;

  /**
   * Dynamic header provider called before every fetch request. Useful for token refresh.
   * Merged on top of static headers (same-name keys override).
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
}

/**
 * Client for the Patches real-time collaboration service using SSE + REST.
 *
 * Uses Server-Sent Events for receiving other clients' changes and HTTP/fetch
 * for sending changes. Drop-in replacement for PatchesWebSocket when paired
 * with PatchesSync.
 */
export class PatchesREST implements PatchesConnection {
  /** The client ID used for SSE connection and subscription management. */
  readonly clientId: string;

  // --- Public Signals ---

  readonly onStateChange = signal<(state: ConnectionState) => void>();
  readonly onChangesCommitted = signal<(docId: string, changes: Change[], options?: CommitChangesOptions) => void>();
  readonly onDocDeleted = signal<(docId: string) => void>();
  /**
   * Emits raw JSON-RPC strings received over the multiplexed `signal` SSE channel.
   * Used by `PatchesRESTSignalingTransport` to drive `WebRTCTransport`'s signaling.
   */
  readonly onSignal = signal<(raw: string) => void>();
  /**
   * Emits transport-level errors that don't reject a specific request — currently a
   * malformed server-pushed SSE event (unparseable JSON or wrong shape) that had to be
   * dropped. PatchesSync forwards these to its own onError so they reach app telemetry;
   * a dropped `changesCommitted` event otherwise means silently missed changes until the
   * next event opens a rev gap or a reconnect resync catches up.
   */
  readonly onError = signal<(error: Error) => void>();

  private _url: string;
  private _state: ConnectionState = 'disconnected';
  private eventSource: EventSource | null = null;
  private options: PatchesRESTOptions;
  private shouldBeConnected = false;
  private onlineUnsubscriber: Unsubscriber | null = null;
  /** Timestamp (ms) of the last SSE frame received (event or heartbeat). 0 until first open. */
  private _lastEventAt = 0;
  /** Interval handle for the half-open-stream watchdog; null while not connected. */
  private livenessTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  /** Pending reconnect attempt scheduled after a fatal error / teardown; null when none. */
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  /** Current exponential reconnect backoff (ms); reset on a successful open. */
  private reconnectBackoff = INITIAL_RECONNECT_BACKOFF_MS;

  constructor(url: string, options?: PatchesRESTOptions) {
    this._url = url.replace(/\/$/, ''); // Strip trailing slash
    this.options = options ?? {};

    // Per-instance, never persisted: sessionStorage survives Duplicate Tab, and
    // two live clients sharing an id would miss each other's changes.
    this.clientId = this.options.clientId ?? createId(22);
  }

  // --- URL ---

  get url(): string {
    return this._url;
  }

  set url(url: string) {
    this._url = url.replace(/\/$/, '');
  }

  // --- Connection State ---

  /** Current connection state of the underlying SSE stream. */
  get state(): ConnectionState {
    return this._state;
  }

  // --- Connection Lifecycle ---

  connect(): Promise<void> {
    this.shouldBeConnected = true;
    this._ensureOnlineOfflineListeners();

    if (onlineState.isOffline) {
      // Defer until online — onStateChange will fire when we connect later
      return Promise.resolve();
    }

    if (this.eventSource) {
      return Promise.resolve(); // Already connected or connecting
    }

    this._setState('connecting');

    return new Promise<void>((resolve, reject) => {
      const es = new EventSource(`${this._url}/events/${this.clientId}`);
      this.eventSource = es;
      let settled = false;

      // Hard timeout for the initial handshake. EventSource has no built-in
      // connect timeout: a reachable-but-unresponsive server can leave the
      // promise pending until the browser's TCP timeout (~minutes). Fail fast
      // so callers can fall back to the offline path.
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.eventSource === es) this._teardownStream();
        else es.close();
        this._setState('error');
        this._scheduleReconnect();
        reject(new Error('SSE connection timed out'));
      }, CONNECT_TIMEOUT_MS);

      es.onopen = () => {
        // A healthy open clears any pending reconnect and resets the backoff.
        this._cancelReconnect();
        this.reconnectBackoff = INITIAL_RECONNECT_BACKOFF_MS;
        this._noteTraffic();
        this._startLivenessWatchdog();
        this._setState('connected');
        if (!settled) {
          settled = true;
          globalThis.clearTimeout(timer);
          resolve();
        }
      };

      es.onerror = () => {
        if (!settled) {
          // First error during initial connection — reject the promise so the caller knows
          // this attempt failed, but tear the dead stream down and schedule a backoff
          // reconnect so the transport keeps trying on its own (mirrors WebSocketTransport,
          // which reconnects after an initial failure too). Without the teardown a CLOSED
          // EventSource would linger and the next connect() would no-op on it.
          settled = true;
          globalThis.clearTimeout(timer);
          this._teardownStream();
          this._setState('error');
          this._scheduleReconnect();
          reject(new Error('SSE connection failed'));
          return;
        }
        // Post-handshake error.
        if (es.readyState === EventSource.CLOSED) {
          // Fatal: the browser has given up and will NOT auto-reconnect (e.g. the
          // auto-reconnect attempt got a non-retryable response). Left untouched the
          // stream sits dead while `connect()` no-ops on the still-non-null eventSource,
          // so the client silently stops converging (the "stuck on connecting" hole).
          // Tear it down, surface 'error', and schedule a backoff reconnect to rebuild.
          this._teardownStream();
          this._setState('error');
          this._scheduleReconnect();
        } else if (this._state === 'connected') {
          // Transient drop — the browser is auto-reconnecting (readyState CONNECTING).
          this._setState('disconnected');
          this._setState('connecting');
        }
      };

      // Listen for typed server events. Every frame also bumps the liveness clock.
      // A malformed event (unparseable JSON or wrong shape) is dropped but surfaced via
      // onError — never silently ignored, since a dropped `changesCommitted` means this
      // client misses committed changes with zero signal. The stream itself stays up:
      // one bad frame doesn't invalidate the connection, and a missed changes event is
      // recovered by the next event's rev gap (MissingChangesError → syncDoc) or a
      // reconnect resync.
      es.addEventListener('changesCommitted', (e: MessageEvent) => {
        this._noteTraffic();
        let parsed: { docId?: unknown; changes?: unknown; options?: CommitChangesOptions };
        try {
          parsed = JSON.parse(e.data) ?? {};
        } catch (err) {
          this._reportMalformedEvent('changesCommitted', e.data, err);
          return;
        }
        const { docId, changes, options } = parsed;
        if (typeof docId !== 'string' || !Array.isArray(changes)) {
          this._reportMalformedEvent(
            'changesCommitted',
            e.data,
            new Error('expected shape { docId: string, changes: Change[] }')
          );
          return;
        }
        this.onChangesCommitted.emit(docId, changes, options);
      });

      es.addEventListener('docDeleted', (e: MessageEvent) => {
        this._noteTraffic();
        let parsed: { docId?: unknown };
        try {
          parsed = JSON.parse(e.data) ?? {};
        } catch (err) {
          this._reportMalformedEvent('docDeleted', e.data, err);
          return;
        }
        const { docId } = parsed;
        if (typeof docId !== 'string') {
          this._reportMalformedEvent('docDeleted', e.data, new Error('expected shape { docId: string }'));
          return;
        }
        this.onDocDeleted.emit(docId);
      });

      es.addEventListener('signal', (e: MessageEvent) => {
        this._noteTraffic();
        this.onSignal.emit(e.data);
      });

      es.addEventListener('resync', () => {
        this._noteTraffic();
        if (!this.shouldBeConnected) return;
        // Server's buffer expired — trigger a full re-sync by cycling state.
        // PatchesSync listens to onStateChange and calls syncAllKnownDocs on 'connected'.
        this._setState('disconnected');
        this._setState('connected');
      });

      // Server's periodic keep-alive. Carries no payload — its only job is to prove the
      // stream is still live so the watchdog doesn't tear down a healthy-but-idle connection.
      es.addEventListener('heartbeat', () => this._noteTraffic());
    });
  }

  disconnect(): void {
    this.shouldBeConnected = false;
    this._removeOnlineOfflineListeners();
    this._cancelReconnect();
    this._teardownStream();
    this._setState('disconnected');
  }

  // --- PatchesAPI: Subscriptions ---

  /**
   * Subscribe to server events for the given doc IDs. Returns the requested
   * ids the server registered (ids denied by authorization are excluded).
   *
   * Failure handling exists for the multi-instance hazard: subscriptions are
   * registered against the instance holding this client's event stream, and a
   * POST that lands elsewhere can register nothing.
   *
   * The response accounts for an id when it appears in `docIds` (registered)
   * or in the optional `denied` array (authoritatively refused by access
   * control). An id in NEITHER means "unknown, safe to retry" — the server's
   * access check failed transiently, or the POST was misdirected. Unaccounted
   * ids are retried (only those ids) up to {@link SUBSCRIBE_MAX_ATTEMPTS}
   * total attempts — each POST re-rolls the load balancer. Exhaustion rejects
   * with a `SubscribeIncompleteError`; like any other request-scoped error it
   * is NOT also emitted on {@link onError} (the consumer's catch is the single
   * telemetry channel). Live updates are silently missing in this state, which
   * is otherwise invisible (commits and reads still succeed).
   *
   * A server verdict that NO instance holds a stream for this client (status
   * error with `data.code === 'UNKNOWN_CLIENT'`) is retried the same way, then
   * treated as a dead stream: tear down + schedule reconnect (the fresh
   * 'connected' state drives the consumer's full re-subscribe) and reject —
   * unless the stream this subscribe was issued against has already been
   * replaced, in which case the verdict is stale and the fresh stream is left
   * alone.
   */
  async subscribe(ids: string | string[]): Promise<string[]> {
    const requested = [...new Set(normalizeIds(ids))];
    if (requested.length === 0) return [];

    // The stream this subscribe belongs to. Overlapping subscribes are routine
    // (resync and newly-tracked docs), so an exhausted UNKNOWN_CLIENT below
    // must not tear down a stream rebuilt after this call started.
    const es = this.eventSource;

    const registered = new Set<string>();
    const accounted = new Set<string>();
    let missing = requested;
    let unknownClient: Error | null = null;
    for (let attempt = 1; attempt <= SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await new Promise(resolve =>
          globalThis.setTimeout(resolve, SUBSCRIBE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 2))
        );
        // Deliberately disconnected (or offline) while waiting to retry — the
        // stream these subscriptions target is gone, so stop quietly.
        if (!this.shouldBeConnected || onlineState.isOffline) return requested.filter(id => registered.has(id));
      }
      let result: { docIds?: unknown; denied?: unknown };
      try {
        result = await this._fetch(`/subscriptions/${this.clientId}`, {
          method: 'POST',
          body: { docIds: missing },
        });
      } catch (err) {
        if (err instanceof StatusError && err.data?.code === 'UNKNOWN_CLIENT') {
          // The server says no instance owns a stream for our clientId. Retry —
          // right after a (re)connect this can be the server's stream registry
          // catching up — and only give up on the stream below once exhausted.
          unknownClient = err;
          continue;
        }
        throw err;
      }
      unknownClient = null;
      const docIds = Array.isArray(result?.docIds) ? (result.docIds as string[]) : [];
      const denied = Array.isArray(result?.denied) ? (result.denied as string[]) : [];
      for (const id of docIds) {
        registered.add(id);
        accounted.add(id);
      }
      for (const id of denied) accounted.add(id);
      // Completeness is set membership, never counts: an id is settled only
      // when the server put it in `docIds` or `denied`. `denied: []` accounts
      // for nothing, and an old server that never sends `denied` leaves every
      // non-registered id unaccounted — both retry naturally. An all-denied
      // response is complete: authoritative, no retry, no error.
      missing = missing.filter(id => !accounted.has(id));
      if (missing.length === 0) return requested.filter(id => registered.has(id));
    }

    if (unknownClient) {
      // Authoritative: our stream is gone server-side (stale/half-open here).
      // Rebuild it — the consumer re-subscribes everything on 'connected' —
      // but only if it is still the stream this subscribe was issued against;
      // a replacement built mid-retry is healthy and must be left alone.
      if (this.shouldBeConnected && this.eventSource === es) {
        this._teardownStream();
        this._setState('error');
        this._scheduleReconnect();
      }
      throw unknownClient;
    }
    const error = new Error(
      `Subscribe left ${missing.length} of ${requested.length} requested documents unaccounted for after ${SUBSCRIBE_MAX_ATTEMPTS} attempts`
    );
    error.name = 'SubscribeIncompleteError';
    throw error;
  }

  async unsubscribe(ids: string | string[]): Promise<void> {
    await this._fetch(`/subscriptions/${this.clientId}`, {
      method: 'DELETE',
      body: { docIds: normalizeIds(ids) },
    });
  }

  // --- PatchesAPI: Documents ---

  async getDoc<T = any>(docId: string): Promise<PatchesState<T>> {
    return this._fetch(`/docs/${docId}`);
  }

  async getChangesSince(docId: string, rev: number): Promise<Change[]> {
    return this._fetch(`/docs/${docId}/_changes?since=${rev}`);
  }

  async commitChanges(
    docId: string,
    changes: ChangeInput[],
    options?: CommitChangesOptions
  ): Promise<{ changes: Change[]; docReloadRequired?: true }> {
    return this._fetch(`/docs/${docId}/_changes`, {
      method: 'POST',
      body: { changes, options },
    });
  }

  async deleteDoc(docId: string, _options?: DeleteDocOptions): Promise<void> {
    await this._fetch(`/docs/${docId}`, { method: 'DELETE' });
  }

  // --- PatchesAPI: Versions ---

  async createVersion(docId: string, metadata: EditableVersionMetadata): Promise<string> {
    return this._fetch(`/docs/${docId}/_versions`, {
      method: 'POST',
      body: metadata,
    });
  }

  async listVersions(docId: string, options?: ListVersionsOptions): Promise<VersionMetadata[]> {
    const params = options ? `?${new URLSearchParams(options as Record<string, string>)}` : '';
    return this._fetch(`/docs/${docId}/_versions${params}`);
  }

  async getVersionState(docId: string, versionId: string): Promise<PatchesSnapshot> {
    return this._fetch(`/docs/${docId}/_versions/${encodeURIComponent(versionId)}`);
  }

  async getVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    return this._fetch(`/docs/${docId}/_versions/${encodeURIComponent(versionId)}/_changes`);
  }

  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    await this._fetch(`/docs/${docId}/_versions/${encodeURIComponent(versionId)}`, {
      method: 'PUT',
      body: metadata,
    });
  }

  // --- Branch Operations ---
  // Note: updateBranch, deleteBranch, and mergeBranch take (docId, branchId) rather than
  // matching BranchAPI signatures, because the REST URL pattern is /docs/:docId/_branches/:branchId.
  // Apps using PatchesREST as a branchApi need a thin adapter to bridge the difference.

  async listBranches(docId: string, options?: { since?: number }): Promise<Branch[]> {
    const params = options?.since ? `?since=${encodeURIComponent(String(options.since))}` : '';
    return this._fetch(`/docs/${docId}/_branches${params}`);
  }

  async createBranch(docId: string, rev: number, metadata?: CreateBranchMetadata): Promise<string> {
    return this._fetch(`/docs/${docId}/_branches`, {
      method: 'POST',
      body: { branchedAtRev: rev, ...metadata },
    });
  }

  async updateBranch(docId: string, branchId: string, metadata: EditableBranchMetadata): Promise<void> {
    await this._fetch(`/docs/${docId}/_branches/${encodeURIComponent(branchId)}`, {
      method: 'PUT',
      body: metadata,
    });
  }

  async deleteBranch(docId: string, branchId: string): Promise<void> {
    await this._fetch(`/docs/${docId}/_branches/${encodeURIComponent(branchId)}`, { method: 'DELETE' });
  }

  /**
   * Merge a branch into its source document. Returns the server commit change(s)
   * the merge applied to the source doc (`{ changes }` in the response body), so
   * callers can fold the merged result into an open doc directly — no follow-up
   * snapshot fetch needed. Empty for a no-op merge (nothing new to bring across).
   */
  async mergeBranch(docId: string, branchId: string): Promise<Change[]> {
    const result = await this._fetch(`/docs/${docId}/_branches/${encodeURIComponent(branchId)}/_merge`, {
      method: 'POST',
    });
    return (result?.changes as Change[]) ?? [];
  }

  // --- WebRTC Signaling ---

  /**
   * POSTs a raw JSON-RPC string to `/signal/:clientId`. Used as the upstream
   * half of the multiplexed signaling channel: receive happens via the `signal`
   * SSE event (see {@link onSignal}).
   *
   * The body is sent verbatim — callers pass an already-stringified JSON-RPC
   * message. The endpoint forwards it to {@link SignalingService.handleClientMessage}.
   *
   * Silently no-ops when the SSE stream is not connected. Signaling is
   * inherently best-effort and the server has no live `signal` channel back
   * to this client until the stream is up, so a frame sent before connect
   * resolves can't be relayed anyway. Throwing here would surface as an
   * unhandled rejection through `JSONRPCClient.call`, which doesn't await
   * `transport.send`.
   */
  async sendSignal(raw: string): Promise<void> {
    if (this._state !== 'connected') return;
    const headers = await this._getHeaders();
    const response = await globalThis.fetch(`${this._url}/signal/${this.clientId}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: raw,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new StatusError(response.status, response.statusText);
    }
  }

  // --- Private Helpers ---

  private _setState(state: ConnectionState) {
    if (state === this._state) return;
    this._state = state;
    this.onStateChange.emit(state);
  }

  /** Record that an SSE frame (event or heartbeat) just arrived, for the liveness watchdog. */
  private _noteTraffic(): void {
    this._lastEventAt = Date.now();
  }

  /**
   * Surfaces a malformed server-pushed SSE event through onError (and the console as a
   * fallback when nothing subscribes) with a truncated payload snippet for telemetry.
   * The event is dropped but the connection stays usable.
   */
  private _reportMalformedEvent(event: string, data: unknown, cause: unknown): void {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    const snippet =
      raw && raw.length > MALFORMED_EVENT_SNIPPET_CHARS ? `${raw.slice(0, MALFORMED_EVENT_SNIPPET_CHARS)}…` : raw;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`Malformed SSE '${event}' event (${reason}). Payload: ${snippet}`, { cause });
    console.error(error);
    this.onError.emit(error);
  }

  /** Close + null the EventSource and stop the liveness watchdog. Idempotent. */
  private _teardownStream(): void {
    this._stopLivenessWatchdog();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Watchdog for half-open streams. A TCP connection can silently die without the
   * browser firing `EventSource.onerror`, leaving `eventSource` non-null and the client
   * stuck `connected` forever (frozen `committedRev`). If no frame — including the
   * server's periodic `heartbeat` — has arrived within {@link LIVENESS_TIMEOUT_MS},
   * force a reconnect: tear the stream down and surface `error`, which drives the
   * consumer's reconnect path (re-subscribe + `syncAllKnownDocs` catch-up).
   */
  private _startLivenessWatchdog(): void {
    this._stopLivenessWatchdog();
    this.livenessTimer = globalThis.setInterval(() => {
      if (!this.shouldBeConnected || onlineState.isOffline || !this.eventSource) return;
      if (Date.now() - this._lastEventAt <= LIVENESS_TIMEOUT_MS) return;
      this._teardownStream();
      this._setState('error');
      this._scheduleReconnect();
    }, LIVENESS_CHECK_MS);
  }

  private _stopLivenessWatchdog(): void {
    if (this.livenessTimer !== null) {
      globalThis.clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /**
   * Schedules a reconnect with exponential backoff after a fatal error or watchdog teardown.
   * Mirrors WebSocketTransport's self-healing: unlike that transport, a fatal SSE error has no
   * native auto-reconnect, and the consumer (PatchesSync) only re-syncs on a fresh `connected`
   * event — it never calls `connect()` on `error`. Without this, a torn-down stream would
   * surface `error` and never rebuild. The eventual `connected` re-emit drives the consumer's
   * `syncAllKnownDocs` catch-up (re-subscribe + pull). Single-flight and gated on intent/online.
   */
  private _scheduleReconnect(): void {
    if (!this.shouldBeConnected || onlineState.isOffline) return;
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // connect() handles its own failure (teardown + 'error' + reschedule); nothing to do here.
      });
    }, this.reconnectBackoff);
    this.reconnectBackoff = Math.min(this.reconnectBackoff * 1.5, MAX_RECONNECT_BACKOFF_MS);
  }

  private _cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async _getHeaders(): Promise<Record<string, string>> {
    const staticHeaders = this.options.headers ?? {};
    if (this.options.getHeaders) {
      const dynamic = await this.options.getHeaders();
      return { ...staticHeaders, ...dynamic };
    }
    return staticHeaders;
  }

  private async _fetch(path: string, init?: { method?: string; body?: any }): Promise<any> {
    const headers = await this._getHeaders();
    const method = init?.method ?? 'GET';
    const hasBody = init?.body !== undefined;

    // Mutations carry clientId so the server can exclude the sender from its own
    // SSE fan-out; GETs omit it (see docs/sse-rest.md). String append, not the URL
    // API: this._url may be a relative base.
    let url = `${this._url}${path}`;
    if (method !== 'GET') {
      url += `${url.includes('?') ? '&' : '?'}clientId=${encodeURIComponent(this.clientId)}`;
    }

    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        method,
        credentials: 'include',
        headers: {
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: hasBody ? JSON.stringify(init!.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // The request died without an HTTP response — a DNS/TCP/TLS failure or a
      // CORS-opaque rejection (both a status-less TypeError), or the AbortSignal
      // timeout above firing. There is no status to classify on and the failure
      // says nothing about the doc it was for, so type it as connection trouble:
      // PatchesSync defers these to connection-level recovery instead of latching
      // the doc at per-doc 'error' (see NetworkError in ../error.ts).
      const message = err instanceof Error ? err.message : String(err);
      throw new NetworkError(`${method} ${path} failed without a response: ${message}`, { cause: err });
    }

    if (!response.ok) {
      let message = response.statusText;
      let data: Record<string, any> | undefined;
      try {
        const json = await response.json();
        message = json.message ?? json.error ?? message;
        data = json.data;
      } catch {
        // Response body wasn't JSON
      }
      throw new StatusError(response.status, message, data);
    }

    // 204 No Content — nothing to parse
    if (response.status === 204) {
      return undefined;
    }

    return response.json();
  }

  private _ensureOnlineOfflineListeners(): void {
    if (!this.onlineUnsubscriber) {
      this.onlineUnsubscriber = onlineState.onOnlineChange(isOnline => {
        if (isOnline && this.shouldBeConnected && !this.eventSource) {
          this.connect();
        } else if (!isOnline) {
          // Going offline: cancel any pending backoff reconnect and tear down the stream.
          // The online transition above rebuilds it when connectivity returns.
          this._cancelReconnect();
          if (this.eventSource) {
            this._teardownStream();
            this._setState('disconnected');
          }
        }
      });
    }
  }

  private _removeOnlineOfflineListeners(): void {
    if (this.onlineUnsubscriber) {
      this.onlineUnsubscriber();
      this.onlineUnsubscriber = null;
    }
  }
}
