import type { Change, ChangeInput, CommitChangesOptions, DeleteDocOptions, PatchesState } from '../types.js';
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
 * Both PatchesServer (OT) and MergeServer (LWW) implement this interface.
 *
 * Methods are called via JSON-RPC from clients. Each method is stateless
 * and receives the document ID as the first parameter.
 */
export interface DocumentServer {
  /**
   * Get the current state of a document.
   * @param docId - The document ID.
   * @param atRev - Optional revision to get state at (for OT servers).
   * @returns The document state and revision, or `{ state: {}, rev: 0 }` if not found.
   */
  getDoc(docId: string, atRev?: number): Promise<PatchesState>;

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
