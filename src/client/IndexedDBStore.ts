import type { PatchesSnapshot, PatchesState } from '../types.js';
import { deferred, type Deferred } from '../utils/deferred.js';
import type { PatchesStore, TrackedDoc } from './PatchesStore.js';

/**
 * Abstract base class for IndexedDB-based stores implementing PatchesStore.
 *
 * Provides common functionality for IndexedDB operations:
 * - Database lifecycle management (open, close, delete)
 * - Transaction helpers
 * - Document tracking (listDocs, trackDocs, untrackDocs)
 * - Basic document operations (deleteDoc, confirmDeleteDoc)
 * - Revision tracking
 *
 * Subclasses must implement strategy-specific methods for document
 * state management and change handling.
 */
export abstract class IndexedDBStore implements PatchesStore {
  protected db: IDBDatabase | null = null;
  protected dbName?: string;
  protected dbPromise: Deferred<IDBDatabase>;

  constructor(dbName?: string) {
    this.dbName = dbName;
    this.dbPromise = deferred<IDBDatabase>();
    if (this.dbName) {
      this.initDB();
    }
  }

  /**
   * Returns the database version for this store.
   * Subclasses should return their specific version number.
   */
  protected abstract getDBVersion(): number;

  /**
   * Hook for subclasses to create strategy-specific object stores.
   * Called during database upgrade.
   *
   * @param db - The IDBDatabase instance
   * @param oldVersion - The previous database version
   */
  protected abstract onUpgrade(db: IDBDatabase, oldVersion: number): void;

  protected async initDB() {
    if (!this.dbName) return;
    const request = indexedDB.open(this.dbName, this.getDBVersion());

    request.onerror = () => this.dbPromise.reject(request.error);
    request.onsuccess = () => {
      this.db = request.result;
      this.dbPromise.resolve(this.db);
    };

    request.onupgradeneeded = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      // Create base stores used by all strategies
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'docId' });
      }
      if (!db.objectStoreNames.contains('docs')) {
        db.createObjectStore('docs', { keyPath: 'docId' });
      }

      // Allow subclasses to create their specific stores
      this.onUpgrade(db, oldVersion);
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
      this.dbPromise.resolve(null as any);
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

  protected async transaction(
    storeNames: string[],
    mode: IDBTransactionMode
  ): Promise<[IDBTransactionWrapper, ...IDBStoreWrapper[]]> {
    const db = await this.getDB();
    const tx = new IDBTransactionWrapper(db.transaction(storeNames, mode));
    const stores = storeNames.map(name => tx.getStore(name));
    return [tx, ...stores];
  }

  // ─── Abstract Methods (Strategy-Specific) ─────────────────────────────────

  /**
   * Retrieves the current document snapshot from storage.
   * Implementation varies by sync strategy (OT vs LWW).
   */
  abstract getDoc(docId: string): Promise<PatchesSnapshot | undefined>;

  /**
   * Saves the current document state to persistent storage.
   * Implementation varies by sync strategy.
   */
  abstract saveDoc(docId: string, docState: PatchesState): Promise<void>;

  // ─── Common Methods ───────────────────────────────────────────────────────

  /**
   * Completely remove all data for this docId and mark it as deleted (tombstone).
   */
  abstract deleteDoc(docId: string): Promise<void>;

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
   * @returns The list of documents.
   */
  async listDocs(includeDeleted = false): Promise<TrackedDoc[]> {
    const [tx, docsStore] = await this.transaction(['docs'], 'readonly');
    const allDocs = await docsStore.getAll<TrackedDoc>();
    await tx.complete();
    return includeDeleted ? allDocs : allDocs.filter(doc => !doc.deleted);
  }

  /**
   * Track a document.
   * @param docIds - The IDs of the documents to track.
   */
  async trackDocs(docIds: string[]): Promise<void> {
    const [tx, docsStore] = await this.transaction(['docs'], 'readwrite');
    await Promise.all(
      docIds.map(async docId => {
        const existing = await docsStore.get<TrackedDoc>(docId);
        if (existing) {
          // If exists but deleted, undelete it
          if (existing.deleted) {
            await docsStore.put({ ...existing, deleted: undefined });
          }
          // Otherwise, it's already tracked and not deleted, do nothing
        } else {
          // If doesn't exist, add it
          await docsStore.put({ docId, committedRev: 0 });
        }
      })
    );
    await tx.complete();
  }

  /**
   * Untrack a document.
   * @param docIds - The IDs of the documents to untrack.
   */
  abstract untrackDocs(docIds: string[]): Promise<void>;

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
