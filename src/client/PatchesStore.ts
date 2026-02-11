import type { PatchesSnapshot, PatchesState } from '../types.js';

/** Available algorithm names */
export type AlgorithmName = 'ot' | 'lww';

/** Represents metadata for a document tracked by the store. */
export interface TrackedDoc {
  docId: string;
  /** The last revision number confirmed by the server. */
  committedRev: number;
  /** Optional flag indicating the document has been locally deleted. */
  deleted?: true;
  /** The sync algorithm this document uses. */
  algorithm?: AlgorithmName;
}

/**
 * Pluggable persistence layer contract used by Patches + PatchesSync.
 * It is *not* strictly offline; an in‑memory implementation fulfils the same contract.
 */
export interface PatchesStore {
  /**
   * Registers documents for local tracking and synchronization.
   *
   * Creates local records for new documents or reactivates previously deleted ones.
   * Must handle duplicate calls gracefully - tracking an already-tracked document is a no-op.
   * Sets initial committedRev to 0 for new documents.
   *
   * @param docIds Array of document IDs to start tracking
   * @param algorithm The algorithm to use for this document ('ot' or 'lww')
   * @example
   * // Start tracking two documents
   * await store.trackDocs(['doc1', 'doc2'], 'ot');
   *
   * // Reactivate a previously deleted document
   * await store.trackDocs(['previously-deleted-doc'], 'lww');
   */
  trackDocs(docIds: string[], algorithm?: AlgorithmName): Promise<void>;

  /**
   * Permanently removes documents from local tracking and storage.
   *
   * Deletes all local data (state, pending changes, metadata) without notifying the server.
   * Use this when the user no longer wants a document synchronized locally, not for collaborative deletion.
   * Cannot be undone - use deleteDoc() for collaborative deletion that syncs to other clients.
   *
   * @param docIds Array of document IDs to stop tracking
   * @example
   * // Stop tracking documents the user no longer needs
   * await store.untrackDocs(['old-draft', 'cancelled-project']);
   */
  untrackDocs(docIds: string[]): Promise<void>;

  /**
   * Returns metadata for all locally tracked documents.
   *
   * By default excludes documents marked as deleted. Set includeDeleted=true to include tombstoned
   * documents that are pending server deletion confirmation.
   *
   * @param includeDeleted Whether to include documents marked for deletion
   * @returns Array of document metadata including docId, committedRev, and deletion status
   * @example
   * // Get active documents
   * const activeDocs = await store.listDocs();
   *
   * // Get all documents including deleted ones
   * const allDocs = await store.listDocs(true);
   */
  listDocs(includeDeleted?: boolean): Promise<TrackedDoc[]>;

  /**
   * Retrieves the current document snapshot from storage.
   *
   * Returns the complete document state as last saved, including revision metadata.
   * Returns undefined if the document doesn't exist or isn't tracked.
   * This is the primary method for loading document state on startup.
   *
   * @param docId Document identifier
   * @returns Document snapshot with state and metadata, or undefined if not found
   * @example
   * const snapshot = await store.getDoc('my-document');
   * if (snapshot) {
   *   console.log('Current state:', snapshot.state);
   *   console.log('At revision:', snapshot.rev);
   * }
   */
  getDoc(docId: string): Promise<PatchesSnapshot | undefined>;

  /**
   * Returns the last committed revision for a document.
   *
   * The committed revision is the last revision confirmed by the server.
   * Used during sync to fetch changes since this revision.
   *
   * @param docId Document identifier
   * @returns The last committed revision, or 0 if not found
   * @example
   * const committedRev = await store.getCommittedRev('my-document');
   * const serverChanges = await api.getChangesSince(docId, committedRev);
   */
  getCommittedRev(docId: string): Promise<number>;

  /**
   * Saves the current document state to persistent storage.
   *
   * Overwrites the existing document snapshot with new state and revision metadata.
   * Called after applying committed changes from the server or creating document snapshots.
   * The state should include the revision number it represents.
   *
   * @param docId Document identifier
   * @param docState Complete document state with metadata
   * @example
   * // Save state after applying server changes
   * await store.saveDoc('my-document', {
   *   state: { title: 'Updated Title', content: '...' },
   *   rev: 42,
   *   createdAt: Date.now()
   * });
   */
  saveDoc(docId: string, docState: PatchesState): Promise<void>;

  /**
   * Marks a document for collaborative deletion.
   *
   * Sets the document's deleted flag to create a tombstone that will be synchronized
   * to the server and other clients. The document remains locally accessible until
   * confirmDeleteDoc() is called after server confirmation.
   * Different from untrackDocs() which only affects local storage.
   *
   * @param docId Document identifier to mark for deletion
   * @example
   * // User deletes a document
   * await store.deleteDoc('my-document');
   * // Document is marked deleted but still accessible until server confirms
   */
  deleteDoc(docId: string): Promise<void>;

  /**
   * Confirms server-side deletion and removes the document locally.
   *
   * Called after the server confirms a document deletion. Removes all local data
   * for the document including the tombstone. The document will no longer appear
   * in listDocs() results even with includeDeleted=true.
   *
   * @param docId Document identifier to confirm deletion
   * @example
   * // Server confirmed the deletion
   * await store.confirmDeleteDoc('my-document');
   * // Document is now completely removed from local storage
   */
  confirmDeleteDoc(docId: string): Promise<void>;

  /**
   * Shuts down the store and releases resources.
   *
   * Closes database connections, clears caches, and performs cleanup.
   * Should be called when the application is shutting down or switching stores.
   * The store cannot be used after calling close().
   *
   * @example
   * // Application shutdown
   * await store.close();
   * // Store is no longer usable
   */
  close(): Promise<void>;
}
