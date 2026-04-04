import { createId } from 'crypto-id';
import type {
  Branch,
  CreateBranchMetadata,
  EditableBranchMetadata,
  ListBranchesOptions,
  PatchesSnapshot,
  PatchesState,
} from '../types.js';
import { deferred, type Deferred } from '../utils/deferred.js';
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

  protected db: IDBDatabase | null = null;
  protected dbName?: string;
  protected dbPromise: Deferred<IDBDatabase>;
  protected external: boolean;

  /**
   * Signal emitted during database upgrade, allowing algorithm-specific stores
   * to create their object stores.
   */
  readonly onUpgrade = signal<(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction) => void>();

  constructor(dbOrName?: string | IDBDatabase | Promise<IDBDatabase>) {
    this.dbPromise = deferred<IDBDatabase>();

    if (dbOrName != null && typeof dbOrName !== 'string') {
      // External mode: caller owns the database
      this.external = true;
      Promise.resolve(dbOrName).then(
        db => {
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
      this.onUpgrade((db, oldVersion, transaction) => {
        this.createSharedStores(db, oldVersion, transaction);
      });

      if (this.dbName) {
        this.initDB();
      }
    }
  }

  /**
   * Creates all Patches object stores in an externally-managed database.
   * Call this from your `onupgradeneeded` handler when hosting Patches stores
   * inside your own IndexedDB database.
   */
  static upgrade(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction): void {
    // Shared stores
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

    // OT stores
    if (!db.objectStoreNames.contains('committedChanges')) {
      db.createObjectStore('committedChanges', { keyPath: ['docId', 'rev'] });
    }
    if (!db.objectStoreNames.contains('pendingChanges')) {
      db.createObjectStore('pendingChanges', { keyPath: ['docId', 'rev'] });
    }

    // LWW stores
    if (!db.objectStoreNames.contains('committedOps')) {
      db.createObjectStore('committedOps', { keyPath: ['docId', 'path'] });
    }
    if (!db.objectStoreNames.contains('pendingOps')) {
      db.createObjectStore('pendingOps', { keyPath: ['docId', 'path'] });
    }
    if (!db.objectStoreNames.contains('sendingChanges')) {
      db.createObjectStore('sendingChanges', { keyPath: 'docId' });
    }
  }

  /**
   * Creates shared object stores used by all sync algorithms.
   */
  protected createSharedStores(db: IDBDatabase, _oldVersion: number, _transaction: IDBTransaction): void {
    // Create docs store
    if (!db.objectStoreNames.contains('docs')) {
      const docsStore = db.createObjectStore('docs', { keyPath: 'docId' });
      // Create index on algorithm field for efficient filtering
      docsStore.createIndex('algorithm', 'algorithm', { unique: false });
    }

    // Create snapshots store
    if (!db.objectStoreNames.contains('snapshots')) {
      db.createObjectStore('snapshots', { keyPath: 'docId' });
    }

    // Create branches store
    if (!db.objectStoreNames.contains('branches')) {
      const branchStore = db.createObjectStore('branches', { keyPath: 'id' });
      branchStore.createIndex('_docId', '_docId', { unique: false });
      branchStore.createIndex('_pending', '_pending', { unique: false });
    } else {
      // Upgrade path: add _pending index to existing branches store
      const branchStore = _transaction.objectStore('branches');
      if (!branchStore.indexNames.contains('_pending')) {
        branchStore.createIndex('_pending', '_pending', { unique: false });
      }
    }
  }

  protected async initDB() {
    if (!this.dbName) return;
    const request = indexedDB.open(this.dbName, IndexedDBStore.DB_VERSION);

    request.onerror = () => this.dbPromise.reject(request.error);
    request.onsuccess = () => {
      this.db = request.result;
      this.dbPromise.resolve(this.db);
    };

    request.onupgradeneeded = event => {
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
    await this.dbPromise.promise;
    if (this.db) {
      if (!this.external) {
        this.db.close();
      }
      this.db = null;
      this.dbPromise = deferred();
      this.dbPromise.reject(new Error('Store has been closed'));
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
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(request.error);
    });
  }

  async transaction(
    storeNames: string[],
    mode: IDBTransactionMode
  ): Promise<[IDBTransactionWrapper, ...IDBStoreWrapper[]]> {
    const db = await this.getDB();
    const tx = new IDBTransactionWrapper(db.transaction(storeNames, mode));
    const stores = storeNames.map(name => tx.getStore(name));
    return [tx, ...stores];
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
          // If exists but deleted, undelete it and update algorithm if provided
          if (existing.deleted) {
            await docsStore.put({
              ...existing,
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

  constructor(tx: IDBTransaction) {
    this.tx = tx;
    this.promise = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  getStore(name: string): IDBStoreWrapper {
    return new IDBStoreWrapper(this.tx.objectStore(name));
  }

  async complete(): Promise<void> {
    return this.promise;
  }
}

export class IDBStoreWrapper {
  protected store: IDBObjectStore;

  constructor(store: IDBObjectStore) {
    this.store = store;
  }

  protected createRange(lower?: any, upper?: any): IDBKeyRange | undefined {
    if (lower === undefined && upper === undefined) return undefined;
    return IDBKeyRange.bound(lower, upper);
  }

  async getAll<T>(lower?: any, upper?: any, count?: number): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const request = this.store.getAll(this.createRange(lower, upper), count);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllByIndex<T>(indexName: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const index = this.store.index(indexName);
      const request = index.getAll(query);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get<T>(key: IDBValidKey): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const request = this.store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async put<T>(value: T): Promise<IDBValidKey> {
    return new Promise((resolve, reject) => {
      const request = this.store.put(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async delete(key: IDBValidKey): Promise<void>;
  async delete(lower: any, upper: any): Promise<void>;
  async delete(keyOrLower: IDBValidKey | any, upper?: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const key = upper === undefined ? keyOrLower : this.createRange(keyOrLower, upper);
      const request = this.store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async count(lower?: any, upper?: any): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = this.store.count(this.createRange(lower, upper));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getFirstFromCursor<T>(lower?: any, upper?: any): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const request = this.store.openCursor(this.createRange(lower, upper));
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
  }

  async getLastFromCursor<T>(lower?: any, upper?: any): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const request = this.store.openCursor(this.createRange(lower, upper), 'prev');
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
  }
}
