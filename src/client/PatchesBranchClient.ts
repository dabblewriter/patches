import { store, type Store } from 'easy-signal';
import { breakChanges, type SizeCalculator } from '../algorithms/ot/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import type { BranchAPI } from '../net/protocol/types.js';
import type {
  Branch,
  CreateBranchMetadata,
  ListBranchesOptions,
} from '../types.js';
import type { BranchClientStore } from './BranchClientStore.js';
import type { Patches } from './Patches.js';
import type { AlgorithmName } from './PatchesStore.js';

export interface PatchesBranchClientOptions {
  /** Maximum size in bytes for a single change in storage. Used to break large initial changes. */
  maxStorageBytes?: number;
  /** Custom size calculator for change size measurement. */
  sizeCalculator?: SizeCalculator;
  /** Algorithm to use for the branch document (defaults to the Patches instance default). */
  algorithm?: AlgorithmName;
}

/**
 * Client-side branch management interface for a document.
 *
 * When constructed with a `BranchClientStore`, branch metas are cached locally
 * and branch creation with `initialState` works offline. PatchesSync handles syncing
 * pending branch metas and their document content through the standard sync pipeline.
 *
 * Without a store, all operations go directly to the server (original behavior).
 */
export class PatchesBranchClient {
  /** Document ID */
  readonly id: string;
  /** Store for the branches list */
  readonly branches: Store<Branch[]>;

  constructor(
    id: string,
    private readonly api: BranchAPI,
    private readonly patches: Patches,
    private readonly localStore?: BranchClientStore,
    private readonly options?: PatchesBranchClientOptions
  ) {
    this.id = id;
    this.branches = store<Branch[]>([]);
  }

  /**
   * Loads cached branches from the local store (if available).
   * Call this at startup before connecting to populate the branch list for offline viewing.
   */
  async loadCached(): Promise<Branch[]> {
    if (!this.localStore) return [];
    const cached = await this.localStore.listBranches(this.id);
    this.branches.state = cached;
    return cached;
  }

  /**
   * List all branches for this document.
   * Uses `since` parameter for incremental sync when a local store is available.
   */
  async listBranches(options?: ListBranchesOptions): Promise<Branch[]> {
    if (this.localStore && !options?.since) {
      // Use incremental sync: only fetch updates since last known modification
      const since = await this.localStore.getLastModifiedAt(this.id);
      if (since) {
        const updates = await this.api.listBranches(this.id, { since });
        if (updates.length > 0) {
          // Separate tombstones from live branches
          const deleted = updates.filter(b => b.deleted);
          const live = updates.filter(b => !b.deleted);
          if (deleted.length > 0) {
            await this.localStore.deleteBranches(deleted.map(b => b.id));
          }
          if (live.length > 0) {
            await this.localStore.saveBranches(this.id, live);
          }
        }
        this.branches.state = await this.localStore.listBranches(this.id);
        return this.branches.state;
      }
    }

    // Full fetch (first time or no local store) — server excludes tombstones
    const branches = await this.api.listBranches(this.id, options);
    if (this.localStore) {
      await this.localStore.saveBranches(this.id, branches);
    }
    this.branches.state = branches;
    return this.branches.state;
  }

  /**
   * Create a new branch from a specific revision.
   *
   * When `initialState` is provided, the branch is created for offline-first sync:
   * - Requires `metadata.id` to be set (used as the branch document ID)
   * - Creates the initial root-replace change locally (broken into multiple if needed)
   * - Saves the branch meta with `pending: true` for later server sync
   * - Tracks the branch document and saves initial changes as pending through the algorithm
   * - PatchesSync will create the branch on the server and flush the document changes
   *
   * When `initialState` is omitted, the branch is created directly on the server.
   */
  async createBranch(rev: number, metadata?: CreateBranchMetadata, initialState?: any): Promise<string> {
    if (initialState !== undefined) {
      if (!metadata) {
        throw new Error('metadata is required when creating a branch with initialState');
      }
      return this._createBranchOffline(rev, metadata, initialState);
    }

    // Online path: server creates the branch and initial content
    const branchId = await this.api.createBranch(this.id, rev, metadata);
    await this.listBranches();
    return branchId;
  }

  /** Close a branch without merging its changes */
  async closeBranch(branchId: string): Promise<void> {
    await this.api.closeBranch(branchId);
    await this.listBranches();
  }

