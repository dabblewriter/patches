import { isEqual } from '@dabble/delta';
import { batch, ReadonlyStoreClass, signal, store, type Store, type Unsubscriber } from 'easy-signal';
import { breakChangesIntoBatches, type SizeCalculator } from '../algorithms/ot/shared/changeBatching.js';
import { BaseDoc } from '../client/BaseDoc.js';
import type { BranchClientStore } from '../client/BranchClientStore.js';
import type { ClientAlgorithm } from '../client/ClientAlgorithm.js';
import { Patches } from '../client/Patches.js';
import type { AlgorithmName, TrackedDoc } from '../client/PatchesStore.js';
import { isDocLoaded } from '../shared/utils.js';
import type { Change, DocSyncState, DocSyncStatus } from '../types.js';
import { blockable, serialGate } from '../utils/concurrency.js';
import { ErrorCodes, StatusError } from './error.js';
import type { PatchesConnection } from './PatchesConnection.js';
import type { JSONRPCClient } from './protocol/JSONRPCClient.js';
import type { BranchAPI, ConnectionState } from './protocol/types.js';
import { PatchesWebSocket } from './websocket/PatchesWebSocket.js';
import type { WebSocketOptions } from './websocket/WebSocketTransport.js';
import { onlineState } from './websocket/onlineState.js';

export interface PatchesSyncState {
  online: boolean;
  connected: boolean;
  syncStatus: DocSyncStatus;
  syncError?: Error;
}

export interface PatchesSyncOptions {
  subscribeFilter?: (docIds: string[]) => string[];
  /** WebSocket options. Only used when a URL string is passed to the constructor. */
  websocket?: WebSocketOptions;
  /** Wire batch limit for network transmission. Defaults to 1MB. */
  maxPayloadBytes?: number;
  /** Per-change storage limit for backend. Falls back to patches.docOptions.maxStorageBytes. */
  maxStorageBytes?: number;
  /** Custom size calculator for storage limit. Falls back to patches.docOptions.sizeCalculator. */
  sizeCalculator?: SizeCalculator;
  /**
   * Local store for branch metadata.
   * When provided, enables offline branch support:
   * - Branch metas are cached locally for offline viewing
   * - Branches with `pending: true` are created on the server during sync
   * - Branch document content flows through the standard doc sync pipeline
   */
  branchStore?: BranchClientStore;
  /**
   * Branch API for syncing pending branch metas.
   * Required when branchStore is provided. Typically the same RPC client
   * used by PatchesBranchClient instances.
   */
  branchApi?: BranchAPI;
}

const EMPTY_DOC_STATE: DocSyncState = {
  committedRev: 0,
  hasPending: false,
  syncStatus: 'unsynced',
  isLoaded: false,
};

/**
 * Handles server connection, document subscriptions, and syncing logic between
 * the Patches instance and the server.
 *
 * Accepts either a URL string (creates a WebSocket connection) or a PatchesConnection
 * instance (e.g. PatchesREST for SSE + fetch).
 *
 * PatchesSync is algorithm-agnostic. It delegates to algorithm methods for:
 * - Getting pending changes to send
 * - Applying server changes
 * - Confirming sent changes
 */
export class PatchesSync extends ReadonlyStoreClass<PatchesSyncState> {
  protected connection: PatchesConnection;
  protected patches: Patches;
  protected maxPayloadBytes?: number;
  protected maxStorageBytes?: number;
  protected sizeCalculator?: SizeCalculator;
  protected trackedDocs: Set<string>;
  /** Maps docId to the algorithm name used for that doc */
  protected docAlgorithms: Map<string, AlgorithmName> = new Map();
  /**
   * Reactive store tracking per-document sync state.
   */
  readonly docStates: Store<Record<string, DocSyncState>>;
  /**
   * Signal emitted when an error occurs.
   */
  readonly onError = signal<(error: Error, context?: { docId?: string }) => void>();
  /**
   * Signal emitted when a document is deleted remotely (by another client or discovered via tombstone).
   * Provides the pending changes that were discarded so the application can handle them.
   */
  readonly onRemoteDocDeleted = signal<(docId: string, pendingChanges: Change[]) => void>();
  /**
   * Signal emitted after pending branch metas have been synced to the server.
   * Consumers should use this to refresh in-memory branch state (e.g. call `loadCached()`
   * on their PatchesBranchClient instances).
   */
  readonly onBranchMetasSynced = signal();

