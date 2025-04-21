import { PatchDoc } from '../client/PatchDoc.js';
import { type Unsubscriber } from '../event-signal.js';
import type { PatchesStore } from '../persist/PatchesStore.js';
import type { Change } from '../types.js';
import { PatchesSync, type PatchesSyncOptions, type PatchesSyncState } from './PatchesSync.js';

// Combine options for constructor convenience
export interface PatchesOptions extends PatchesSyncOptions {
  /** URL of the Patches WebSocket server. */
  url: string;
  /** Persistence layer instance (e.g., new IndexedDBStore('my-db') or new InMemoryStore()). */
  store: PatchesStore;
  /** Initial metadata to attach to changes from this client (merged with per-doc metadata). */
  metadata?: Record<string, any>;
}

// Keep internal doc management structure
interface ManagedDoc<T extends object> {
  doc: PatchDoc<T>;
  onChangeUnsubscriber: Unsubscriber;
  // isFlushing/hasPending are now managed within PatchesSync
}

/**
 * Main client-side entry point for the Patches library.
 * Manages document instances (`PatchDoc`), persistence (`PatchStore`),
 * and network synchronization (`PatchesSync`).
 */
export class Patches {
  protected store: PatchesStore;
  protected sync: PatchesSync;
  protected options: PatchesOptions;
  protected docs: Map<string, ManagedDoc<any>> = new Map();

  // Public signals (re-emitted from PatchesSync)
  readonly onStateChange: typeof this.sync.onStateChange;
  readonly onError: typeof this.sync.onError;

  constructor(opts: PatchesOptions) {
    this.options = opts;

    // Initialize store - Now guaranteed by options type
    this.store = opts.store;

    // Initialize sync layer
    this.sync = new PatchesSync(opts.url, this.store, {
      wsOptions: opts.wsOptions,
      maxBatchSize: opts.maxBatchSize,
    });

    // Expose signals
    this.onStateChange = this.sync.onStateChange;
    this.onError = this.sync.onError;

    // Handle server commits coming from the sync layer
    this.sync.onServerCommit(this._handleServerCommit);

    // Initialize connection (don't block constructor)
    void this.sync.connect();
  }

  // --- Public API Methods ---

  get state(): PatchesSyncState {
    return this.sync.state;
  }

  async connect(): Promise<void> {
    await this.sync.connect();
  }

  disconnect(): void {
    this.sync.disconnect();
  }

  async trackDocs(docIds: string[]): Promise<void> {
    await this.sync.trackDocs(docIds);
  }

  async untrackDocs(docIds: string[]): Promise<void> {
    // Close any open PatchDoc instances first
    const closedPromises = docIds.filter(id => this.docs.has(id)).map(id => this.closeDoc(id)); // closeDoc removes from this.docs map
    await Promise.all(closedPromises);

    // Then tell sync layer to untrack and remove from store
    await this.sync.untrackDocs(docIds);
  }

  async openDoc<T extends object>(docId: string, opts: { metadata?: Record<string, any> } = {}): Promise<PatchDoc<T>> {
    const existing = this.docs.get(docId);
    if (existing) return existing.doc as PatchDoc<T>;

    // Ensure the doc is tracked before proceeding
    await this.trackDocs([docId]);

    // Load initial state from store
    const snapshot = await this.store.getDoc(docId);
    const initialState = (snapshot?.state ?? {}) as T;
    const mergedMetadata = { ...this.options.metadata, ...opts.metadata };
    const doc = new PatchDoc<T>(initialState, mergedMetadata);
    doc.setId(docId);
    if (snapshot) {
      doc.import(snapshot);
    }

    // Set up local listener -> store -> sync
    const unsub = this._setupLocalDocListener(docId, doc);
    this.docs.set(docId, { doc, onChangeUnsubscriber: unsub });

    // Trigger initial sync for this specific doc (if needed)
    // Note: Global sync on connect already handles most cases
    if (this.sync.state.connected) {
      await this.sync.syncDoc(docId);
    }

    return doc;
  }

  async closeDoc(docId: string): Promise<void> {
    const managed = this.docs.get(docId);
    if (managed) {
      managed.onChangeUnsubscriber();
      this.docs.delete(docId);
      // Note: We do NOT call untrackDocs here automatically.
      // Closing a doc just removes it from memory; it remains tracked
      // for background sync unless explicitly untracked.
    }
  }

  async deleteDoc(docId: string): Promise<void> {
    // Close if open locally
    if (this.docs.has(docId)) {
      await this.closeDoc(docId);
    }
    // Delegate delete (incl. untracking) to sync layer
    await this.sync.deleteDoc(docId);
  }

  close(): void {
    // Disconnect sync layer (stops WebSocket)
    this.sync.disconnect();

    // Clean up local PatchDoc listeners
    this.docs.forEach(managed => managed.onChangeUnsubscriber());
    this.docs.clear();

    // Close store connection
    void this.store.close();
  }

  // --- Internal Handlers ---

  protected _setupLocalDocListener(docId: string, doc: PatchDoc<any>): Unsubscriber {
    return doc.onChange(async () => {
      const changes = doc.getUpdatesForServer();
      if (!changes.length) return;
      try {
        await this.store.savePendingChanges(docId, changes);
        // Notify sync layer to flush changes for this doc
        void this.sync.flushDoc(docId);
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
        // TODO: Consider triggering a resync or other recovery?
        void this.sync.syncDoc(docId); // Attempt resync on apply failure
      }
    }
    // If doc isn't open locally, changes were already saved to store by PatchesSync
  };
}
