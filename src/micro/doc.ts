import { Delta } from '@dabble/delta';
import { batch, store, type Store, type Subscriber, type Unsubscriber } from 'easy-signal';
import {
  buildState,
  clearDescendants,
  consolidateOps,
  effectiveFields,
  generateId,
  transformPendingTxt,
} from './ops.js';
import { type Change, type CommitResult, type FieldMap, type Op, type SyncResult } from './types.js';

// --- Proxy-based updater types ---

interface BaseUpdates<T> {
  set(val: T): void;
  del(): void;
}
interface NumberUpdates extends BaseUpdates<number> {
  inc(val?: number): void;
  bit(val: number): void;
  max(val: number): void;
}
interface StringUpdates extends BaseUpdates<string> {
  max(val: string): void;
}
interface DeltaUpdates extends BaseUpdates<Delta> {
  txt(delta: Delta): void;
}
export type Updatable<T> = T extends Delta
  ? DeltaUpdates
  : T extends number
    ? NumberUpdates
    : T extends string
      ? StringUpdates
      : T extends object
        ? { [K in keyof T]-?: Updatable<NonNullable<T[K]>> } & BaseUpdates<T>
        : BaseUpdates<T>;

function createUpdater<T>(emit: (path: string, op: Op, val: any) => void, path = ''): Updatable<T> {
  return new Proxy({} as any, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      switch (prop) {
        case 'set':
          return (val: any) => emit(path, '=', val);
        case 'del':
          return () => emit(path, '!', null);
        case 'inc':
          return (val = 1) => emit(path, '+', val);
        case 'bit':
          return (val: number) => emit(path, '~', val);
        case 'max':
          return (val: any) => emit(path, '^', val);
        case 'txt':
          return (delta: Delta) => emit(path, '#', delta.ops);
        default:
          if (prop.includes('.')) throw new Error(`Field names cannot contain "." (got "${prop}")`);
          return createUpdater(emit, path ? `${path}.${prop}` : prop);
      }
    },
  });
}

/** The in-flight change restored from persistence, re-sent under its original id. */
export interface RestoredSend {
  id: string;
  fields: FieldMap;
}

// --- MicroDoc ---

export class MicroDoc<T = Record<string, any>> {
  private _store: Store<T>;
  private _confirmed: FieldMap;
  private _sending: FieldMap | null = null;
  private _sendingId: string | null = null;
  private _pending: FieldMap = {};
  private _needsResync = false;
  private _lastCommittedRev = 0;

  /** Called by client when ops are queued. */
  _onUpdate?: () => void;

  constructor(
    confirmed: FieldMap = {},
    pending: FieldMap = {},
    public rev = 0,
    sending?: RestoredSend | null
  ) {
    this._confirmed = { ...confirmed };
    this._pending = { ...pending };
    if (sending && Object.keys(sending.fields).length) {
      this._sending = { ...sending.fields };
      this._sendingId = sending.id;
    }
    this._store = store<T>(this._rebuild());
  }

  get state(): T {
    return this._store.state;
  }
  get pending(): FieldMap {
    return this._pending;
  }
  get confirmed(): FieldMap {
    return this._confirmed;
  }
  get isSending(): boolean {
    return this._sending !== null;
  }
  get sendingFields(): FieldMap | null {
    return this._sending;
  }
  get sendingId(): string | null {
    return this._sendingId;
  }
  get needsResync(): boolean {
    return this._needsResync;
  }
  /** True while any op has not been confirmed by the server (pending or in flight). */
  get hasUnsent(): boolean {
    return this._sending !== null || Object.keys(this._pending).length > 0;
  }

  subscribe(cb: Subscriber<T>, noInit?: false): Unsubscriber {
    return this._store.subscribe(cb, noInit);
  }

  /** Apply changes via proxy-based updater. */
  update(fn: (doc: Updatable<T>) => void) {
    let ops: FieldMap = {};
    const ts = Date.now();
    const emit = (path: string, op: Op, val: any) => {
      if (!path) throw new Error('Cannot apply an operation to the document root');
      ops = consolidateOps(ops, { [path]: { op, val, ts } });
    };
    fn(createUpdater<T>(emit));
    if (!Object.keys(ops).length) return;
    this._pending = consolidateOps(this._pending, ops);
    this._store.state = this._rebuild();
    this._onUpdate?.();
  }