  constructor(patches: Patches, url: string, options?: PatchesSyncOptions);
  constructor(patches: Patches, connection: PatchesConnection, options?: PatchesSyncOptions);
  constructor(
    patches: Patches,
    urlOrConnection: string | PatchesConnection,
    protected options?: PatchesSyncOptions
  ) {
    super({
      online: onlineState.isOnline,
      connected: false,
      syncStatus: 'unsynced',
    });
    this.patches = patches;

    if (options?.branchStore && !options?.branchApi) {
      throw new Error('branchApi is required when branchStore is provided');
    }

    // Use options if provided, otherwise fall back to patches.docOptions
    this.maxPayloadBytes = options?.maxPayloadBytes;
    this.maxStorageBytes = options?.maxStorageBytes ?? patches.docOptions?.maxStorageBytes;
    this.sizeCalculator = options?.sizeCalculator ?? patches.docOptions?.sizeCalculator;

    if (typeof urlOrConnection === 'string') {
      this.connection = new PatchesWebSocket(urlOrConnection, options?.websocket);
    } else {
      this.connection = urlOrConnection;
    }

    this.docStates = store<Record<string, DocSyncState>>({});
    this.trackedDocs = new Set(patches.trackedDocs);

    // --- Event Listeners ---
    this._unsubs = [
      onlineState.onOnlineChange(online => this.updateState({ online })),
      this.connection.onStateChange(this._handleConnectionChange.bind(this)),
      this.connection.onChangesCommitted(this._receiveCommittedChanges.bind(this)),
      this.connection.onDocDeleted(docId => this._handleRemoteDocDeleted(docId)),
      patches.onTrackDocs(this._handleDocsTracked.bind(this)),
      patches.onUntrackDocs(this._handleDocsUntracked.bind(this)),
      patches.onDeleteDoc(this._handleDocDeleted.bind(this)),
      patches.onChange(this._handleDocChange.bind(this)),
    ];
  }

  private _unsubs: Unsubscriber[] = [];

  /**
   * Gets the algorithm for a document. Uses the open doc's algorithm if available,
   * otherwise falls back to the default algorithm.
   */
  protected _getAlgorithm(docId: string): ClientAlgorithm {
    // First check if doc is open (Patches knows its algorithm)
    const docAlgorithm = this.patches.getDocAlgorithm(docId);
    if (docAlgorithm) return docAlgorithm;

    // Fall back to cached algorithm name or default
    const algorithmName = this.docAlgorithms.get(docId) ?? this.patches.defaultAlgorithm;
    const algorithm = this.patches.algorithms[algorithmName];
    if (!algorithm) {
      throw new Error(`Algorithm '${algorithmName}' not found for doc ${docId}`);
    }
    return algorithm;
  }

  /**
   * Gets the server URL.
   */
  get url(): string {
    return this.connection.url;
  }

  /**
   * Sets the server URL. Reconnects if currently connected.
   */
  set url(url: string) {
    this.connection.url = url;
    if (this.state.connected) {
      this.connection.disconnect();
      this.connection.connect();
    }
  }

  /**
   * Gets the JSON-RPC client for making custom RPC calls.
   * Only available when using a WebSocket connection (PatchesWebSocket or PatchesClient).
   * Returns undefined when using REST transport.
   */
  get rpc(): JSONRPCClient | undefined {
    if ('rpc' in this.connection) {
      return (this.connection as { rpc: JSONRPCClient }).rpc;
    }
    return undefined;
  }

