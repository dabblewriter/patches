import type { Change, PatchesSnapshot, PatchesState } from '../types.js';
/** Represents metadata for a document tracked by the store. */
export interface TrackedDoc {
  docId: string;
  /** The last revision number confirmed by the server. */
  committedRev: number;
  /** Optional flag indicating the document has been locally deleted. */
  deleted?: true;
  /** The last revision that was attempted to be submitted to the server. */
  lastAttemptedSubmissionRev?: number;
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
   * Atomically applies server-confirmed changes and updates pending changes.
   *
   * This is the core sync operation that must be atomic: server changes become
   * committed history, and pending changes are replaced with their rebased versions.
   * Implementations must ensure both operations complete together (single transaction
   * for databases) to prevent inconsistent state if the app crashes mid-operation.
   *
   * @param docId Document identifier
   * @param serverChanges Changes confirmed by the server to add to committed history
   * @param rebasedPendingChanges Pending changes after OT rebasing (replaces all existing pending)
   * @example
   * // After receiving server changes and rebasing pending
   * const rebased = rebaseChanges(serverChanges, pending);
   * await store.applyServerChanges('my-document', serverChanges, rebased);
   */
  applyServerChanges(docId: string, serverChanges: Change[], rebasedPendingChanges: Change[]): Promise<void>;

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

  /**
   * Gets the last revision that was attempted to be submitted to the server.
   *
   * This bookmark is used by change collapsing to avoid modifying changes that
   * may have been partially committed by the server. Returns undefined if no
   * submission has been attempted yet.
   *
   * @param docId Document identifier
   * @returns The last attempted submission revision, or undefined if none
   * @example
   * const lastAttempted = await store.getLastAttemptedSubmissionRev('my-document');
   * // Use this to protect changes from collapsing
   */
  getLastAttemptedSubmissionRev?(docId: string): Promise<number | undefined>;

  /**
   * Sets the last revision that was attempted to be submitted to the server.
   *
   * Called before sending changes to the server to mark them as "in flight".
   * This prevents change collapsing from modifying these changes in case the
   * server commits them but the client doesn't receive confirmation.
   *
   * @param docId Document identifier
   * @param rev The revision being submitted
   * @example
   * // Before sending batch to server
   * await store.setLastAttemptedSubmissionRev('my-document', lastChange.rev);
   * await sendToServer(batch);
   */
  setLastAttemptedSubmissionRev?(docId: string, rev: number): Promise<void>;
}
