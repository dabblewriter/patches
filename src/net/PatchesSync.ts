import { Patches } from '../client/Patches.js';
import type { PatchesStore, TrackedDoc } from '../client/PatchesStore.js';
import { signal } from '../event-signal.js';
import { breakIntoBatches } from '../utils/batching.js';
import type { ConnectionState } from './protocol/types.js';
import { PatchesWebSocket } from './websocket/PatchesWebSocket.js';
import type { WebSocketOptions } from './websocket/WebSocketTransport.js';
import { onlineState } from './websocket/onlineState.js';

export interface PatchesSyncOptions {
  /** WebSocket connection options */
  wsOptions?: WebSocketOptions;
  /**
   * Maximum size in bytes for a single payload (network message).
   * Changes exceeding this will be automatically split.
   */
  maxPayloadBytes?: number;
}

export interface PatchesSyncState {
  online: boolean;
  connected: boolean;
  syncing: 'initial' | 'updating' | null | Error;
}

/**
 * Handles WebSocket connection, document subscriptions, and syncing logic between
 * the Patches instance and the server.
 */
export class PatchesSync {
  private ws: PatchesWebSocket;
  private patches: Patches;
  private store: PatchesStore;
  private options: PatchesSyncOptions;
  private trackedDocs: Set<string>;
  private isFlushing = new Set<string>();
  private globalSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  private _state: PatchesSyncState = { online: false, connected: false, syncing: null };

  // Signals
  readonly onStateChange = signal<(state: PatchesSyncState) => void>();
  readonly onError = signal<(error: Error, context?: { docId?: string }) => void>();

  constructor(url: string, patches: Patches, options: PatchesSyncOptions = {}) {
    this.patches = patches;
    this.store = patches.store;
    this.options = options;
    this.ws = new PatchesWebSocket(url, options.wsOptions);
    this._state.online = onlineState.isOnline;
    this.trackedDocs = new Set(patches.trackedDocs);

    // Set maxPayloadBytes on Patches docOptions if provided
    if (options.maxPayloadBytes) {
      patches.updateDocOptions({ maxPayloadBytes: options.maxPayloadBytes });
    }

    // --- Event Listeners ---
    onlineState.onOnlineChange(this._handleOnlineChange);
    this.ws.onStateChange(this._handleConnectionChange);
    this.ws.onChangesCommitted(({ docId, changes }) => {
      // Persist first, then notify Patches instance to update PatchesDoc
      this.store
        .saveCommittedChanges(docId, changes)
        .then(() => this.patches.applyServerChanges(docId, changes))
        .catch((err: Error) => this.onError.emit(err, { docId }));
    });

    // Forward errors to Patches error signal
    this.onError((err, context) => {
      patches.onError.emit(err, context);
    });

    // Listen to Patches for tracking changes
    patches.onTrackDocs(this._handleDocsTracked);
    patches.onUntrackDocs(this._handleDocsUntracked);
    patches.onDeleteDoc(this._handleDocDeleted);
  }

  get state(): PatchesSyncState {
    return this._state;
  }

  private setState(update: Partial<PatchesSyncState>) {
    const newState = { ...this._state, ...update };
    if (JSON.stringify(this._state) !== JSON.stringify(newState)) {
      this._state = newState;
      this.onStateChange.emit(this._state);
    }
  }

  // --- Connection & Lifecycle ---
  async connect(): Promise<void> {
    try {
      await this.ws.connect();
      // _handleConnectionChange handles state update and sync trigger
    } catch (err) {
      console.error('PatchesSync connection failed:', err);
      this.setState({ connected: false, syncing: err instanceof Error ? err : new Error(String(err)) });
      this.onError.emit(err as Error);
      throw err;
    }
  }

  disconnect(): void {
    if (this.globalSyncTimeout) clearTimeout(this.globalSyncTimeout);
    this.ws.disconnect();
    this.setState({ connected: false, syncing: null });
  }

  // --- Doc Tracking & Subscription (Now handled via signals) ---

