import { getStateAtRevision } from '../algorithms/ot/server/getStateAtRevision.js';
import { breakChanges } from '../algorithms/ot/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import { createVersionMetadata } from '../data/version.js';
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
import type { PatchesServer } from './PatchesServer.js';
import type { BranchingStoreBackend, OTStoreBackend } from './types.js';

/**
 * Combined store backend type for OT branch management.
 * Requires both OT operations and branch metadata operations.
 */
type OTBranchStore = OTStoreBackend & BranchingStoreBackend;

/**
 * OT-specific branch manager implementation.
 *
 * Manages branches for documents using Operational Transformation semantics:
 * - Creates branches at specific revision points
 * - Uses fast-forward merge when possible (no concurrent changes on source)
 * - Falls back to flattened merge for divergent histories
 *
 * A branch is a document that originates from another document at a specific revision.
 * Its first version represents the source document's state at that revision.
 * Branches allow parallel development with the ability to merge changes back.
 */
export class OTBranchManager implements BranchManager {
  static api = branchManagerApi;

  constructor(
    private readonly store: OTBranchStore,
    private readonly patchesServer: PatchesServer,
    private readonly maxPayloadBytes?: number
  ) {}

  /**
   * Lists all open branches for a document.
   * @param docId - The ID of the document.
   * @returns The branches.
   */
  async listBranches(docId: string): Promise<Branch[]> {
    return await this.store.listBranches(docId);
  }

  /**
   * Creates a new branch for a document.
   * @param docId - The ID of the document to branch from.
   * @param rev - The revision of the document to branch from.
   * @param branchName - Optional name for the branch.
   * @param metadata - Additional optional metadata to store with the branch.
   * @returns The ID of the new branch document.
   */
  async createBranch(docId: string, rev: number, metadata?: EditableBranchMetadata): Promise<string> {
    await assertNotABranch(this.store, docId);

    // Get the state at the branch point
    const { state: stateAtRev } = await getStateAtRevision(this.store, docId, rev);
    const branchDocId = await generateBranchId(this.store, docId);
    const now = Date.now();

    // Create an initial version at the branch point rev (for snapshotting/large docs)
    const initialVersionMetadata = createVersionMetadata({
      origin: 'main', // Branch doc versions are 'main' until merged
      startedAt: now,
      endedAt: now,
      endRev: rev,
      startRev: rev,
      name: metadata?.name,
      groupId: branchDocId,
      branchName: metadata?.name,
    });
    await this.store.createVersion(branchDocId, initialVersionMetadata, stateAtRev, []);

    // Create the branch metadata record
    const branch = createBranchRecord(branchDocId, docId, rev, metadata);
    await this.store.createBranch(branch);
    return branchDocId;
  }

  /**
   * Updates a branch's metadata.
   * @param branchId - The ID of the branch to update.
   * @param metadata - The metadata to update.
   */
  async updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void> {
    assertBranchMetadata(metadata);
    await this.store.updateBranch(branchId, metadata);
  }

  /**
   * Closes a branch, marking it as merged or deleted.
   * @param branchId - The ID of the branch to close.
   * @param status - The status to set for the branch.
   */
  async closeBranch(branchId: string, status: Exclude<BranchStatus, 'open'> = 'closed'): Promise<void> {
    await this.store.updateBranch(branchId, { status });
  }

  /**
   * Merges changes from a branch back into its source document.
   * @param branchId - The ID of the branch document to merge.
   * @returns The server commit change(s) applied to the source document.
   * @throws Error if branch not found, already closed/merged, or merge fails.
   */
  async mergeBranch(branchId: string): Promise<Change[]> {
    // Load and validate branch
    const branch = await this.store.loadBranch(branchId);
    assertBranchOpenForMerge(branch, branchId);

    const sourceDocId = branch.docId;
    const branchStartRevOnSource = branch.branchedAtRev;

    // Get all committed server changes made on the branch document since it was created
    const branchChanges = await this.store.listChanges(branchId, {});
    if (branchChanges.length === 0) {
      console.log(`Branch ${branchId} has no changes to merge.`);
      await this.closeBranch(branchId, 'merged');
      return [];
    }

    // Check if we can fast-forward (no concurrent changes on source since branch)
    const sourceChanges = await this.store.listChanges(sourceDocId, {
      startAfter: branchStartRevOnSource,
    });
    const canFastForward = sourceChanges.length === 0;

    // Get all versions from the branch doc (skip offline-branch versions)
    const branchVersions = await this.store.listVersions(branchId, { origin: 'main' });

    // For each version, create a corresponding version in the main doc
    // Use 'main' origin if fast-forward, 'branch' if divergent
    const versionOrigin = canFastForward ? 'main' : 'branch';
    let lastVersionId: string | undefined;

    // Note: if version creation succeeds but commit fails, orphaned versions
    // may remain in the store. The store interface does not currently expose a
    // deleteVersion method, so cleanup is not possible. These orphaned versions
    // are harmless (they reference a groupId that was never fully merged).
    for (const v of branchVersions) {
      const newVersionMetadata = createVersionMetadata({
        ...v,
        origin: versionOrigin,
        startRev: branchStartRevOnSource,
        groupId: branchId,
        branchName: branch.name, // Keep branchName for traceability
        parentId: lastVersionId,
      });
      const state = await this.store.loadVersionState(branchId, v.id);
      const changes = await this.store.loadVersionChanges?.(branchId, v.id);
      await this.store.createVersion(sourceDocId, newVersionMetadata, state, changes);
      lastVersionId = newVersionMetadata.id;
    }

    // Commit changes to source doc with error handling
    const committedMergeChanges = await wrapMergeCommit(branchId, sourceDocId, async () => {
      if (canFastForward) {
        // Fast-forward: commit branch changes individually with adjusted revs
        const adjustedChanges = branchChanges.map(c => ({
          ...c,
          baseRev: branchStartRevOnSource,
          rev: undefined, // Let commitChanges assign sequential revs
        }));
        return this.patchesServer.commitChanges(sourceDocId, adjustedChanges);
      } else {
        // Divergent: flatten and transform (current behavior)
        const rev = branchStartRevOnSource + branchChanges.length;
        const flattenedChange = createChange(
          branchStartRevOnSource,
          rev,
          branchChanges.flatMap(c => c.ops)
        );

        // Break oversized flattened change if needed
        let changesToCommit = [flattenedChange];
        if (this.maxPayloadBytes) {
          changesToCommit = breakChanges(changesToCommit, this.maxPayloadBytes);
        }

        return this.patchesServer.commitChanges(sourceDocId, changesToCommit);
      }
    });

    // Merge succeeded. Update the branch status.
    await this.closeBranch(branchId, 'merged');
    return committedMergeChanges;
  }
}

// Re-export for backwards compatibility
export { assertBranchMetadata } from './branchUtils.js';

/**
 * @deprecated Use OTBranchManager instead. This alias will be removed in a future version.
 */
export const PatchesBranchManager = OTBranchManager;
