import { signal, type Unsubscriber } from 'easy-signal';
import type {
  Branch,
  Change,
  ChangeInput,
  CommitChangesOptions,
  DeleteDocOptions,
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
import { encodeDocId, normalizeIds } from './utils.js';

const SESSION_STORAGE_KEY = 'patches-clientId';

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

  private _url: string;
  private _state: ConnectionState = 'disconnected';
  private eventSource: EventSource | null = null;
  private options: PatchesRESTOptions;
  private shouldBeConnected = false;
  private onlineUnsubscriber: Unsubscriber | null = null;

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

      es.onopen = () => {
        this._setState('connected');
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      es.onerror = () => {
        if (!settled) {
          // First error during initial connection — reject the promise
          settled = true;
          this._setState('error');
          reject(new Error('SSE connection failed'));
          return;
        }
        // Subsequent errors (after initial connection) — EventSource auto-reconnects
        if (this._state === 'connected') {
          this._setState('disconnected');
          this._setState('connecting');
        }
      };

      // Listen for typed server events
      es.addEventListener('changesCommitted', (e: MessageEvent) => {
        try {
          const { docId, changes, options } = JSON.parse(e.data);
          this.onChangesCommitted.emit(docId, changes, options);
        } catch {
          // Malformed event, ignore
        }
      });

      es.addEventListener('docDeleted', (e: MessageEvent) => {
        try {
          const { docId } = JSON.parse(e.data);
          this.onDocDeleted.emit(docId);
        } catch {
          // Malformed event, ignore
        }
      });

      es.addEventListener('resync', () => {
        if (!this.shouldBeConnected) return;
        // Server's buffer expired — trigger a full re-sync by cycling state.
        // PatchesSync listens to onStateChange and calls syncAllKnownDocs on 'connected'.
        this._setState('disconnected');
        this._setState('connected');
      });
    });
  }

  disconnect(): void {
    this.shouldBeConnected = false;
    this._removeOnlineOfflineListeners();

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

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
    return this._fetch(`/docs/${encodeDocId(docId)}`);
  }

  async getChangesSince(docId: string, rev: number): Promise<Change[]> {
    return this._fetch(`/docs/${encodeDocId(docId)}/_changes?since=${rev}`);
  }

  async commitChanges(
    docId: string,
    changes: ChangeInput[],
    options?: CommitChangesOptions
  ): Promise<{ changes: Change[]; docReloadRequired?: true }> {
    return this._fetch(`/docs/${encodeDocId(docId)}/_changes`, {
      method: 'POST',
      body: { changes, options },
    });
  }

  async deleteDoc(docId: string, _options?: DeleteDocOptions): Promise<void> {
    await this._fetch(`/docs/${encodeDocId(docId)}`, { method: 'DELETE' });
  }

  // --- PatchesAPI: Versions ---

  async createVersion(docId: string, metadata: EditableVersionMetadata): Promise<string> {
    return this._fetch(`/docs/${encodeDocId(docId)}/_versions`, {
      method: 'POST',
      body: metadata,
    });
  }

  async listVersions(docId: string, options?: ListVersionsOptions): Promise<VersionMetadata[]> {
    const params = options ? `?${new URLSearchParams(options as Record<string, string>)}` : '';
    return this._fetch(`/docs/${encodeDocId(docId)}/_versions${params}`);
  }

  async getVersionState(docId: string, versionId: string): Promise<PatchesSnapshot> {
    return this._fetch(`/docs/${encodeDocId(docId)}/_versions/${encodeURIComponent(versionId)}`);
  }

  async getVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    return this._fetch(`/docs/${encodeDocId(docId)}/_versions/${encodeURIComponent(versionId)}/_changes`);
  }

  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    await this._fetch(`/docs/${encodeDocId(docId)}/_versions/${encodeURIComponent(versionId)}`, {
      method: 'PUT',
      body: metadata,
    });
  }

  // --- Branch Operations (not in PatchesAPI but matches PatchesClient feature parity) ---

  async listBranches(docId: string): Promise<Branch[]> {
    return this._fetch(`/docs/${encodeDocId(docId)}/_branches`);
  }

  async createBranch(docId: string, rev: number, metadata?: EditableBranchMetadata, initialChanges?: Change[]): Promise<string> {
    return this._fetch(`/docs/${encodeDocId(docId)}/_branches`, {
      method: 'POST',
      body: { rev, ...metadata, ...(initialChanges ? { initialChanges } : {}) },
    });
  }

  async closeBranch(branchId: string): Promise<void> {
    await this._fetch(`/docs/${encodeDocId(branchId)}`, { method: 'DELETE' });
  }

  async mergeBranch(branchId: string): Promise<void> {
    await this._fetch(`/docs/${encodeDocId(branchId)}/_merge`, { method: 'POST' });
  }

  // --- Private Helpers ---

  private _setState(state: ConnectionState) {
    if (state === this._state) return;
    this._state = state;
    this.onStateChange.emit(state);
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
        } else if (!isOnline && this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
          this._setState('disconnected');
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
