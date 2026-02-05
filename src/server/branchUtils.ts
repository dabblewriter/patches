import { createId } from 'crypto-id';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import type { Branch, BranchStatus, EditableBranchMetadata } from '../types.js';

/**
 * Standard API definition for branch managers.
 * Used with JSONRPCServer.register() to expose branch methods.
 */
export const branchManagerApi: ApiDefinition = {
  listBranches: 'read',
  createBranch: 'write',
  updateBranch: 'write',
  closeBranch: 'write',
  mergeBranch: 'write',
} as const;

/**
 * Fields that cannot be modified via updateBranch().
 */
const nonModifiableBranchFields = new Set(['id', 'docId', 'branchedAtRev', 'createdAt', 'status']);

/**
 * Validates that branch metadata doesn't contain non-modifiable fields.
 * @throws Error if metadata contains protected fields.
 */
export function assertBranchMetadata(metadata?: EditableBranchMetadata) {
  if (!metadata) return;
  for (const key in metadata) {
    if (nonModifiableBranchFields.has(key)) {
      throw new Error(`Cannot modify branch field ${key}`);
    }
  }
}

/**
 * Store interface for branch ID generation.
 */
export interface BranchIdGenerator {
  createBranchId?: (docId: string) => Promise<string> | string;
}

/**
 * Generates a branch ID, using the store's custom generator if available.
 * @param store - Store that may have a custom createBranchId method.
 * @param docId - The source document ID.
 * @returns A unique branch document ID.
 */
export async function generateBranchId(store: BranchIdGenerator, docId: string): Promise<string> {
  return store.createBranchId ? await Promise.resolve(store.createBranchId(docId)) : createId(22);
}

/**
 * Creates a Branch record with standard fields.
 * @param branchDocId - The branch document ID.
 * @param sourceDocId - The source document being branched from.
 * @param branchedAtRev - The revision at which the branch was created.
 * @param metadata - Optional branch metadata (name, etc.).
 * @returns A new Branch object.
 */
export function createBranchRecord(
  branchDocId: string,
  sourceDocId: string,
  branchedAtRev: number,
  metadata?: EditableBranchMetadata
): Branch {
  return {
    ...metadata,
    id: branchDocId,
    docId: sourceDocId,
    branchedAtRev,
    createdAt: Date.now(),
    status: 'open',
  };
}

/**
 * Store interface for branch loading.
 */
export interface BranchLoader {
  loadBranch(docId: string): Promise<Branch | null>;
}

/**
 * Validates that a document is not already a branch (prevents branch-of-branch).
 * @param store - Store with loadBranch capability.
 * @param docId - The document ID to check.
 * @throws Error if the document is already a branch.
 */
export async function assertNotABranch(store: BranchLoader, docId: string): Promise<void> {
  const maybeBranch = await store.loadBranch(docId);
  if (maybeBranch) {
    throw new Error('Cannot create a branch from another branch.');
  }
}

/**
 * Validates that a branch exists and is open for merging.
 * @param branch - The branch to validate (may be null).
 * @param branchId - The branch ID (for error messages).
 * @throws Error if branch not found or not open.
 */
export function assertBranchOpenForMerge(branch: Branch | null, branchId: string): asserts branch is Branch {
  if (!branch) {
    throw new Error(`Branch with ID ${branchId} not found.`);
  }
  if (branch.status !== 'open') {
    throw new Error(`Branch ${branchId} is not open (status: ${branch.status}). Cannot merge.`);
  }
}

/**
 * Wraps a merge commit operation with standard error handling.
 * @param branchId - The branch being merged.
 * @param sourceDocId - The source document being merged into.
 * @param commitFn - The async function that performs the commit.
 * @returns The result of the commit function.
 * @throws Error with standardized message if commit fails.
 */
export async function wrapMergeCommit<T>(
  branchId: string,
  sourceDocId: string,
  commitFn: () => Promise<T>
): Promise<T> {
  try {
    return await commitFn();
  } catch (error) {
    console.error(`Failed to merge branch ${branchId} into ${sourceDocId}:`, error);
    throw new Error(`Merge failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Standard close branch operation.
 * @param store - Store with updateBranch capability.
 * @param branchId - The branch to close.
 * @param status - The status to set (defaults to 'closed').
 */
export async function closeBranch(
  store: { updateBranch(branchId: string, updates: Partial<Pick<Branch, 'status' | 'name'>>): Promise<void> },
  branchId: string,
  status: Exclude<BranchStatus, 'open'> = 'closed'
): Promise<void> {
  await store.updateBranch(branchId, { status });
}
