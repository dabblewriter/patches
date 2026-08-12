import { signal, type Signal } from 'easy-signal';
import { StatusError } from '../net/error.js';
import { MicroDoc, type RestoredSend } from './doc.js';
import { transformPendingTxt } from './ops.js';
import type { CommitResult, DocState, FieldMap, SyncResult } from './types.js';

export interface ClientOptions {
  /** Base URL for REST API, e.g. "https://api.example.com" */
  url: string;
  /** If provided, persists state to IndexedDB with this database name. */
  dbName?: string;
  /** Debounce delay in ms before flushing pending ops. Default: 300 */
  debounce?: number;
}

interface DocEntry<T = any> {
  doc: MicroDoc<T>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  backoff: number;
  resyncing: boolean;
}

const MAX_RETRY_DELAY = 30000;

export class MicroClient {
  private _url: string;
  private _dbName?: string;
  private _debounce: number;
  private _docs = new Map<string, DocEntry>();
  private _opening = new Map<string, Promise<MicroDoc<any>>>();
  private _ws: WebSocket | null = null;
  private _wsBackoff = 0;
  private _wsTimer: ReturnType<typeof setTimeout> | null = null;
  private _db: IDBDatabase | null = null;
  private _dbOpening: Promise<IDBDatabase> | null = null;

  readonly onConnection: Signal<(connected: boolean) => void> = signal();

  constructor(opts: ClientOptions) {
    this._url = opts.url.replace(/\/$/, '');
    this._dbName = opts.dbName;
    this._debounce = opts.debounce ?? 300;
  }

  /** Open a document. Fetches from server (or IDB cache), subscribes via WS. */
  open<T = Record<string, any>>(docId: string): Promise<MicroDoc<T>> {
    const existing = this._docs.get(docId);
    if (existing) return Promise.resolve(existing.doc as MicroDoc<T>);
    let opening = this._opening.get(docId);
    if (!opening) {
      opening = this._open<T>(docId).finally(() => this._opening.delete(docId));
      this._opening.set(docId, opening);
    }
    return opening as Promise<MicroDoc<T>>;
  }

  private async _open<T>(docId: string): Promise<MicroDoc<T>> {
    let state: DocState = { rev: 0, fields: {} };
    let pending: FieldMap = {};
    let sending: RestoredSend | null = null;

    const cached = await this._idbLoad(docId);
    if (cached) {
      state = { rev: cached.rev, fields: cached.fields };
      pending = cached.pending;
      sending = cached.sending;
    }

    const fetchFull = async () => {
      const remote = await this._fetch<DocState>(`/docs/${docId}`);
      if (remote.rev > state.rev) state = { rev: remote.rev, fields: { ...remote.fields } };
    };

    // Fetch fresh state. Pending ops are NEVER discarded: non-text ops commit
    // safely as-is and text ops are rebased (here when the sync route provides
    // the text log, otherwise server-side OT covers them).
    try {
      if (state.rev > 0) {
        try {
          const sync = await this._fetchSync(docId, state.rev);
          if (sync.rev > state.rev) {
            const log = sync.textLog ?? {};
            state = { rev: sync.rev, fields: { ...sync.fields } };
            pending = transformPendingTxt(pending, log);
            if (sending) sending = { id: sending.id, fields: transformPendingTxt(sending.fields, log) };
          }
        } catch {
          await fetchFull();
        }
      } else {
        await fetchFull();
      }
    } catch {
      // Offline — use cached state
    }

    const doc = new MicroDoc<T>(state.fields, pending, state.rev, sending);
    const entry: DocEntry<T> = { doc, timer: null, inFlight: false, backoff: 0, resyncing: false };
    this._docs.set(docId, entry);
    void this._idbSave(docId, doc);

    doc._onUpdate = () => {
      void this._idbSave(docId, doc, false);
      this._scheduleFlush(docId);
    };
    this._ensureWS();
    this._wsSend({ type: 'sub', docId });
    if (doc.hasUnsent) this._scheduleFlush(docId);
    return doc;
  }

  /** Close a document subscription, flushing unsent ops best-effort. */
  close(docId: string) {
    const entry = this._docs.get(docId);
    if (!entry) return;
    void this.flush(docId); // starts the send synchronously, before the entry is dropped
    void this._idbSave(docId, entry.doc);
    this._docs.delete(docId);
    this._wsSend({ type: 'unsub', docId });
  }

