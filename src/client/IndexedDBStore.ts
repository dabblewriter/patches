import { createId } from 'crypto-id';
import type {
  Branch,
  CreateBranchMetadata,
  EditableBranchMetadata,
  ListBranchesOptions,
  PatchesSnapshot,
  PatchesState,
  QuarantinedChange,
} from '../types.js';
import { deferred, type Deferred } from '../utils/deferred.js';
import { StorageTimeoutError, storageOpLabel, toStorageError } from '../net/error.js';
import { signal } from 'easy-signal';
import type { BranchClientStore } from './BranchClientStore.js';
import type { PatchesStore, TrackedDoc } from './PatchesStore.js';

/** Branch meta stored in IndexedDB, keyed by branch id */
interface StoredBranch extends Branch {
  /** Source docId index for querying all branches of a doc */
  _docId: string;
  /** Numeric pending flag for IndexedDB indexing (1 when pending, absent otherwise) */
  _pending?: 1;
}

/** Soft threshold: an operation still unsettled after this fires `onSlowStorage`. */
export const DEFAULT_SLOW_STORAGE_MS = 1000;
/** Hard threshold: an operation still unsettled after this is rejected with {@link StorageTimeoutError}. */
export const DEFAULT_STORAGE_TIMEOUT_MS = 4000;

/** Passed to `onSlowStorage` when an IndexedDB operation crosses the soft threshold without settling. */
export interface SlowStorageInfo {
  operation: 'open' | 'transaction' | 'delete';
  storeNames: string[];
  elapsedMs: number;
}

/**
 * Max-time guard options for IndexedDB opens, transactions, and deletes. Some machines have
 * IDB calls that never settle (no success, error, or abort event), silently losing every
 * write. A healthy operation settles in single-digit milliseconds, so these thresholds only
 * trip on a genuinely unsettled one. Ships enabled; omitting options uses the defaults.
 */
export interface StorageGuardOptions {
  /** Soft threshold in ms before `onSlowStorage` is invoked (no throw). Default {@link DEFAULT_SLOW_STORAGE_MS}. */
  slowStorageMs?: number;
  /** Hard threshold in ms before the operation is rejected with {@link StorageTimeoutError}. Default {@link DEFAULT_STORAGE_TIMEOUT_MS}. */
  storageTimeoutMs?: number;
  /** Invoked once per operation at the soft threshold. Defaults to a console.warn. */
  onSlowStorage?: (info: SlowStorageInfo) => void;
}

function warnSlowStorage({ operation, storeNames, elapsedMs }: SlowStorageInfo): void {
  console.warn(`${storageOpLabel(operation, storeNames)} still unsettled after ${elapsedMs}ms`);
}

interface StorageGuard {
  /** Push the hard deadline out to a full `storageTimeoutMs` from now. No-op once settled. */
  extend(): void;
  /** Stand down the hard timer only (observable activity owns the deadline); the soft timer stays. */
  clearHard(): void;
  /** Settled: clear all timers; `extend()` becomes a no-op. */
  clear(): void;
}

/**
 * Arm the soft/hard guard timers for one storage operation. The soft timer fires
 * `onSlowStorage` once; the hard timer invokes `onTimeout` with the elapsed ms.
 * `storeNames` is called lazily, only when a timer actually fires.
 */
function armStorageGuard(
  options: StorageGuardOptions | undefined,
  operation: SlowStorageInfo['operation'],
  storeNames: () => string[],
  onTimeout: (elapsedMs: number) => void
): StorageGuard {
  const started = Date.now();
  const timeoutMs = options?.storageTimeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS;
  let done = false;
  let slowTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    slowTimer = undefined;
    (options?.onSlowStorage ?? warnSlowStorage)({
      operation,
      storeNames: storeNames(),
      elapsedMs: Date.now() - started,
    });
  }, options?.slowStorageMs ?? DEFAULT_SLOW_STORAGE_MS);
  const fireHard = () => {
    hardTimer = undefined;
    onTimeout(Date.now() - started);
  };
  let hardTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(fireHard, timeoutMs);
  const clearHard = () => {
    if (hardTimer !== undefined) {
      clearTimeout(hardTimer);
      hardTimer = undefined;
    }
  };
  return {
    extend() {
      if (done) return;
      clearHard();
      hardTimer = setTimeout(fireHard, timeoutMs);
    },
    clearHard,
    clear() {
      done = true;
      clearHard();
      if (slowTimer !== undefined) {
        clearTimeout(slowTimer);
        slowTimer = undefined;
      }
    },
  };
}