  // --- Syncing Logic ---
  private scheduleGlobalSync() {
    if (this.globalSyncTimeout) clearTimeout(this.globalSyncTimeout);
    this.globalSyncTimeout = setTimeout(() => {
      this.globalSyncTimeout = null;
      void this.syncAllKnownDocs();
    }, 300);
  }

  async syncAllKnownDocs(): Promise<void> {
    if (!this.state.connected) return;
    this.setState({ syncing: 'updating' });

    try {
      const tracked = await this.store.listDocs(true); // Include deleted docs
      const activeDocs = tracked.filter(t => !t.deleted);
      const deletedDocs = tracked.filter(t => t.deleted);

      const activeDocIds = activeDocs.map((t: TrackedDoc) => t.docId);

      // Ensure tracked set reflects only active docs for subscription purposes
      this.trackedDocs = new Set(activeDocIds);

      // Subscribe to active docs
      if (activeDocIds.length > 0) {
        try {
          await this.ws.subscribe(activeDocIds);
        } catch (err) {
          console.warn('Error subscribing to active docs during sync:', err);
          this.onError.emit(err as Error);
        }
      }

      // Sync each active doc
      const activeSyncPromises = activeDocIds.map((id: string) => this.syncDoc(id));

      // Attempt to delete docs marked with tombstones
      const deletePromises = deletedDocs.map(async ({ docId }) => {
        try {
          console.info(`Attempting server delete for tombstoned doc: ${docId}`);
          await this.ws.deleteDoc(docId);
          // If server delete succeeds, remove tombstone and all data locally
          await this.store.confirmDeleteDoc(docId);
          console.info(`Successfully deleted and untracked doc: ${docId}`);
        } catch (err) {
          // If server delete fails (e.g., offline, already deleted), keep tombstone for retry
          console.warn(`Server delete failed for ${docId}, keeping tombstone:`, err);
          this.onError.emit(err as Error, { docId });
        }
      });

      // Wait for all sync and delete operations
      await Promise.all([...activeSyncPromises, ...deletePromises]);

      this.setState({ syncing: null });
    } catch (error) {
      console.error('Error during global sync:', error);
      this.setState({ syncing: error instanceof Error ? error : new Error(String(error)) });
      this.onError.emit(error as Error);
    }
  }

  async syncDoc(docId: string): Promise<void> {
    if (this.isFlushing.has(docId)) return; // Already flushing
    if (!this.state.connected) return;

    try {
      const pending = await this.store.getPendingChanges(docId);
      if (pending.length > 0) {
        await this.flushDoc(docId); // flushDoc handles setting flushing state
      } else {
        // No pending, just check for server changes
        const [committedRev] = await this.store.getLastRevs(docId);
        if (committedRev) {
          const serverChanges = await this.ws.getChangesSince(docId, committedRev);
          if (serverChanges.length > 0) {
            await this.store.saveCommittedChanges(docId, serverChanges);
            this.patches.applyServerChanges(docId, serverChanges);
          }
        } else {
          const snapshot = await this.ws.getDoc(docId);
          await this.store.saveDoc(docId, snapshot);
        }
      }
    } catch (err) {
      console.error(`Error syncing doc ${docId}:`, err);
      this.onError.emit(err as Error, { docId });
      // Don't let one doc failure stop others in global sync
    }
  }

