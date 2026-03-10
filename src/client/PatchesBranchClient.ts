import { store, type Store } from 'easy-signal';
import type { BranchAPI } from '../net/protocol/types.js';
import type { Branch, EditableBranchMetadata } from '../types.js';

/**
 * Client-side branch management interface for a document.
 * Allows listing, creating, closing, and merging branches.
 */
export class PatchesBranchClient {
  /** Document ID */
  readonly id: string;
  /** Store for the branches list */
  readonly branches: Store<Branch[]>;

  constructor(
    id: string,
    private readonly api: BranchAPI
  ) {
    this.id = id;
    this.branches = store<Branch[]>([]);
  }

  /** List all branches for this document */
  async listBranches(): Promise<Branch[]> {
    this.branches.state = await this.api.listBranches(this.id);
    return this.branches.state;
  }

  /** Create a new branch from a specific revision */
  async createBranch(rev: number, metadata?: EditableBranchMetadata): Promise<string> {
    const branchId = await this.api.createBranch(this.id, rev, metadata);
    await this.listBranches();
    return branchId;
  }

  /** Close a branch without merging its changes */
  async closeBranch(branchId: string): Promise<void> {
    await this.api.closeBranch(branchId);
    await this.listBranches();
  }

  /** Merge a branch's changes back into this document */
  async mergeBranch(branchId: string): Promise<void> {
    await this.api.mergeBranch(branchId);
    await this.listBranches();
  }

  /** Clear state */
  clear() {
    this.branches.state = [];
  }
}