/**
 * `IDBDatabase.transaction()` raises `InvalidStateError` in exactly one situation: the
 * connection is closing/closed (or an upgrade is mid-flight). Its other failures raise
 * `NotFoundError` / `InvalidAccessError` / `TypeError`, so matching the name is precise.
 * The browser puts a still-referenced connection into that "closing" state out from under
 * us when it suspends a backgrounded tab or worker (Safari does this aggressively —
 * DABBLE-WRITER-3-CA) or when a `versionchange` from another connection upgrades the DB.
 * The message wording varies by engine, so never match on it.
 */
function isConnectionClosingError(err: unknown): boolean {
  return err != null && (err as { name?: unknown }).name === 'InvalidStateError';
}

/**
 * IndexedDB store providing common database operations for all sync algorithms.
 *
 * Can be used as a standalone store or as a shared database connection
 * for multiple algorithm-specific stores (OT, LWW).
 *
 * Supports two modes:
 * - **Managed mode** (pass a `dbName`): Opens and owns the database lifecycle.
 * - **External mode** (pass an `IDBDatabase` or `Promise<IDBDatabase>`): Uses a
 *   caller-provided database. The caller owns the lifecycle; `close()` detaches
 *   without closing, `deleteDB()` is a no-op, and `setName()` throws.
 *
 * Provides:
 * - Database lifecycle management (open, close, delete)
 * - Transaction helpers
 * - Document tracking (listDocs, trackDocs, untrackDocs)
 * - Basic document operations (deleteDoc, confirmDeleteDoc)
 * - Revision tracking
 * - Extensibility via onUpgrade signal for algorithm-specific stores
 */
export class IndexedDBStore implements PatchesStore, BranchClientStore {
  private static readonly DB_VERSION = 2;

  /**
   * How long an `open` may sit `blocked` by another connection before waiters are rejected
   * rather than left waiting forever. Peers honoring `onversionchange` close in milliseconds,
   * so this only expires when one genuinely cannot (a suspended tab, an external connection
   * with no handler) — long enough not to fail an open that was about to succeed, short enough
   * that a stuck store surfaces as an error instead of a silent hang.
   */
  protected static readonly OPEN_BLOCKED_TIMEOUT_MS = 5_000;

  protected db: IDBDatabase | null = null;
  /**
   * Terminal flag set by `close()`/`deleteDB()`. Any reopen path (suspend recovery,
   * versionchange) nulls `this.db` before the async open completes, so a `close()` that
   * lands in that window would early-return on `if (!this.db)` and then get silently
   * resurrected by the open's `onsuccess`. Every reopen path checks this flag so a closed
   * store stays closed.
   */
  protected closed = false;
  protected dbName?: string;
  protected dbPromise: Deferred<IDBDatabase>;
  protected external: boolean;
  protected options: StorageGuardOptions;
  /**
   * Cancels the in-flight open's guard and blocked timers. Every reopen path (setName,
   * versionchange, suspend recovery) and close() must call this so a superseded open's
   * timers can never reject or replace the current `dbPromise`.
   */
  protected cancelOpenGuard?: () => void;
  protected requiredStores = new Set(['docs', 'snapshots', 'branches', 'quarantinedChanges']);

  /**
   * Signal emitted during database upgrade, allowing algorithm-specific stores
   * to create their object stores.
   */
  readonly onUpgrade = signal<(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction) => void>();

  constructor(dbOrName?: string | IDBDatabase | Promise<IDBDatabase>, options?: StorageGuardOptions) {
    this.options = options ?? {};
    this.dbPromise = deferred<IDBDatabase>();

    if (dbOrName != null && typeof dbOrName !== 'string') {
      // External mode: caller owns the database
      this.external = true;
      Promise.resolve(dbOrName).then(
        db => {
          // We can't self-heal an external database (the host owns its version), so warn
          // loudly instead of failing later with an opaque NotFoundError.
          const missing = [...this.requiredStores].filter(name => !db.objectStoreNames.contains(name));
          if (missing.length) {
            console.error(
              `External database "${db.name}" is missing object stores: ${missing.join(', ')}. ` +
                `Bump the database version so upgradePatchesDB runs and creates them.`
            );
          }
          this.db = db;
          this.dbPromise.resolve(db);
        },
        err => this.dbPromise.reject(err)
      );
    } else {
      // Managed mode: we open and own the database
      this.external = false;
      this.dbName = dbOrName;

      // Subscribe to own upgrade signal to create shared stores
      this.onUpgrade((db, _oldVersion, transaction) => {
        IndexedDBStore.upgradeSharedStores(db, transaction);
      });

      if (this.dbName) {
        this.initDB();
      }
    }
  }

