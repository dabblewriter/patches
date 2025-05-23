import { transformPatch } from '../json-patch/transformPatch.js';
import type { Change, Deferred, PatchesSnapshot, PatchesState } from '../types.js';
import { applyChanges, deferred } from '../utils.js';
import type { PatchesStore, TrackedDoc } from './PatchesStore.js';

const DB_VERSION = 1;
const SNAPSHOT_INTERVAL = 200;

interface Snapshot {
  docId: string;
  state: any;
  rev: number;
}

interface StoredChange extends Change {
  docId: string;
}

/**
 * Creates a new IndexedDB database with stores:
 * - snapshots<{ docId: string; rev: number; state: any }> (primary key: docId)
 * - committedChanges<Change & { docId: string; }> (primary key: [docId, rev])
 * - pendingChanges<Change & { docId: string; }> (primary key: [docId, rev])
 * - docs<{ docId: string; committedRev: number; deleted?: boolean }> (primary key: docId)
 *
 * Under the hood, this class will store snapshots of the document only for committed state. It will not update the
 * committed state on *every* received committed change as this can cause issues with IndexedDB with many large updates.
 * After every 200 committed changes, the class will save the current state to the snapshot store and delete the committed changes that went into it.
 * A snapshot will not be created if there are pending changes based on revisions older than the 200th committed change until those pending changes are committed.
 */
export class IndexedDBStore implements PatchesStore {
  private db: IDBDatabase | null = null;
  private dbName?: string;
  private dbPromise: Deferred<IDBDatabase>;

  constructor(dbName?: string) {
    this.dbName = dbName;
    this.dbPromise = deferred<IDBDatabase>();
    if (this.dbName) {
      this.initDB();
    }
  }

