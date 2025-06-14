import { createId } from 'crypto-id';
import { createChange } from '../data/change.js';
import { createVersionMetadata } from '../data/version.js';
import type { Branch, BranchStatus, Change, EditableBranchMetadata } from '../types.js';
import type { PatchesServer } from './PatchesServer.js';
import type { BranchingStoreBackend } from './types.js';

/**
 * Helps manage branches for a document. A branch is a document that is branched from another document. Its first
 * version will be the point-in-time of the original document at the time of the branch. Branches allow for parallel
 * development of a document with the ability to merge changes back into the original document later.
 */
export class PatchesBranchManager {
  constructor(
    private readonly store: BranchingStoreBackend,
    private readonly patchesServer: PatchesServer
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
    // Prevent branching off a branch
    const maybeBranch = await this.store.loadBranch(docId);
    if (maybeBranch) {
      throw new Error('Cannot create a branch from another branch.');
    }
    // 1. Get the state at the branch point
    const stateAtRev = (await this.patchesServer.getStateAtRevision(docId, rev)).state;
    const branchDocId = createId();
    const now = Date.now();
    // Create an initial version at the branch point rev (for snapshotting/large docs)
    const initialVersionMetadata = createVersionMetadata({
      origin: 'main', // Branch doc versions are 'main' until merged
      startDate: now,
      endDate: now,
      rev,
      baseRev: rev,
      name: metadata?.name,
      groupId: branchDocId,
      branchName: metadata?.name,
    });
    await this.store.createVersion(branchDocId, initialVersionMetadata, stateAtRev, []);
    // 2. Create the branch metadata record
    const branch: Branch = {
      ...metadata,
      id: branchDocId,
      branchedFromId: docId,
      branchedRev: rev,
      created: now,
      status: 'open',
    };
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
    // 1. Load branch metadata
    const branch = await this.store.loadBranch(branchId);
    if (!branch) {
      throw new Error(`Branch with ID ${branchId} not found.`);
    }
    if (branch.status !== 'open') {
      throw new Error(`Branch ${branchId} is not open (status: ${branch.status}). Cannot merge.`);
    }
    const sourceDocId = branch.branchedFromId;
    const branchStartRevOnSource = branch.branchedRev;
    // 2. Get all committed server changes made on the branch document since it was created.
    const branchChanges = await this.store.listChanges(branchId, {});
    if (branchChanges.length === 0) {
      console.log(`Branch ${branchId} has no changes to merge.`);
      await this.closeBranch(branchId, 'merged');
      return [];
    }
    // 3. Get all versions from the branch doc (skip offline versions)
    const branchVersions = await this.store.listVersions(branchId, { origin: 'main' });
    // 4. For each version, create a corresponding version in the main doc with updated fields
    let lastVersionId: string | undefined;
    for (const v of branchVersions) {
      const newVersionMetadata = createVersionMetadata({
        ...v,
        origin: 'branch',
        baseRev: branchStartRevOnSource,
        groupId: branchId,
        branchName: branch.name,
        parentId: lastVersionId,
      });
      const state = await this.store.loadVersionState(branchId, v.id);
      const changes = await this.store.loadVersionChanges(branchId, v.id);
      await this.store.createVersion(sourceDocId, newVersionMetadata, state, changes);
      lastVersionId = newVersionMetadata.id;
    }
    // 5. Flatten all branch changes into a single change for the main doc
    const rev = branchStartRevOnSource + branchChanges.length;
    const flattenedChange = createChange(
      branchStartRevOnSource,
      rev,
      branchChanges.flatMap(c => c.ops)
    );
    // 6. Commit the flattened change to the main doc
    let committedMergeChanges: Change[] = [];
    try {
      [, committedMergeChanges] = await this.patchesServer.commitChanges(sourceDocId, [flattenedChange]);
    } catch (error) {
      console.error(`Failed to merge branch ${branchId} into ${sourceDocId}:`, error);
      throw new Error(`Merge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 7. Merge succeeded. Update the branch status.
    await this.closeBranch(branchId, 'merged');
    return committedMergeChanges;
  }
}

const nonModifiableMetadataFields = new Set(['id', 'branchedFromId', 'branchedRev', 'created', 'status']);

export function assertBranchMetadata(metadata?: EditableBranchMetadata) {
  if (!metadata) return;
  for (const key in metadata) {
    if (nonModifiableMetadataFields.has(key)) {
      throw new Error(`Cannot modify branch field ${key}`);
    }
  }
}
