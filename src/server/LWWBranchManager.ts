import { JSONPatch } from '../json-patch/JSONPatch.js';
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
import { readStreamAsString } from './jsonReadable.js';
import type { LWWServer } from './LWWServer.js';
import type { BranchingStoreBackend, LWWStoreBackend } from './types.js';

/**
 * Combined store type for LWW branch management.
 * Requires LWW ops operations and branch metadata operations.
 */
type LWWBranchStore = LWWStoreBackend & BranchingStoreBackend;

/**
 * LWW-specific branch manager implementation.
 *
 * Manages branches for documents using Last-Write-Wins semantics:
 * - Creates branches from the current document state (copies ops with timestamps)
 * - Merges by applying branch ops changes to source; timestamps resolve conflicts automatically
 * - No transformation needed - LWW conflicts resolve deterministically by timestamp
 *
 * LWW branching is simpler than OT because:
 * - Timestamps are immutable and survive branching/merging
 * - Conflict resolution is deterministic (later timestamp wins)
 * - Merging is idempotent - merge the same ops multiple times, get the same result
 */
export class LWWBranchManager implements BranchManager {
  static api = branchManagerApi;

  constructor(
    private readonly store: LWWBranchStore,
    private readonly lwwServer: LWWServer
  ) {}

  /**
   * Lists all branches for a document.
   * @param docId - The source document ID.
   * @param options - Optional filtering options (e.g. `since` for incremental sync).
   * @returns Array of branch metadata.
   */
  async listBranches(docId: string, options?: ListBranchesOptions): Promise<Branch[]> {
    return await this.store.listBranches(docId, options);
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
   * @returns The new branch document ID.
   */
  async createBranch(docId: string, atPoint: number, metadata?: CreateBranchMetadata): Promise<string> {
    const branchDocId = metadata?.id ?? (await generateBranchId(this.store, docId));

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

    if (!metadata?.contentStartRev) {
      // Build state directly from store (no streaming round-trip)
      const snapshot = await this.store.getSnapshot(docId);
      const baseRev = snapshot?.rev ?? 0;
      let state: any = snapshot ? JSON.parse(await readStreamAsString(snapshot.state)) : {};

      const ops = await this.store.listOps(docId);
      const opsAfterSnapshot = ops.filter(op => (op.rev ?? 0) > baseRev);
      if (opsAfterSnapshot.length > 0) {
        state = new JSONPatch(opsAfterSnapshot).apply(state);
      }
      const rev = ops.length > 0 ? Math.max(baseRev, ...ops.map(op => op.rev ?? 0)) : baseRev;

      // Initialize the branch document with current state as snapshot
      await this.store.saveSnapshot(branchDocId, state, rev);

      // Copy ops metadata to the branch document (preserving timestamps)
      if (ops.length > 0) {
        await this.store.saveOps(branchDocId, ops);
      }

      // Create the branch metadata record
      // contentStartRev: first rev of user content after init (for LWW, init is just the snapshot copy)
      const branch = createBranchRecord(branchDocId, docId, atPoint, rev + 1, metadata);
      await this.store.createBranch(branch);
      return branchDocId;
    }

    // Client supplied initial content — contentStartRev tells us where user content begins
    const branch = createBranchRecord(branchDocId, docId, atPoint, metadata.contentStartRev, metadata);
    await this.store.createBranch(branch);
    return branchDocId;
  }

  /**
   * Updates branch metadata.
   * @param branchId - The branch document ID.
   * @param metadata - The metadata ops to update.
   */
  async updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void> {
    assertBranchMetadata(metadata);
    await this.store.updateBranch(branchId, { ...metadata, modifiedAt: Date.now() });
  }

  /**
   * Closes a branch with the specified status.
   * @param branchId - The branch document ID.
   * @param status - The status to set (defaults to 'closed').
   */
  async closeBranch(branchId: string, status?: Exclude<BranchStatus, 'open'> | null): Promise<void> {
    await this.store.updateBranch(branchId, { status: status ?? 'closed', modifiedAt: Date.now() });
  }

  /**
   * Deletes a branch, replacing the record with a tombstone.
   */
  async deleteBranch(branchId: string): Promise<void> {
    await this.store.deleteBranch(branchId);
  }

  /**
   * Merges a branch back into its source document.
   *
   * Supports multiple merges — the branch stays open and `lastMergedRev` tracks
   * which branch revision was last merged. Subsequent merges only pick up new changes.
   *
   * LWW merge algorithm:
   * 1. Get ops changes made on the branch since last merge (or since creation)
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

    // Get only unmerged changes: since lastMergedRev (if previously merged) or branchedAtRev
    const sinceRev = branch.lastMergedRev ?? branch.branchedAtRev;
    const branchChanges = await this.lwwServer.getChangesSince(branchId, sinceRev);

    if (branchChanges.length === 0) {
      return [];
    }

    // Track the branch rev for lastMergedRev update
    const branchRev = await this.store.getCurrentRev(branchId);

    // LWW merge: commit the branch changes to the source document
    // Timestamps will automatically resolve any conflicts
    const { changes: committedChanges } = await wrapMergeCommit(branchId, sourceDocId, () =>
      this.lwwServer.commitChanges(sourceDocId, branchChanges)
    );

    // Update lastMergedRev so next merge picks up only new changes
    await this.store.updateBranch(branchId, { lastMergedRev: branchRev, modifiedAt: Date.now() });
    return committedChanges;
  }
}
