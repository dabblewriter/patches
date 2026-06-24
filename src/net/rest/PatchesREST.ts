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
import { StatusError } from '../error.js';
import type { PatchesConnection } from '../PatchesConnection.js';
import type { ConnectionState } from '../protocol/types.js';
import { onlineState } from '../websocket/onlineState.js';
import { normalizeIds } from './utils.js';

const SESSION_STORAGE_KEY = 'patches-clientId';
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

/**
 * Options for creating a PatchesREST instance.
 */
export interface PatchesRESTOptions {
  /**
   * Explicit client ID. If not provided, restored from sessionStorage (when available)
   * or generated via crypto.randomUUID(). Persisted to sessionStorage automatically.
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

    // Resolve clientId: explicit > sessionStorage > random
    const storage = typeof globalThis.sessionStorage !== 'undefined' ? globalThis.sessionStorage : undefined;
    this.clientId = this.options.clientId ?? storage?.getItem(SESSION_STORAGE_KEY) ?? globalThis.crypto.randomUUID();
    try {
      storage?.setItem(SESSION_STORAGE_KEY, this.clientId);
    } catch {
      // sessionStorage may throw in private browsing or when full
    }
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
      es.addEventListener('changesCommitted', (e: MessageEvent) => {
        this._noteTraffic();
        try {
          const { docId, changes, options } = JSON.parse(e.data);
          this.onChangesCommitted.emit(docId, changes, options);
        } catch {
          // Malformed event, ignore
        }
      });

      es.addEventListener('docDeleted', (e: MessageEvent) => {
        this._noteTraffic();
        try {
          const { docId } = JSON.parse(e.data);
          this.onDocDeleted.emit(docId);
        } catch {
          // Malformed event, ignore
        }
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

  async subscribe(ids: string | string[]): Promise<string[]> {
    const result = await this._fetch(`/subscriptions/${this.clientId}`, {
      method: 'POST',
      body: { docIds: normalizeIds(ids) },
    });
    return result.docIds;
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

    const response = await globalThis.fetch(`${this._url}${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: hasBody ? JSON.stringify(init!.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

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
