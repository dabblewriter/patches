import type { JSONPatchOp } from './json-patch/types.js';

export interface Change {
  /** Unique identifier for the change, generated client-side. */
  id: string;
  /** The patch operations. */
  ops: JSONPatchOp[];
  /** The revision number assigned on the client to the optimistic revision and updated by the server after commit. */
  rev: number;
  /** The server revision this change was based on. Required for client->server changes. */
  baseRev?: number;
  /** Client-side timestamp when the change was created. */
  created: number;
  /** Optional batch identifier for grouping changes that belong to the same client batch (for multi-batch offline/large edits). */
  batchId?: string;
  /** Optional arbitrary metadata associated with the change. */
  [metadata: string]: any;
}

/**
 * Represents the state of a document in the OT protocol.
 * @property state - The state of the document.
 * @property rev - The revision number of the state.
 */
export interface PatchesState<T = any> {
  state: T;
  rev: number;
}

/**
 * Represents a snapshot of a document in the OT protocol.
 * @property state - The state of the document.
 * @property rev - The revision number of the state.
 * @property changes - Any unapplied changes since `rev` that may be applied to the `state` to get the latest state.
 */
export interface PatchesSnapshot<T = any> extends PatchesState<T> {
  changes: Change[];
}

/** Status options for a branch */
export type BranchStatus = 'open' | 'closed' | 'merged' | 'archived' | 'abandoned';

export interface Branch {
  /** The ID of the branch document. */
  id: string;
  /** The ID of the document this document was branched from. */
  branchedFromId: string;
  /** The revision number on the source document where the branch occurred. */
  branchedRev: number;
  /** Server-side timestamp when the branch record was created. */
  created: number;
  /** Optional user-friendly name for the branch. */
  name?: string;
  /** Current status of the branch. */
  status: BranchStatus;
  /** Optional arbitrary metadata associated with the branch record. */
  [metadata: string]: any;
}

/**
 * Metadata, state snapshot, and included changes for a specific version.
 */
export interface VersionMetadata {
  /** Unique identifier (UUID) for this version record. */
  id: string;
  name?: string;
  /** ID of the parent version in the history DAG. Undefined for root versions and for the first branched version. */
  parentId?: string;
  /** Identifier linking versions from the same offline batch or branch. */
  groupId?: string;
  /** Indicates how the version was created ('main', 'offline', 'branch'). */
  origin: 'main' | 'offline' | 'branch';
  /** User-defined name if origin is 'branch'. */
  branchName?: string;
  /** Timestamp marking the beginning of the changes included in this version (e.g., first change in session). */
  startDate: number;
  /** Timestamp marking the end of the changes included in this version (e.g., last change in session). */
  endDate: number;
  /** The revision number this version was created at. */
  rev: number;
  /** The revision number on the main timeline before the changes that created this version. If this is an offline/branch version, this is the revision number of the source document where the branch was created and not . */
  baseRev: number;
  /** Optional arbitrary metadata associated with the version. */
  [metadata: string]: any;
}

/**
 * Options for listing committed server changes. *Always* ordered by revision number.
 */
export interface ListChangesOptions {
  /** List changes committed strictly *after* this revision number. */
  startAfter?: number;
  /** List changes committed strictly *before* this revision number. */
  endBefore?: number;
  /** Maximum number of changes to return. */
  limit?: number;
  /** Return changes in descending revision order (latest first). Defaults to false (ascending). */
  reverse?: boolean;
  /** Filter out changes that have the given batch ID. */
  withoutBatchId?: string;
}

/**
 * Options for listing version metadata.
 */
export interface ListVersionsOptions {
  /** List versions whose orderBy field is *after* this value. */
  startAfter?: number;
  /** List versions whose orderBy field is strictly *before* this value. */
  endBefore?: number;
  /** Maximum number of versions to return. */
  limit?: number;
  /** Sort by start date, rev, or baseRev. Defaults to 'rev'. */
  orderBy?: 'startDate' | 'rev' | 'baseRev';
  /** Return versions in descending order. Defaults to false (ascending). When reversed, startAfter and endBefore apply to the *reversed* list. */
  reverse?: boolean;
  /** Filter by the origin type. */
  origin?: 'main' | 'offline' | 'branch';
  /** Filter by the group ID (branch ID or offline batch ID). */
  groupId?: string;
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  status: 'pending' | 'fulfilled' | 'rejected';
}
