import type { Change, PatchSnapshot } from '../types.js';

/** Represents metadata for a document tracked by the offline store. */
export interface TrackedDoc {
  docId: string;
  /** The last revision number confirmed by the server. */
  committedRev: number;
  /** Optional flag indicating the document has been locally deleted. */
  deleted?: true;
}

/**
 * Minimal contract for an offline persistence layer used by PatchesOfflineFirst.
 * Implementations handle storing document snapshots, changes (pending and committed),
 * and tracking document metadata.
 */
export interface OfflineStore {
  /** -------- Reconstruction / Bootstrap -------- */

  /** Retrieves the last snapshot, applies committed changes, and rebased pending changes. */
  getDoc(docId: string): Promise<PatchSnapshot | undefined>;

  /** Retrieves all pending changes for a specific document. */
  getPendingChanges(docId: string): Promise<Change[]>;

  /** Gets the latest committed revision and the highest pending revision for a document. */
  getLastRevs(docId: string): Promise<[committedRev: number, pendingRev: number]>;

  /** Lists metadata for all documents known to the store. */
  listDocs(): Promise<TrackedDoc[]>;

  /** -------- Writes -------- */

  /** Saves locally generated changes to the pending queue before attempting to send. */
  savePendingChanges(docId: string, changes: Change[]): Promise<void>;

  /** Saves server-confirmed changes, removing the corresponding pending changes. */
  saveCommittedChanges(
    docId: string,
    changes: Change[],
    /** The revision range of pending changes that were successfully sent and confirmed. */
    sentPendingRange?: [minRev: number, maxRev: number]
  ): Promise<void>;

  /** -------- Misc -------- */

  /** Marks a document as deleted locally and removes associated data. */
  deleteDoc(docId: string): Promise<void>;

  /** Closes the connection to the underlying storage. */
  close(): Promise<void>;
}
