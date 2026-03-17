import { store, type Store } from 'easy-signal';
import { breakChanges, type SizeCalculator } from '../algorithms/ot/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import type { BranchAPI } from '../net/protocol/types.js';
import type {
  Branch,
  CreateBranchMetadata,
  EditableBranchMetadata,
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
          await this.localStore.saveBranches(this.id, updates);
        }
        this.branches.state = await this.localStore.listBranches(this.id);
        return this.branches.state;
      }
    }

    // Full fetch (first time or no local store)
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
      return this._createBranchOffline(rev, metadata!, initialState);
    }

    // Online path: server creates the branch and initial content
    const branchId = await this.api.createBranch(this.id, rev, metadata as EditableBranchMetadata);
    await this.listBranches();
    return branchId;
  }

  /** Close a branch without merging its changes */
  async closeBranch(branchId: string): Promise<void> {
    await this.api.closeBranch(branchId);
    await this.listBranches();
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
    const branchDocId = metadata?.id as string | undefined;
    if (!branchDocId) {
      throw new Error('metadata.id is required when creating a branch with initialState');
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
    await algorithm.handleDocChange(branchDocId, initChanges[0].ops, undefined, {});

    // If breakChanges produced multiple changes, save the remaining ones
    // (handleDocChange only processes the first set of ops; we need to save any additional changes)
    if (initChanges.length > 1) {
      for (let i = 1; i < initChanges.length; i++) {
        await algorithm.handleDocChange(branchDocId, initChanges[i].ops, undefined, {});
      }
    }

    // Update branches store
    this.branches.state = [...this.branches.state, branch];

    // Trigger sync if connected
    this.patches.onChange.emit(branchDocId);

    return branchDocId;
  }
}
