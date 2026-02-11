import type { PatchesSnapshot, PatchesState } from '../types.js';
import { deferred, type Deferred } from '../utils/deferred.js';
import { signal } from '../event-signal.js';
import type { PatchesStore, TrackedDoc } from './PatchesStore.js';

/**
 * IndexedDB store providing common database operations for all sync algorithms.
 *
 * Can be used as a standalone store or as a shared database connection
 * for multiple algorithm-specific stores (OT, LWW).
 *
 * Provides:
 * - Database lifecycle management (open, close, delete)
 * - Transaction helpers
 * - Document tracking (listDocs, trackDocs, untrackDocs)
 * - Basic document operations (deleteDoc, confirmDeleteDoc)
 * - Revision tracking
 * - Extensibility via onUpgrade signal for algorithm-specific stores
 */
export class IndexedDBStore implements PatchesStore {
  private static readonly DB_VERSION = 1;

  protected db: IDBDatabase | null = null;
  protected dbName?: string;
  protected dbPromise: Deferred<IDBDatabase>;

  /**
   * Signal emitted during database upgrade, allowing algorithm-specific stores
   * to create their object stores.
   */
  readonly onUpgrade = signal<(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction) => void>();

  constructor(dbName?: string) {
    this.dbName = dbName;
    this.dbPromise = deferred<IDBDatabase>();

    // Subscribe to own upgrade signal to create shared stores
    this.onUpgrade((db, oldVersion, transaction) => {
      this.createSharedStores(db, oldVersion, transaction);
    });

    if (this.dbName) {
      this.initDB();
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
   */
  setName(dbName: string) {
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
   */
  async close(): Promise<void> {
    await this.dbPromise.promise;
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = deferred();
      this.dbPromise.reject(new Error('Store has been closed'));
    }
  }

  async deleteDB(): Promise<void> {
    if (!this.dbName) return;
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

    if (algorithm === 'lww') {
      // LWW: only get docs explicitly marked as LWW
      docs = await docsStore.getAllByIndex<TrackedDoc>('algorithm', 'lww');
    } else if (algorithm === 'ot') {
      // OT: get both OT docs AND docs with no algorithm (backward compatibility)
      const otDocs = await docsStore.getAllByIndex<TrackedDoc>('algorithm', 'ot');
      const allDocs = await docsStore.getAll<TrackedDoc>();
      const noAlgoDocs = allDocs.filter(doc => !doc.algorithm);
      docs = [...otDocs, ...noAlgoDocs];
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
