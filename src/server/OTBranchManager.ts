import { getStateAtRevision } from '../algorithms/ot/server/getStateAtRevision.js';
import { breakChanges } from '../algorithms/ot/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import { createVersionMetadata } from '../data/version.js';
import type {
  Branch,
  BranchStatus,
  Change,
  CreateBranchMetadata,
  EditableBranchMetadata,
  ListBranchesOptions,
} from '../types.js';
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
   * @param options - Optional filtering options (e.g. `since` for incremental sync).
   * @returns The branches.
   */
  async listBranches(docId: string, options?: ListBranchesOptions): Promise<Branch[]> {
    return await this.store.listBranches(docId, options);
  }

  /**
   * Creates a new branch for a document.
   * @param docId - The ID of the document to branch from.
   * @param rev - The revision of the document to branch from.
   * @returns The ID of the new branch document.
   */
  async createBranch(
    docId: string,
    rev: number,
    metadata?: CreateBranchMetadata,
  ): Promise<string> {
    const branchDocId = metadata?.id ?? await generateBranchId(this.store, docId);

    // Idempotent: if a branch with this ID already exists, return it as a no-op.
    // This handles retry-on-bad-connection scenarios.
    if (metadata?.id) {
      const existing = await this.store.loadBranch(branchDocId);
      if (existing) {
        if (existing.docId !== docId) {
          throw new Error(`Branch ${branchDocId} already exists for a different document`);
        }
        return branchDocId;
      }
    }

    await assertNotABranch(this.store, docId);

    const now = Date.now();

    let contentStartRev: number;

    if (metadata?.contentStartRev) {
      // Client supplied initial content as pending changes through normal sync flow.
      // contentStartRev tells us where user content begins (init changes are below it).
      contentStartRev = metadata.contentStartRev;
    } else {
      // Generate init changes from the source state at the branch point
      const { state: stateAtRev } = await getStateAtRevision(this.store, docId, rev);
      const rootReplace = createChange(0, 1, [{ op: 'replace' as const, path: '', value: stateAtRev }], {
        createdAt: now,
        committedAt: now,
      });
      const initChanges = this.maxPayloadBytes ? breakChanges([rootReplace], this.maxPayloadBytes) : [rootReplace];
      contentStartRev = initChanges[initChanges.length - 1].rev + 1;

      await this.store.saveChanges(branchDocId, initChanges);

      // Create an initial version representing the branch point (metadata + init changes, no state)
      const initialVersionMetadata = createVersionMetadata({
        origin: 'main',
        startedAt: now,
        endedAt: now,
        endRev: rev,
        startRev: rev,
        name: metadata?.name,
        groupId: branchDocId,
        branchName: metadata?.name,
      });
      await this.store.createVersion(branchDocId, initialVersionMetadata, initChanges);
    }

    // Create the branch metadata record
    const branch = createBranchRecord(branchDocId, docId, rev, contentStartRev, metadata);
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
    await this.store.updateBranch(branchId, { ...metadata, modifiedAt: Date.now() });
  }

  /**
   * Closes a branch, marking it as merged or deleted.
   * @param branchId - The ID of the branch to close.
   * @param status - The status to set for the branch.
   */
  async closeBranch(branchId: string, status?: Exclude<BranchStatus, 'open'>): Promise<void> {
    await this.store.updateBranch(branchId, { status: status ?? 'closed', modifiedAt: Date.now() });
  }

  /**
   * Deletes a branch, replacing the record with a tombstone.
   */
  async deleteBranch(branchId: string): Promise<void> {
    await this.store.deleteBranch(branchId);
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

    // Skip initialization changes — only merge user content changes
    const contentStartRev = branch.contentStartRev ?? 2;
    const branchChanges = await this.store.listChanges(branchId, { startAfter: contentStartRev - 1 });
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
      const changes = await this.store.loadVersionChanges?.(branchId, v.id);
      await this.store.createVersion(sourceDocId, newVersionMetadata, changes);
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
        return (await this.patchesServer.commitChanges(sourceDocId, adjustedChanges)).changes;
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

        return (await this.patchesServer.commitChanges(sourceDocId, changesToCommit)).changes;
      }
    });

    // Merge succeeded. Update the branch status.
    await this.closeBranch(branchId, 'merged');
    return committedMergeChanges;
  }
}

// Re-export for backwards compatibility
export { assertBranchMetadata } from './branchUtils.js';
