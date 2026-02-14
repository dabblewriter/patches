import type { JSONPatchOp } from '../json-patch/types.js';
import type {
  Branch,
  Change,
  DocumentTombstone,
  EditableVersionMetadata,
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
   * Saves version metadata, its state snapshot, and optionally the original changes.
   * State and changes are stored separately from the core metadata.
   * @param changes - Optional for LWW (which doesn't store changes), required for OT.
   */
  createVersion(docId: string, metadata: VersionMetadata, state: any, changes?: Change[]): Promise<void>;

  /** Lists version metadata based on filtering/sorting options. */
  listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]>;

  /** Loads the state snapshot for a specific version ID. */
  loadVersionState(docId: string, versionId: string): Promise<any | undefined>;

  /** Update a version's metadata. */
  updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void>;

  /** Loads the original Change objects associated with a specific version ID. */
  loadVersionChanges?(docId: string, versionId: string): Promise<Change[]>;

  /**
   * Appends changes to an existing version, updating its state snapshot, endedAt, and endRev.
   * Used when a session spans multiple batch submissions.
   */
  appendVersionChanges?(
    docId: string,
    versionId: string,
    changes: Change[],
    newEndedAt: number,
    newEndRev: number,
    newState: any
  ): Promise<void>;
}

/**
 * Interface for OT (Operational Transformation) storage backend.
 * Extends ServerStoreBackend and VersioningStoreBackend because OT requires versioning
 * for session tracking and state snapshots.
 */
export interface OTStoreBackend extends ServerStoreBackend, VersioningStoreBackend {
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
 * Interface for LWW (Last-Write-Wins) storage backend.
 * LWW stores fields (not changes) and reconstructs state from fields.
 *
 * ## Rich Text Support
 *
 * LWW supports collaborative rich text editing via `@txt` operations. While standard
 * LWW fields use timestamp-based conflict resolution, `@txt` fields use Delta-based
 * Operational Transformation for character-level merge of concurrent edits.
 *
 * To support `@txt`, the store must implement the optional `TextDeltaStoreBackend`
 * interface. The text delta log stores individual deltas per text field path, enabling:
 * 1. **Transform**: Incoming text deltas are transformed against concurrent edits
 * 2. **Catchup**: Clients that missed changes receive composed deltas (not full text)
 *
 * The delta log can be pruned after snapshots — it is not needed for state reconstruction.
 * The field store always contains the current composed text value for each text field.
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
   * @param docId - The document ID.
   * @returns The snapshot state and revision, or null if no snapshot exists.
   */
  getSnapshot(docId: string): Promise<{ state: any; rev: number } | null>;

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
   *
   * @param docId - The document ID.
   * @param ops - Array of ops to save.
   * @param pathsToDelete - Optional paths to delete atomically.
   * @returns The new revision number.
   */
  saveOps(docId: string, ops: JSONPatchOp[], pathsToDelete?: string[]): Promise<number>;
}

/**
 * Optional interface for storing text delta history, enabling collaborative
 * rich text editing within LWW documents.
 *
 * The text delta log is an append-only record of individual `@txt` deltas per field path.
 * It serves two purposes:
 * 1. **Transform**: When concurrent text edits arrive, the server transforms incoming
 *    deltas against recent deltas from the log to ensure correct merge.
 * 2. **Catchup**: When a client requests changes since a revision, text fields return
 *    a composed delta (not the full text) so the client can transform against local pending.
 *
 * The delta log is NOT needed for state reconstruction — the field store (`listOps`)
 * always contains the current composed text value. Deltas can be pruned after snapshots.
 *
 * ## Implementation Requirements
 *
 * - `appendTextDelta`: Store a delta with its document path and revision. Called after
 *   the field store is updated with the composed text value.
 * - `getTextDeltasSince`: Return all deltas for a specific path since a given revision,
 *   ordered by revision ascending. Used for both transform and catchup.
 * - `getAllTextDeltasSince`: Return all text deltas across all paths since a revision,
 *   ordered by revision ascending. Used by `getChangesSince()` for efficient catchup.
 * - `pruneTextDeltas`: Delete deltas at or before a revision. Called after snapshots
 *   and when text fields are deleted. Pass specific paths to clean up deleted fields,
 *   or omit paths to prune all deltas up to the revision (e.g., after compaction).
 *
 * ## Example: SQL Schema
 *
 * ```sql
 * CREATE TABLE text_deltas (
 *   doc_id TEXT NOT NULL,
 *   path TEXT NOT NULL,
 *   rev INTEGER NOT NULL,
 *   delta JSON NOT NULL,
 *   PRIMARY KEY (doc_id, path, rev)
 * );
 * CREATE INDEX idx_text_deltas_since ON text_deltas (doc_id, rev);
 * ```
 */