  /**
   * Creates shared object stores (docs, snapshots, branches, quarantinedChanges) during
   * database upgrade.
   */
  static upgradeSharedStores(db: IDBDatabase, transaction: IDBTransaction): void {
    if (!db.objectStoreNames.contains('docs')) {
      const docsStore = db.createObjectStore('docs', { keyPath: 'docId' });
      docsStore.createIndex('algorithm', 'algorithm', { unique: false });
    }
    if (!db.objectStoreNames.contains('snapshots')) {
      db.createObjectStore('snapshots', { keyPath: 'docId' });
    }
    if (!db.objectStoreNames.contains('branches')) {
      const branchStore = db.createObjectStore('branches', { keyPath: 'id' });
      branchStore.createIndex('_docId', '_docId', { unique: false });
      branchStore.createIndex('_pending', '_pending', { unique: false });
    } else {
      const branchStore = transaction.objectStore('branches');
      if (!branchStore.indexNames.contains('_pending')) {
        branchStore.createIndex('_pending', '_pending', { unique: false });
      }
    }
    if (!db.objectStoreNames.contains('quarantinedChanges')) {
      db.createObjectStore('quarantinedChanges', { keyPath: ['docId', 'changeId'] });
    }
  }

  /**
   * Registers object stores that must exist after the database opens. Algorithm-specific
   * stores (OT, LWW) call this so a database first created by a factory with a different
   * algorithm set (same dbName, same version, so no upgrade fires) gets its missing stores
   * created via a version bump instead of failing every operation with NotFoundError.
   */
  requireStores(...names: string[]): void {
    for (const name of names) this.requiredStores.add(name);
  }

  /** Opens the database. `version: null` opens at whatever version currently exists. */
  protected async initDB(version: number | null = IndexedDBStore.DB_VERSION) {
    if (!this.dbName) return;
    // A superseded open's timers must never touch this open's promise.
    this.cancelOpenGuard?.();
    const request = indexedDB.open(this.dbName, version ?? undefined);
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const clearBlockedTimer = () => {
      if (blockedTimer !== undefined) {
        clearTimeout(blockedTimer);
        blockedTimer = undefined;
      }
    };

    // Max-time guard: on some machines `indexedDB.open` never settles with ANY event,
    // leaving `dbPromise` pending forever. On timeout, reject waiters and re-arm so late
    // arrivals also fail fast. The hard timer stands down for observable activity
    // (`blocked` has its own grace period below, `upgradeneeded` runs to success/error);
    // the soft timer stays until settle so any slow open reports.
    const guard = armStorageGuard(
      this.options,
      'open',
      () => [],
      elapsedMs => {
        if (this.closed) return;
        this.rejectOpenWaiters(new StorageTimeoutError('open', [], elapsedMs));
        guard.extend();
      }
    );
    this.cancelOpenGuard = () => {
      clearBlockedTimer();
      guard.clear();
    };

    // `blocked` fires when another connection still holds this database at an older version,
    // so our upgrade cannot proceed. Crucially it settles NOTHING: unlike `error` it is not
    // terminal (`success` still fires if the blocker closes), so without this handler
    // `dbPromise` can stay pending forever and EVERY read and write through this store hangs
    // silently — no error, no log, no recovery short of tearing down the worker.
    //
    // Failing immediately would be wrong: peers that run the `onversionchange` installed below
    // close within milliseconds, and that is the overwhelmingly common case. But nothing
    // GUARANTEES a peer ever closes — a suspended or backgrounded tab/worker may never run its
    // handler (Safari suspends aggressively — DABBLE-WRITER-3-CA), and an externally-provided
    // connection never gets `onversionchange` installed at all.
    //
    // So: give peers a grace period, then hand the current waiters an error — a rejection they
    // can retry or surface beats an unbounded wait — and install a fresh deferred for callers
    // that arrive later. If the blocker does eventually close, this same request's `onsuccess`
    // resolves that new deferred and the store heals with no reopen.
    request.onblocked = () => {
      clearBlockedTimer();
      // Observable state, not a silent hang: the grace period owns the deadline.
      guard.clearHard();
      blockedTimer = setTimeout(() => {
        blockedTimer = undefined;
        if (this.closed) return;
        this.rejectOpenWaiters(new Error(`IndexedDB open blocked for "${this.dbName}"`));
        // Re-arm the hard guard so callers arriving after this rejection also fail fast
        // if the open stays wedged, instead of parking forever on the fresh deferred.
        guard.extend();
      }, IndexedDBStore.OPEN_BLOCKED_TIMEOUT_MS);
    };

    request.onerror = () => {
      clearBlockedTimer();
      guard.clear();
      // A previous session bumped past DB_VERSION to add missing stores — reopen at the current version
      if (version !== null && request.error?.name === 'VersionError') {
        this.initDB(null);
      } else {
        this.dbPromise.reject(request.error);
        // A reopen (versionchange/suspend recovery) may have no awaiter, so a reopen that
        // fails on anything but the VersionError handled above (quota, corruption) would
        // surface as an unhandled rejection on an idle tab. Swallow it here; real getDB()
        // callers still receive the rejected promise. Mirrors close()'s guard.
        this.dbPromise.promise.catch(() => undefined);
      }
    };
    request.onsuccess = () => {
      clearBlockedTimer();
      guard.clear();
      const db = request.result;
      // close()/deleteDB() ran while this open was in flight. A reopen nulls this.db, so
      // that close() early-returned without settling this promise — honor the terminal close
      // instead of resurrecting the connection, and reject so any waiting reopen unblocks.
      if (this.closed) {
        db.close();
        this.dbPromise.reject(new Error('Store has been closed'));
        this.dbPromise.promise.catch(() => undefined);
        return;
      }
      // Missing stores mean the database was created without this store's upgrade
      // subscribers — bump the version so onupgradeneeded fires and creates them
      const missing = [...this.requiredStores].some(name => !db.objectStoreNames.contains(name));
      if (missing) {
        db.close();
        this.initDB(db.version + 1);
        return;
      }
      // Another connection (this store's own missing-stores bump, another tab, or a
      // deploy that raised DB_VERSION) needs to upgrade the database. Close proactively
      // so we don't block that upgrade, then drop our handle and reopen so the next
      // transaction() runs on the fresh connection instead of throwing InvalidStateError
      // on this now-closing one (DABBLE-WRITER-3-CA).
      db.onversionchange = () => {
        db.close();
        if (this.db === db && !this.closed) {
          this.db = null;
          this.dbPromise = deferred<IDBDatabase>();
          this.initDB();
        }
      };
      this.db = db;
      this.dbPromise.resolve(this.db);
    };

    request.onupgradeneeded = event => {
      // An upgrade is observable progress, and its transaction may legitimately run long
      // (index builds iterate every record): stand the hard deadline down like `blocked`
      // does and let success/error settle the open.
      clearBlockedTimer();
      guard.clearHard();
      const db = (event.target as IDBOpenDBRequest).result;
      const transaction = (event.target as IDBOpenDBRequest).transaction!;
      const oldVersion = event.oldVersion;

      // Emit to all subscribers (base + algorithm-specific stores)
      this.onUpgrade.emit(db, oldVersion, transaction);
    };
  }

