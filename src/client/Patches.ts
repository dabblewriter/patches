import { type Unsubscriber, signal } from '../event-signal.js';
import type { Change } from '../types.js';
import { PatchesDoc, type PatchesDocOptions } from './PatchesDoc.js';
import type { PatchesStore } from './PatchesStore.js';

// Simplified options without sync-specific parameters
export interface PatchesOptions {
  /** Persistence layer instance (e.g., new IndexedDBStore('my-db') or new InMemoryStore()). */
  store: PatchesStore;
  /** Initial metadata to attach to changes from this client (merged with per-doc metadata). */
  metadata?: Record<string, any>;
  /** Document-level options to pass to each PatchesDoc instance */
  docOptions?: PatchesDocOptions;
}

// Keep internal doc management structure
interface ManagedDoc<T extends object> {
  doc: PatchesDoc<T>;
  onChangeUnsubscriber: Unsubscriber;
}

/**
 * Main client-side entry point for the Patches library.
 * Manages document instances (`PatchesDoc`) and persistence (`PatchesStore`).
 * Can be used standalone or with PatchesSync for network synchronization.
 */
export class Patches {
  protected options: PatchesOptions;
  protected docs: Map<string, ManagedDoc<any>> = new Map();

  readonly docOptions: PatchesDocOptions;
  readonly store: PatchesStore;
  readonly trackedDocs = new Set<string>();

  // Public signals
  readonly onError = signal<(error: Error, context?: { docId?: string }) => void>();
  readonly onServerCommit = signal<(docId: string, changes: Change[]) => void>();
  readonly onTrackDocs = signal<(docIds: string[]) => void>();
  readonly onUntrackDocs = signal<(docIds: string[]) => void>();
  readonly onDeleteDoc = signal<(docId: string) => void>();

  constructor(opts: PatchesOptions) {
    this.options = opts;
    this.store = opts.store;
    this.docOptions = opts.docOptions ?? {};
    this.store.listDocs().then(docs => {
      this.trackDocs(docs.map(({ docId }) => docId));
    });
  }

  // --- Public API Methods ---

  /**
   * Tracks the given document IDs, adding them to the set of tracked documents and notifying listeners.
   * Tracked docs are kept in sync with the server, even when not open locally.
   * This allows for background syncing and updates of unopened documents.
   * @param docIds - Array of document IDs to track.
   */
  async trackDocs(docIds: string[]): Promise<void> {
    docIds = docIds.filter(id => !this.trackedDocs.has(id));
    if (!docIds.length) return;
    docIds.forEach(this.trackedDocs.add, this.trackedDocs);
    this.onTrackDocs.emit(docIds);
    await this.store.trackDocs(docIds);
  }

  /**
   * Untracks the given document IDs, removing them from the set of tracked documents and notifying listeners.
   * Untracked docs will no longer be kept in sync with the server, even if not open locally.
   * Closes any open docs and removes them from the store.
   * @param docIds - Array of document IDs to untrack.
   */
  async untrackDocs(docIds: string[]): Promise<void> {
    docIds = docIds.filter(id => this.trackedDocs.has(id));
    if (!docIds.length) return;
    docIds.forEach(this.trackedDocs.delete, this.trackedDocs);
    this.onUntrackDocs.emit(docIds);

    // Close any open PatchesDoc instances first
    const closedPromises = docIds.filter(id => this.docs.has(id)).map(id => this.closeDoc(id)); // closeDoc removes from this.docs map
    await Promise.all(closedPromises);

    // Remove from store
    await this.store.untrackDocs(docIds);
  }

  /**
   * Opens a document by ID, loading its state from the store and setting up change listeners.
   * If the doc is already open, returns the existing instance.
   * @param docId - The document ID to open.
   * @param opts - Optional metadata to merge with the doc's metadata.
   * @returns The opened PatchesDoc instance.
   */
  async openDoc<T extends object>(
    docId: string,
    opts: { metadata?: Record<string, any> } = {}
  ): Promise<PatchesDoc<T>> {
    const existing = this.docs.get(docId);
    if (existing) return existing.doc as PatchesDoc<T>;

    // Ensure the doc is tracked before proceeding
    await this.trackDocs([docId]);

    // Load initial state from store
    const snapshot = await this.store.getDoc(docId);
    const initialState = (snapshot?.state ?? {}) as T;
    const mergedMetadata = { ...this.options.metadata, ...opts.metadata };
    const doc = new PatchesDoc<T>(initialState, mergedMetadata, this.docOptions);
    doc.setId(docId);
    if (snapshot) {
      doc.import(snapshot);
    }

    // Set up local listener -> store
    const unsub = this._setupLocalDocListener(docId, doc);
    
    try {
      this.docs.set(docId, { doc, onChangeUnsubscriber: unsub });
    } catch (error) {
      // Clean up listener if adding to docs map fails
      unsub();
      throw error;
    }

    return doc;
  }