  /** Force flush pending ops for a document immediately. */
  async flush(docId: string) {
    const entry = this._docs.get(docId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    await this._doFlush(docId, entry);
  }

  /** Disconnect WebSocket and clean up. */
  destroy() {
    for (const [docId, entry] of this._docs) {
      if (entry.timer) clearTimeout(entry.timer);
      void this._idbSave(docId, entry.doc);
    }
    this._docs.clear();
    if (this._wsTimer) {
      clearTimeout(this._wsTimer);
      this._wsTimer = null;
    }
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this._db?.close();
    this._db = null;
  }

  // --- Sync ---

  private _scheduleFlush(docId: string) {
    const entry = this._docs.get(docId);
    if (!entry || entry.timer || entry.inFlight) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this._doFlush(docId, entry);
    }, this._debounce);
  }

  private async _doFlush(docId: string, entry: DocEntry) {
    if (entry.inFlight || entry.resyncing) return;
    const change = entry.doc._flush();
    if (!change) return;

    entry.inFlight = true;
    void this._idbSave(docId, entry.doc, false); // pending moved to sending

    try {
      const result = await this._fetch<CommitResult>(`/docs/${docId}/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      });
      entry.doc._confirmSend(result);
      entry.backoff = 0;
      void this._idbSave(docId, entry.doc);
    } catch (e) {
      const code = e instanceof StatusError ? e.code : 0;
      if (code === 409) {
        // Compaction rejection: resync, then the retry below re-sends the rebased change.
        entry.doc._markDesync();
      } else if (code >= 400 && code < 500 && code !== 408 && code !== 429) {
        // Server rejected the change; roll it back into pending. The next
        // update (or explicit flush) re-sends. The StatusError itself is the
        // consumer's signal via their own fetch/auth layer.
        entry.doc._failSend();
        void this._idbSave(docId, entry.doc, false);
        return;
      }
      // Transient failure — retry the SAME change (same id) with backoff.
      entry.backoff = Math.min(entry.backoff ? entry.backoff * 2 : 2000, MAX_RETRY_DELAY);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (this._docs.get(docId) === entry) void this._doFlush(docId, entry);
      }, entry.backoff);
    } finally {
      entry.inFlight = false;
    }

    if (entry.doc.needsResync) void this._resync(docId);
    else if (entry.doc.hasUnsent && this._docs.get(docId) === entry) this._scheduleFlush(docId);
  }

  /** Fetch changes since the doc's rev and reconcile. Used for every desync path. */
  private async _resync(docId: string) {
    const entry = this._docs.get(docId);
    if (!entry || entry.resyncing || entry.inFlight) return;
    entry.resyncing = true;
    try {
      const sync = await this._fetchSync(docId, entry.doc.rev);
      entry.doc._applySync(sync);
      void this._idbSave(docId, entry.doc);
      if (entry.doc.hasUnsent) this._scheduleFlush(docId);
    } catch {
      setTimeout(() => {
        if (this._docs.get(docId) === entry) void this._resync(docId);
      }, 5000);
    } finally {
      entry.resyncing = false;
    }
  }

  private _fetchSync(docId: string, since: number): Promise<SyncResult> {
    return this._fetch<SyncResult>(`/docs/${docId}/changes?since=${since}`);
  }

  // --- WebSocket ---

  private _ensureWS() {
    if (this._ws && this._ws.readyState <= WebSocket.OPEN) return;
    const wsUrl = this._url.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    this._ws = ws;

    ws.onopen = () => {
      if (this._ws !== ws) return;
      this._wsBackoff = 0;
      this.onConnection.emit(true);
      // Re-subscribe and catch up on anything broadcast while disconnected
      for (const docId of this._docs.keys()) {
        this._wsSend({ type: 'sub', docId });
        void this._resync(docId);
      }
    };

    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.type === 'change' && msg.docId) {
          const entry = this._docs.get(msg.docId);
          if (!entry) return;
          entry.doc.applyRemote(msg.fields, msg.rev, msg.changeId);
          if (entry.doc.needsResync) void this._resync(msg.docId);
          else void this._idbSave(msg.docId, entry.doc);
        }
      } catch {
        /* ignore malformed messages */
      }
    };

    ws.onclose = () => {
      if (this._ws !== ws) return;
      this.onConnection.emit(false);
      this._reconnectWS();
    };

    ws.onerror = () => ws.close();
  }

  private _reconnectWS() {
    if (this._wsTimer) return;
    const delay = Math.min(1000 * 2 ** this._wsBackoff, 30000);
    this._wsBackoff++;
    this._wsTimer = setTimeout(() => {
      this._wsTimer = null;
      if (this._docs.size > 0) this._ensureWS();
    }, delay);
  }

  private _wsSend(msg: any) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  // --- REST ---

  private async _fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this._url + path, init);
    if (!res.ok) throw new StatusError(res.status, `HTTP ${res.status}`);
    return res.json();
  }

  // --- IndexedDB ---

  private _idbOpen(dbName: string): Promise<IDBDatabase> {
    if (this._db) return Promise.resolve(this._db);
    this._dbOpening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs');
        if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending');
      };
      req.onsuccess = () => {
        this._db = req.result;
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    }).finally(() => (this._dbOpening = null));
    return this._dbOpening;
  }

  private async _idbLoad(
    docId: string
  ): Promise<{ fields: FieldMap; rev: number; pending: FieldMap; sending: RestoredSend | null } | null> {
    if (!this._dbName) return null;
    try {
      const db = await this._idbOpen(this._dbName);
      const tx = db.transaction(['docs', 'pending'], 'readonly');
      const [docData, pendingData] = await Promise.all([
        idbGet(tx.objectStore('docs'), docId),
        idbGet(tx.objectStore('pending'), docId),
      ]);
      if (!docData) return null;
      const sending =
        pendingData?.sending && pendingData.sendingId
          ? { id: pendingData.sendingId, fields: pendingData.sending }
          : null;
      return { fields: docData.fields, rev: docData.rev, pending: pendingData?.ops ?? {}, sending };
    } catch {
      return null;
    }
  }

  /**
   * Persist BOTH unconfirmed layers (pending and in-flight sending), plus the
   * confirmed state unless the caller only touched the unconfirmed ones.
   */
  private async _idbSave(docId: string, doc: MicroDoc<any>, confirmedToo = true) {
    if (!this._dbName) return;
    try {
      const db = await this._idbOpen(this._dbName);
      const stores = confirmedToo ? ['docs', 'pending'] : ['pending'];
      const tx = db.transaction(stores, 'readwrite');
      if (confirmedToo) tx.objectStore('docs').put({ fields: doc.confirmed, rev: doc.rev }, docId);
      tx.objectStore('pending').put({ ops: doc.pending, sending: doc.sendingFields, sendingId: doc.sendingId }, docId);
      await idbDone(tx);
    } catch {
      /* best-effort */
    }
  }
}

function idbGet(store: IDBObjectStore, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
