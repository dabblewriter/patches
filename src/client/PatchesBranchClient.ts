import { store, type Store } from 'easy-signal';
import { breakChangesIntoBatches } from '../algorithms/ot/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import type { BranchAPI } from '../net/protocol/types.js';
import type { Branch, Change, CreateBranchMetadata, EditableBranchMetadata, ListBranchesOptions } from '../types.js';
import type { BranchClientStore } from './BranchClientStore.js';
import type { Patches } from './Patches.js';
import type { AlgorithmName } from './PatchesStore.js';

// Error message when attempting offline merge
const OFFLINE_MERGE_ERROR =
  'Branch merging requires a server connection. Use a BranchAPI or call the server merge endpoint directly.';

export interface PatchesBranchClientOptions {
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
 * - `BranchAPI` — server performs the merge via `mergeBranch`
 * - `BranchClientStore` — merge is not supported; call the server merge endpoint directly
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
   * Update branch metadata (e.g. name).
   */
  async updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void> {
    await this.api.updateBranch(branchId, metadata);
    this.branches.state = this.branches.state.map(b => (b.id === branchId ? { ...b, ...metadata } : b));
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
   * Requires a `BranchAPI` (online mode) — the server performs the merge.
   * Throws if the API is a `BranchClientStore` (offline-first mode) because
   * client stores don't maintain full change history needed for correct merging.
   * Offline-first consumers should call the server merge endpoint directly.
   *
   * @returns The server commit change(s) the merge applied to the source document
   *   (empty for a no-op merge). Consumers can fold these into an open doc directly.
   */
  async mergeBranch(branchId: string): Promise<Change[]> {
    if (this.isOffline) {
      throw new Error(OFFLINE_MERGE_ERROR);
    }
    const changes = await (this.api as BranchAPI).mergeBranch(branchId);
    await this.listBranches();
    return changes ?? [];
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

    // Pre-split the seed the way PatchesSync will commit it on the wire — by BOTH the
    // per-change storage limit (possibly a compressed measure) AND the uncompressed payload
    // limit — so the pending changes persisted below are flush-stable: a flush that re-split
    // the seed would renumber it under a frozen `contentStartRev`, and a later merge would
    // replay the seed's tail into the source document, duplicating its content.
    // `maxPayloadBytes` is resolved the same way PatchesSync resolves it (docOptions, else a
    // 1MB default) so the two splits agree.
    const options = this.patches.docOptions;
    const initChanges = breakChangesIntoBatches([rootReplace], {
      maxPayloadBytes: options.maxPayloadBytes,
      maxStorageBytes: options.maxStorageBytes,
      sizeCalculator: options.sizeCalculator,
    }).flat();

    // Validate algorithm exists before persisting anything
    const algorithmName = this.options?.algorithm ?? this.patches.defaultAlgorithm;
    const algorithm = this.patches.algorithms[algorithmName];
    if (!algorithm) {
      throw new Error(`Algorithm '${algorithmName}' not found`);
    }

    try {
      // Track the branch document through the standard pipeline
      await this.patches.trackDocs([branchDocId], algorithmName);

      // Persist the seed as pending changes, then derive `contentStartRev` from the
      // revisions the algorithm ACTUALLY assigned. The algorithm applies its own storage
      // split with its own options, so predicting the final revision span from `docOptions`
      // desyncs the floor whenever the two configs disagree — and an undercounted floor
      // makes a merge replay the seed's tail, duplicating the document's content. The
      // persisted revs are the truth.
      let lastSeedRev = 0;
      for (const change of initChanges) {
        const persisted = await algorithm.handleDocChange(branchDocId, change.ops, undefined, {});
        lastSeedRev = persisted[persisted.length - 1]?.rev ?? lastSeedRev;
      }
      if (!lastSeedRev) {
        throw new Error('Branch seeding persisted no changes');
      }

      // contentStartRev is the first revision after the persisted seed
      const contentStartRev = lastSeedRev + 1;

      // Create branch via the API (store saves with pendingOp: 'create')
      await this.api.createBranch(this.id, rev, { ...metadata, contentStartRev });
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
}