  async flushDoc(docId: string): Promise<void> {
    if (!this.trackedDocs.has(docId)) {
      throw new Error(`Document ${docId} is not tracked`);
    }
    if (this.isFlushing.has(docId)) {
      throw new Error(`Document ${docId} is already being flushed`);
    }
    if (!this.state.connected) {
      throw new Error('Not connected to server');
    }

    this.isFlushing.add(docId);
    if (this.state.syncing !== 'updating') {
      this.setState({ syncing: 'updating' });
    }

    try {
      // Get changes from Patches for this doc
      let pending = await this.store.getPendingChanges(docId);
      if (!pending.length) {
        // Try to get from memory if available
        pending = this.patches.getDocChanges(docId);
        if (!pending.length) {
          this.isFlushing.delete(docId);
          return; // Nothing to flush
        }
      }

      const batches = breakIntoBatches(pending, this.options.maxPayloadBytes);

      for (const batch of batches) {
        if (!this.state.connected) {
          throw new Error('Disconnected during flush');
        }
        const range: [number, number] = [batch[0].rev, batch[batch.length - 1].rev];
        const committed = await this.ws.commitChanges(docId, batch);
        // Persist committed + remove pending in store
        await this.store.saveCommittedChanges(docId, committed, range);
        // Notify Patches to update PatchesDoc
        this.patches.applyServerChanges(docId, committed);
        // Fetch remaining pending for next batch or check completion
        pending = await this.store.getPendingChanges(docId);
      }
    } catch (err) {
      console.error(`Flush failed for doc ${docId}:`, err);
      this.onError.emit(err as Error, { docId });
      // Let Patches know about the failure
      this.patches.handleSendFailure(docId);
      // Don't clear flushing flag, let next sync attempt retry
      throw err; // Re-throw so caller (like syncAll) knows it failed
    } finally {
      this.isFlushing.delete(docId);
      // Update global sync state if nothing else is flushing
      if (this.isFlushing.size === 0 && this.state.syncing === 'updating') {
        this.setState({ syncing: null });
      }
    }
  }

  // --- Server Operations ---
  /**
   * Initiates the deletion process for a document both locally and on the server.
   * This now delegates the local tombstone marking to Patches.
   */
  async _handleDocDeleted(docId: string): Promise<void> {
    // Attempt server delete if online
    if (this.state.connected) {
      try {
        await this.ws.deleteDoc(docId);
        await this.store.confirmDeleteDoc(docId);
      } catch (err) {
        console.error(`Server delete failed for doc ${docId}, will retry on reconnect/resync.`, err);
        this.onError.emit(err as Error, { docId });
        throw err;
      }
    } else {
      console.warn(`Offline: Server delete for doc ${docId} deferred.`);
    }
  }

  // --- Event Handlers ---
  private _handleOnlineChange = (isOnline: boolean) => {
    this.setState({ online: isOnline });
    if (isOnline && this.state.connected) {
      this.scheduleGlobalSync();
    }
  };

  private _handleConnectionChange = (connectionState: ConnectionState) => {
    const isConnected = connectionState === 'connected';
    const isConnecting = connectionState === 'connecting';

    // Preserve syncing state if moving from connecting -> connected
    // Reset syncing if disconnected or errored
    const newSyncingState = isConnected
      ? this._state.syncing // Preserve
      : isConnecting
        ? this._state.syncing // Preserve during connecting phase too
        : null; // Reset

    this.setState({ connected: isConnected, syncing: newSyncingState });

    if (isConnected) {
      // Sync everything on connect/reconnect
      void this.syncAllKnownDocs();
    }
  };

  private _handleDocsTracked = async (docIds: string[]) => {
    const newIds = docIds.filter(id => !this.trackedDocs.has(id));
    if (!newIds.length) return;

    newIds.forEach(id => this.trackedDocs.add(id));

    if (this.state.connected) {
      try {
        await this.ws.subscribe(newIds);
        // Trigger sync for newly tracked docs immediately
        await Promise.all(newIds.map(id => this.syncDoc(id)));
      } catch (err) {
        console.warn(`Failed to subscribe/sync newly tracked docs: ${newIds.join(', ')}`, err);
        this.onError.emit(err as Error);
        // State remains tracked locally, will retry on next sync
      }
    }
  };

  private _handleDocsUntracked = async (docIds: string[]) => {
    const existingIds = docIds.filter(id => this.trackedDocs.has(id));
    if (!existingIds.length) return;

    existingIds.forEach(id => this.trackedDocs.delete(id));
    if (this.state.connected) {
      try {
        await this.ws.unsubscribe(existingIds);
      } catch (err) {
        console.warn(`Failed to unsubscribe docs: ${existingIds.join(', ')}`, err);
        // Continue with local untrack
      }
    }
  };
}
