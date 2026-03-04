import { signal, type Signal } from 'easy-signal';
import { MicroDoc } from './doc.js';
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
}

export class MicroClient {
  private _url: string;
  private _dbName?: string;
  private _debounce: number;
  private _docs = new Map<string, DocEntry>();
  private _ws: WebSocket | null = null;
  private _wsBackoff = 0;
  private _wsTimer: ReturnType<typeof setTimeout> | null = null;
  private _db: IDBDatabase | null = null;

  readonly onConnection: Signal<(connected: boolean) => void> = signal();

  constructor(opts: ClientOptions) {
    this._url = opts.url.replace(/\/$/, '');
    this._dbName = opts.dbName;
    this._debounce = opts.debounce ?? 300;
  }

  /** Open a document. Fetches from server (or IDB cache), subscribes via WS. */
  async open<T = Record<string, any>>(docId: string): Promise<MicroDoc<T>> {
    if (this._docs.has(docId)) return this._docs.get(docId)!.doc as MicroDoc<T>;

    // Try loading from IDB first, then fetch from server
    let state: DocState = { rev: 0, fields: {} };
    let pending: FieldMap = {};

    if (this._dbName) {
      const cached = await this._idbLoad(docId);
      if (cached) {
        state = { rev: cached.rev, fields: cached.fields };
        pending = cached.pending;
      }
    }

    try {
      if (state.rev > 0 && Object.keys(pending).length) {
        // Have cached state with pending ops — try incremental sync to preserve them
        try {
          const sync = await this._fetch<SyncResult>(`/docs/${docId}/sync?since=${state.rev}`);
          if (sync.rev > state.rev) {
            Object.assign(state.fields, sync.fields);
            pending = transformPendingTxt(pending, sync.textLog);
            state.rev = sync.rev;
          }
        } catch {
          // Incremental sync unavailable, fall back to full fetch
          const remote = await this._fetch<DocState>(`/docs/${docId}`);
          if (remote.rev > state.rev) {
            state = remote;
            pending = {};
          }
        }
      } else {
        const remote = await this._fetch<DocState>(`/docs/${docId}`);
        if (remote.rev > state.rev) {
          state = remote;
          pending = {};
        }
      }
    } catch {
      // Offline — use cached state
    }

    const doc = new MicroDoc<T>(state.fields, pending, state.rev);
    const entry: DocEntry<T> = { doc, timer: null };
    this._docs.set(docId, entry);

    doc._onUpdate = () => this._scheduleFlush(docId);
    this._ensureWS();
    this._wsSend({ type: 'sub', docId });
    return doc;
  }

  /** Close a document subscription. */
  close(docId: string) {
    const entry = this._docs.get(docId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
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
    for (const entry of this._docs.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this._docs.clear();
    if (this._wsTimer) clearTimeout(this._wsTimer);
    this._ws?.close();
    this._ws = null;
    this._db?.close();
    this._db = null;
  }

  // --- Sync ---

  private _scheduleFlush(docId: string) {
    const entry = this._docs.get(docId);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this._doFlush(docId, entry);
    }, this._debounce);
  }

  private async _doFlush(docId: string, entry: DocEntry) {
    const change = entry.doc._flush();
    if (!change) return;

    if (this._dbName) this._idbSave(docId, entry.doc);

    try {
      const result = await this._fetch<CommitResult>(`/docs/${docId}/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      });
      entry.doc._confirmSend(result.rev);
      if (this._dbName) this._idbSave(docId, entry.doc);
      // If more pending ops accumulated while sending, flush again
      if (Object.keys(entry.doc.pending).length) this._scheduleFlush(docId);
    } catch {
      entry.doc._failSend();
      // Retry after backoff
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this._doFlush(docId, entry);
      }, 2000);
    }
  }

  // --- WebSocket ---

  private _ensureWS() {
    if (this._ws && this._ws.readyState <= WebSocket.OPEN) return;
    const wsUrl = this._url.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    this._ws = ws;

    ws.onopen = () => {
      this._wsBackoff = 0;
      this.onConnection.emit(true);
      // Re-subscribe all open docs
      for (const docId of this._docs.keys()) {
        this._wsSend({ type: 'sub', docId });
      }
    };

    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.type === 'change' && msg.docId) {
          const entry = this._docs.get(msg.docId);
          if (entry) entry.doc.applyRemote(msg.fields, msg.rev);
        }
      } catch {
        /* ignore malformed messages */
      }
    };

    ws.onclose = () => {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // --- IndexedDB ---

  private async _idbOpen(): Promise<IDBDatabase> {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName!, 1);
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
    });
  }

  private async _idbLoad(docId: string): Promise<{ fields: FieldMap; rev: number; pending: FieldMap } | null> {
    try {
      const db = await this._idbOpen();
      const tx = db.transaction(['docs', 'pending'], 'readonly');
      const [docData, pendingData] = await Promise.all([
        idbGet(tx.objectStore('docs'), docId),
        idbGet(tx.objectStore('pending'), docId),
      ]);
      if (!docData) return null;
      return { fields: docData.fields, rev: docData.rev, pending: pendingData?.ops ?? {} };
    } catch {
      return null;
    }
  }

  private async _idbSave(docId: string, doc: MicroDoc<any>) {
    try {
      const db = await this._idbOpen();
      const tx = db.transaction(['docs', 'pending'], 'readwrite');
      tx.objectStore('docs').put({ fields: doc.confirmed, rev: doc.rev }, docId);
      tx.objectStore('pending').put({ ops: doc.pending }, docId);
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
