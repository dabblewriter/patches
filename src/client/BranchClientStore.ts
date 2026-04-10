import type {
  Branch,
  CreateBranchMetadata,
  EditableBranchMetadata,
  ListBranchesOptions,
} from '../types.js';

/**
 * Client-side branch storage interface that doubles as a BranchAPI-compatible layer.
 *
 * Implements the same method signatures as BranchAPI (listBranches, createBranch,
 * deleteBranch, updateBranch) so PatchesBranchClient can call a single
 * interface regardless of online/offline mode.
 *
 * All mutating methods set `pendingOp` on the branch record so PatchesSync knows
 * which operations to push to the server.
 *
 * Also exposes sync-facing methods used by PatchesSync to reconcile local state
 * with the server.
 */
export interface BranchClientStore {
  // --- BranchAPI-compatible methods (PatchesBranchClient calls these) ---

  /**
   * Returns locally cached branch metas for a document.
   * Excludes deleted branches.
   */
  listBranches(docId: string, options?: ListBranchesOptions): Promise<Branch[]>;

  /**
   * Creates a branch record locally with `pendingOp: 'create'`.
   * Returns the branch document ID.
   */
  createBranch(docId: string, rev: number, metadata?: CreateBranchMetadata): Promise<string>;

  /**
   * Deletes a branch locally.
   * If the branch has `pendingOp: 'create'` (never synced), physically removes it.
   * Otherwise saves a tombstone with `pendingOp: 'delete'` and `deleted: true`.
   */
  deleteBranch(branchId: string): Promise<void>;

  /**
   * Updates branch metadata locally (e.g. name, lastMergedRev).
   * If the branch has `pendingOp: 'create'` (never synced), keeps it as 'create'.
   * Otherwise sets `pendingOp: 'update'`.
   */
  updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void>;

  // --- Internal methods (PatchesBranchClient uses) ---

  /**
   * Loads a single branch by its branch document ID.
   * Returns undefined if not found. Used to check if a document is a branch.
   */
  loadBranch(branchId: string): Promise<Branch | undefined>;

  // --- Sync-facing methods (PatchesSync uses) ---

  /**
   * Saves branch metas from the server into the local store.
   * Merges with existing data: updates existing branches and adds new ones.
   * Branches not in the provided array are left untouched (incremental update friendly).
   */
  saveBranches(docId: string, branches: Branch[]): Promise<void>;

  /**
   * Physically removes branches from the local store.
   * Called by PatchesSync after the server confirms deletion.
   */
  removeBranches(branchIds: string[]): Promise<void>;

  /**
   * Returns all branches with a `pendingOp` set, across all documents.
   * Used by PatchesSync to efficiently find branches that need server sync.
   */
  listPendingBranches(): Promise<Branch[]>;

  /**
   * Returns the most recent `modifiedAt` timestamp across all committed branches
   * for a given document. Used as the `since` parameter for incremental list fetches.
   * Returns undefined if no committed branches exist locally.
   */
  getLastModifiedAt(docId: string): Promise<number | undefined>;
}
