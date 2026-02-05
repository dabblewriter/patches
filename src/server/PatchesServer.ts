import type {
  Change,
  ChangeInput,
  ChangeMutator,
  CommitChangesOptions,
  DeleteDocOptions,
  EditableVersionMetadata,
  PatchesState,
} from '../types.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';

/**
 * Result of committing changes to a document.
 * Used internally by the algorithm layer to provide structured information
 * about what was committed.
 */
export interface CommitResult {
  /** Changes the client missed from other clients (for catchup sync). */
  catchupChanges: Change[];
  /** The client's changes after transformation (will be broadcast to others). */
  newChanges: Change[];
}

/**
 * Interface that document servers must implement to work with the RPC layer.
 * Both OTServer and LWWServer implement this interface.
 *
 * Methods are called via JSON-RPC from clients. Each method is stateless
 * and receives the document ID as the first parameter.
 */
export interface PatchesServer {
  /**
   * Get the current state of a document.
   * @param docId - The document ID.
   * @returns The document state and revision, or `{ state: {}, rev: 0 }` if not found.
   */
  getDoc(docId: string): Promise<PatchesState>;

  /**
   * Get changes that occurred after a specific revision.
   * @param docId - The document ID.
   * @param rev - The revision number to get changes after.
   * @returns Array of changes after the specified revision, in revision order.
   */
  getChangesSince(docId: string, rev: number): Promise<Change[]>;

  /**
   * Commit changes to a document.
   *
   * Applies operational transformation as needed, assigns revision numbers,
   * and persists the changes. Returns all changes the client needs to apply:
   * both catchup changes (from other clients) and the client's own transformed changes.
   *
   * @param docId - The document ID.
   * @param changes - The changes to commit.
   * @param options - Optional commit options.
   * @returns Combined array of catchup changes followed by the client's committed changes.
   */
  commitChanges(docId: string, changes: ChangeInput[], options?: CommitChangesOptions): Promise<Change[]>;

  /**
   * Delete a document.
   * @param docId - The document ID.
   * @param options - Optional deletion options.
   */
  deleteDoc(docId: string, options?: DeleteDocOptions): Promise<void>;

  /**
   * Removes the tombstone for a deleted document, allowing it to be recreated.
   * @param docId - The document ID.
   * @returns True if tombstone was found and removed, false if no tombstone existed.
   */
  undeleteDoc?(docId: string): Promise<boolean>;

  /**
   * Captures the current state of a document as a new version.
   * @param docId - The document ID.
   * @param metadata - Optional metadata for the version.
   * @returns The ID of the created version, or null if no changes to capture.
   */
  captureCurrentVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string | null>;

  /**
   * Make a server-side change to a document.
   * @param docId - The document ID.
   * @param mutator - A function that receives a JSONPatch and PathProxy to define the changes.
   * @param metadata - Optional metadata for the change.
   * @returns The created change, or null if no operations were generated.
   */
  change<T = Record<string, any>>(
    docId: string,
    mutator: ChangeMutator<T>,
    metadata?: Record<string, any>
  ): Promise<Change | null>;
}

/**
 * Interface for objects that can be registered with JSONRPCServer.register().
 * Requires a static `api` property defining method access levels.
 */
export interface Registrable {
  constructor: { api: ApiDefinition };
}

/**
 * Helper type to extract the static api from a class.
 */
export type StaticApi<T> = T extends { api: infer A } ? A : never;