  protected getDB(): Promise<IDBDatabase> {
    return this.dbPromise.promise;
  }

  /**
   * Reject current open waiters and install a fresh deferred, so a success that eventually
   * lands still heals the store. Shared by the hang-guard and blocked-grace expiries.
   */
  protected rejectOpenWaiters(err: Error): void {
    const waiting = this.dbPromise;
    this.dbPromise = deferred<IDBDatabase>();
    waiting.reject(err);
    waiting.promise.catch(() => undefined);
  }

  /**
   * Set the name of the database, loads a new database connection.
   * @param dbName - The new name of the database.
   * @throws When using an externally-provided database.
   */
  setName(dbName: string) {
    if (this.external) {
      throw new Error('Cannot set name on an externally-provided database');
    }
    this.dbName = dbName;
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = deferred<IDBDatabase>();
    }
    this.initDB();
  }

  /**
   * Closes the database connection. After calling this method, the store
   * will no longer be usable. A new instance must be created to reopen
   * the database.
   *
   * When using an externally-provided database, this detaches from the
   * database without closing it (the caller owns the lifecycle).
   */
  async close(): Promise<void> {
    // Mark terminal before any await so a reopen in flight (which has already nulled
    // this.db) can't resurrect the store via its open's onsuccess.
    this.closed = true;
    // An in-flight open's guard timers have nothing left to report or reject.
    this.cancelOpenGuard?.();
    if (!this.db) return;
    await this.dbPromise.promise;
    if (this.db) {
      if (!this.external) {
        this.db.close();
      }
      this.db = null;
      this.dbPromise = deferred();
      this.dbPromise.reject(new Error('Store has been closed'));
      // Nothing may ever await this promise again — swallow the rejection here so
      // close() doesn't produce a guaranteed unhandled rejection. Later getDB()
      // callers still receive the rejected promise.
      this.dbPromise.promise.catch(() => undefined);
    }
  }

  /**
   * Deletes the database. No-op when using an externally-provided database.
   */
  async deleteDB(): Promise<void> {
    if (this.external || !this.dbName) return;
    await this.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName!);
      const guard = armStorageGuard(
        this.options,
        'delete',
        () => [],
        elapsedMs => reject(new StorageTimeoutError('delete', [], elapsedMs))
      );
      request.onsuccess = () => {
        guard.clear();
        resolve();
      };
      request.onerror = () => {
        guard.clear();
        reject(toStorageError(request.error));
      };
      request.onblocked = () => {
        guard.clear();
        reject(request.error);
      };
    });
  }

  async transaction(
    storeNames: string[],
    mode: IDBTransactionMode
  ): Promise<[IDBTransactionWrapper, ...IDBStoreWrapper[]]> {
    const tx = new IDBTransactionWrapper(await this.beginTransaction(storeNames, mode), this.options);
    const stores = storeNames.map(name => tx.getStore(name));
    return [tx, ...stores];
  }

  /**
   * Open a raw `IDBTransaction`, transparently recovering from a connection the browser
   * closed out from under us. `db.transaction()` throws `InvalidStateError` only when the
   * connection is closing/closed (see `isConnectionClosingError`); we never intend that —
   * our own `close()` nulls `this.db`, so `getDB()` would already reject with "Store has
   * been closed". So the browser suspended a backgrounded tab/worker (Safari does this
   * aggressively — DABBLE-WRITER-3-CA) or a `versionchange` closed us: drop the stale
   * handle, reopen, and retry once. In managed mode the fresh connection lets the write
   * survive instead of surfacing as a failed change round-trip; if the reopen also fails
   * (genuine teardown / page unload) the error propagates. External databases are never
   * reopened — the host owns that connection's lifecycle — so their errors always propagate.
   */
  private async beginTransaction(
    storeNames: string[],
    mode: IDBTransactionMode,
    reopened = false
  ): Promise<IDBTransaction> {
    const db = await this.getDB();
    try {
      return db.transaction(storeNames, mode);
    } catch (err) {
      if (reopened || this.external || !this.dbName || !isConnectionClosingError(err)) throw err;
      // Only reopen the connection we just found dead; a concurrent caller may have already
      // swapped in a fresh one, in which case just retry against that. Never reopen once
      // close() has run — the retry below then rejects with "Store has been closed".
      if (this.db === db && !this.closed) {
        this.db = null;
        this.dbPromise = deferred<IDBDatabase>();
        this.initDB();
      }
      return this.beginTransaction(storeNames, mode, true);
    }
  }

  /** Whether the open database contains the named object store (it may not on an external-mode database the host hasn't upgraded). */
  async hasStore(name: string): Promise<boolean> {
    return (await this.getDB()).objectStoreNames.contains(name);
  }

  // ─── Quarantine (shared store) ────────────────────────────────────────────
  // `quarantinedChanges` is one shared object store created here, so list/discard live
  // here once and the algorithm stores delegate — a per-algorithm copy of these bodies
  // is how the hasStore guard drifted between OT and LWW.

  /**
   * List quarantined changes for one doc, or all docs when docId is omitted. Entries from
   * every algorithm over this database appear here (the store is shared). Absent store
   * (an external-mode database whose host hasn't bumped its version) returns [].
   */
  async listQuarantinedChanges(docId?: string): Promise<QuarantinedChange[]> {
    if (!(await this.hasStore('quarantinedChanges'))) return [];
    const [tx, quarantined] = await this.transaction(['quarantinedChanges'], 'readonly');
    const entries =
      docId !== undefined
        ? await quarantined.getAll<QuarantinedChange>([docId, ''], [docId, '￿'])
        : await quarantined.getAll<QuarantinedChange>();
    await tx.complete();
    return entries;
  }

  /** Permanently remove a quarantined change. Absent store is a no-op (nothing could have been quarantined). */
  async discardQuarantinedChange(docId: string, changeId: string): Promise<void> {
    if (!(await this.hasStore('quarantinedChanges'))) return;
    const [tx, quarantined] = await this.transaction(['quarantinedChanges'], 'readwrite');
    await quarantined.delete([docId, changeId]);
    await tx.complete();
  }

  // ─── Algorithm-Specific Methods ──────────────────────────────────────────
  // These are implemented by algorithm-specific stores (OT, LWW)

  /**
   * Retrieves the current document snapshot from storage.
   * Implementation varies by sync algorithm (OT vs LWW).
   * This base implementation throws an error - override in algorithm-specific stores.
   */
  async getDoc(_docId: string): Promise<PatchesSnapshot | undefined> {
    throw new Error('getDoc must be implemented by algorithm-specific store');
  }

  /**
   * Saves the current document state to persistent storage.
   * Implementation varies by sync algorithm.
   * This base implementation throws an error - override in algorithm-specific stores.
   */
  async saveDoc(_docId: string, _docState: PatchesState): Promise<void> {
    throw new Error('saveDoc must be implemented by algorithm-specific store');
  }

  /**
   * Completely remove all data for this docId and mark it as deleted (tombstone).
   * This base implementation throws an error - override in algorithm-specific stores.
   */
  async deleteDoc(_docId: string): Promise<void> {
    throw new Error('deleteDoc must be implemented by algorithm-specific store');
  }

  /**
   * Confirm the deletion of a document.
   * @param docId - The ID of the document to delete.
   */
  async confirmDeleteDoc(docId: string): Promise<void> {
    const [tx, docsStore] = await this.transaction(['docs'], 'readwrite');
    await docsStore.delete(docId);
    await tx.complete();
  }

  /**
   * List all documents in the store.
   * @param includeDeleted - Whether to include deleted documents.
   * @param algorithm - Optional algorithm filter ('ot' or 'lww'). If provided, uses index for efficient filtering.
   * @returns The list of documents.
   */
  async listDocs(includeDeleted = false, algorithm?: 'ot' | 'lww'): Promise<TrackedDoc[]> {
    const [tx, docsStore] = await this.transaction(['docs'], 'readonly');

    let docs: TrackedDoc[];

    if (algorithm) {
      docs = await docsStore.getAllByIndex<TrackedDoc>('algorithm', algorithm);
    } else {
      // No filter - get all docs
      docs = await docsStore.getAll<TrackedDoc>();
    }

    await tx.complete();
    return includeDeleted ? docs : docs.filter(doc => !doc.deleted);
  }

  /**
   * Track a document.
   * @param docIds - The IDs of the documents to track.
   * @param algorithm - The algorithm to use for this document.
   */
  async trackDocs(docIds: string[], algorithm?: 'ot' | 'lww'): Promise<void> {
    const [tx, docsStore] = await this.transaction(['docs'], 'readwrite');
    await Promise.all(
      docIds.map(async docId => {
        const existing = await docsStore.get<TrackedDoc>(docId);
        if (existing) {
          // If exists but deleted, undelete it, reset committedRev (data was
          // wiped by deleteDoc), and update algorithm if provided
          if (existing.deleted) {
            await docsStore.put({
              ...existing,
              committedRev: 0,
              deleted: undefined,
              ...(algorithm && { algorithm }),
            });
          } else if (algorithm && existing.algorithm !== algorithm) {
            // Update algorithm if provided and different
            await docsStore.put({ ...existing, algorithm });
          }
          // Otherwise, it's already tracked and not deleted, do nothing
        } else {
          // If doesn't exist, add it
          await docsStore.put({ docId, committedRev: 0, ...(algorithm && { algorithm }) });
        }
      })
    );
    await tx.complete();
  }

  /**
   * Untrack a document.
   * @param docIds - The IDs of the documents to untrack.
   * This base implementation throws an error - override in algorithm-specific stores.
   */
  async untrackDocs(_docIds: string[]): Promise<void> {
    throw new Error('untrackDocs must be implemented by algorithm-specific store');
  }

  /**
   * Returns the last committed revision for a document.
   * @param docId - The ID of the document.
   * @returns The last committed revision, or 0 if not found.
   */
  async getCommittedRev(docId: string): Promise<number> {
    const [tx, docsStore] = await this.transaction(['docs'], 'readonly');
    const docMeta = await docsStore.get<TrackedDoc>(docId);
    await tx.complete();
    return docMeta?.committedRev ?? 0;
  }

  // ─── Branch Methods (BranchClientStore) ─────────────────────────────────

  // --- BranchAPI-compatible methods ---

  async listBranches(docId: string, _options?: ListBranchesOptions): Promise<Branch[]> {
    const [tx, branchStore] = await this.transaction(['branches'], 'readonly');
    const results = await branchStore.getAllByIndex<StoredBranch>('_docId', docId);
    await tx.complete();
    return results.filter(b => !b.deleted).map(stripInternal);
  }

  async createBranch(docId: string, rev: number, metadata?: CreateBranchMetadata): Promise<string> {
    const branchDocId = metadata?.id ?? createId(22);
    const now = Date.now();
    const branch: Branch = {
      ...metadata,
      id: branchDocId,
      docId,
      branchedAtRev: rev,
      contentStartRev: metadata?.contentStartRev ?? 0,
      createdAt: now,
      modifiedAt: now,
      pendingOp: 'create',
    };
    await this._saveBranch(docId, branch);
    return branchDocId;
  }

  async deleteBranch(branchId: string): Promise<void> {
    const [tx, branchStore] = await this.transaction(['branches'], 'readwrite');
    const existing = await branchStore.get<StoredBranch>(branchId);
    if (!existing) throw new Error(`Branch ${branchId} not found`);

    if (existing.pendingOp === 'create') {
      // Never synced — just remove it, no server call needed
      await branchStore.delete(branchId);
    } else {
      // Save as a tombstone for PatchesSync to delete on the server
      const tombstone: StoredBranch = {
        ...existing,
        modifiedAt: Date.now(),
        pendingOp: 'delete',
        deleted: true,
        _pending: 1,
      };
      await branchStore.put<StoredBranch>(tombstone);
    }
    await tx.complete();
  }

  async updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void> {
    const [tx, branchStore] = await this.transaction(['branches'], 'readwrite');
    const existing = await branchStore.get<StoredBranch>(branchId);
    if (!existing) throw new Error(`Branch ${branchId} not found`);
    Object.assign(existing, metadata);
    existing.modifiedAt = Date.now();
    // If never synced, keep pendingOp as 'create'
    if (existing.pendingOp !== 'create') existing.pendingOp = 'update';
    existing._pending = 1;
    await branchStore.put<StoredBranch>(existing);
    await tx.complete();
  }

  // --- Internal methods ---

  async loadBranch(branchId: string): Promise<Branch | undefined> {
    const [tx, branchStore] = await this.transaction(['branches'], 'readonly');
    const result = await branchStore.get<StoredBranch>(branchId);
    await tx.complete();
    return result ? stripInternal(result) : undefined;
  }

  // --- Sync-facing methods ---

  async saveBranches(docId: string, branches: Branch[]): Promise<void> {
    if (branches.length === 0) return;
    const [tx, branchStore] = await this.transaction(['branches'], 'readwrite');
    await Promise.all(
      branches.map(async branch => {
        const existing = await branchStore.get<StoredBranch>(branch.id);

        // Don't overwrite branches with pending local operations — the pending op
        // hasn't been synced yet and server data is stale relative to the local mutation.
        if (existing?.pendingOp && !branch.pendingOp) return;

        const stored: StoredBranch = { ...branch, _docId: docId };
        // lastMergedRev max-wins: two clients may merge the same branch independently,
        // so always keep the higher value to avoid rolling back merge progress.
        if (
          existing?.lastMergedRev != null &&
          (stored.lastMergedRev == null || existing.lastMergedRev > stored.lastMergedRev)
        ) {
          stored.lastMergedRev = existing.lastMergedRev;
        }
        if (branch.pendingOp) stored._pending = 1;
        return branchStore.put<StoredBranch>(stored);
      })
    );
    await tx.complete();
  }

  async removeBranches(branchIds: string[]): Promise<void> {
    if (branchIds.length === 0) return;
    const [tx, branchStore] = await this.transaction(['branches'], 'readwrite');
    await Promise.all(branchIds.map(id => branchStore.delete(id)));
    await tx.complete();
  }

  async listPendingBranches(): Promise<Branch[]> {
    const [tx, branchStore] = await this.transaction(['branches'], 'readonly');
    const results = await branchStore.getAllByIndex<StoredBranch>('_pending', 1);
    await tx.complete();
    return results.map(stripInternal);
  }

  async getLastModifiedAt(docId: string): Promise<number | undefined> {
    const [tx, branchStore] = await this.transaction(['branches'], 'readonly');
    const branches = await branchStore.getAllByIndex<StoredBranch>('_docId', docId);
    await tx.complete();

    if (branches.length === 0) return undefined;

    let max = 0;
    for (const b of branches) {
      if (!b.pendingOp && !b.deleted && b.modifiedAt > max) max = b.modifiedAt;
    }
    return max || undefined;
  }

  // --- Private helpers ---

  private async _saveBranch(docId: string, branch: Branch): Promise<void> {
    const [tx, branchStore] = await this.transaction(['branches'], 'readwrite');
    const stored: StoredBranch = { ...branch, _docId: docId };
    if (branch.pendingOp) stored._pending = 1;
    await branchStore.put<StoredBranch>(stored);
    await tx.complete();
  }
}

