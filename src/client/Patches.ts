import { type Unsubscriber, signal } from '../event-signal.js';
import type { PatchesStore } from '../persist/PatchesStore.js';
import type { Change } from '../types.js';
import { PatchesDoc } from './PatchesDoc.js';

// Simplified options without sync-specific parameters
export interface PatchesOptions {
  /** Persistence layer instance (e.g., new IndexedDBStore('my-db') or new InMemoryStore()). */
  store: PatchesStore;
  /** Initial metadata to attach to changes from this client (merged with per-doc metadata). */
  metadata?: Record<string, any>;
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
    this.store.listDocs().then(docs => {
      this.trackDocs(docs.map(({ docId }) => docId));
    });
  }

  // --- Public API Methods ---

  async trackDocs(docIds: string[]): Promise<void> {
    docIds = docIds.filter(id => !this.trackedDocs.has(id));
    if (!docIds.length) return;
    docIds.forEach(this.trackedDocs.add, this.trackedDocs);
    this.onTrackDocs.emit(docIds);
    await this.store.trackDocs(docIds);
  }

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
    const doc = new PatchesDoc<T>(initialState, mergedMetadata);
    doc.setId(docId);
    if (snapshot) {
      doc.import(snapshot);
    }

    // Set up local listener -> store
    const unsub = this._setupLocalDocListener(docId, doc);
    this.docs.set(docId, { doc, onChangeUnsubscriber: unsub });

    return doc;
  }

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
   * Gets all tracked document IDs that are currently open.
   * Used by PatchesSync to check which docs need syncing.
   */
  getOpenDocIds(): string[] {
    return Array.from(this.docs.keys());
  }

  /**
   * Retrieves changes for a document that should be sent to the server.
   * Used by PatchesSync during synchronization.
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
   * Handles failure to send changes to the server.
   * Used by PatchesSync to requeue changes after failures.
   */
  handleSendFailure(docId: string): void {
    const doc = this.docs.get(docId)?.doc;
    if (doc) {
      doc.handleSendFailure();
    }
  }

  /**
   * Apply server changes to a document.
   * Used by PatchesSync to update documents with server changes.
   */
  applyServerChanges(docId: string, changes: Change[]): void {
    this._handleServerCommit(docId, changes);
  }

  close(): void {
    // Clean up local PatchesDoc listeners
    this.docs.forEach(managed => managed.onChangeUnsubscriber());
    this.docs.clear();

    // Close store connection
    void this.store.close();
  }

  // --- Internal Handlers ---

  protected _setupLocalDocListener(docId: string, doc: PatchesDoc<any>): Unsubscriber {
    return doc.onChange(async () => {
      const changes = doc.getUpdatesForServer();
      if (!changes.length) return;
      try {
        await this.store.savePendingChanges(docId, changes);
        // Note: When used with PatchesSync, it will handle flushing the changes
      } catch (err) {
        console.error(`Error saving pending changes for doc ${docId}:`, err);
        this.onError.emit(err as Error, { docId });
      }
    });
  }

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
