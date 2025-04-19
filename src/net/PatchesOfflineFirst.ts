import { createId } from 'crypto-id';
import { PatchDoc } from '../client/PatchDoc.js';
import type { Unsubscriber } from '../event-signal.js';
import { IndexedDBStore } from '../persist/IndexedDBStore.js';
import type { OfflineStore } from '../persist/OfflineStore.js';
import type { Change } from '../types.js';
import { PatchesRealtime, type PatchesRealtimeOptions } from './PatchesRealtime.js';
import { onlineState } from './websocket/onlineState.js';

export interface PatchesOfflineFirstOptions extends PatchesRealtimeOptions {
  /** Provide a custom persistence layer; defaults to IndexedDBStore */
  store?: OfflineStore;
  /** Optional db-name if you keep the default store (defaults to 'patches-offline') */
  dbName?: string;
  /** Optional maximum size in bytes for a batch of changes sent to the server. */
  maxBatchSize?: number;
}

/** Internal structure extending ManagedDoc for offline state */
interface ManagedOfflineDoc<T extends object> {
  doc: PatchDoc<T>;
  onChangeUnsubscriber: Unsubscriber;
  /** Flag indicating if there are pending changes saved locally but not yet sent/confirmed */
  hasPending: boolean;
  /** Flag indicating if a flush operation is currently in progress for this doc */
  isFlushing: boolean;
}

/**
 * High-level client for real-time collaborative editing with offline persistence.
 * Extends PatchesRealtime, storing changes locally first and syncing when online.
 */
