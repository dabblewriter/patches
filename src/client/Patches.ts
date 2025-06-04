import { type Unsubscriber, signal } from '../event-signal.js';
import type { Change } from '../types.js';
import { singleInvocation } from '../utils/concurrency.js';
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
  unsubscribe: Unsubscriber;
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
  readonly onChange = signal<(docId: string, changes: Change[]) => void>();

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
  @singleInvocation(true) // ensure a second call to openDoc with the same docId returns the same promise while opening
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
    const unsubscribe = doc.onChange(changes => this._savePendingChanges(docId, changes));
    this.docs.set(docId, { doc, unsubscribe });

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
      managed.unsubscribe();
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
    // Unsubscribe from server if tracked (deletes the doc from the store before the next step adds a tombstone)
    if (this.trackedDocs.has(docId)) {
      await this.untrackDocs([docId]);
    }
    // Mark document as deleted in store (adds a tombstone until sync commits it)
    await this.store.deleteDoc(docId);
    this.onDeleteDoc.emit(docId);
  }

  /**
   * Gets an open document instance by ID, if it exists.
   * Used by PatchesSync for applying server changes to open docs.
   * @param docId - The document ID to get.
   * @returns The PatchesDoc instance or undefined if not open.
   */
  getOpenDoc<T extends object>(docId: string): PatchesDoc<T> | undefined {
    return this.docs.get(docId)?.doc as PatchesDoc<T> | undefined;
  }

  /**
   * Closes all open documents and cleans up listeners and store connections.
   * Should be called when shutting down the client.
   */
  close(): void {
    // Clean up local PatchesDoc listeners
    this.docs.forEach(managed => managed.unsubscribe());
    this.docs.clear();

    // Close store connection
    this.store.close();
    this.onChange.clear();
    this.onDeleteDoc.clear();
    this.onUntrackDocs.clear();
    this.onTrackDocs.clear();
    this.onServerCommit.clear();
    this.onError.clear();
  }

  /**
   * Internal handler for saving pending changes to the store.
   * @param docId - The document ID to save the changes for.
   * @param changes - The changes to save.
   */
  protected async _savePendingChanges(docId: string, changes: Change[]): Promise<void> {
    try {
      await this.store.savePendingChanges(docId, changes);
      // Only after it is persisted, emit the change (for PatchesSync to flush)
      this.onChange.emit(docId, changes);
    } catch (err) {
      console.error(`Error saving pending changes for doc ${docId}:`, err);
      this.onError.emit(err as Error, { docId });
    }
  }
}
