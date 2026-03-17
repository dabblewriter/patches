import type { Branch } from '../types.js';
import type { BranchClientStore } from './BranchClientStore.js';
import { IndexedDBStore } from './IndexedDBStore.js';

/** Branch meta stored in IndexedDB, keyed by branch id */
interface StoredBranch extends Branch {
  /** Source docId index for querying all branches of a doc */
  _docId: string;
}

/**
 * IndexedDB-backed store for branch metadata.
 *
 * Creates one object store:
 * - `branches` — cached branch metas (key: branch `id`, index: `_docId`)
 *
 * This store can share an `IndexedDBStore` instance with OT/LWW stores,
 * adding its stores via the shared `onUpgrade` signal.
 */
export class BranchIndexedDBStore implements BranchClientStore {
  public db: IndexedDBStore;

  constructor(db?: string | IndexedDBStore) {
    this.db = !db || typeof db === 'string' ? new IndexedDBStore(db) : db;

    this.db.onUpgrade((database, _oldVersion, _transaction) => {
      this.createBranchStores(database);
    });
  }

  protected createBranchStores(database: IDBDatabase): void {
    if (!database.objectStoreNames.contains('branches')) {
      const branchStore = database.createObjectStore('branches', { keyPath: 'id' });
      branchStore.createIndex('_docId', '_docId', { unique: false });
    }
  }

  async listBranches(docId: string): Promise<Branch[]> {
    const [tx, branchStore] = await this.db.transaction(['branches'], 'readonly');
    const results = await branchStore.getAllByIndex<StoredBranch>('_docId', docId);
    await tx.complete();
    return results.filter(b => !b.deleted).map(stripInternal);
  }

  async saveBranches(docId: string, branches: Branch[]): Promise<void> {
    if (branches.length === 0) return;
    const [tx, branchStore] = await this.db.transaction(['branches'], 'readwrite');
    await Promise.all(
      branches.map(branch => branchStore.put<StoredBranch>({ ...branch, _docId: docId }))
    );
    await tx.complete();
  }

  async deleteBranches(branchIds: string[]): Promise<void> {
    if (branchIds.length === 0) return;
    const [tx, branchStore] = await this.db.transaction(['branches'], 'readwrite');
    await Promise.all(branchIds.map(id => branchStore.delete(id)));
    await tx.complete();
  }

  async listPendingBranches(): Promise<Branch[]> {
    const [tx, branchStore] = await this.db.transaction(['branches'], 'readonly');
    const all = await branchStore.getAll<StoredBranch>();
    await tx.complete();
    return all.filter(b => b.pending).map(stripInternal);
  }

  async getLastModifiedAt(docId: string): Promise<number | undefined> {
    const [tx, branchStore] = await this.db.transaction(['branches'], 'readonly');
    const branches = await branchStore.getAllByIndex<StoredBranch>('_docId', docId);
    await tx.complete();

    if (branches.length === 0) return undefined;

    let max = 0;
    for (const b of branches) {
      if (!b.pending && !b.deleted && b.modifiedAt > max) max = b.modifiedAt;
    }
    return max || undefined;
  }
}

/** Strip internal IndexedDB fields from stored branch */
function stripInternal(stored: StoredBranch): Branch {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _docId, ...branch } = stored;
  return branch;
}
