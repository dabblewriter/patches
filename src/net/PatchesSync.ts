import { isEqual } from '@dabble/delta';
import { applyCommittedChanges } from '../algorithms/client/applyCommittedChanges.js';
import { breakChangesIntoBatches, type SizeCalculator } from '../algorithms/shared/changeBatching.js';
import { Patches } from '../client/Patches.js';
import type { PatchesStore, TrackedDoc } from '../client/PatchesStore.js';
import { signal } from '../event-signal.js';
import type { Change, SyncingState } from '../types.js';
import { blockable } from '../utils/concurrency.js';
import type { ConnectionState } from './protocol/types.js';
import { PatchesWebSocket } from './websocket/PatchesWebSocket.js';
import type { WebSocketOptions } from './websocket/WebSocketTransport.js';
import { onlineState } from './websocket/onlineState.js';

export interface PatchesSyncState {
  online: boolean;
  connected: boolean;
  syncing: SyncingState;
}

export interface PatchesSyncOptions {
  subscribeFilter?: (docIds: string[]) => string[];
  websocket?: WebSocketOptions;
  /** Wire batch limit for network transmission. Defaults to 1MB. */
  maxPayloadBytes?: number;
  /** Per-change storage limit for backend. Falls back to patches.docOptions.maxStorageBytes. */
  maxStorageBytes?: number;
  /** Custom size calculator for storage limit. Falls back to patches.docOptions.sizeCalculator. */
  sizeCalculator?: SizeCalculator;
}

/**
 * Handles WebSocket connection, document subscriptions, and syncing logic between
 * the Patches instance and the server.
 */
export class PatchesSync {
  protected ws: PatchesWebSocket;
  protected patches: Patches;
  protected store: PatchesStore;
  protected maxPayloadBytes?: number;
  protected maxStorageBytes?: number;
  protected sizeCalculator?: SizeCalculator;
  protected trackedDocs: Set<string>;
  protected _state: PatchesSyncState = { online: false, connected: false, syncing: null };

  /**
   * Signal emitted when the sync state changes.
   */
  readonly onStateChange = signal<(state: PatchesSyncState) => void>();
  /**
   * Signal emitted when an error occurs.
   */
  readonly onError = signal<(error: Error, context?: { docId?: string }) => void>();
  /**
   * Signal emitted when a document is deleted remotely (by another client or discovered via tombstone).
   * Provides the pending changes that were discarded so the application can handle them.
   */
  readonly onRemoteDocDeleted = signal<(docId: string, pendingChanges: Change[]) => void>();

  constructor(
    patches: Patches,
    url: string,
    protected options?: PatchesSyncOptions
  ) {
    this.patches = patches;
    this.store = patches.store;
    // Use options if provided, otherwise fall back to patches.docOptions
    this.maxPayloadBytes = options?.maxPayloadBytes;
    this.maxStorageBytes = options?.maxStorageBytes ?? patches.docOptions?.maxStorageBytes;
    this.sizeCalculator = options?.sizeCalculator ?? patches.docOptions?.sizeCalculator;
    this.ws = new PatchesWebSocket(url, options?.websocket);
    this._state.online = onlineState.isOnline;
    this.trackedDocs = new Set(patches.trackedDocs);

    // --- Event Listeners ---
    onlineState.onOnlineChange(online => this.updateState({ online }));
    this.ws.onStateChange(this._handleConnectionChange.bind(this));
    this.ws.onChangesCommitted(this._receiveCommittedChanges.bind(this));
    this.ws.onDocDeleted(docId => this._handleRemoteDocDeleted(docId));

    // Listen to Patches for tracking changes
    patches.onTrackDocs(this._handleDocsTracked.bind(this));
    patches.onUntrackDocs(this._handleDocsUntracked.bind(this));
    patches.onDeleteDoc(this._handleDocDeleted.bind(this));
    patches.onChange(this._handleDocChange.bind(this));
  }

