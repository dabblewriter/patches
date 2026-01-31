import type { Change, ChangeInput, PatchesState } from '../types.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';

/**
 * Result of committing changes to a document.
 */
export interface CommitResult {
  /** The changes that were committed (potentially transformed). */
  changes: Change[];
  /** Server timestamp in milliseconds (useful for client time calibration). */
  serverTime?: number;
}

/**
 * Interface that document servers must implement to work with the RPC layer.
 * Both PatchesServer (OT) and MergeServer (LWW) implement this interface.
 */
export interface DocumentServer {
  /**
   * Get the current state of a document.
   * @param docId - The document ID.
   * @param atRev - Optional revision to get state at (for OT servers).
   * @returns The document state and revision, or a state with rev 0 if not found.
   */
  getDoc(docId: string, atRev?: number): Promise<PatchesState>;

  /**
   * Get changes that occurred after a specific revision.
   * @param docId - The document ID.
   * @param rev - The revision number to get changes after.
   * @returns Array of changes after the specified revision.
   */
  getChangesSince(docId: string, rev: number): Promise<Change[]>;

  /**
   * Commit changes to a document.
   * @param docId - The document ID.
   * @param changes - The changes to commit.
   * @param options - Optional commit options.
   * @returns Tuple of [priorChanges, newChanges] for OT conflict resolution.
   */
  commitChanges(docId: string, changes: ChangeInput[], options?: any): Promise<[Change[], Change[]]>;

  /**
   * Delete a document.
   * @param docId - The document ID.
   * @param options - Optional deletion options.
   */
  deleteDoc(docId: string, options?: any): Promise<void>;

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
