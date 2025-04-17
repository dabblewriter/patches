import type { JSONPatchOp } from './json-patch/types';

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
  /** Optional arbitrary metadata associated with the change. */
  metadata?: Record<string, any>;
  /** Optional batch identifier for grouping changes that belong to the same client batch (for multi-batch offline/large edits). */
  batchId?: string;
}

/**
 * Represents the state of a document in the OT protocol.
 * @property state - The state of the document.
 * @property rev - The revision number of the state.
 */
export interface PatchState<T = any> {
  state: T;
  rev: number;
}

/**
 * Represents a snapshot of a document in the OT protocol.
 * @property state - The state of the document.
 * @property rev - The revision number of the state.
 * @property changes - Any unapplied changes since `rev` that may be applied to the `state` to get the latest state.
 */
export interface PatchSnapshot<T = any> extends PatchState<T> {
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
  metadata?: Record<string, any>;
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

/**
 * Interface for a backend storage system for patch synchronization.
 * Defines methods needed by PatchServer, HistoryManager, etc.
 */
export interface PatchStoreBackend {
  /** Adds a subscription for a client to one or more documents. */
  addSubscription(clientId: string, docIds: string[]): Promise<string[]>;

  /** Removes a subscription for a client from one or more documents. */
  removeSubscription(clientId: string, docIds: string[]): Promise<string[]>;

  /** Saves a batch of committed server changes. */
  saveChanges(docId: string, changes: Change[]): Promise<void>;

  /** Lists committed server changes based on revision numbers. */
  listChanges(docId: string, options: ListChangesOptions): Promise<Change[]>;

  /**
   * Saves version metadata, its state snapshot, and the original changes that constitute it.
   * State and changes are stored separately from the core metadata.
   */
  createVersion(docId: string, metadata: VersionMetadata, state: any, changes: Change[]): Promise<void>;

  /** Update a version's metadata. */
  updateVersion(docId: string, versionId: string, metadata: Partial<VersionMetadata>): Promise<void>;

  /** Lists version metadata based on filtering/sorting options. */
  listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]>;

  /** Loads the state snapshot for a specific version ID. */
  loadVersionState(docId: string, versionId: string): Promise<any | undefined>;

  /** Loads the original Change objects associated with a specific version ID. */
  loadVersionChanges(docId: string, versionId: string): Promise<Change[]>;

  /** Deletes a document. */
  deleteDoc(docId: string): Promise<void>;
}

/**
 * Extends PatchStoreBackend with methods specifically for managing branches.
 */
export interface BranchingStoreBackend extends PatchStoreBackend {
  /** Lists metadata records for branches originating from a document. */
  listBranches(docId: string): Promise<Branch[]>;

  /** Loads the metadata record for a specific branch ID. */
  loadBranch(branchId: string): Promise<Branch | null>;

  /** Creates or updates the metadata record for a branch. */
  createBranch(branch: Branch): Promise<void>; // Changed return type

  /** Updates specific fields (status, name, metadata) of an existing branch record. */
  updateBranch(branchId: string, updates: Partial<Pick<Branch, 'status' | 'name' | 'metadata'>>): Promise<void>;

  /**
   * @deprecated Use updateBranch with status instead.
   * Marks a branch as closed. Implementations might handle this via updateBranch.
   */
  closeBranch(branchId: string): Promise<void>;
}
