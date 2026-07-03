import { createId } from 'crypto-id';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import type { Branch, CreateBranchMetadata, EditableBranchMetadata } from '../types.js';
import type { BranchingStoreBackend } from './types.js';

/**
 * Standard API definition for branch managers.
 * Used with JSONRPCServer.register() to expose branch methods.
 */
export const branchManagerApi: ApiDefinition = {
  listBranches: 'read',
  createBranch: 'write',
  updateBranch: 'write',
  deleteBranch: 'write',
  mergeBranch: 'write',
} as const;

/**
 * Fields that cannot be modified via updateBranch().
 */
const nonModifiableBranchFields = new Set([
  'id',
  'docId',
  'branchedAtRev',
  'createdAt',
  'modifiedAt',
  'contentStartRev',
  'pendingOp',
  'deleted',
]);

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
 * Server-managed merge bookkeeping fields that clients must never set. `lastMergedRev` is the
 * merge watermark; `mergeBaseRev` pins the merge base (and with it the server's change-id
 * dedup window) for branches whose `branchedAtRev` was found ahead of the source tip.
 */
const serverManagedMergeFields = ['lastMergedRev', 'mergeBaseRev'] as const;

/**
 * Drops server-managed merge bookkeeping from client-supplied branch metadata. Only server
 * merge code may set `lastMergedRev`/`mergeBaseRev` — clients sync whole branch records
 * (PatchesSync), so stale values arrive on ordinary metadata updates and must be ignored
 * rather than rejected: honoring them would rewind or advance the merge cursor (re-merging or
 * skipping changes) or shift the merge base's dedup window (re-applying merged changes).
 */
export function stripMergeWatermark<T extends Record<string, any>>(metadata: T): T {
  if (!serverManagedMergeFields.some(field => field in metadata)) return metadata;
  const safe = { ...metadata };
  for (const field of serverManagedMergeFields) delete safe[field];
  return safe;
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
 * @param contentStartRev - The first revision of user content on the branch (after init changes).
 * @param metadata - Optional branch metadata (name, etc.).
 * @returns A new Branch object.
 */
export function createBranchRecord(
  branchDocId: string,
  sourceDocId: string,
  branchedAtRev: number,
  contentStartRev: number,
  metadata?: CreateBranchMetadata | EditableBranchMetadata
): Branch {
  const now = Date.now();
  return {
    // Server-managed merge bookkeeping cannot be seeded at create time: a forged
    // lastMergedRev would skip changes on the first merge, and a forged mergeBaseRev
    // would shift the merge's dedup window and re-apply already-merged changes.
    ...(metadata && stripMergeWatermark(metadata)),
    id: branchDocId,
    docId: sourceDocId,
    branchedAtRev,
    contentStartRev,
    createdAt: now,
    modifiedAt: now,
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
 * Validates that a branch exists and is not a tombstone. Stores return tombstone records
 * from `loadBranch`, and merging one would misbehave: the tombstone drops `lastMergedRev`
 * (and possibly `branchedAtRev`), so the merge would re-copy versions and commit against
 * garbage revs.
 * @param branch - The branch to validate (may be null).
 * @param branchId - The branch ID (for error messages).
 * @throws Error if branch not found or deleted.
 */
export function assertBranchExists(branch: Branch | null, branchId: string): asserts branch is Branch {
  if (!branch) {
    throw new Error(`Branch with ID ${branchId} not found.`);
  }
  if (branch.deleted) {
    throw new Error(`Branch ${branchId} has been deleted.`);
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
    throw new Error(`Merge failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Bound on watermark CAS retries — only contended by concurrent merges of the same branch. */
const MAX_WATERMARK_CAS_RETRIES = 5;

/**
 * Advance a branch's merge watermark (`lastMergedRev`) to `mergedThroughRev` — the highest
 * branch rev included in the merge batch that was just committed — after a successful merge.
 *
 * With a CAS-capable store (`updateBranchIf`), the watermark only ever moves forward: the
 * write is conditioned on the value observed when the merge began, and on a mismatch (a
 * concurrent merge advanced it first) the record is re-read and the write retried — or
 * skipped entirely when the concurrent merge already covered this batch. This closes the
 * read-modify-write race where two interleaved merges could each read a stale watermark and
 * the slower writer regress it, causing the next merge to re-scan (and re-copy versions for)
 * already-merged branch revisions.
 *
 * Stores without the capability keep the legacy non-atomic max-wins read-then-write.
 *
 * Never called with a watermark computed from the branch tip — only from the batch actually
 * read and committed — so a branch edit landing during the merge stays uncovered and is
 * picked up by the next merge.
 */
export async function advanceMergeWatermark(
  store: BranchingStoreBackend,
  branchId: string,
  expectedLastMergedRev: number | undefined,
  mergedThroughRev: number
): Promise<void> {
  if (!store.updateBranchIf) {
    // Legacy semantics: non-atomic read-then-write, max-wins against concurrent merges.
    const current = await store.loadBranch(branchId);
    const effective = Math.max(mergedThroughRev, current?.lastMergedRev ?? 0);
    await store.updateBranch(branchId, { lastMergedRev: effective, modifiedAt: Date.now() });
    return;
  }

  let expected = expectedLastMergedRev;
  for (let attempt = 0; attempt < MAX_WATERMARK_CAS_RETRIES; attempt++) {
    // A concurrent merge already covered this batch — its watermark stands.
    if (expected !== undefined && expected >= mergedThroughRev) return;
    const applied = await store.updateBranchIf(
      branchId,
      { lastMergedRev: mergedThroughRev, modifiedAt: Date.now() },
      { lastMergedRev: expected }
    );
    if (applied) return;
    const current = await store.loadBranch(branchId);
    // Branch deleted mid-merge — nothing to advance; the tombstone stands.
    if (!current || current.deleted) return;
    expected = current.lastMergedRev;
  }
  // Practically unreachable: each failed CAS means another merge advanced the watermark, and
  // it only moves forward. Throwing is safe — the commit itself is idempotent, so a caller
  // retrying the whole merge dedups to a no-op and re-attempts only this write.
  throw new Error(`Failed to advance merge watermark for branch ${branchId} after concurrent merges.`);
}
