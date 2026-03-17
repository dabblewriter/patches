import type { Branch } from '../types.js';

/**
 * Client-side storage interface for branch metadata.
 *
 * Stores branch metas locally for offline viewing. Branches with `pending: true`
 * haven't been synced to the server yet; PatchesSync creates them on the server
 * and clears the flag during sync.
 */
export interface BranchClientStore {
  /**
   * Returns locally cached branch metas for a document.
   * Includes both committed (synced) and pending (unsynced) branches.
   * Excludes deleted branches.
   */
  listBranches(docId: string): Promise<Branch[]>;

  /**
   * Saves branch metas to the local store.
   * Merges with existing data: updates existing branches and adds new ones.
   * Branches not in the provided array are left untouched (incremental update friendly).
   */
  saveBranches(docId: string, branches: Branch[]): Promise<void>;

  /**
   * Removes branches from the local store.
   */
  deleteBranches(branchIds: string[]): Promise<void>;

  /**
   * Returns all branches with `pending: true` across all documents.
   * Used by PatchesSync to efficiently find branches that need server creation.
   */
  listPendingBranches(): Promise<Branch[]>;

  /**
   * Returns the most recent `modifiedAt` timestamp across all committed branches
   * for a given document. Used as the `since` parameter for incremental list fetches.
   * Returns undefined if no committed branches exist locally.
   */
  getLastModifiedAt(docId: string): Promise<number | undefined>;
}