  /**
   * Gets the URL of the WebSocket connection.
   */
  get url(): string {
    return this.ws.transport.url;
  }

  /**
   * Sets the URL of the WebSocket connection.
   */
  set url(url: string) {
    this.ws.transport.url = url;
    if (this.state.connected) {
      this.ws.disconnect();
      this.ws.connect();
    }
  }

  /**
   * Gets the current sync state.
   */
  get state(): PatchesSyncState {
    return this._state;
  }

  /**
   * Gets the JSON-RPC client for making custom RPC calls.
   * Useful for application-specific methods not part of the Patches protocol.
   */
  get rpc() {
    return this.ws.rpc;
  }

  /**
   * Updates the sync state.
   * @param update - The partial state to update.
   */
  protected updateState(update: Partial<PatchesSyncState>) {
    const newState = { ...this._state, ...update };
    if (!isEqual(this._state, newState)) {
      this._state = newState;
      this.onStateChange.emit(this._state);
    }
  }

  /**
   * Connects to the WebSocket server and starts syncing if online. If not online, it will wait for online state.
   */
  async connect(): Promise<void> {
    try {
      await this.ws.connect();
    } catch (err) {
      console.error('PatchesSync connection failed:', err);
      this.updateState({ connected: false, syncing: err instanceof Error ? err : new Error(String(err)) });
      this.onError.emit(err as Error);
      throw err;
    }
  }

  /**
   * Disconnects from the WebSocket server and stops syncing.
   */
  disconnect(): void {
    this.ws.disconnect();
    this.updateState({ connected: false, syncing: null });
  }