export interface TextDeltaStoreBackend {
  /**
   * Append a text delta to the log for a specific field path.
   * Called after the field store is updated with the composed text value.
   *
   * @param docId - The document ID.
   * @param path - The JSON Pointer path of the text field (e.g., '/body').
   * @param delta - The delta ops array (from Delta.ops).
   * @param rev - The revision number this delta was committed at.
   */
  appendTextDelta(docId: string, path: string, delta: any[], rev: number): Promise<void>;

  /**
   * Get all text deltas for a specific path since a given revision.
   * Returns deltas in ascending revision order.
   *
   * @param docId - The document ID.
   * @param path - The JSON Pointer path of the text field.
   * @param sinceRev - Return deltas with rev strictly greater than this value.
   * @returns Array of `{ path, delta, rev }` entries ordered by rev ascending.
   */
  getTextDeltasSince(docId: string, path: string, sinceRev: number): Promise<TextDeltaEntry[]>;

  /**
   * Get all text deltas across all paths since a given revision.
   * Returns deltas in ascending revision order. Used by `getChangesSince()`
   * to build composed text catchup for clients.
   *
   * @param docId - The document ID.
   * @param sinceRev - Return deltas with rev strictly greater than this value.
   * @returns Array of `{ path, delta, rev }` entries ordered by rev ascending.
   */
  getAllTextDeltasSince(docId: string, sinceRev: number): Promise<TextDeltaEntry[]>;

  /**
   * Delete text deltas at or before a given revision, optionally filtered by paths.
   *
   * When `paths` is provided, only deletes deltas for those specific paths (used when
   * a text field is deleted or overwritten). When `paths` is omitted, deletes all
   * deltas up to the revision (used after snapshot compaction).
   *
   * @param docId - The document ID.
   * @param atOrBeforeRev - Delete deltas with rev ≤ this value.
   * @param paths - Optional specific paths to prune. If omitted, prunes all paths.
   */
  pruneTextDeltas(docId: string, atOrBeforeRev: number, paths?: string[]): Promise<void>;
}

/**
 * A single entry in the text delta log.
 */
export interface TextDeltaEntry {
  /** The JSON Pointer path of the text field. */
  path: string;
  /** The delta ops array. */
  delta: any[];
  /** The revision this delta was committed at. */
  rev: number;
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
  listBranches(docId: string): Promise<Branch[]>;

  /** Loads the metadata record for a specific branch ID. */
  loadBranch(branchId: string): Promise<Branch | null>;

  /** Creates or updates the metadata record for a branch. */
  createBranch(branch: Branch): Promise<void>;

  /** Updates specific fields (status, name, metadata) of an existing branch record. */
  updateBranch(branchId: string, updates: Partial<Pick<Branch, 'status' | 'name' | 'metadata'>>): Promise<void>;

  /**
   * @deprecated Use updateBranch with status instead.
   * Marks a branch as closed. Implementations might handle this via updateBranch.
   */
  closeBranch(branchId: string): Promise<void>;
}