  /**
   * Updates the sync state.
   * @param update - The partial state to update.
   */
  protected updateState(update: Partial<PatchesSyncState>) {
    const newState = { ...this.state, ...update };
    // Clear error when moving away from 'error' status
    if (newState.syncStatus !== 'error' && newState.syncError) {
      newState.syncError = undefined;
    }
    if (!isEqual(this.state, newState)) {
      this.state = newState;
    }
  }

  /**
   * Connects to the server and starts syncing if online. If not online, it will wait for online state.
   */
  async connect(): Promise<void> {
    try {
      await this.connection.connect();
    } catch (err) {
      console.error('PatchesSync connection failed:', err);
      const error = err instanceof Error ? err : new Error(String(err));
      this.updateState({ connected: false, syncStatus: 'error', syncError: error });
      this.onError.emit(error);
      throw err;
    }
  }

  /**
   * Disconnects from the server and stops syncing.
   */
  disconnect(): void {
    this.connection.disconnect();
    this.updateState({ connected: false, syncStatus: 'unsynced' });
    this._resetSyncingStatuses();
  }

  /**
   * Disconnects and removes all event listeners.
   * After calling destroy(), this instance should not be reused.
   */
  destroy(): void {
    this.disconnect();
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
  }

  /**
   * Syncs pending branch metas to the server.
   *
   * Pending branches come in two flavors:
   * - **Created offline** (`pending: true`, no `deleted`): created on the server via `createBranch`.
   * - **Deleted offline** (`pending: true`, `deleted: true`): deleted on the server via `deleteBranch`,
   *   then physically removed from the local store.
   *
   * The server skips initial change creation when `contentStartRev` is set in the metadata,
   * so their document content flows through the standard doc sync pipeline.
   */
  protected async syncPendingBranchMetas(): Promise<void> {
    const branchStore = this.options?.branchStore;
    const branchApi = this.options?.branchApi;
    if (!branchStore || !branchApi) return;

    const pendingBranches = await branchStore.listPendingBranches();

    // Process creations first, then deletions, so a create+delete in the same
    // offline session is handled correctly.
    const pendingCreates = pendingBranches.filter(b => !b.deleted);
    const pendingDeletes = pendingBranches.filter(b => b.deleted);

    for (const branch of pendingCreates) {
      if (!this.state.connected) break;

      try {
        // Create the branch on the server. The server is idempotent when metadata.id is provided.
        // The server skips initial change creation when contentStartRev is set in the metadata.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const {
          docId: sourceDocId,
          branchedAtRev,
          createdAt,
          modifiedAt,
          status,
          pending,
          deleted,
          ...metadata
        } = branch;
        await branchApi.createBranch(sourceDocId, branchedAtRev, metadata);

        // Clear the pending flag
        const synced = { ...branch };
        delete synced.pending;
        await branchStore.saveBranches(sourceDocId, [synced]);
      } catch (err) {
        console.error('Failed to sync pending branch meta:', branch.id, err);
        this.onError.emit(err instanceof Error ? err : new Error(String(err)));
        // Stop processing further branches — ordering may matter
        break;
      }
    }

    for (const branch of pendingDeletes) {
      if (!this.state.connected) break;

      try {
        await branchApi.deleteBranch(branch.id);

        // Server confirmed the delete — remove the tombstone from the local store
        await branchStore.deleteBranches([branch.id]);
      } catch (err) {
        console.error('Failed to sync pending branch deletion:', branch.id, err);
        this.onError.emit(err instanceof Error ? err : new Error(String(err)));
        // Stop processing further deletions — keep tombstone for retry
        break;
      }
    }