  private async initDB() {
    if (!this.dbName) return;
    const request = indexedDB.open(this.dbName, DB_VERSION);

    request.onerror = () => this.dbPromise.reject(request.error);
    request.onsuccess = () => {
      this.db = request.result;
      this.dbPromise.resolve(this.db);
    };

    request.onupgradeneeded = event => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create stores
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'docId' });
      }
      if (!db.objectStoreNames.contains('committedChanges')) {
        db.createObjectStore('committedChanges', { keyPath: ['docId', 'rev'] });
      }
      if (!db.objectStoreNames.contains('pendingChanges')) {
        db.createObjectStore('pendingChanges', { keyPath: ['docId', 'rev'] });
      }
      if (!db.objectStoreNames.contains('docs')) {
        db.createObjectStore('docs', { keyPath: 'docId' });
      }
    };
  }

  private getDB(): Promise<IDBDatabase> {
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

  private async transaction(
    storeNames: string[],
    mode: IDBTransactionMode
  ): Promise<[IDBTransactionWrapper, ...IDBStoreWrapper[]]> {
    const db = await this.getDB();
    const tx = new IDBTransactionWrapper(db.transaction(storeNames, mode));
    const stores = storeNames.map(name => tx.getStore(name));
    return [tx, ...stores];
  }

  // ─── Snapshots + Reconstruction ────────────────────────────────────────────

  /**
   * Rebuilds a document snapshot + pending queue *without* loading
   * the full PatchesDoc into memory.
   *
   * 1. load the last snapshot (state + rev)
   * 2. load committedChanges[rev > snapshot.rev]
   * 3. load pendingChanges
   * 4. apply committed changes, rebase pending
   * 5. return { state, rev, changes: pending }
   */
  async getDoc(docId: string): Promise<PatchesSnapshot | undefined> {
    const [tx, docsStore, snapshots, committedChanges, pendingChanges] = await this.transaction(
      ['docs', 'snapshots', 'committedChanges', 'pendingChanges'],
      'readonly'
    );

    const docMeta = await docsStore.get<TrackedDoc>(docId);
    if (docMeta?.deleted) {
      await tx.complete();
      return undefined;
    }

    const snapshot = await snapshots.get<Snapshot>(docId);
    const committed = await committedChanges.getAll<StoredChange>([docId, snapshot?.rev ?? 0], [docId, Infinity]);
    const pending = await pendingChanges.getAll<StoredChange>([docId, 0], [docId, Infinity]);

    if (!snapshot && !committed.length && !pending.length) return undefined;

    // Apply any committed changes to the snapshot state
    const state = applyChanges(snapshot?.state, committed);

    // Rebase pending changes if there are any committed changes received since their baseRev
    const lastCommitted = committed[committed.length - 1];
    const baseRev = pending[0]?.baseRev;
    if (lastCommitted && baseRev && baseRev < lastCommitted.rev) {
      const patch = committed
        .filter(change => change.rev > baseRev)
        .map(change => change.ops)
        .flat();
      const offset = lastCommitted.rev - baseRev;
      pending.forEach(change => {
        change.rev += offset;
        change.ops = transformPatch(state, patch, change.ops);
      });
    }

    await tx.complete();
    return {
      state,
      rev: committed[committed.length - 1]?.rev ?? snapshot?.rev ?? 0,
      changes: pending,
    };
  }

  /**
   * Completely remove all data for this docId and mark it as deleted (tombstone).
   */
  async deleteDoc(docId: string): Promise<void> {
    const [tx, snapshots, committedChanges, pendingChanges, docsStore] = await this.transaction(
      ['snapshots', 'committedChanges', 'pendingChanges', 'docs'],
      'readwrite'
    );

    const docMeta = (await docsStore.get<TrackedDoc>(docId)) ?? { docId, committedRev: 0 };
    await docsStore.put({ ...docMeta, deleted: true });

    await Promise.all([
      snapshots.delete(docId),
      committedChanges.delete([docId, 0], [docId, Infinity]),
      pendingChanges.delete([docId, 0], [docId, Infinity]),
    ]);

    await tx.complete();
  }

  async confirmDeleteDoc(docId: string): Promise<void> {
    const [tx, docsStore] = await this.transaction(['docs'], 'readwrite');
    await docsStore.delete(docId);
    await tx.complete();
  }

  // ─── Pending Changes ────────────────────────────────────────────────────────

  async saveDoc(docId: string, docState: PatchesState): Promise<void> {
    const [tx, snapshots, committedChanges, pendingChanges, docsStore] = await this.transaction(
      ['snapshots', 'committedChanges', 'pendingChanges', 'docs'],
      'readwrite'
    );

    const { rev, state } = docState;

    await Promise.all([
      docsStore.put<TrackedDoc>({ docId, committedRev: rev }),
      snapshots.put<Snapshot>({ docId, state, rev }),
      committedChanges.delete([docId, 0], [docId, Infinity]),
      pendingChanges.delete([docId, 0], [docId, Infinity]),
    ]);

    await tx.complete();
  }

  /**
   * Append an array of local changes to the pending queue.
   * Called *before* you attempt to send them to the server.
   */
  async savePendingChange(docId: string, change: Change): Promise<void> {
    const [tx, pendingChanges, docsStore] = await this.transaction(['pendingChanges', 'docs'], 'readwrite');

    let docMeta = await docsStore.get<TrackedDoc>(docId);
    if (!docMeta) {
      docMeta = { docId, committedRev: 0 };
      await docsStore.put(docMeta);
    } else if (docMeta.deleted) {
      delete docMeta.deleted;
      await docsStore.put(docMeta);
      console.warn(`Revived document ${docId} by saving pending changes.`);
    }

    await pendingChanges.put<StoredChange>({ ...change, docId });
    await tx.complete();
  }

  /** Read back all pending changes for this docId (in order). */
  async getPendingChanges(docId: string): Promise<Change[]> {
    const [tx, pendingChanges] = await this.transaction(['pendingChanges'], 'readonly');
    const result = await pendingChanges.getAll<Change>([docId, 0], [docId, Infinity]);
    await tx.complete();
    return result;
  }

  // ─── Committed Changes ─────────────────────────────────────────────────────

  /**
   * Store server‐confirmed changes.  Will:
   * - persist them in the committedChanges store
   * - remove any pending changes whose rev falls within `sentPendingRange`
   * - optionally compact a new snapshot after N changes (hidden internally)
   * @param docId - The ID of the document to save the changes for
   * @param changes - The changes to save
   * @param sentPendingRange - The range of pending changes to remove, *must* be provided after receiving the changes
   * from the server in response to a patchesDoc request.
   */
  async saveCommittedChanges(docId: string, changes: Change[], sentPendingRange?: [number, number]): Promise<void> {
    const [tx, committedChanges, pendingChanges, snapshots, docsStore] = await this.transaction(
      ['committedChanges', 'pendingChanges', 'snapshots', 'docs'],
      'readwrite'
    );

    // Save committed changes
    await Promise.all(changes.map(change => committedChanges.put<StoredChange>({ ...change, docId })));

    // Remove pending changes if range provided
    if (sentPendingRange) {
      await pendingChanges.delete([docId, sentPendingRange[0]], [docId, sentPendingRange[1]]);
    }

    // Check if we should create a snapshot
    const count = await committedChanges.count([docId, 0], [docId, Infinity]);

    if (count >= SNAPSHOT_INTERVAL) {
      // Update the snapshot. A snapshot will not be updated if there are pending changes based on revisions older than
      // the latest committed change until those pending changes are committed.
      const [snapshot, committed, firstPending] = await Promise.all([
        snapshots.get<Snapshot>(docId),
        committedChanges.getAll<StoredChange>([docId, 0], [docId, Infinity], SNAPSHOT_INTERVAL),
        pendingChanges.getFirstFromCursor<StoredChange>([docId, 0], [docId, Infinity]),
      ]);

      // Update the snapshot
      const lastRev = committed[committed.length - 1]?.rev;
      if (!firstPending?.baseRev || firstPending?.baseRev >= lastRev) {
        const state = applyChanges(snapshot?.state, committed);
        await Promise.all([
          snapshots.put({
            docId,
            rev: lastRev,
            state,
          }),
          committedChanges.delete([docId, 0], [docId, lastRev]),
        ]);
      } else {
        // Warning: snapshot creation skipped due to old pending changes
        console.warn(
          `Snapshot creation skipped for doc ${docId}: pending change baseRev ${firstPending.baseRev} < lastRev ${lastRev}. ` +
          `Committed changes count: ${count}. This may lead to memory growth.`
        );
        
        // Force snapshot creation if too many committed changes accumulate
        if (count >= SNAPSHOT_INTERVAL * 3) {
          console.warn(
            `Force creating snapshot for doc ${docId} due to ${count} accumulated committed changes`
          );
          const state = applyChanges(snapshot?.state, committed);
          await Promise.all([
            snapshots.put({
              docId,
              rev: lastRev,
              state,
            }),
            committedChanges.delete([docId, 0], [docId, lastRev]),
          ]);
        }
      }
    }

    // Update committedRev in the docs store if changes were saved
    const lastCommittedRev = changes.at(-1)?.rev;
    if (lastCommittedRev !== undefined) {
      const docMeta = (await docsStore.get<TrackedDoc>(docId)) ?? { docId, committedRev: 0 };
      if (lastCommittedRev > docMeta.committedRev) {
        await docsStore.put({ ...docMeta, committedRev: lastCommittedRev, deleted: undefined });
      }
    }

    await tx.complete();
  }

  // --- New method for OfflineStore interface ---
  async listDocs(includeDeleted = false): Promise<TrackedDoc[]> {
    const [tx, docsStore] = await this.transaction(['docs'], 'readonly');
    const allDocs = await docsStore.getAll<TrackedDoc>();
    await tx.complete();
    return includeDeleted ? allDocs : allDocs.filter(doc => !doc.deleted);
  }

  // ─── Metadata / Tracking ───────────────────────────────────────────
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

  async untrackDocs(docIds: string[]): Promise<void> {
    const [tx, docsStore, snapshots, committedChanges, pendingChanges] = await this.transaction(
      ['docs', 'snapshots', 'committedChanges', 'pendingChanges'],
      'readwrite'
    );
    await Promise.all(
      docIds.map(docId => {
        return Promise.all([
          docsStore.delete(docId),
          snapshots.delete(docId),
          committedChanges.delete([docId, 0], [docId, Infinity]),
          pendingChanges.delete([docId, 0], [docId, Infinity]),
        ]);
      })
    );
    await tx.complete();
  }

  // ─── Revision Tracking ─────────────────────────────────────────────────────

  /**
   * Tell me the last committed revision you have *and* the highest
   * rev of any change.  Use these to drive:
   *   - fetch changes:   api.getChangesSince(docId, committedRev)
   *   - build new patch: newChange.rev = pendingRev; baseRev = committedRev
   */
  async getLastRevs(docId: string): Promise<[number, number]> {
    const [tx, committedChanges, pendingChanges] = await this.transaction(
      ['committedChanges', 'pendingChanges'],
      'readonly'
    );

    const [lastCommitted, lastPending] = await Promise.all([
      committedChanges.getLastFromCursor<StoredChange>([docId, 0], [docId, Infinity]),
      pendingChanges.getLastFromCursor<StoredChange>([docId, 0], [docId, Infinity]),
    ]);

    await tx.complete();
    return [lastCommitted?.rev ?? 0, lastPending?.rev ?? lastCommitted?.rev ?? 0];
  }
}

class IDBTransactionWrapper {
  private tx: IDBTransaction;
  private promise: Promise<void>;

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

class IDBStoreWrapper {
  private store: IDBObjectStore;

  constructor(store: IDBObjectStore) {
    this.store = store;
  }

  private createRange(lower?: any, upper?: any): IDBKeyRange | undefined {
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