export class PatchesOfflineFirst extends PatchesRealtime {
  protected store: OfflineStore;
  protected options: PatchesOfflineFirstOptions;
  // Override docs map to use the extended ManagedOfflineDoc
  protected docs: Map<string, ManagedOfflineDoc<any>> = new Map();
  protected globalSyncTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, opts: PatchesOfflineFirstOptions = {}) {
    // Pass realtime options to the super constructor
    super(url, opts);
    this.options = opts;
    this.store = opts.store ?? new IndexedDBStore(opts.dbName ?? 'patches-offline');

    // --- Event Listeners for Online/Offline State ---
    onlineState.onOnlineChange(isOnline => {
      // Note: PatchesRealtime already handles its internal 'online' state update
      if (isOnline && this.state.connected) {
        // Debounce global sync slightly to avoid rapid toggles
        this._scheduleGlobalSync();
      }
    });

    // Listen to the connection state from the superclass
    // super.onStateChange(state => { // Cannot access protected property here
    // We rely on the public state getter which combines info
    // The connect/disconnect methods in superclass update its state,
    // and we trigger sync on connect/online change.
    // });
  }

  /** Estimate JSON string byte size. */
  private _getJSONByteSize(data: any): number {
    // Basic estimation, might not be perfectly accurate due to encoding nuances
    return new TextEncoder().encode(JSON.stringify(data)).length;
  }

  /** Break changes into batches based on maxBatchSize. */
  private _breakIntoBatches(changes: Change[]): Change[][] {
    const maxSize = this.options.maxBatchSize;
    if (!maxSize || this._getJSONByteSize(changes) < maxSize) {
      return [changes];
    }

    const batchId = createId(12);
    const batches: Change[][] = [];
    let currentBatch: Change[] = [];
    let currentSize = 2; // Account for [] wrapper

    for (const change of changes) {
      // Add batchId if breaking up
      const changeWithBatchId = { ...change, batchId };
      const changeSize = this._getJSONByteSize(changeWithBatchId) + (currentBatch.length > 0 ? 1 : 0); // Add 1 for comma

      // If a single change is too big, we have an issue (should be rare)
      if (changeSize > maxSize && currentBatch.length === 0) {
        console.error(
          `Single change ${change.id} (size ${changeSize}) exceeds maxBatchSize (${maxSize}). Sending as its own batch.`
        );
        batches.push([changeWithBatchId]); // Send it anyway
        continue;
      }

      if (currentSize + changeSize > maxSize) {
        batches.push(currentBatch);
        currentBatch = [];
        currentSize = 2;
      }

      currentBatch.push(changeWithBatchId);
      currentSize += changeSize;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /** Schedule or reschedule the global sync operation. */
  private _scheduleGlobalSync() {
    if (this.globalSyncTimeout) {
      clearTimeout(this.globalSyncTimeout);
    }
    this.globalSyncTimeout = setTimeout(() => {
      this.globalSyncTimeout = null;
      void this._syncAllKnownDocs();
    }, 500); // 500ms debounce
  }

  /** Sync all docs known to the store, including those not currently open. */
  private async _syncAllKnownDocs(): Promise<void> {
    if (!this.state.connected) return;
    this.state = { syncing: 'updating' }; // Use the state setter from superclass

    try {
      const trackedDocs = await this.store.listDocs();
      const allDocIds = trackedDocs.map(d => d.docId);

      // Ensure subscription for all known docs
      if (allDocIds.length > 0) {
        try {
          await this.ws.subscribe(allDocIds);
        } catch (err) {
          console.warn('Error subscribing to all known docs during sync:', err);
          // Continue syncing best effort
        }
      }

      // Sync each doc
      await Promise.all(
        trackedDocs.map(async ({ docId, committedRev }) => {
          const managedDoc = this.docs.get(docId);
          if (managedDoc?.isFlushing) return; // Skip if already flushing

          const pending = await this.store.getPendingChanges(docId);

          if (pending.length > 0) {
            if (managedDoc) managedDoc.hasPending = true;
            await this._flushDoc(docId);
          } else {
            // No pending changes, just check for incoming server changes
            try {
              const serverChanges = await this.ws.getChangesSince(docId, committedRev);
              if (serverChanges.length > 0) {
                // Save committed changes directly to store
                await this.store.saveCommittedChanges(docId, serverChanges);
                // If doc is open, apply to the instance
                managedDoc?.doc.applyExternalServerUpdate(serverChanges);
              }
            } catch (err) {
              console.error(`Error fetching changes for background doc ${docId}:`, err);
              // Don't let one doc failure stop others
            }
          }
        })
      );
      this.state = { syncing: null };
    } catch (error) {
      console.error('Error during global sync:', error);
      this.state = { syncing: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /**
   * Opens a document, loading from the store first, then syncing with the server.
   * Overrides PatchesRealtime.openDoc.
   */
  async openDoc<T extends object>(docId: string, opts: { metadata?: Record<string, any> } = {}): Promise<PatchDoc<T>> {
    // 1. Check if already open
    const existingManagedDoc = this.docs.get(docId);
    if (existingManagedDoc) {
      return existingManagedDoc.doc as PatchDoc<T>;
    }

    this.state = { syncing: 'initial' }; // Indicate loading state

    try {
      // 2. Rebuild local state entirely offline first
      const snapshot = await this.store.getDoc(docId);
      if (snapshot === undefined && !(await this.store.getPendingChanges(docId)).length) {
        // If no snapshot and no pending changes, it might be truly new or fully deleted.
        // Let super.openDoc handle fetching or potential creation.
        // We still need to setup the local listener afterwards.
        const doc = await super.openDoc<T>(docId, opts);
        const onChangeUnsubscriber = this._setupLocalDocSync(docId, doc);
        this.docs.set(docId, { doc, onChangeUnsubscriber, hasPending: false, isFlushing: false });
        this.state = { syncing: null };
        return doc;
      }

      const doc = new PatchDoc<T>(snapshot?.state as T, { ...this.options.metadata, ...opts.metadata });
      if (snapshot) {
        doc.import(snapshot);
      }

      // 3. Register local listener (saves to store, then tries to flush)
      const onChangeUnsubscriber = this._setupLocalDocSync(docId, doc);

      const managedDoc: ManagedOfflineDoc<T> = {
        doc,
        onChangeUnsubscriber,
        hasPending: !!snapshot?.changes?.length, // Mark pending if store returned pending changes
        isFlushing: false,
      };
      this.docs.set(docId, managedDoc);

      // 4. Connect and subscribe (best effort, tolerate offline)
      try {
        await this.connect(); // Ensure connection attempt
        await this.ws.subscribe(docId);
        // If connected, trigger a sync/flush immediately
        if (this.state.connected) {
          void this._flushDoc(docId); // Don't await, let it run in background
          // Fetch latest state in case offline store was stale
          void this._resyncDoc(docId); // Use super's resync
        }
      } catch (err) {
        console.warn(`Offline on openDoc for ${docId}, subscription/sync deferred:`, err);
        // Remain in 'initial' sync state if connection failed?
        // No, set to null, rely on reconnect logic.
      }

      this.state = { syncing: null };
      return doc;
    } catch (error) {
      console.error(`Error opening doc ${docId}:`, error);
      this.state = { syncing: error instanceof Error ? error : new Error(String(error)) };
      this.onError.emit({ type: 'syncError', docId, error: error as Error });
      throw error; // Re-throw for the caller
    }
  }

  /** Sets up the listener for local PatchDoc changes to save and flush. */
  protected _setupLocalDocSync(docId: string, doc: PatchDoc<any>): Unsubscriber {
    return doc.onChange(async () => {
      const managedDoc = this.docs.get(docId);
      if (!managedDoc) return; // Should not happen

      const changes = doc.getUpdatesForServer();
      if (!changes.length) return;

      try {
        await this.store.savePendingChanges(docId, changes);
        managedDoc.hasPending = true;
        // Attempt to flush immediately if online
        if (this.state.connected) {
          void this._flushDoc(docId);
        }
      } catch (error) {
        console.error(`Error saving pending changes for doc ${docId}:`, error);
        this.onError.emit({ type: 'syncError', docId, error: error as Error, recoveryAttempted: false });
        // TODO: What should happen here? Maybe mark doc as dirty/error state?
      }
    });
  }

  /** Flushes pending changes for a specific document to the server. */
  protected async _flushDoc(docId: string): Promise<void> {
    const managedDoc = this.docs.get(docId);
    // Prevent concurrent flushes for the same doc
    if (!managedDoc || managedDoc.isFlushing) return;

    // Only flush if online and connected
    if (!this.state.connected || !onlineState.isOnline) {
      managedDoc.hasPending = true; // Ensure flag is set if called while offline
      return;
    }

    managedDoc.isFlushing = true;
    this.state = { syncing: 'updating' };

    try {
      let pending = await this.store.getPendingChanges(docId);
      if (pending.length === 0) {
        managedDoc.hasPending = false;
        return; // Nothing to flush
      }

      managedDoc.hasPending = true; // Mark as pending initially

      const batches = this._breakIntoBatches(pending);

      for (const batch of batches) {
        if (!this.state.connected || !onlineState.isOnline) {
          throw new Error('Connection lost during batch flush'); // Abort flushing this doc
        }
        const sentRange: [number, number] = [batch[0].rev, batch[batch.length - 1].rev];

        try {
          // Use superclass websocket directly
          const committed = await this.ws.commitChanges(docId, batch);
          // Save committed, remove pending for this batch
          await this.store.saveCommittedChanges(docId, committed, sentRange);
          // Apply confirmation to the local PatchDoc instance if open
          managedDoc.doc.applyServerConfirmation(committed);

          // Update pending list for next iteration (or final check)
          pending = await this.store.getPendingChanges(docId);
        } catch (commitError) {
          console.error(`Error committing batch for doc ${docId}:`, commitError);
          this.onError.emit({ type: 'sendFailed', docId, error: commitError as Error });
          // Let superclass handle potential resync via its error handling?
          // Or should we trigger resync explicitly?
          // For now, just stop flushing this doc on error.
          throw commitError; // Propagate to outer catch
        }
      }

      // If loop completed and no pending changes remain, clear flag
      if (pending.length === 0) {
        managedDoc.hasPending = false;
      }
    } catch (flushError) {
      // Error occurred during flushing (network or commit error)
      // State remains hasPending = true, will retry on next sync/connect
      console.warn(`Flush failed for doc ${docId}:`, flushError);
      // Update global sync state only if it was 'updating'
      if (this.state.syncing === 'updating') {
        this.state = { syncing: flushError instanceof Error ? flushError : new Error(String(flushError)) };
      }
    } finally {
      managedDoc.isFlushing = false;
      // If no other docs are flushing, set global sync state to null
      const stillFlushing = Array.from(this.docs.values()).some(d => d.isFlushing);
      if (!stillFlushing && this.state.syncing !== null && !(this.state.syncing instanceof Error)) {
        this.state = { syncing: null };
      }
    }
  }

  /** Override closeDoc to ensure local listeners are removed. */
  async closeDoc(docId: string): Promise<void> {
    const managedDoc = this.docs.get(docId);
    if (managedDoc) {
      managedDoc.onChangeUnsubscriber();
      this.docs.delete(docId);
    }
    // Let superclass handle unsubscribe etc.
    await super.closeDoc(docId);
  }

  /** Override close to close the store and superclass resources. */
  close(): void {
    if (this.globalSyncTimeout) {
      clearTimeout(this.globalSyncTimeout);
      this.globalSyncTimeout = null;
    }
    // Close store first
    this.store.close().catch(err => console.error('Error closing offline store:', err));
    // Then call super.close() for websocket and listeners
    super.close();
  }

  /** Override deleteDoc to mark in store and sync deletion. */
  async deleteDoc(docId: string): Promise<void> {
    try {
      // Mark as deleted locally first
      await this.store.deleteDoc(docId);
      // If online, attempt server deletion using the protected ws instance
      if (this.state.connected) {
        await this.ws.deleteDoc(docId); // Use protected ws
      }
      // Ensure local instance is closed if open
      if (this.docs.has(docId)) {
        await this.closeDoc(docId);
      }
    } catch (error) {
      console.error(`Error deleting doc ${docId}:`, error);
      this.onError.emit({ type: 'syncError', docId, error: error as Error });
      throw error;
    }
  }

  // Prevent direct use of these methods from PatchesRealtime
  // They are superseded by the store-based logic
  protected override _setupDocSync(docId: string, doc: PatchDoc<any>): Unsubscriber {
    throw new Error('_setupDocSync should not be called directly on PatchesOfflineFirst');
  }
  protected override async _sendPendingIfNecessary(docId: string, doc: PatchDoc<any>): Promise<void> {
    throw new Error('_sendPendingIfNecessary should not be called directly on PatchesOfflineFirst');
  }
  // _resyncDoc is still useful, so we keep it accessible via super._resyncDoc
}