/** Strip internal IndexedDB fields from stored branch */
function stripInternal(stored: StoredBranch): Branch {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _docId, _pending, ...branch } = stored;
  return branch;
}

export class IDBTransactionWrapper {
  protected tx: IDBTransaction;
  protected promise: Promise<void>;
  /**
   * Rejects when the transaction fails or times out; never resolves. Store wrappers race
   * their requests against it so a request that never settles still rejects with the
   * transaction's typed error instead of parking its caller forever.
   */
  protected failure: Promise<never>;
  /** Called by store wrappers on every request settle; a settling request is progress, not a hang. */
  protected extendDeadline: () => void;

  constructor(tx: IDBTransaction, options?: StorageGuardOptions) {
    this.tx = tx;
    const storeNames = () => Array.from(tx.objectStoreNames ?? []);
    let guard!: StorageGuard;
    this.promise = new Promise((resolve, reject) => {
      // Max-time guard: some machines have transactions that never fire ANY of the settle
      // events below. Every request settle extends the hard deadline, so a bulk transaction
      // still making progress is never aborted; only a genuinely stalled one times out.
      guard = armStorageGuard(options, 'transaction', storeNames, elapsedMs => {
        guard.clear();
        // Reject BEFORE aborting so the typed timeout wins over the AbortError the abort
        // fires (the later onabort reject is a no-op on the settled promise).
        reject(new StorageTimeoutError('transaction', storeNames(), elapsedMs));
        try {
          tx.abort();
        } catch {
          // Connection already dead/finished; nothing left to abort.
        }
      });
      tx.oncomplete = () => {
        guard.clear();
        resolve();
      };
      tx.onerror = () => {
        guard.clear();
        reject(toStorageError(tx.error));
      };
      // A transaction that aborts at commit — notably under quota pressure — can fire ONLY
      // `onabort` (with `tx.error` set) and no `onerror`, which would otherwise leave this
      // promise pending forever. Reject on abort too, routing a storage-fault abort through the
      // same typed StorageError; a plain user/teardown AbortError passes through untouched (and
      // whichever of onerror/onabort fires first wins — the second reject is a no-op).
      tx.onabort = () => {
        guard.clear();
        reject(toStorageError(tx.error));
      };
    });
    this.extendDeadline = () => guard.extend();
    this.failure = new Promise<never>((_, reject) => this.promise.catch(reject));
    // The failure promise may have no racers when the transaction settles (or nobody ever
    // awaits complete()); swallow so it can't surface as an unhandled rejection.
    this.failure.catch(() => undefined);
  }

