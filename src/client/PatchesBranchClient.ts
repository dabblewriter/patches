import { store, type Store } from 'easy-signal';
import { breakChanges, type SizeCalculator } from '../algorithms/ot/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import type { BranchAPI } from '../net/protocol/types.js';
import type { Branch, CreateBranchMetadata, ListBranchesOptions } from '../types.js';
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
 * Client-side branch management for a document.
 *
 * Accepts either a `BranchAPI` (online, server does the work) or a `BranchClientStore`
 * (offline-first, local store handles caching/pending/tombstones). The API shape
 * determines merge behavior:
 *
 * - `BranchAPI` has `mergeBranch` — server performs the merge
 * - `BranchClientStore` has `updateBranch` — client merges locally, updates `lastMergedRev`
 */
export class PatchesBranchClient {
  /** Document ID */
  readonly id: string;
  /** Store for the branches list */
  readonly branches: Store<Branch[]>;

  constructor(
    id: string,
    private readonly api: BranchAPI | BranchClientStore,
    private readonly patches: Patches,
    private readonly options?: PatchesBranchClientOptions
  ) {
    this.id = id;
    this.branches = store<Branch[]>([]);
  }

  /** Whether this client uses a local store (offline-first mode). */
  private get isOffline(): boolean {
    return 'loadBranch' in this.api;
  }

  /**
   * Loads cached branches from the local store.
   * Returns empty array when using online-only BranchAPI.
   */
  async loadCached(): Promise<Branch[]> {
    if (!this.isOffline) return [];
    const cached = await this.api.listBranches(this.id);
    this.branches.state = cached;
    return cached;
  }

  /**
   * List all branches for this document.
   * With a local store, returns cached data (server sync is handled by PatchesSync).
   * With a BranchAPI, fetches directly from the server.
   */
  async listBranches(options?: ListBranchesOptions): Promise<Branch[]> {
    const branches = await this.api.listBranches(this.id, options);
    this.branches.state = branches;
    return branches;
  }

  /**
   * Create a new branch from a specific revision.
   *
   * When `initialState` is provided, the branch is created for offline-first sync:
   * - Requires `metadata.id` to be set (used as the branch document ID)
   * - Creates the initial root-replace change locally (broken into multiple if needed)
   * - Saves the branch meta via the API (store marks it pending for later server sync)
   * - Tracks the branch document and saves initial changes as pending through the algorithm
   * - PatchesSync will create the branch on the server and flush the document changes
   *
   * When `initialState` is omitted, the branch is created directly via the API.
   */
  async createBranch(rev: number, metadata?: CreateBranchMetadata, initialState?: any): Promise<string> {
    if (initialState !== undefined) {
      if (!metadata) {
        throw new Error('metadata is required when creating a branch with initialState');
      }
      return this._createBranchOffline(rev, metadata, initialState);
    }

    const branchId = await this.api.createBranch(this.id, rev, metadata);
    await this.listBranches();
    return branchId;
  }

  /**
   * Delete a branch.
   * The API implementation handles tombstones (offline store) or direct deletion (online).
   */
  async deleteBranch(branchId: string): Promise<void> {
    await this.api.deleteBranch(branchId);
    this.branches.state = this.branches.state.filter(b => b.id !== branchId);
  }

  /**
   * Delete a branch and its document.
   * Convenience method that deletes both the branch record and the branch document.
   */
  async deleteBranchWithDoc(branchId: string): Promise<void> {
    await this.deleteBranch(branchId);
    await this.patches.deleteDoc(branchId);
  }

  /**
   * Merge a branch's changes back into this document.
   *
   * Online (BranchAPI with `mergeBranch`): server performs the merge.
   * Offline (BranchClientStore with `updateBranch`): client reads branch changes,
   * re-stamps them with `batchId: branchId`, submits via algorithm.handleDocChange
   * on the source doc, then updates `lastMergedRev` locally.
   */
  async mergeBranch(branchId: string): Promise<void> {
    if (!this.isOffline) {
      await (this.api as BranchAPI).mergeBranch(branchId);
      await this.listBranches();
      return;
    }

    await this._mergeBranchLocally(branchId);
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

    // Prevent branching from a branch
    if ('loadBranch' in this.api) {
      const maybeBranch = await this.api.loadBranch(this.id);
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

    // Validate algorithm exists before persisting anything
    const algorithmName = this.options?.algorithm ?? this.patches.defaultAlgorithm;
    const algorithm = this.patches.algorithms[algorithmName];
    if (!algorithm) {
      throw new Error(`Algorithm '${algorithmName}' not found`);
    }

    // Create branch via the API (store saves with pendingOp: 'create')
    await this.api.createBranch(this.id, rev, { ...metadata, contentStartRev });

    try {
      // Track the branch document through the standard pipeline
      await this.patches.trackDocs([branchDocId], algorithmName);

      // Save initial changes as pending through the algorithm's store
      for (const change of initChanges) {
        await algorithm.handleDocChange(branchDocId, change.ops, undefined, {});
      }
    } catch (err) {
      // Rollback: remove saved branch meta and untrack doc so we don't leave inconsistent state
      if (this.isOffline) {
        await (this.api as BranchClientStore).removeBranches([branchDocId]);
      }
      await this.patches.untrackDocs([branchDocId]);
      throw err;
    }

    // Refresh branch list from store
    await this.listBranches();

    // Trigger sync if connected
    this.patches.onChange.emit(branchDocId);

    return branchDocId;
  }

  private async _mergeBranchLocally(branchId: string): Promise<void> {
    const offlineApi = this.api as BranchClientStore;

    // 1. Get branch metadata
    const branch = this.branches.state.find(b => b.id === branchId);
    if (!branch) throw new Error(`Branch ${branchId} not found`);

    const sourceDocId = branch.docId;

    // 2. Get the algorithm for reading branch changes
    const algorithmName = this.options?.algorithm ?? this.patches.defaultAlgorithm;
    const algorithm = this.patches.algorithms[algorithmName];
    if (!algorithm?.listChanges) {
      throw new Error('Offline merge requires an algorithm with listChanges support');
    }

    // 3. Get unmerged branch changes (after lastMergedRev or contentStartRev)
    const startAfter = branch.lastMergedRev ?? (branch.contentStartRev ?? 2) - 1;
    const branchChanges = await algorithm.listChanges(branchId, { startAfter });
    if (branchChanges.length === 0) return;

    const lastBranchRev = branchChanges[branchChanges.length - 1].rev;

    // 4. Submit branch changes to source doc through the serialized change queue
    for (const change of branchChanges) {
      await this.patches.submitDocChange(sourceDocId, change.ops, { batchId: branchId });
    }

    // 5. Update lastMergedRev on the branch
    await offlineApi.updateBranch(branchId, { lastMergedRev: lastBranchRev });

    // 6. Trigger sync for source doc
    this.patches.onChange.emit(sourceDocId);

    // 7. Update local branch state
    this.branches.state = this.branches.state.map(b =>
      b.id === branchId ? { ...b, lastMergedRev: lastBranchRev } : b
    );
  }
}
