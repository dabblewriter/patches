import type { Branch, BranchStatus, Change, CreateBranchMetadata, EditableBranchMetadata, ListBranchesOptions } from '../types.js';

/**
 * Interface for managing document branches.
 * Implementations handle algorithm-specific branching and merging logic.
 *
 * A branch is a document that originates from another document at a specific point.
 * Its first version represents the source document's state at the branch point.
 * Branches allow parallel development with the ability to merge changes back.
 */
export interface BranchManager {
  /**
   * Lists all branches for a document.
   * @param docId - The source document ID.
   * @param options - Optional filtering options (e.g. `since` for incremental sync).
   * @returns Array of branch metadata.
   */
  listBranches(docId: string, options?: ListBranchesOptions): Promise<Branch[]>;

  /**
   * Creates a new branch from a document.
   * @param docId - The source document ID.
   * @param atPoint - Algorithm-specific branching point (revision for OT, typically current rev for LWW).
   * @param metadata - Optional branch metadata (name, custom fields).
   *   When `contentStartRev` is set, the server skips generating initial changes
   *   (the client has already created them and will sync them as regular document changes).
   * @returns The new branch document ID.
   */
  createBranch(
    docId: string,
    atPoint: number,
    metadata?: CreateBranchMetadata,
  ): Promise<string>;

  /**
   * Updates branch metadata.
   * @param branchId - The branch document ID.
   * @param metadata - The metadata fields to update.
   */
  updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void>;

  /**
   * Closes a branch with the specified status.
   * @param branchId - The branch document ID.
   * @param status - The status to set (defaults to 'closed').
   */
  closeBranch(branchId: string, status?: Exclude<BranchStatus, 'open'>): Promise<void>;

  /**
   * Deletes a branch, replacing it with a tombstone record.
   * The tombstone preserves `id`, `docId`, `modifiedAt`, and `deleted: true`
   * so that clients using incremental sync (`since`) can clean up their local cache.
   * @param branchId - The branch document ID to delete.
   */
  deleteBranch(branchId: string): Promise<void>;

  /**
   * Merges a branch back into its source document.
   * Algorithm-specific: OT uses fast-forward or flattened merge, LWW uses timestamp resolution.
   * @param branchId - The branch document ID to merge.
   * @returns The changes applied to the source document.
   */
  mergeBranch(branchId: string): Promise<Change[]>;
}