  /**
   * The change to POST. While a send is unconfirmed this returns the SAME change
   * (same id) so retries stay idempotent; otherwise pending moves to sending.
   * Returns null if there is nothing to send.
   */
  _flush(): Change | null {
    if (!this._sending) {
      if (!Object.keys(this._pending).length) return null;
      this._sending = this._pending;
      this._sendingId = generateId();
      this._pending = {};
    }
    return { id: this._sendingId!, rev: this.rev, fields: this._sending };
  }

  /**
   * Confirm a successful send. Folds the SERVER-transformed fields into
   * confirmed — the raw sending ops are never trusted as the committed value.
   */
  _confirmSend(result: CommitResult) {
    if (!this._sending) return;
    this._sending = null;
    this._sendingId = null;
    this._lastCommittedRev = result.rev;
    batch(() => {
      if (result.rev > this.rev + 1) {
        // Commits happened concurrently that local ops were never transformed
        // against — resync from the server instead of guessing.
        this._markDesync();
      } else {
        this._foldCommitted(result.fields);
        this.rev = Math.max(this.rev, result.rev);
      }
      this._store.state = this._rebuild();
    });
  }

  /** Roll sending back into pending after the server rejected the change. */
  _failSend() {
    if (!this._sending) return;
    this._pending = consolidateOps(this._sending, this._pending);
    this._sending = null;
    this._sendingId = null;
  }

  /** Flag that this doc must resync (e.g. after a compaction rejection). */
  _markDesync() {
    this._needsResync = true;
  }

  /** Apply remote fields from another client (via WS push). */
  applyRemote(fields: FieldMap, rev: number, changeId?: string) {
    if (changeId && changeId === this._sendingId) return; // own echo; the confirm path handles it
    if (rev <= this.rev) return; // stale or duplicate
    if (rev > this.rev + 1) {
      this._markDesync(); // missed a broadcast — applying out of order would corrupt
      return;
    }
    batch(() => {
      // Rebase local text ops against the remote deltas before folding them in.
      for (const [key, field] of Object.entries(fields)) {
        if (field.op !== '#') continue;
        const remote = new Delta(field.val);
        if (this._sending?.[key]) {
          const s = new Delta(this._sending[key].val);
          const sPrime = remote.transform(s, true); // sending rebased after remote (server priority)
          const rPrime = s.transform(remote, false); // remote passed through sending layer
          this._sending[key] = { op: '#', val: sPrime.ops, ts: this._sending[key].ts };
          if (this._pending[key]) {
            const p = new Delta(this._pending[key].val);
            this._pending[key] = { op: '#', val: rPrime.transform(p, true).ops, ts: this._pending[key].ts };
          }
        } else if (this._pending[key]) {
          const p = new Delta(this._pending[key].val);
          this._pending[key] = { op: '#', val: remote.transform(p, true).ops, ts: this._pending[key].ts };
        }
      }
      this._foldCommitted(fields);
      this.rev = rev;
      this._store.state = this._rebuild();
    });
  }

  /**
   * Reconcile from a server sync response: replace confirmed with the server's
   * fields (never compose) and rebase local text ops against the text log.
   */
  _applySync(sync: SyncResult) {
    batch(() => {
      this._confirmed = { ...sync.fields };
      this._pending = transformPendingTxt(this._pending, sync.textLog, this._lastCommittedRev);
      if (this._sending) {
        this._sending = transformPendingTxt(this._sending, sync.textLog, this._lastCommittedRev);
      }
      this.rev = Math.max(this.rev, sync.rev);
      this._needsResync = false;
      this._store.state = this._rebuild();
    });
  }

  /**
   * Fold server-committed fields into confirmed. Values are absolute resolved
   * state (replace), except `#` fields which carry the transformed delta (compose).
   */
  private _foldCommitted(fields: FieldMap) {
    for (const [key, field] of Object.entries(fields)) {
      if (field.op === '#') {
        const base = this._confirmed[key]?.val ? new Delta(this._confirmed[key].val) : new Delta();
        this._confirmed[key] = { op: '#', val: base.compose(new Delta(field.val)).ops, ts: field.ts };
      } else {
        if (field.op === '=' || field.op === '!') clearDescendants(this._confirmed, key, field.ts);
        this._confirmed[key] = field;
      }
    }
  }

  private _rebuild(): T {
    return buildState<T>(effectiveFields(this._confirmed, this._sending, this._pending));
  }
}