  /**
   * Closes an open document by ID, removing listeners and optionally untracking it.
   * @param docId - The document ID to close.
   * @param options - Optional: set untrack to true to also untrack the doc.
   */
  async closeDoc(docId: string, { untrack = false }: { untrack?: boolean } = {}): Promise<void> {
    const managed = this.docs.get(docId);
    if (managed) {
      managed.onChangeUnsubscriber();
      this.docs.delete(docId);
      if (untrack) {
        await this.untrackDocs([docId]);
      }
    }
  }

  /**
   * Deletes a document by ID, closing it if open, untracking it, and removing it from the store.
   * Emits the onDeleteDoc signal.
   * @param docId - The document ID to delete.
   */
  async deleteDoc(docId: string): Promise<void> {
    // Close if open locally
    if (this.docs.has(docId)) {
      await this.closeDoc(docId);
    }
    // Unsubscribe from server if tracked
    if (this.trackedDocs.has(docId)) {
      await this.untrackDocs([docId]);
    }
    // Mark document as deleted in store
    await this.store.deleteDoc(docId);
    this.onDeleteDoc.emit(docId);
  }

  /**
   * Gets all tracked document IDs that are currently open in memory.
   * Used by PatchesSync to determine which docs need syncing.
   * @returns Array of open document IDs.
   */
  getOpenDocIds(): string[] {
    return Array.from(this.docs.keys());
  }

  /**
   * Retrieves local changes for a document that should be sent to the server.
   * Used by PatchesSync during synchronization.
   * @param docId - The document ID to get changes for.
   * @returns Array of Change objects to send to the server.
   */
  getDocChanges(docId: string): Change[] {
    const doc = this.docs.get(docId)?.doc;
    if (!doc) return [];
    try {
      return doc.getUpdatesForServer();
    } catch (err) {
      console.error(`Error getting updates for doc ${docId}:`, err);
      this.onError.emit(err as Error, { docId });
      return [];
    }
  }

  /**
   * Handles a failure to send changes to the server for a given document.
   * Used by PatchesSync to requeue changes after failures.
   * @param docId - The document ID for which sending failed.
   */
  handleSendFailure(docId: string): void {
    const doc = this.docs.get(docId)?.doc;
    if (doc) {
      doc.handleSendFailure();
    }
  }

  /**
   * Applies server-confirmed changes to a document.
   * Used by PatchesSync to update documents with server changes.
   * @param docId - The document ID to apply changes to.
   * @param changes - Array of Change objects from the server.
   */
  applyServerChanges(docId: string, changes: Change[]): void {
    this._handleServerCommit(docId, changes);
  }

  /**
   * Closes all open documents and cleans up listeners and store connections.
   * Should be called when shutting down the client.
   */
  close(): void {
    // Clean up local PatchesDoc listeners
    this.docs.forEach(managed => managed.onChangeUnsubscriber());
    this.docs.clear();

    // Clear all event signal subscribers
    this.onError.clear();
    this.onServerCommit.clear();
    this.onTrackDocs.clear();
    this.onUntrackDocs.clear();
    this.onDeleteDoc.clear();

    // Close store connection
    void this.store.close();
  }

  /**
   * Updates document options that will be applied to all new documents
   * @param options - Options to merge with current docOptions
   */
  updateDocOptions(options: Partial<PatchesDocOptions>): void {
    Object.assign(this.docOptions, options);
  }

  // --- Internal Handlers ---

  /**
   * Sets up a listener for local changes on a PatchesDoc, saving pending changes to the store.
   * @param docId - The document ID being managed.
   * @param doc - The PatchesDoc instance to listen to.
   * @returns An Unsubscriber function to remove the listener.
   */
  protected _setupLocalDocListener(docId: string, doc: PatchesDoc<any>): Unsubscriber {
    return doc.onChange(async change => {
      try {
        await this.store.savePendingChange(docId, change);
        // Note: When used with PatchesSync, it will handle flushing the changes
      } catch (err) {
        console.error(`Error saving pending changes for doc ${docId}:`, err);
        this.onError.emit(err as Error, { docId });
      }
    });
  }

  /**
   * Internal handler for applying server commits to a document and emitting errors if needed.
   * @param docId - The document ID to update.
   * @param changes - Array of Change objects from the server.
   */
  private _handleServerCommit = (docId: string, changes: Change[]) => {
    const managedDoc = this.docs.get(docId);
    if (managedDoc) {
      try {
        // Apply confirmed/transformed changes from the server
        managedDoc.doc.applyExternalServerUpdate(changes);
      } catch (err) {
        console.error(`Error applying server commit for doc ${docId}:`, err);
        this.onError.emit(err as Error, { docId });
      }
    }
    // If doc isn't open locally, changes were already saved to store by PatchesSync
  };
}