  getStore(name: string): IDBStoreWrapper {
    return new IDBStoreWrapper(this.tx.objectStore(name), this.failure, this.extendDeadline);
  }

  async complete(): Promise<void> {
    return this.promise;
  }
}

export class IDBStoreWrapper {
  protected store: IDBObjectStore;
  protected failure?: Promise<never>;
  protected onSettle?: () => void;

  constructor(store: IDBObjectStore, failure?: Promise<never>, onSettle?: () => void) {
    this.store = store;
    this.failure = failure;
    this.onSettle = onSettle;
  }

  protected createRange(lower?: any, upper?: any): IDBKeyRange | undefined {
    if (lower === undefined && upper === undefined) return undefined;
    return IDBKeyRange.bound(lower, upper);
  }

  /**
   * Issue a request, racing it against the owning transaction's failure so a request that
   * never fires success OR error still rejects with the transaction's typed error instead
   * of parking its caller forever. Each settle extends the transaction's hard deadline.
   */
  protected run<T>(makeRequest: () => IDBRequest, map?: (result: any) => T): Promise<T> {
    const request = new Promise<T>((resolve, reject) => {
      const req = makeRequest();
      req.onsuccess = () => {
        this.onSettle?.();
        resolve(map ? map(req.result) : req.result);
      };
      req.onerror = () => {
        this.onSettle?.();
        reject(toStorageError(req.error));
      };
    });
    if (!this.failure) return request;
    // A request rejection landing after the race was lost (e.g. the AbortError from the
    // guard's tx.abort()) must not surface as an unhandled rejection.
    request.catch(() => undefined);
    return Promise.race([request, this.failure]);
  }