    if (pendingBranches.length > 0) {
      this.onBranchMetasSynced.emit();
    }
  }

  /**
   * Syncs all known docs when initially connected.
   */
  protected async syncAllKnownDocs(): Promise<void> {
    if (!this.state.connected) return;
    this.updateState({ syncStatus: 'syncing' });

    try {
      // Sync pending branch metas first — branches must exist on the server
      // before their document content can be synced.
      await this.syncPendingBranchMetas();

      // Get tracked docs from ALL algorithms and populate docAlgorithms Map
      const allTracked: TrackedDoc[] = [];

      for (const algorithm of Object.values(this.patches.algorithms)) {
        if (!algorithm) continue; // Skip undefined algorithms

        const docs = await algorithm.listDocs(true); // Include deleted docs
        allTracked.push(...docs);

        // Populate docAlgorithms Map for algorithm determination during sync
        for (const doc of docs) {
          if (doc.algorithm) {
            this.docAlgorithms.set(doc.docId, doc.algorithm);
          }
        }
      }

      const activeDocs = allTracked.filter(t => !t.deleted);
      const deletedDocs = allTracked.filter(t => t.deleted);

      const activeDocIds = activeDocs.map((t: TrackedDoc) => t.docId);

      // Ensure tracked set reflects only active docs for subscription purposes
      this.trackedDocs = new Set(activeDocIds);

      // Populate synced map for active docs
      const syncedEntries: Record<string, DocSyncState> = {};
      for (const doc of activeDocs) {
        const algorithm = this._getAlgorithm(doc.docId);
        const hasPending = await algorithm.hasPending(doc.docId);
        const entry: DocSyncState = {
          committedRev: doc.committedRev,
          hasPending,
          syncStatus: doc.committedRev === 0 ? 'unsynced' : 'synced',
          syncError: undefined,
          isLoaded: false,
        };
        // Preserve sticky isLoaded from previous lifecycle, or derive it
        const existing = this.docStates.state[doc.docId];
        entry.isLoaded = existing?.isLoaded || isDocLoaded(entry.committedRev, entry.hasPending, entry.syncStatus);
        syncedEntries[doc.docId] = entry;
      }
      this.docStates.state = syncedEntries;

      // Subscribe to active docs
      if (activeDocIds.length > 0) {
        try {
          const subscribeIds = this._filterSubscribeIds(activeDocIds);
          if (subscribeIds.length) {
            await this.connection.subscribe(subscribeIds);
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
          await this.connection.deleteDoc(docId);
          // If server delete succeeds, remove tombstone and all data locally
          const algorithm = this._getAlgorithm(docId);
          await algorithm.confirmDeleteDoc(docId);
          console.info(`Successfully deleted and untracked doc: ${docId}`);
        } catch (err) {
          // If server delete fails (e.g., offline, already deleted), keep tombstone for retry
          console.warn(`Server delete failed for ${docId}, keeping tombstone:`, err);
          this.onError.emit(err as Error, { docId });
        }
      });

      // Wait for all sync and delete operations
      await Promise.all([...activeSyncPromises, ...deletePromises]);

      this.updateState({ syncStatus: 'synced' });
    } catch (error) {
      console.error('Error during global sync:', error);
      const syncError = error instanceof Error ? error : new Error(String(error));
      this.updateState({ syncStatus: 'error', syncError });
      this.onError.emit(syncError);
    }
  }

  /**
   * Syncs a single document.
   * @param docId The ID of the document to sync.
   */
  @serialGate
  protected async syncDoc(docId: string): Promise<void> {
    if (!this.state.connected || !this.trackedDocs.has(docId)) return;

    this._updateDocSyncState(docId, { syncStatus: 'syncing' });

    const doc = this.patches.getOpenDoc(docId);
    const algorithm = this._getAlgorithm(docId);

    // Cast to BaseDoc for internal methods (updateSyncStatus, import)
    const baseDoc = doc as BaseDoc | undefined;

    if (baseDoc) {
      baseDoc.updateSyncStatus('syncing');
    }
    try {
      // Use algorithm to get pending changes to send
      const pending = await algorithm.getPendingToSend(docId);

      if (pending && pending.length > 0) {
        await this.flushDoc(docId, pending);
      } else {
        const committedRev = await algorithm.getCommittedRev(docId);
        if (committedRev) {
          const serverChanges = await this.connection.getChangesSince(docId, committedRev);
          if (serverChanges.length > 0) {
            await this._applyServerChangesToDoc(docId, serverChanges);
          }
        } else {
          // No committed rev means this is a new doc - fetch from server
          const snapshot = await this.connection.getDoc(docId);
          // Save via algorithm's store
          await algorithm.store.saveDoc(docId, snapshot);
          // Update synced doc with the server's revision
          this._updateDocSyncState(docId, { committedRev: snapshot.rev });
          // Import into doc if open (use BaseDoc.import)
          if (baseDoc) {
            baseDoc.import({ ...snapshot, changes: [] });
          }
        }
      }
      this._updateDocSyncState(docId, { syncStatus: 'synced' });
      if (baseDoc) {
        baseDoc.updateSyncStatus('synced');
      }
    } catch (err) {
      // Handle DOC_DELETED error (document was deleted while we were offline)
      if (this._isDocDeletedError(err)) {
        await this._handleRemoteDocDeleted(docId);
        return;
      }
      const syncError = err instanceof Error ? err : new Error(String(err));
      this._updateDocSyncState(docId, { syncStatus: 'error', syncError });
      console.error(`Error syncing doc ${docId}:`, err);
      this.onError.emit(syncError, { docId });
      if (baseDoc) {
        baseDoc.updateSyncStatus('error', syncError);
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

    const algorithm = this._getAlgorithm(docId);

    try {
      if (!pending) {
        pending = (await algorithm.getPendingToSend(docId)) ?? [];
      }
      if (!pending.length) {
        return; // Nothing to flush
      }

      const batches = breakChangesIntoBatches(pending, {
        maxPayloadBytes: this.maxPayloadBytes,
        maxStorageBytes: this.maxStorageBytes,
        sizeCalculator: this.sizeCalculator,
      });

      for (const changeBatch of batches) {
        if (!this.state.connected) {
          throw new Error('Disconnected during flush');
        }

        const { changes: committed, docReloadRequired } = await this.connection.commitChanges(docId, changeBatch);

        if (docReloadRequired) {
          // Our local state is stale (baseRev:0 on existing doc). Confirm the sent
          // changes (they were committed), then reload the full state from the server.
          await algorithm.confirmSent(docId, changeBatch);
          const snapshot = await this.connection.getDoc(docId);
          await algorithm.store.saveDoc(docId, snapshot);
          this._updateDocSyncState(docId, { committedRev: snapshot.rev });
          const openDoc = this.patches.getOpenDoc(docId) as BaseDoc | undefined;
          if (openDoc) {
            openDoc.import({ ...snapshot, changes: [] });
          }
        } else {
          // Confirm sent first so server corrections (applied next) overwrite
          // any stale ops for fields the server won via LWW timestamp resolution.
          // For OT this order doesn't matter; for LWW it ensures applyServerChanges
          // is the last writer for corrected fields.
          await algorithm.confirmSent(docId, changeBatch);
          await this._applyServerChangesToDoc(docId, committed);
        }

        // Fetch remaining pending for next batch or check completion
        pending = (await algorithm.getPendingToSend(docId)) ?? [];
      }

      const stillHasPending = await algorithm.hasPending(docId);
      this._updateDocSyncState(docId, { hasPending: stillHasPending, syncStatus: 'synced' });
    } catch (err) {
      if (this._isDocDeletedError(err)) {
        await this._handleRemoteDocDeleted(docId);
        return;
      }
      const flushError = err instanceof Error ? err : new Error(String(err));
      this._updateDocSyncState(docId, { syncStatus: 'error', syncError: flushError });
      console.error(`Flush failed for doc ${docId}:`, err);
      this.onError.emit(flushError, { docId });
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
   * Applies server changes to a document using the algorithm.
   * The algorithm handles all algorithm-specific logic (OT rebasing, LWW merging, etc).
   */
  protected async _applyServerChangesToDoc(docId: string, serverChanges: Change[]): Promise<void> {
    const doc = this.patches.getOpenDoc(docId);
    const algorithm = this._getAlgorithm(docId);

    // Delegate to algorithm - it handles store updates and doc updates
    await algorithm.applyServerChanges(docId, serverChanges, doc);

    if (serverChanges.length > 0) {
      const lastRev = serverChanges[serverChanges.length - 1].rev;
      this._updateDocSyncState(docId, { committedRev: lastRev });
    }
  }

  /**
   * Initiates the deletion process for a document both locally and on the server.
   * This now delegates the local tombstone marking to Patches.
   */
  protected async _handleDocDeleted(docId: string): Promise<void> {
    // Attempt server delete if online
    if (this.state.connected) {
      try {
        const algorithm = this._getAlgorithm(docId);
        await this.connection.deleteDoc(docId);
        await algorithm.confirmDeleteDoc(docId);
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
    const newSyncStatus: DocSyncStatus = isConnected
      ? this.state.syncStatus // Preserve
      : isConnecting
        ? this.state.syncStatus // Preserve during connecting phase too
        : 'unsynced'; // Reset

    this.updateState({ connected: isConnected, syncStatus: newSyncStatus });

    if (isConnected) {
      // Sync everything on connect/reconnect
      void this.syncAllKnownDocs();
    } else if (!isConnecting) {
      // Reset any stale 'syncing' statuses on disconnect/error
      this._resetSyncingStatuses();
    }
  }

  protected async _handleDocsTracked(docIds: string[], algorithmName?: AlgorithmName) {
    const newIds = docIds.filter(id => !this.trackedDocs.has(id));
    if (!newIds.length) return;

    // Snapshot current subscriptions before adding new docs
    const alreadySubscribed = this._getActiveSubscriptions();

    newIds.forEach(id => this.trackedDocs.add(id));

    // Populate docAlgorithms Map
    if (algorithmName) {
      // Algorithm name provided directly from signal — no store lookup needed
      for (const docId of newIds) {
        this.docAlgorithms.set(docId, algorithmName);
      }
    } else {
      // Fallback: read from stores (backward compatibility)
      for (const docId of newIds) {
        for (const algorithm of Object.values(this.patches.algorithms)) {
          if (!algorithm) continue;

          const docs = await algorithm.listDocs(false);
          const tracked = docs.find(d => d.docId === docId);
          if (tracked?.algorithm) {
            this.docAlgorithms.set(docId, tracked.algorithm);
            break;
          }
        }
      }
    }

    // Collect data for all new docs first (async), then batch the store updates
    const docData: { docId: string; committedRev: number; hasPending: boolean }[] = [];
    for (const docId of newIds) {
      const algorithm = this._getAlgorithm(docId);
      const committedRev = await algorithm.getCommittedRev(docId);
      const hasPending = await algorithm.hasPending(docId);
      docData.push({
        docId,
        committedRev,
        hasPending,
      });
    }

    // Batch all synced doc updates so subscribers are only notified once
    batch(() => {
      for (const { docId, committedRev, hasPending } of docData) {
        this._updateDocSyncState(docId, {
          committedRev,
          hasPending,
          syncStatus: committedRev === 0 ? 'unsynced' : 'synced',
        });
      }
    });

    if (this.state.connected) {
      try {
        // Only subscribe to IDs not already covered by existing subscriptions
        const subscribeIds = this._filterSubscribeIds(newIds).filter(id => !alreadySubscribed.has(id));
        if (subscribeIds.length) {
          await this.connection.subscribe(subscribeIds);
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

    // Snapshot current subscriptions before removing docs
    const subscribedBefore = this._getActiveSubscriptions();

    existingIds.forEach(id => this.trackedDocs.delete(id));
    batch(() => {
      existingIds.forEach(id => this._updateDocSyncState(id, undefined));
    });

    // Only unsubscribe from subscriptions no longer needed by any remaining tracked doc
    const subscribedAfter = this._getActiveSubscriptions();
    const unsubscribeIds = [...subscribedBefore].filter(id => !subscribedAfter.has(id));

    if (this.state.connected && unsubscribeIds.length) {
      try {
        await this.connection.unsubscribe(unsubscribeIds);
      } catch (err) {
        console.warn(`Failed to unsubscribe docs: ${unsubscribeIds.join(', ')}`, err);
      }
    }
  }

  protected _handleDocChange(docId: string): void {
    if (!this.trackedDocs.has(docId)) return;
    this._updateDocSyncState(docId, { hasPending: true });
    if (!this.state.connected) return;
    this.syncDoc(docId);
  }

  /**
   * Unified handler for remote document deletion (both real-time notifications and offline discovery).
   * Cleans up local state and notifies the application with any pending changes that were lost.
   */
  protected async _handleRemoteDocDeleted(docId: string): Promise<void> {
    const algorithm = this._getAlgorithm(docId);

    // Get pending changes before cleanup so app can handle them
    const pendingChanges = (await algorithm.getPendingToSend(docId)) ?? [];

    // Close doc if open
    const doc = this.patches.getOpenDoc(docId);
    if (doc) {
      await this.patches.closeDoc(docId);
    }

    // Clean up tracking and local storage
    this.trackedDocs.delete(docId);
    this._updateDocSyncState(docId, undefined);
    await algorithm.confirmDeleteDoc(docId);

    // Notify application (with any pending changes that were lost)
    await this.onRemoteDocDeleted.emit(docId, pendingChanges);
  }

  /**
   * Adds, updates, or removes a doc state entry immutably and notifies via store.
   * - Pass a full DocSyncState to add a new entry or overwrite an existing one.
   * - Pass a Partial<DocSyncState> to merge into an existing entry (no-ops if doc not in map).
   * - Pass undefined to remove the entry.
   * No-ops if nothing actually changed.
   */
  protected _updateDocSyncState(docId: string, updates: Partial<DocSyncState> | undefined): void {
    const currentDocs = this.docStates.state;

    if (updates === undefined) {
      // Remove
      if (!(docId in currentDocs)) return;
      const newDocs = { ...currentDocs };
      delete newDocs[docId];
      this.docStates.state = newDocs;
    } else {
      const updated = { ...EMPTY_DOC_STATE, ...currentDocs[docId], ...updates } as DocSyncState;
      // Clear error when moving away from 'error' status
      if (updated.syncStatus !== 'error' && updated.syncError) {
        updated.syncError = undefined;
      }
      // Latch isLoaded: once true, stays true for this sync lifecycle
      if (!updated.isLoaded) {
        updated.isLoaded = isDocLoaded(updated.committedRev, updated.hasPending, updated.syncStatus);
      }
      if (isEqual(currentDocs[docId], updated)) return;
      this.docStates.state = { ...currentDocs, [docId]: updated };
    }
  }

  /**
   * Resets any docs with status 'syncing' back to a stable state on disconnect.
   * Uses hasPending to decide: pending docs become 'synced' (they have local data),
   * docs with no pending and no committed rev become 'unsynced'.
   */
  protected _resetSyncingStatuses(): void {
    batch(() => {
      for (const [docId, doc] of Object.entries(this.docStates.state)) {
        if (doc.syncStatus === 'syncing') {
          const newStatus = doc.committedRev === 0 && !doc.hasPending ? 'unsynced' : 'synced';
          this._updateDocSyncState(docId, { syncStatus: newStatus });
        }
      }
    });
  }

  /**
   * Applies the subscribeFilter option to a list of doc IDs, returning the subset
   * that should be sent to subscribe/unsubscribe. Returns the full list if no filter is set.
   */
  protected _filterSubscribeIds(docIds: string[]): string[] {
    return this.options?.subscribeFilter?.(docIds) || docIds;
  }

  /**
   * Returns the set of doc IDs currently subscribed on the server, derived by
   * applying the subscribe filter to the full tracked set.
   */
  protected _getActiveSubscriptions(): Set<string> {
    return new Set(this._filterSubscribeIds([...this.trackedDocs]));
  }

  /**
   * Helper to detect DOC_DELETED (410) errors from the server.
   */
  protected _isDocDeletedError(err: unknown): boolean {
    return err instanceof StatusError && err.code === ErrorCodes.DOC_DELETED;
  }
}
