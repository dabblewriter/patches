import type { JSONPatchOp } from '../json-patch/types.js';
import type {
  Branch,
  Change,
  DocumentTombstone,
  EditableVersionMetadata,
  ListBranchesOptions,
  ListChangesOptions,
  ListVersionsOptions,
  VersionMetadata,
} from '../types.js';

/**
 * Base interface for all server store backends.
 * Provides the minimal deletion capability that all servers need.
 */
export interface ServerStoreBackend {
  /** Deletes a document and all its associated data. */
  deleteDoc(docId: string): Promise<void>;
}

/**
 * Interface for version storage, shared between OT and LWW.
 * OT requires this, LWW can optionally implement it for user-visible versioning.
 */
export interface VersioningStoreBackend {
  /**
   * Saves version metadata and optionally the original changes.
   * Implementations are responsible for building and persisting version state —
   * inline or queued, but must throw if state creation fails.
   *
   * Concurrency: count-based versioning can fire during continuous high-rate streaming, so two
   * server instances may attempt to create overlapping versions for the same `[startRev, endRev]`
   * range at nearly the same time. This is not a data-loss/convergence hazard (versions are
   * derived snapshots of already-committed changes), but implementations that care about a clean
   * version history should make creation idempotent on the covered range (e.g. key on
   * `docId + endRev`, or dedupe overlapping ranges) rather than blindly appending.
   * @param changes - Optional for LWW (which doesn't store changes), required for OT.
   */
  createVersion(docId: string, metadata: VersionMetadata, changes?: Change[]): Promise<void>;

  /** Lists version metadata based on filtering/sorting options. */
  listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]>;

  /** Loads metadata for a specific version by its ID. */
  loadVersion(docId: string, versionId: string): Promise<VersionMetadata | undefined>;

  /**
   * Loads the state snapshot for a specific version ID.
   * Returns a JSON string, ReadableStream of JSON chunks, or undefined if not found.
   * ReadableStream allows large state blobs to be streamed without full materialization.
   */
  loadVersionState(docId: string, versionId: string): Promise<string | ReadableStream<string> | undefined>;

  /** Update a version's metadata. */
  updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void>;

  /** Loads the original Change objects associated with a specific version ID. */
  loadVersionChanges?(docId: string, versionId: string): Promise<Change[]>;
}

/**
 * Interface for OT (Operational Transformation) storage backend.
 * Extends ServerStoreBackend and VersioningStoreBackend because OT requires versioning
 * for session tracking and state snapshots.
 */
export interface OTStoreBackend extends ServerStoreBackend, VersioningStoreBackend {
  /**
   * Get the current revision number without loading state.
   * @param docId - The document ID.
   * @returns The current revision number, or 0 if document doesn't exist.
   */
  getCurrentRev(docId: string): Promise<number>;

  /** Saves a batch of committed server changes. */
  saveChanges(docId: string, changes: Change[]): Promise<void>;

  /** Lists committed server changes based on revision numbers. */
  listChanges(docId: string, options: ListChangesOptions): Promise<Change[]>;
}

/**
 * Options for listing fields. Use either sinceRev OR paths, not both.
 */
export type ListFieldsOptions = { sinceRev: number } | { paths: string[] };

/**
 * Change ids to record atomically with a saveOps call, for retry idempotency.
 * `expireAt` is a unix-ms timestamp after which the ids may be discarded —
 * provided so implementations can TTL-index rather than track age themselves.
 */
export interface CommittedChangeIds {
  ids: string[];
  expireAt: number;
}

/**
 * Result from LWW getSnapshot. State is a ReadableStream so large snapshots
 * can be streamed to clients without full materialization.
 */
export interface SnapshotResult {
  rev: number;
  state: ReadableStream<string>;
}

/**
 * Interface for LWW (Last-Write-Wins) storage backend.
 * LWW stores fields (not changes) and reconstructs state from fields.
 */
export interface LWWStoreBackend extends ServerStoreBackend {
  /**
   * Get the current revision number without reconstructing state.
   * More efficient than getSnapshot() when only the revision is needed.
   * @param docId - The document ID.
   * @returns The current revision number, or 0 if document doesn't exist.
   */
  getCurrentRev(docId: string): Promise<number>;

  /**
   * Get the latest snapshot of document state.
   * State is returned as a ReadableStream so it can be streamed to clients.
   * @param docId - The document ID.
   * @returns The snapshot revision and state stream, or null if no snapshot exists.
   */
  getSnapshot(docId: string): Promise<SnapshotResult | null>;

  /**
   * Save a snapshot of document state (overwrites previous snapshot).
   * @param docId - The document ID.
   * @param state - The document state.
   * @param rev - The revision number.
   */
  saveSnapshot(docId: string, state: any, rev: number): Promise<void>;

  /**
   * List field metadata, optionally filtered by paths or revision.
   *
   * Options are mutually exclusive:
   * - `{ sinceRev: number }` - Get fields changed since a revision
   * - `{ paths: string[] }` - Get fields at specific paths
   * - No options - Get all fields
   *
   * @param docId - The document ID.
   * @param options - Optional filter options.
   * @returns Array of field metadata matching the criteria.
   */
  listOps(docId: string, options?: ListFieldsOptions): Promise<JSONPatchOp[]>;