  /**
   * Syncs all known docs when initially connected.
   */
  protected async syncAllKnownDocs(): Promise<void> {
    if (!this.state.connected) return;
    this.updateState({ syncing: 'updating' });

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
          const subscribeIds = this.options?.subscribeFilter?.(activeDocIds) || activeDocIds;
          if (subscribeIds.length) {
            await this.ws.subscribe(subscribeIds);
          }
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

      this.updateState({ syncing: null });
    } catch (error) {
      console.error('Error during global sync:', error);
      this.updateState({ syncing: error instanceof Error ? error : new Error(String(error)) });
      this.onError.emit(error as Error);
    }
  }

  /**
   * Syncs a single document.
   * @param docId The ID of the document to sync.
   */
  @blockable
  protected async syncDoc(docId: string): Promise<void> {
    if (!this.state.connected) return;

    const doc = this.patches.getOpenDoc(docId);
    if (doc) {
      doc.updateSyncing('updating');
    }
    try {
      const pending = await this.store.getPendingChanges(docId);

      if (pending.length > 0) {
        await this.flushDoc(docId, pending);
      } else {
        const [committedRev] = await this.store.getLastRevs(docId);
        if (committedRev) {
          const serverChanges = await this.ws.getChangesSince(docId, committedRev);
          if (serverChanges.length > 0) {
            await this._applyServerChangesToDoc(docId, serverChanges);
          }
        } else {
          const snapshot = await this.ws.getDoc(docId);
          await this.store.saveDoc(docId, snapshot);
          if (doc) {
            doc.import({ ...snapshot, changes: [] });
          }
        }
      }
      if (doc) {
        doc.updateSyncing(null);
      }
    } catch (err) {
      // Handle DOC_DELETED error (document was deleted while we were offline)
      if (this._isDocDeletedError(err)) {
        await this._handleRemoteDocDeleted(docId);
        return;
      }
      console.error(`Error syncing doc ${docId}:`, err);
      this.onError.emit(err as Error, { docId });
      if (doc) {
        doc.updateSyncing(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Flushes a document to the server.
   * @param docId The ID of the document to flush.
   * @param pending Optional pending changes to flush, to avoid redundant store fetch.
   */
  protected async flushDoc(docId: string, pending?: Change[]): Promise<void> {
    if (!this.trackedDocs.has(docId)) {
      throw new Error(`Document ${docId} is not tracked`);
    }
    if (!this.state.connected) {
      throw new Error('Not connected to server');
    }

    try {
      if (!pending) pending = await this.store.getPendingChanges(docId);
      if (!pending.length) {
        return; // Nothing to flush
      }

      const batches = breakChangesIntoBatches(pending, {
        maxPayloadBytes: this.maxPayloadBytes,
        maxStorageBytes: this.maxStorageBytes,
        sizeCalculator: this.sizeCalculator,
      });

      for (const batch of batches) {
        if (!this.state.connected) {
          throw new Error('Disconnected during flush');
        }
        const range: [number, number] = [batch[0].rev, batch[batch.length - 1].rev];
        const committed = await this.ws.commitChanges(docId, batch);

        // Apply the committed changes using the sync algorithm (already saved to store)
        await this._applyServerChangesToDoc(docId, committed, range);

        // Fetch remaining pending for next batch or check completion
        pending = await this.store.getPendingChanges(docId);
      }
    } catch (err) {
      if (this._isDocDeletedError(err)) {
        await this._handleRemoteDocDeleted(docId);
        return;
      }
      if (this._isDocExistsError(err)) {
        await this._recoverFromDocExists(docId);
        return;
      }
      console.error(`Flush failed for doc ${docId}:`, err);
      this.onError.emit(err as Error, { docId });
      throw err;
    }
  }

  /**
   * Receives committed changes from the server and applies them to the document. This is a blockable function, so it
   * is separate from applyServerChangesToDoc, which is called by other blockable functions. Ensuring this is blockable
   * ensures that while a doc is sending changes to the server, it isn't receiving changes from the server which could
   * cause a race condition.
   */
  @blockable
  protected async _receiveCommittedChanges(docId: string, serverChanges: Change[]): Promise<void> {
    try {
      await this._applyServerChangesToDoc(docId, serverChanges);
    } catch (err) {
      this.onError.emit(err as Error, { docId });
    }
  }

  /**
   * Applies server changes to a document using the centralized sync algorithm.
   * This ensures consistent OT behavior regardless of whether the doc is open in memory.
   */
  protected async _applyServerChangesToDoc(
    docId: string,
    serverChanges: Change[],
    sentPendingRange?: [number, number]
  ): Promise<Change[]> {
    // 1. Get current document snapshot from store
    const currentSnapshot = await this.store.getDoc(docId);
    if (!currentSnapshot) {
      console.warn(`Cannot apply server changes to non-existent doc: ${docId}`);
      return [];
    }
    const doc = this.patches.getOpenDoc(docId);
    if (doc) {
      // Ensure we have all the changes, stored and in-memory (newly created but not yet persisted)
      const inMemoryPendingChanges = doc?.getPendingChanges();
      const latestRev = currentSnapshot.changes[currentSnapshot.changes.length - 1]?.rev || currentSnapshot.rev;
      const newChanges = inMemoryPendingChanges.filter(change => change.rev > latestRev);
      currentSnapshot.changes.push(...newChanges);
    }

    // 2. Use the pure algorithm to calculate the new state
    const { state, rev, changes: rebasedPendingChanges } = applyCommittedChanges(currentSnapshot, serverChanges);

    // 3. If the doc is open in memory, update it with the new state
    if (doc) {
      if (doc.committedRev === serverChanges[0].rev - 1) {
        // We can update the doc's snapshot
        doc.applyCommittedChanges(serverChanges, rebasedPendingChanges);
      } else {
        // We have to do a full state update
        doc.import({ state, rev, changes: rebasedPendingChanges });
      }
    }

    // 4. Save changes to store (if not already saved)
    await Promise.all([
      this.store.saveCommittedChanges(docId, serverChanges, sentPendingRange),
      this.store.replacePendingChanges(docId, rebasedPendingChanges),
    ]);

    return rebasedPendingChanges;
  }

  /**
   * Initiates the deletion process for a document both locally and on the server.
   * This now delegates the local tombstone marking to Patches.
   */
  protected async _handleDocDeleted(docId: string): Promise<void> {
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

  protected _handleConnectionChange(connectionState: ConnectionState) {
    const isConnected = connectionState === 'connected';
    const isConnecting = connectionState === 'connecting';

    // Preserve syncing state if moving from connecting -> connected
    // Reset syncing if disconnected or errored
    const newSyncingState = isConnected
      ? this._state.syncing // Preserve
      : isConnecting
        ? this._state.syncing // Preserve during connecting phase too
        : null; // Reset

    this.updateState({ connected: isConnected, syncing: newSyncingState });

    if (isConnected) {
      // Sync everything on connect/reconnect
      void this.syncAllKnownDocs();
    }
  }

  protected async _handleDocsTracked(docIds: string[]) {
    const newIds = docIds.filter(id => !this.trackedDocs.has(id));
    if (!newIds.length) return;

    newIds.forEach(id => this.trackedDocs.add(id));
    let subscribeIds = newIds;

    // If a subscribe filter is provided, filter out docs that are already tracked
    if (this.options?.subscribeFilter) {
      const alreadyTracked = this.options.subscribeFilter([...this.trackedDocs]);
      subscribeIds = subscribeIds.filter(id => !alreadyTracked.includes(id));
    }

    if (this.state.connected) {
      try {
        if (subscribeIds.length) {
          await this.ws.subscribe(subscribeIds);
        }
        // Trigger sync for newly tracked docs immediately
        await Promise.all(newIds.map(id => this.syncDoc(id)));
      } catch (err) {
        console.warn(`Failed to subscribe/sync newly tracked docs: ${newIds.join(', ')}`, err);
        this.onError.emit(err as Error);
      }
    }
  }

  protected async _handleDocsUntracked(docIds: string[]) {
    const existingIds = docIds.filter(id => this.trackedDocs.has(id));
    if (!existingIds.length) return;

    existingIds.forEach(id => this.trackedDocs.delete(id));
    if (this.state.connected) {
      try {
        await this.ws.unsubscribe(existingIds);
      } catch (err) {
        console.warn(`Failed to unsubscribe docs: ${existingIds.join(', ')}`, err);
      }
    }
  }

  protected async _handleDocChange(docId: string, _changes: Change[]): Promise<void> {
    if (!this.state.connected) return;
    if (!this.trackedDocs.has(docId)) return;
    await this.flushDoc(docId);
  }

  /**
   * Unified handler for remote document deletion (both real-time notifications and offline discovery).
   * Cleans up local state and notifies the application with any pending changes that were lost.
   */
  protected async _handleRemoteDocDeleted(docId: string): Promise<void> {
    // Get pending changes before cleanup so app can handle them
    const pendingChanges = await this.store.getPendingChanges(docId);

    // Close doc if open
    const doc = this.patches.getOpenDoc(docId);
    if (doc) {
      await this.patches.closeDoc(docId);
    }

    // Clean up tracking and local storage
    this.trackedDocs.delete(docId);
    await this.store.confirmDeleteDoc(docId);

    // Notify application (with any pending changes that were lost)
    await this.onRemoteDocDeleted.emit(docId, pendingChanges);
  }

  /**
   * Helper to detect DOC_DELETED (410) errors from the server.
   */
  protected _isDocDeletedError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 410;
  }

  /**
   * Helper to detect "document already exists" errors from the server.
   */
  private _isDocExistsError(err: unknown): boolean {
    const message = (err as Error)?.message ?? '';
    return message.includes('already exists');
  }

  /**
   * Recovers from a "document already exists" error by fetching server state and retrying.
   */
  private async _recoverFromDocExists(docId: string): Promise<void> {
    const serverChanges = await this.ws.getChangesSince(docId, 0);
    const rebasedPending = await this._applyServerChangesToDoc(docId, serverChanges);

    if (rebasedPending.length > 0) {
      await this.flushDoc(docId, rebasedPending);
    }
  }
}