  async getAll<T>(lower?: any, upper?: any, count?: number): Promise<T[]> {
    return this.run(() => this.store.getAll(this.createRange(lower, upper), count));
  }

  async getAllByIndex<T>(indexName: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
    return this.run(() => this.store.index(indexName).getAll(query));
  }

  async get<T>(key: IDBValidKey): Promise<T | undefined> {
    return this.run(() => this.store.get(key));
  }

  async put<T>(value: T): Promise<IDBValidKey> {
    return this.run(() => this.store.put(value));
  }

  async delete(key: IDBValidKey): Promise<void>;
  async delete(lower: any, upper: any): Promise<void>;
  async delete(keyOrLower: IDBValidKey | any, upper?: any): Promise<void> {
    return this.run(() => this.store.delete(upper === undefined ? keyOrLower : this.createRange(keyOrLower, upper)));
  }

  async count(lower?: any, upper?: any): Promise<number> {
    return this.run(() => this.store.count(this.createRange(lower, upper)));
  }

  async getFirstFromCursor<T>(lower?: any, upper?: any): Promise<T | undefined> {
    return this.run(
      () => this.store.openCursor(this.createRange(lower, upper)),
      cursor => cursor?.value
    );
  }

  async getLastFromCursor<T>(lower?: any, upper?: any): Promise<T | undefined> {
    return this.run(
      () => this.store.openCursor(this.createRange(lower, upper), 'prev'),
      cursor => cursor?.value
    );
  }
}