  /**
   * Save field metadata and atomically increment the revision.
   *
   * Implementation requirements:
   * - Atomically increment the document revision
   * - Set the rev on all saved fields to the new revision
   * - Delete children atomically when saving a parent (e.g., saving /obj deletes /obj/name)
   * - Delete paths in pathsToDelete atomically with saving ops
   * - Persist changeIds.ids in the same transaction as the ops (see below) — recording
   *   them in a separate call could ack the ops and lose the ids, silently re-enabling
   *   double-applied retries
   *
   * @param docId - The document ID.
   * @param ops - Array of ops to save.
   * @param pathsToDelete - Optional paths to delete atomically.
   * @param changeIds - Optional change ids to record atomically for retry dedup.
   *   Only passed by servers when the backend implements {@link seenChangeIds}.
   * @returns The new revision number.
   */
  saveOps(docId: string, ops: JSONPatchOp[], pathsToDelete?: string[], changeIds?: CommittedChangeIds): Promise<number>;

  /**
   * Return which of the given change ids were recorded by a prior saveOps call and have
   * not yet expired. Enables retry idempotency: LWW compacts ops per path and keeps no
   * change log, so without this a client retrying an unacked commit re-applies delta ops
   * (@inc/@bit/@max/@min) and double-counts.
   *
   * Optional — when absent, LWWServer skips dedup and retried deltas double-apply.
   * Expiry is the implementation's job; use the expireAt passed to saveOps (a TTL index
   * or lazy pruning both work).
   */
  seenChangeIds?(docId: string, ids: string[]): Promise<string[]>;
}

/**
 * Interface for tombstone storage, providing soft-delete capabilities.
 * Optional add-on for servers that need to track deleted documents.
 */
export interface TombstoneStoreBackend {
  /** Creates a tombstone for a deleted document. Called before deleteDoc() to preserve deletion metadata. */
  createTombstone(tombstone: DocumentTombstone): Promise<void>;

  /** Retrieves a tombstone for a document if it exists. Returns undefined if the document was never deleted or tombstone has expired. */
  getTombstone(docId: string): Promise<DocumentTombstone | undefined>;

  /** Removes a tombstone (for undelete or TTL cleanup). */
  removeTombstone(docId: string): Promise<void>;
}

/**
 * Precondition for {@link BranchingStoreBackend.updateBranchIf}.
 *
 * Every key *present* on the object is compared against the branch record's current value
 * with strict equality, where `undefined` means "the field is not set on the record".
 * Implementations must distinguish a key set to `undefined` from an absent key (use
 * `Object.keys(expected)` / the `in` operator, not truthiness).
 */
export interface BranchPrecondition {
  /** Expected current merge watermark (`undefined` = never merged). */
  lastMergedRev?: number | undefined;
  /** Expected current persisted merge base (`undefined` = not set). */
  mergeBaseRev?: number | undefined;
}

/**
 * Interface for branch storage. Standalone interface that can be composed
 * with OTStoreBackend or LWWStoreBackend as needed.
 */
export interface BranchingStoreBackend {
  /**
   * Generates a unique ID for a new branch document.
   * If not provided, a random 22-character ID is generated using createId().
   * @param docId - The source document ID being branched from
   */
  createBranchId?(docId: string): Promise<string> | string;

  /** Lists metadata records for branches originating from a document. */
  listBranches(docId: string, options?: ListBranchesOptions): Promise<Branch[]>;

  /** Loads the metadata record for a specific branch ID. */
  loadBranch(branchId: string): Promise<Branch | null>;

  /** Creates or updates the metadata record for a branch. */
  createBranch(branch: Branch): Promise<void>;

  /** Updates mutable fields of an existing branch record (excludes immutable identity fields). */
  updateBranch(
    branchId: string,
    updates: Partial<Omit<Branch, 'id' | 'docId' | 'branchedAtRev' | 'createdAt' | 'contentStartRev'>>
  ): Promise<void>;

  /**
   * Optional capability: compare-and-set update of a branch record.
   *
   * Atomically applies `updates` only when the branch record's current values match
   * `expected` (see {@link BranchPrecondition} for the comparison contract). Returns `true`
   * when the update was applied and `false` on a precondition mismatch — including when the
   * branch record is missing or tombstoned.
   *
   * Backends should implement this with their native conditional-write primitive (a
   * transaction, an ETag/revision precondition, a conditional UPDATE). Merge code uses it to
   * advance the merge watermark (`lastMergedRev`) and to pin the merge base (`mergeBaseRev`)
   * without racing concurrent merges of the same branch. Stores without this capability fall
   * back to non-atomic read-then-write (max-wins) semantics, so multi-instance deployments
   * that can merge a branch concurrently should implement it.
   */
  updateBranchIf?(
    branchId: string,
    updates: Partial<Omit<Branch, 'id' | 'docId' | 'branchedAtRev' | 'createdAt' | 'contentStartRev'>>,
    expected: BranchPrecondition
  ): Promise<boolean>;

  /**
   * Replaces a branch record with a tombstone containing only `id`, `docId`, `modifiedAt`,
   * and `deleted: true`. Tombstones are returned by `listBranches` when `since` is provided
   * so that clients can clean up their local cache.
   */
  deleteBranch(branchId: string): Promise<void>;
}