  /**
   * Delete a branch.
   *
   * With a local store: marks the branch as a pending deletion (`deleted: true`, `pending: true`)
   * so PatchesSync can sync it to the server later. The branch is immediately hidden from
   * `branches.state` and `listBranches`.
   *
   * Without a local store: calls the server API directly (online-only).
   */
  async deleteBranch(branchId: string): Promise<void> {
    if (this.localStore) {
      const existing = await this.localStore.loadBranch(branchId);
      const docId = existing?.docId ?? this.id;

      if (existing?.pending) {
        // Branch was created offline and never synced — just remove it, no server call needed
        await this.localStore.deleteBranches([branchId]);
      } else {
        // Branch exists on the server — save as a pending-deleted tombstone for sync
        const tombstone: Branch = {
          ...(existing ?? { id: branchId, docId, branchedAtRev: 0, createdAt: 0, status: 'open' as const, contentStartRev: 0 }),
          modifiedAt: Date.now(),
          pending: true,
          deleted: true,
        };
        await this.localStore.saveBranches(docId, [tombstone]);
      }
    } else {
      await this.api.deleteBranch(branchId);
    }
    this.branches.state = this.branches.state.filter(b => b.id !== branchId);
  }

  /**
   * Delete a branch and its document.
   *
   * Convenience method that deletes both the branch record and the branch document.
   * The branch record deletion follows the same offline/online logic as `deleteBranch`.
   * The branch document is deleted via `Patches.deleteDoc` (tombstoned for sync).
   */
  async deleteBranchWithDoc(branchId: string): Promise<void> {
    await this.deleteBranch(branchId);
    await this.patches.deleteDoc(branchId);
  }

  /** Merge a branch's changes back into this document */
  async mergeBranch(branchId: string): Promise<void> {
    await this.api.mergeBranch(branchId);
    await this.listBranches();
  }

  /** Clear state */
  clear() {
    this.branches.state = [];
  }

  // --- Private ---

  private async _createBranchOffline(rev: number, metadata: CreateBranchMetadata, initialState: any): Promise<string> {
    const branchDocId = metadata.id as string | undefined;
    if (!branchDocId) {
      throw new Error('metadata.id is required when creating a branch with initialState');
    }

    // Prevent branching from a branch: check if this document is itself a branch
    if (this.localStore) {
      const maybeBranch = await this.localStore.loadBranch(this.id);
      if (maybeBranch) {
        throw new Error('Cannot create a branch from another branch.');
      }
    }

    const now = Date.now();

    // Create the root-replace change that seeds the branch with the source document's state
    const rootReplace = createChange(0, 1, [{ op: 'replace' as const, path: '', value: initialState }], {
      createdAt: now,
      committedAt: 0,
    });

    // Break the change into multiple if it exceeds the storage size limit
    let initChanges = [rootReplace];
    if (this.options?.maxStorageBytes) {
      initChanges = breakChanges(initChanges, this.options.maxStorageBytes, this.options.sizeCalculator);
    }

    // contentStartRev is the first revision after all init changes
    const contentStartRev = initChanges[initChanges.length - 1].rev + 1;

    // Build the branch metadata record
    const branch: Branch = {
      ...metadata,
      id: branchDocId,
      docId: this.id,
      branchedAtRev: rev,
      contentStartRev,
      createdAt: now,
      modifiedAt: now,
      status: 'open',
      pending: true,
    };

    // Save branch meta locally
    if (this.localStore) {
      await this.localStore.saveBranches(this.id, [branch]);
    }

    // Track the branch document through the standard pipeline
    const algorithmName = this.options?.algorithm ?? this.patches.defaultAlgorithm;
    await this.patches.trackDocs([branchDocId], algorithmName);

    // Save initial changes as pending through the algorithm's store
    const algorithm = this.patches.algorithms[algorithmName];
    if (!algorithm) {
      throw new Error(`Algorithm '${algorithmName}' not found`);
    }
    for (const change of initChanges) {
      await algorithm.handleDocChange(branchDocId, change.ops, undefined, {});
    }

    // Update branches store
    this.branches.state = [...this.branches.state, branch];

    // Trigger sync if connected
    this.patches.onChange.emit(branchDocId);

    return branchDocId;
  }
}
