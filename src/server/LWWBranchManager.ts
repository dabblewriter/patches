import type { Branch, BranchStatus, Change, EditableBranchMetadata } from '../types.js';
import type { BranchManager } from './BranchManager.js';
import {
  assertBranchMetadata,
  assertBranchOpenForMerge,
  assertNotABranch,
  branchManagerApi,
  createBranchRecord,
  generateBranchId,
  wrapMergeCommit,
} from './branchUtils.js';
import type { LWWServer } from './LWWServer.js';
import type { BranchingStoreBackend, LWWStoreBackend } from './types.js';

/**
 * Combined store type for LWW branch management.
 * Requires LWW field operations and branch metadata operations.
 */
type LWWBranchStore = LWWStoreBackend & BranchingStoreBackend;

/**
 * LWW-specific branch manager implementation.
 *
 * Manages branches for documents using Last-Write-Wins semantics:
 * - Creates branches from the current document state (copies fields with timestamps)
 * - Merges by applying branch field changes to source; timestamps resolve conflicts automatically
 * - No transformation needed - LWW conflicts resolve deterministically by timestamp
 *
 * LWW branching is simpler than OT because:
 * - Timestamps are immutable and survive branching/merging
 * - Conflict resolution is deterministic (later timestamp wins)
 * - Merging is idempotent - merge the same fields multiple times, get the same result
 */
export class LWWBranchManager implements BranchManager {
  static api = branchManagerApi;

  constructor(
    private readonly store: LWWBranchStore,
    private readonly lwwServer: LWWServer
  ) { }

  /**
   * Lists all branches for a document.
   * @param docId - The source document ID.
   * @returns Array of branch metadata.
   */
  async listBranches(docId: string): Promise<Branch[]> {
    return await this.store.listBranches(docId);
  }

  /**
   * Creates a new branch from a document's current state.
   *
   * Note: Unlike OT, LWW cannot access historical states, so branches
   * always start from the current state. The `atPoint` parameter is
   * recorded for tracking purposes.
   *
   * @param docId - The source document ID.
   * @param atPoint - The revision number (recorded for tracking).
   * @param metadata - Optional branch metadata.
   * @returns The new branch document ID.
   */
  async createBranch(docId: string, atPoint: number, metadata?: EditableBranchMetadata): Promise<string> {
    await assertNotABranch(this.store, docId);

    // Get current state and all field metadata
    const doc = await this.lwwServer.getDoc(docId);
    const fields = await this.store.listOps(docId);

    // Generate branch document ID
    const branchDocId = await generateBranchId(this.store, docId);

    // Initialize the branch document with current state as snapshot
    await this.store.saveSnapshot(branchDocId, doc.state, doc.rev);

    // Copy field metadata to the branch document (preserving timestamps)
    if (fields.length > 0) {
      await this.store.saveOps(branchDocId, fields);
    }

    // Create the branch metadata record
    const branch = createBranchRecord(branchDocId, docId, atPoint, metadata);
    await this.store.createBranch(branch);
    return branchDocId;
  }

  /**
   * Updates branch metadata.
   * @param branchId - The branch document ID.
   * @param metadata - The metadata fields to update.
   */
  async updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void> {
    assertBranchMetadata(metadata);
    await this.store.updateBranch(branchId, metadata);
  }

  /**
   * Closes a branch with the specified status.
   * @param branchId - The branch document ID.
   * @param status - The status to set (defaults to 'closed').
   */
  async closeBranch(branchId: string, status: Exclude<BranchStatus, 'open'> = 'closed'): Promise<void> {
    await this.store.updateBranch(branchId, { status });
  }

  /**
   * Merges a branch back into its source document.
   *
   * LWW merge strategy:
   * 1. Get all field changes made on the branch since it was created
   * 2. Apply those changes to the source document
   * 3. Timestamps automatically resolve any conflicts (later wins)
   *
   * @param branchId - The branch document ID.
   * @returns The changes applied to the source document.
   */
  async mergeBranch(branchId: string): Promise<Change[]> {
    // Load and validate branch
    const branch = await this.store.loadBranch(branchId);
    assertBranchOpenForMerge(branch, branchId);

    const sourceDocId = branch.docId;

    // Get all changes made on the branch (synthesized from fields)
    const branchChanges = await this.lwwServer.getChangesSince(branchId, branch.branchedAtRev);

    if (branchChanges.length === 0) {
      console.log(`Branch ${branchId} has no changes to merge.`);
      await this.closeBranch(branchId, 'merged');
      return [];
    }

    // LWW merge: commit the branch changes to the source document
    // Timestamps will automatically resolve any conflicts
    const committedChanges = await wrapMergeCommit(branchId, sourceDocId, () =>
      this.lwwServer.commitChanges(sourceDocId, branchChanges)
    );

    // Close the branch
    await this.closeBranch(branchId, 'merged');
    return committedChanges;
  }
}
