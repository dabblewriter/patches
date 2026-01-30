import type {
  Branch,
  Change,
  DocumentTombstone,
  EditableVersionMetadata,
  ListChangesOptions,
  ListVersionsOptions,
  PatchesState,
  VersionMetadata,
} from '../types.js';

/**
 * Interface for a backend storage system for patch synchronization.
 * Defines methods needed by PatchesServer, PatchesHistoryManager, etc.
 */
export interface PatchesStoreBackend {
  /** Saves a batch of committed server changes. */
  saveChanges(docId: string, changes: Change[]): Promise<void>;

  /** Lists committed server changes based on revision numbers. */
  listChanges(docId: string, options: ListChangesOptions): Promise<Change[]>;

  /** Loads the last version state for a document. Optional method for performance. */
  loadLastVersionState?: (docId: string) => Promise<PatchesState | undefined>;

  /** Saves the last version state for a document. Optional method for performance. */
  saveLastVersionState?: (docId: string, rev: number, state: any) => Promise<void>;

  /**
   * Saves version metadata, its state snapshot, and the original changes that constitute it.
   * State and changes are stored separately from the core metadata.
   */
  createVersion(docId: string, metadata: VersionMetadata, state: any, changes: Change[]): Promise<void>;

  /** Update a version's metadata. */
  updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void>;

  /**
   * Appends changes to an existing version, updating its state snapshot, endedAt, and endRev.
   * Used when a session spans multiple batch submissions.
   */
  appendVersionChanges(
    docId: string,
    versionId: string,
    changes: Change[],
    newEndedAt: number,
    newEndRev: number,
    newState: any
  ): Promise<void>;

  /** Lists version metadata based on filtering/sorting options. */
  listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]>;

  /** Loads the state snapshot for a specific version ID. */
  loadVersionState(docId: string, versionId: string): Promise<any | undefined>;

  /** Loads the original Change objects associated with a specific version ID. */
  loadVersionChanges(docId: string, versionId: string): Promise<Change[]>;

  /** Deletes a document. */
  deleteDoc(docId: string): Promise<void>;

  /** Creates a tombstone for a deleted document. Called before deleteDoc() to preserve deletion metadata. */
  createTombstone(tombstone: DocumentTombstone): Promise<void>;

  /** Retrieves a tombstone for a document if it exists. Returns undefined if the document was never deleted or tombstone has expired. */
  getTombstone(docId: string): Promise<DocumentTombstone | undefined>;

  /** Removes a tombstone (for undelete or TTL cleanup). */
  removeTombstone(docId: string): Promise<void>;
}

/**
 * Extends PatchesStoreBackend with methods specifically for managing branches.
 */
export interface BranchingStoreBackend extends PatchesStoreBackend {
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
  createBranch(branch: Branch): Promise<void>; // Changed return type

  /** Updates specific fields (status, name, metadata) of an existing branch record. */
  updateBranch(branchId: string, updates: Partial<Pick<Branch, 'status' | 'name' | 'metadata'>>): Promise<void>;

  /**
   * @deprecated Use updateBranch with status instead.
   * Marks a branch as closed. Implementations might handle this via updateBranch.
   */
  closeBranch(branchId: string): Promise<void>;
}
