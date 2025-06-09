import type { Change, PatchesSnapshot, PatchesState } from '../types.js';
/** Represents metadata for a document tracked by the store. */
export interface TrackedDoc {
  docId: string;
  /** The last revision number confirmed by the server. */
  committedRev: number;
  /** Optional flag indicating the document has been locally deleted. */
  deleted?: true;
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
   * @example
   * // Start tracking two documents
   * await store.trackDocs(['doc1', 'doc2']);
   *
   * // Reactivate a previously deleted document
   * await store.trackDocs(['previously-deleted-doc']);
   */
  trackDocs(docIds: string[]): Promise<void>;

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
   * Retrieves all pending (unconfirmed) changes for a document.
   *
   * Pending changes are local edits that haven't been confirmed by the server yet.
   * Returns changes in chronological order as they were created locally.
   * Used during sync to resend unconfirmed operations.
   *
   * @param docId Document identifier
   * @returns Array of pending changes in chronological order
   * @example
   * const pendingChanges = await store.getPendingChanges('my-document');
   * console.log(`${pendingChanges.length} changes waiting for server confirmation`);
   */
  getPendingChanges(docId: string): Promise<Change[]>;

  /**
   * Returns revision counters for tracking document sync state.
   *
   * committedRev: Last revision confirmed by the server
   * pendingRev: Next revision number for new local changes
   * The gap between these indicates how many changes are pending server confirmation.
   *
   * @param docId Document identifier
   * @returns Tuple of [committedRev, pendingRev]
   * @example
   * const [committed, pending] = await store.getLastRevs('my-document');
   * console.log(`Server confirmed through rev ${committed}, local changes at rev ${pending}`);
   * if (pending > committed) {
   *   console.log(`${pending - committed} changes pending server confirmation`);
   * }
   */
  getLastRevs(docId: string): Promise<[committedRev: number, pendingRev: number]>;

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
   * Appends new pending changes to the document's local change queue.
   *
   * Adds changes to the end of the pending changes list without replacing existing ones.
   * Called when the user makes local edits that haven't been sent to the server yet.
   * Changes should have sequential revision numbers starting after the last pending change.
   *
   * @param docId Document identifier
   * @param changes Array of new changes to append
   * @example
   * // User made a local edit
   * const newChange = { rev: 15, patches: [...], clientId: 'client-123' };
   * await store.savePendingChanges('my-document', [newChange]);
   */
  savePendingChanges(docId: string, changes: Change[]): Promise<void>;

  /**
   * Records changes confirmed by the server and optionally removes sent pending changes.
   *
   * Adds server-confirmed changes to the document's history and updates the committed revision.
   * If sentPendingRange is provided, removes the specified range of pending changes that
   * were confirmed by the server (they're no longer pending).
   *
   * @param docId Document identifier
   * @param changes Server-confirmed changes to record
   * @param sentPendingRange Optional range [startRev, endRev] of pending changes to remove
   * @example
   * // Server confirmed our changes
   * await store.saveCommittedChanges('my-document', serverChanges, [10, 12]);
   *
   * // Server sent changes from other clients
   * await store.saveCommittedChanges('my-document', serverChanges);
   */
  saveCommittedChanges(docId: string, changes: Change[], sentPendingRange?: [number, number]): Promise<void>;

  /**
   * Completely replaces the document's pending changes with a new set.
   *
   * Discards all existing pending changes and replaces them with the provided array.
   * Used when operational transformation rebases pending changes after receiving server updates.
   * The new changes should have sequential revision numbers.
   *
   * @param docId Document identifier
   * @param changes New complete set of pending changes
   * @example
   * // After rebasing pending changes due to server conflicts
   * const rebasedChanges = transformPendingChanges(serverChanges, currentPending);
   * await store.replacePendingChanges('my-document', rebasedChanges);
   */
  replacePendingChanges(docId: string, changes: Change[]): Promise<void>;

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
