import { Delta } from '@dabble/delta';
import { batch, store, type Store, type Subscriber, type Unsubscriber } from 'easy-signal';
import { buildState, consolidateOps, effectiveFields, generateId, mergeField } from './ops.js';
import { TXT, parseSuffix, type Change, type FieldMap } from './types.js';

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
export type Updatable<T> = T extends Delta ? DeltaUpdates
  : T extends number ? NumberUpdates
  : T extends string ? StringUpdates
  : T extends object ? { [K in keyof T]-?: Updatable<NonNullable<T[K]>> } & BaseUpdates<T>
  : BaseUpdates<T>;

function createUpdater<T>(emit: (path: string, suffix: string, val: any) => void, path = ''): Updatable<T> {
  return new Proxy({} as any, {
    get(_, prop: string) {
      const p = path ? `${path}.${prop}` : prop;
      switch (prop) {
        case 'set': return (val: any) => emit(path, '', val);
        case 'del': return () => emit(path, '', null);
        case 'inc': return (val = 1) => emit(path, '+', val);
        case 'bit': return (val: number) => emit(path, '~', val);
        case 'max': return (val: any) => emit(path, '^', val);
        case 'txt': return (delta: Delta) => emit(path, '#', delta.ops);
        default: return createUpdater(emit, p);
      }
    },
  });
}

// --- MicroDoc ---

export class MicroDoc<T = Record<string, any>> {
  private _store: Store<T>;
  private _confirmed: FieldMap;
  private _sending: FieldMap | null = null;
  private _sendingId: string | null = null;
  private _pending: FieldMap = {};

  /** Called by client when ops are queued. */
  _onUpdate?: () => void;

  constructor(confirmed: FieldMap = {}, pending: FieldMap = {}, public rev = 0) {
    this._confirmed = { ...confirmed };
    this._pending = { ...pending };
    this._store = store<T>(this._rebuild());
  }

  get state(): T { return this._store.state; }
  get pending(): FieldMap { return this._pending; }
  get confirmed(): FieldMap { return this._confirmed; }
  get isSending(): boolean { return this._sending !== null; }

  subscribe(cb: Subscriber<T>, noInit?: false): Unsubscriber {
    return this._store.subscribe(cb, noInit);
  }

  /** Apply changes via proxy-based updater. */
  update(fn: (doc: Updatable<T>) => void) {
    const ops: FieldMap = {};
    const ts = Date.now();
    const emit = (path: string, suffix: string, val: any) => {
      ops[suffix ? path + suffix : path] = { val, ts };
    };
    fn(createUpdater<T>(emit));
    if (!Object.keys(ops).length) return;
    this._pending = consolidateOps(this._pending, ops);
    this._store.state = this._rebuild();
    this._onUpdate?.();
  }

  /** Move pending to sending, return the Change to POST. Returns null if nothing to send. */
  _flush(): Change | null {
    if (this._sending || !Object.keys(this._pending).length) return null;
    this._sending = this._pending;
    this._sendingId = generateId();
    this._pending = {};
    return { id: this._sendingId, rev: this.rev, fields: this._sending };
  }

  /** Confirm a successful send. Merge sending into confirmed. */
  _confirmSend(rev: number) {
    if (!this._sending) return;
    for (const [key, field] of Object.entries(this._sending)) {
      const { suffix } = parseSuffix(key);
      if (suffix === TXT) {
        const base = this._confirmed[key]?.val ? new Delta(this._confirmed[key].val) : new Delta();
        this._confirmed[key] = { val: base.compose(new Delta(field.val)).ops, ts: field.ts };
      } else {
        this._confirmed[key] = mergeField(this._confirmed[key], field, suffix);
      }
    }
    this._sending = null;
    this._sendingId = null;
    this.rev = rev;
    this._store.state = this._rebuild();
  }

  /** Roll sending back into pending on failure. */
  _failSend() {
    if (!this._sending) return;
    this._pending = consolidateOps(this._sending, this._pending);
    this._sending = null;
    this._sendingId = null;
  }

  /** Apply remote fields from another client (via WS push). */
  applyRemote(fields: FieldMap, rev: number) {
    batch(() => {
      for (const [key, field] of Object.entries(fields)) {
        const { suffix } = parseSuffix(key);
        if (suffix === TXT) {
          const remote = new Delta(field.val);
          // Transform sending against remote
          if (this._sending?.[key]) {
            const s = new Delta(this._sending[key].val);
            this._sending[key] = { val: s.transform(remote, false).ops, ts: this._sending[key].ts };
            const rPrime = remote.transform(s, true);
            // Transform pending against transformed remote
            if (this._pending[key]) {
              const p = new Delta(this._pending[key].val);
              this._pending[key] = { val: p.transform(rPrime, false).ops, ts: this._pending[key].ts };
            }
          } else if (this._pending[key]) {
            const p = new Delta(this._pending[key].val);
            this._pending[key] = { val: p.transform(remote, false).ops, ts: this._pending[key].ts };
          }
          // Compose remote into confirmed
          const base = this._confirmed[key]?.val ? new Delta(this._confirmed[key].val) : new Delta();
          this._confirmed[key] = { val: base.compose(remote).ops, ts: field.ts };
        } else {
          this._confirmed[key] = field;
        }
      }
      this.rev = rev;
      this._store.state = this._rebuild();
    });
  }

  private _rebuild(): T {
    return buildState<T>(effectiveFields(this._confirmed, this._sending, this._pending));
  }
}
