import { signal } from '../event-signal.js';
import { transformPatch } from '../json-patch/transformPatch.js';
import type { Change, PatchSnapshot } from '../types.js';
import { applyChanges } from '../utils.js';

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
 * - deleted<{ docId: string; }> (primary key: docId)
 *
 * Under the hood, this class will store snapshots of the document only for committed state. It will not update the
 * committed state on *every* received committed change as this can cause issues with IndexedDB with many large updates.
 * After every 200 committed changes, the class will save the current state to the snapshot store and delete the committed changes that went into it.
 * A snapshot will not be created if there are pending changes based on revisions older than the 200th committed change until those pending changes are committed.
 */
export class IndexedDBStore {
  private db: IDBDatabase | null = null;
  private dbName: string;
  private dbPromise: Promise<IDBDatabase>;

  /** Subscribe to be notified after local state changes are saved to the database. */
  readonly onPendingChanges = signal<(docId: string, changes: Change[]) => void>();

  constructor(dbName: string) {
    this.dbName = dbName;
    this.dbPromise = this.initDB();
  }

  private async initDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
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
        if (!db.objectStoreNames.contains('deleted')) {
          db.createObjectStore('deleted', { keyPath: 'docId' });
        }
      };
    });
  }

  private getDB(): Promise<IDBDatabase> {
    return this.dbPromise;
  }

  /**
   * Closes the database connection. After calling this method, the store
   * will no longer be usable. A new instance must be created to reopen
   * the database.
   */
  async close(): Promise<void> {
    await this.dbPromise;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
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
   * the full PatchDoc into memory.
   *
   * 1. load the last snapshot (state + rev)
   * 2. load committedChanges[rev > snapshot.rev]
   * 3. load pendingChanges
   * 4. apply committed changes, rebase pending
   * 5. return { state, rev, changes: pending }
   */
  async getDoc(docId: string): Promise<PatchSnapshot | undefined> {
    const [tx, snapshots, committedChanges, pendingChanges] = await this.transaction(
      ['snapshots', 'committedChanges', 'pendingChanges'],
      'readonly'
    );

    const snapshot = await snapshots.get<Snapshot>(docId);
    const committed = await committedChanges.getAll<StoredChange>([docId, snapshot?.rev ?? 0 + 1], [docId, Infinity]);
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
   * Completely remove all data for this docId and mark it
   * as deleted (tombstone).  Provider will call `patchAPI.deleteDoc`
   * on reconnect.
   */
  async deleteDoc(docId: string): Promise<void> {
    const [tx, snapshots, committedChanges, pendingChanges, deleted] = await this.transaction(
      ['snapshots', 'committedChanges', 'pendingChanges', 'deleted'],
      'readwrite'
    );

    await Promise.all([
      snapshots.delete(docId),
      committedChanges.delete([docId, 0], [docId, Infinity]),
      pendingChanges.delete([docId, 0], [docId, Infinity]),
      deleted.add({ docId }),
    ]);

    await tx.complete();
  }

  // ─── Pending Changes ────────────────────────────────────────────────────────

  /**
   * Append an array of local changes to the pending queue.
   * Called *before* you attempt to send them to the server.
   */
  async savePendingChanges(docId: string, changes: Change[]): Promise<void> {
    const [tx, pendingChanges] = await this.transaction(['pendingChanges'], 'readwrite');

    await Promise.all(changes.map(change => pendingChanges.add<StoredChange>({ ...change, docId })));

    this.onPendingChanges.emit(docId, changes);
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
   * from the server in response to a patchDoc request.
   */
  async saveCommittedChanges(docId: string, changes: Change[], sentPendingRange?: [number, number]): Promise<void> {
    const [tx, committedChanges, pendingChanges, snapshots] = await this.transaction(
      ['committedChanges', 'pendingChanges', 'snapshots'],
      'readwrite'
    );

    // Save committed changes
    await Promise.all(changes.map(change => committedChanges.add<StoredChange>({ ...change, docId })));

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
          snapshots.add({
            docId,
            rev: lastRev,
            state,
          }),
          committedChanges.delete([docId, 0], [docId, lastRev]),
        ]);
      }
    }

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

  async add<T>(value: T): Promise<IDBValidKey> {
    return new Promise((resolve, reject) => {
      const request = this.store.add(value);
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
