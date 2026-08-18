import { isEqual } from '@dabble/delta';
import { batch, ReadonlyStoreClass, signal, store, type Store, type Unsubscriber } from 'easy-signal';
import { MissingChangesError } from '../algorithms/ot/client/applyCommittedChanges.js';
import { ApplyChangesError } from '../algorithms/ot/shared/applyChanges.js';
import { breakChangesIntoBatches, type SizeCalculator } from '../algorithms/ot/shared/changeBatching.js';
import { BaseDoc } from '../client/BaseDoc.js';
import type { BranchClientStore } from '../client/BranchClientStore.js';
import type { ClientAlgorithm } from '../client/ClientAlgorithm.js';
import type { PatchesDoc } from '../client/PatchesDoc.js';
import { Patches } from '../client/Patches.js';
import type { AlgorithmName, TrackedDoc } from '../client/PatchesStore.js';
import { isDocLoaded } from '../shared/utils.js';
import type { Change, DocSyncState, DocSyncStatus, PatchesSnapshot } from '../types.js';
import { blockable, serialGate } from '../utils/concurrency.js';
import {
  CommittedPoisonSkippedError,
  ErrorCodes,
  isAbortError,
  isNetworkError,
  isUnsplittableChangeError,
  NetworkError,
  StatusError,
  TERMINAL_STATUS_CODES,
} from './error.js';
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
  /**
   * Hard ceiling for an op the splitter can't break apart. Falls back to
   * patches.docOptions.maxUnsplittableBytes, then to `Infinity` (emit it anyway).
   */
  maxUnsplittableBytes?: number;
  /** Custom size calculator for storage limit. Falls back to patches.docOptions.sizeCalculator. */
  sizeCalculator?: SizeCalculator;
  /**
   * Local store for branch metadata.
   * When provided, enables offline branch support:
   * - Branch metas are cached locally
   * - Branches with `pendingOp` are synced to the server during sync
   * - Branch document content flows through the standard doc sync pipeline
   */
  branchStore?: BranchClientStore;
  /**
   * Server-side Branch API for syncing pending branch operations.
   * Required when branchStore is provided. Typically the same RPC client
   * used by PatchesBranchClient instances in online mode.
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
 * How long `_handleRemoteDocDeleted` waits on the app's `onRemoteDocDeleted` subscribers before
 * giving up on them and proceeding. The await is deliberate — subscribers may be async and the
 * app shelves the discarded pending changes there, so proceeding early risks losing them — but
 * it runs inside the doc's serialized sync gate, so a subscriber that never settles would wedge
 * that doc's sync forever. Long enough for a real shelf write (including a slow disk), short
 * enough that a broken subscriber costs one doc a pause rather than its whole sync lifetime.
 */
export const REMOTE_DOC_DELETED_EMIT_TIMEOUT_MS = 10_000;

// Backoff for retrying a doc that failed to sync transiently (see `syncDoc`).
const SYNC_RETRY_BASE_MS = 1_000;
const SYNC_RETRY_MAX_MS = 30_000;
const SYNC_RETRY_MAX_ATTEMPTS = 10;
// Definitive StatusError codes — don't retry (auth, payment, permission, not-found, gone).
// Shared with Patches' change-submit retry so both layers classify failures the same way.
const TERMINAL_SYNC_CODES = TERMINAL_STATUS_CODES;
// Floor for the per-doc storage budget halved by `_tryResplitOversized`. Four halvings from a
// typical 900KB budget; below this the change is small enough that a 413 is telling us something
// other than "split harder", so stop and let the doc latch instead of grinding to nothing.
const MIN_RESPLIT_STORAGE_BYTES = 100_000;
// Circuit breaker: max auto-ejections per doc per session, so a systematically
// mis-attributing server can't serially drain an offline queue into quarantine.
const MAX_DOC_EJECTIONS = 3;
// Strict-apply failures a COMMITTED change must rack up before it is skipped rather than
// re-attempted forever (see `_skipFlooredPoison`). Two, not one: the first failure is far
// more likely to mean this replica's committed state drifted, which the snapshot reload
// recovers losslessly — only a change that fails again on top of authoritative state has
// proven the document's history is what can't be applied.
const POISON_SKIP_FLOOR = 2;
// Bound on the per-doc poison memo, oldest first. A doc accumulating this many distinct
// unappliable committed changes is broken in a way skipping won't fix.
const MAX_POISON_MEMO_ENTRIES = 50;
// Unappliable committed changes `_loadRepairedSnapshot` will skip in one server snapshot
// before giving up. A snapshot needing more is damaged past what skipping can honestly heal.
const MAX_SNAPSHOT_REPAIRS = 5;
// Slow background re-probe for a doc left at 'error' with pending changes while the
// connection stays up (see `_scheduleSyncReprobe`).
const SYNC_REPROBE_EXHAUSTED_MS = 5 * 60_000;
const SYNC_REPROBE_TERMINAL_MS = 10 * 60_000;
// Docs that fail together in the same syncAllKnownDocs pass (e.g. a bulk permission
// revocation) would otherwise all schedule the exact same delay, then re-probe,
// re-fail, and reschedule in lockstep every 5/10 minutes. Jitter downward only —
// never later than the nominal delay, only ever equal or earlier — so callers can
// still rely on the constants above as an upper bound.
const SYNC_REPROBE_JITTER_RATIO = 0.2;

function jitterReprobeDelay(delayMs: number): number {
  return delayMs - Math.random() * delayMs * SYNC_REPROBE_JITTER_RATIO;
}

/** Per-change record behind `_skipFlooredPoison`'s floor (see `_committedApplyFailures`). */
interface PoisonMemoEntry {
  failures: number;
  reloadedSince: boolean;
  surfaced: boolean;
  error: ApplyChangesError;
}

/**
 * True once a change has met the whole evidence bar for skipping: enough strict-apply failures,
 * at least one of them on top of an authoritative snapshot (`_markPoisonReloaded` clamps the
 * ones that came before). The single definition of "decided" — the skip reads it, and eviction
 * and the clamp both protect what it matches.
 */
function isFlooredPoison(entry: PoisonMemoEntry): boolean {
  return entry.failures >= POISON_SKIP_FLOOR && entry.reloadedSince;
}

/**
 * A copy of an apply failure carrying everything telemetry reports — name, message, stack, and
 * the change it names — with the `cause` chain reduced to its message. The raw chain holds the
 * offending op, whose `value` for a text change is the change's entire payload, and the memo
 * retains its copy for the session across up to `MAX_POISON_MEMO_ENTRIES` entries per doc.
 */
function trimApplyError(error: ApplyChangesError): ApplyChangesError {
  const cause = error.cause;
  const trimmed = new ApplyChangesError(
    error.changeId,
    error.rev,
    error.index,
    cause instanceof Error ? cause.message : String(cause)
  );
  trimmed.stack = error.stack;
  return trimmed;
}

/**
 * Interval between degraded-mode catch-up passes while online with the push stream down
 * on a send-independent transport (see `_syncAllDegraded`). Jittered via
 * `jitterReprobeDelay` (~24-30s) so a fleet of stream-blocked clients doesn't sweep the
 * server in lockstep. DAB-831.
 */
const DEGRADED_SYNC_INTERVAL_MS = 30_000;

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
  protected maxUnsplittableBytes?: number;
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
    this.maxPayloadBytes = options?.maxPayloadBytes ?? patches.docOptions?.maxPayloadBytes;
    this.maxStorageBytes = options?.maxStorageBytes ?? patches.docOptions?.maxStorageBytes;
    this.maxUnsplittableBytes = options?.maxUnsplittableBytes ?? patches.docOptions?.maxUnsplittableBytes;
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
      onlineState.onOnlineChange(online => {
        this.updateState({ online });
        // Coming online with the stream down: on a started, send-independent transport
        // don't wait for the stream to establish (a hostile network may hold it down
        // forever — DAB-831); drain pending and pull catch-up over plain requests right
        // away. `_canSend()` also keeps this from firing on a never-connect()ed or
        // explicitly disconnect()ed instance.
        if (online && !this.state.connected && this._canSend()) {
          void this._syncAllDegraded();
        } else if (!online) {
          this._clearDegradedSync();
        }
      }),
      this.connection.onStateChange(this._handleConnectionChange.bind(this)),
      this.connection.onChangesCommitted(this._receiveCommittedChanges.bind(this)),
      this.connection.onDocDeleted(docId => this._handleRemoteDocDeleted(docId)),
      // Forward transport-level errors that don't reject a specific request (e.g. a
      // malformed server-pushed event the transport had to drop) so they reach the
      // app's telemetry instead of vanishing.
      ...(this.connection.onError ? [this.connection.onError(error => this.onError.emit(error))] : []),
      patches.onTrackDocs(this._handleDocsTracked.bind(this)),
      patches.onUntrackDocs(this._handleDocsUntracked.bind(this)),
      patches.onDeleteDoc(this._handleDocDeleted.bind(this)),
      patches.onChange(this._handleDocChange.bind(this)),
    ];
  }

  private _unsubs: Unsubscriber[] = [];
  /** Pending per-doc retry timers + attempt counts for transient sync failures. */
  private _syncRetryTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  private _syncRetryAttempts = new Map<string, number>();
  /** Doc ids untracked while `syncAllKnownDocs` rebuilds from a store snapshot (null when no rebuild in flight). */
  private _untrackedDuringResync: Set<string> | null = null;
  /** Per-doc buffers for committed-change broadcasts landing while `_reloadDocFromServer` is in flight. */
  private _reloadBuffers = new Map<string, Change[]>();
  /** Pending per-doc slow re-probe timers for docs the retry ladder gave up on (see `_scheduleSyncReprobe`). */
  private _syncReprobeTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  /** Pending timer for the next degraded-mode catch-up pass (see `_syncAllDegraded`); null when idle. */
  private _degradedSyncTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  /**
   * Whether the app has asked this instance to sync (`connect()` sets it, `disconnect()`
   * clears it). `_canSend()` consults it, so on a send-independent transport an explicit
   * disconnect stops the send path too — not just the stream. Without it, a degraded
   * pass in flight when `disconnect()`/`destroy()` runs would re-arm itself in its
   * `finally` and keep POSTing on a torn-down instance (stale-auth requests after a
   * logout, forever). Mirrors the transport's internal `shouldBeConnected` intent,
   * which isn't visible through the connection interface.
   */
  private _started = false;
  /**
   * Doc ids THIS instance has successfully subscribed on the server. A resume pass
   * (successor tab reconnecting with the predecessor's cursor) rides the server-restored
   * subscription set for docs it knows it subscribed, but must subscribe tracked docs
   * missing from this set — a doc tracked while the stream was down (offline, or the
   * degraded mode DAB-831 makes routine) was never subscribed by anyone, and skipping it
   * on resume left it silently missing live pushes until the next cold connect (DAB-865).
   * A successor starts empty and so re-subscribes everything on resume: one idempotent
   * POST buys correctness; the round-trip saving remains for same-instance resumes.
   * Cleared on disconnect — conservative, since re-subscribing known ids is harmless.
   */
  private _subscribedIds = new Set<string>();
  /**
   * Docs whose current sync failure has already been surfaced (console + `onError`).
   * A background re-probe re-enters `syncDoc` every few minutes; without this a
   * permanently-latched doc (e.g. a 403) would re-log/re-emit the identical error on
   * every probe. Cleared on recovery, untrack, remote delete, and disconnect — so a
   * still-failing doc re-surfaces at most once per connection session.
   */
  private _surfacedSyncErrors = new Set<string>();
  /** Per-doc auto-ejection counts for the circuit breaker (see MAX_DOC_EJECTIONS). Session-scoped. */
  private _ejectionCounts = new Map<string, number>();
  /** Per-doc storage budgets halved down from `maxStorageBytes` by a 413 (see `_tryResplitOversized`). */
  private _resplitBudgets = new Map<string, number>();
  /** Docs whose persisted quarantine entries were re-surfaced this session (see `_resurfaceQuarantined`). */
  private _quarantineResurfaced = new Set<string>();
  /**
   * Per-doc memo of COMMITTED changes that failed strict apply this session (see
   * `_skipFlooredPoison`): how many times each failed, whether an authoritative snapshot has
   * been installed since, and whether the skip has been surfaced. Deliberately NOT cleared
   * when the doc syncs cleanly — the reload that answers each failure IS a success, so
   * clearing on success would reset the count on every lap and the floor would never be
   * reached. Session-scoped, dropped with the doc. `error` is a trimmed copy — see
   * `trimApplyError` for why the raw failure must not be what lives here.
   */
  private _committedApplyFailures = new Map<string, Map<string, PoisonMemoEntry>>();

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
  async connect(lastEventId?: string): Promise<void> {
    // Forward the resume cursor to the transport. Whether the next `connected` pass
    // actually runs in resume mode is decided from `connection.resumedStream` (what the
    // transport did), not from the cursor being passed here (what the caller intended) —
    // so an offline defer or an already-connected no-op can't leak a resume into a later
    // cold reconnect. See `_handleConnectionChange`.
    this._started = true;
    try {
      await this.connection.connect(lastEventId);
    } catch (err) {
      console.error('PatchesSync connection failed:', err);
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.connection.sendRequiresStream === false) {
        // A stream-only failure isn't a sync failure on a send-independent transport:
        // every commit and read still works over plain requests (DAB-831). Keep the
        // error off the sync posture, start the degraded catch-up/flush pass now (the
        // pending backlog must not wait for a `connected` event that may never come),
        // and let the transport keep retrying the stream with its own backoff.
        this.updateState({ connected: false });
        void this._syncAllDegraded();
      } else {
        this.updateState({ connected: false, syncStatus: 'error', syncError: error });
      }
      this.onError.emit(error);
      throw err;
    }
  }

  /**
   * Disconnects from the server and stops syncing.
   */
  disconnect(): void {
    // Clear the intent first: an in-flight degraded pass checks `_canSend()` between
    // docs and its finally's re-schedule guards on `_started`, so this is what makes
    // an explicit stop actually stop the send path (not just the stream).
    this._started = false;
    this.connection.disconnect();
    this.updateState({ connected: false, syncStatus: 'unsynced' });
    this._clearAllSyncRetries();
    this._clearDegradedSync();
    this._resetSyncingStatuses();
    this._subscribedIds.clear();
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

    // Process in order: creates → updates → deletes
    const creates = pendingBranches.filter(b => b.pendingOp === 'create');
    const updates = pendingBranches.filter(b => b.pendingOp === 'update');
    const deletes = pendingBranches.filter(b => b.pendingOp === 'delete');

    for (const branch of creates) {
      if (!this._canSend()) break;

      try {
        // Create the branch on the server. The server is idempotent when metadata.id is provided.
        // The server skips initial change creation when contentStartRev is set in the metadata.
        /* eslint-disable @typescript-eslint/no-unused-vars */
        const {
          docId: sourceDocId,
          branchedAtRev,
          createdAt: _1,
          modifiedAt: _2,
          pendingOp: _3,
          deleted: _4,
          ...metadata
        } = branch;
        /* eslint-enable @typescript-eslint/no-unused-vars */
        await branchApi.createBranch(sourceDocId, branchedAtRev, metadata);

        // Clear the pending flag
        const synced = { ...branch, pendingOp: undefined };
        delete synced.pendingOp;
        await branchStore.saveBranches(sourceDocId, [synced]);
      } catch (err) {
        console.error('Failed to sync pending branch create:', branch.id, err);
        this.onError.emit(err instanceof Error ? err : new Error(String(err)));
        break;
      }
    }

    for (const branch of updates) {
      if (!this._canSend()) break;

      try {
        // Extract only the editable metadata fields to send to the server
        /* eslint-disable @typescript-eslint/no-unused-vars */
        const {
          id: _id,
          docId: _did,
          branchedAtRev: _bar,
          createdAt: _ca,
          modifiedAt: _ma,
          contentStartRev: _csr,
          pendingOp: _po,
          deleted: _del,
          ...metadata
        } = branch;
        /* eslint-enable @typescript-eslint/no-unused-vars */
        await branchApi.updateBranch(branch.id, metadata);
        const synced = { ...branch, pendingOp: undefined };
        delete synced.pendingOp;
        await branchStore.saveBranches(branch.docId, [synced]);
      } catch (err) {
        console.error('Failed to sync pending branch update:', branch.id, err);
        this.onError.emit(err instanceof Error ? err : new Error(String(err)));
        break;
      }
    }

    for (const branch of deletes) {
      if (!this._canSend()) break;

      try {
        await branchApi.deleteBranch(branch.id);

        // Server confirmed the delete — remove the tombstone from the local store
        await branchStore.removeBranches([branch.id]);
      } catch (err) {
        console.error('Failed to sync pending branch deletion:', branch.id, err);
        this.onError.emit(err instanceof Error ? err : new Error(String(err)));
        break;
      }
    }

    if (pendingBranches.length > 0) {
      this.onBranchMetasSynced.emit();
    }
  }

  /**
   * Syncs all known docs when initially connected.
   *
   * `resume` (a successor tab reconnecting with the predecessor's event cursor): the
   * server is replaying the committed gap over the stream and restored this client's
   * subscriptions server-side, so this pass skips the re-subscribe and the per-doc
   * re-pull and only flushes docs still holding local pending. It stays on 'synced'
   * unless there is pending to flush, so a clean hand-off never flashes 'syncing'. A
   * cold connect (`resume` false) subscribes, syncs, and processes tombstones as before.
   */
  protected async syncAllKnownDocs(opts?: { resume?: boolean }): Promise<void> {
    const resume = opts?.resume ?? false;
    if (!this.state.connected) return;
    if (!resume) this.updateState({ syncStatus: 'syncing' });

    this._untrackedDuringResync = new Set();
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

      // The store snapshot above is stale by however long the reads took. Merge it with what
      // happened meanwhile instead of replacing wholesale: docs tracked during the window stay
      // tracked (evicting them would silently stop sending their edits until the next
      // reconnect), docs untracked during the window stay untracked. Both merges run in one
      // synchronous block so track/untrack handlers can't interleave.
      // `??` guards a connection flap overlapping two runs: the first run's finally may null
      // the set while the second is mid-flight.
      const untracked = this._untrackedDuringResync ?? new Set<string>();
      const tracked = new Set(this.trackedDocs);
      for (const id of activeDocIds) if (!untracked.has(id)) tracked.add(id);
      for (const { docId } of deletedDocs) tracked.delete(docId);
      this.trackedDocs = tracked;

      const docStates: Record<string, DocSyncState> = {};
      for (const [id, entry] of Object.entries(syncedEntries)) {
        if (!untracked.has(id)) docStates[id] = entry;
      }
      for (const [id, entry] of Object.entries(this.docStates.state)) {
        if (!(id in docStates) && tracked.has(id)) docStates[id] = entry;
      }
      this.docStates.state = docStates;

      // Docs tracked during the window were already subscribed + synced by _handleDocsTracked
      const syncIds = activeDocIds.filter(id => tracked.has(id));

      // On resume the replay covers clean docs, so sync only those still holding local
      // pending (a mint a predecessor or this tab persisted but never flushed). A cold
      // connect syncs every doc. hasPending was just read into syncedEntries above.
      const flushIds = resume ? syncIds.filter(id => syncedEntries[id]?.hasPending) : syncIds;

      // Cold connect subscribes everything. A resume subscribes the docs it will flush
      // (one may have been created offline and never subscribed by the predecessor) PLUS
      // any tracked doc this instance never subscribed itself (`_subscribedIds`) — a doc
      // tracked while the stream was down has no subscription anywhere, and skipping it
      // here left it silently missing live pushes until the next cold connect (DAB-865).
      // Docs this instance knows it subscribed ride the set the server restored from its
      // own store (2h TTL) when the stream reopened, so re-POSTing those would just add
      // the round-trips a hand-off is meant to avoid.
      const subscribeCandidates = resume
        ? syncIds.filter(id => syncedEntries[id]?.hasPending || !this._subscribedIds.has(id))
        : syncIds;
      if (subscribeCandidates.length > 0) {
        try {
          const subscribeIds = this._filterSubscribeIds(subscribeCandidates);
          if (subscribeIds.length) {
            // Record only the GRANTED ids: subscribe() resolves with the possibly-partial
            // subset actually registered (denied/unaccounted ids resolve silently, no
            // throw). Recording the request instead would mark a denied doc as
            // subscribed and permanently skip it from re-subscribe — the silent miss
            // DAB-865 exists to prevent.
            const granted = (await this.connection.subscribe(subscribeIds)) ?? [];
            granted.forEach(id => this._subscribedIds.add(id));
          }
        } catch (err) {
          console.warn('Error subscribing to active docs during sync:', err);
          this.onError.emit(err as Error);
        }
      }

      if (resume && flushIds.length) this.updateState({ syncStatus: 'syncing' });

      // Sync each active doc
      const activeSyncPromises = flushIds.map((id: string) => this.syncDoc(id));

      // Attempt to delete docs marked with tombstones — deferred to the next cold sync on
      // resume (rare, and the predecessor most likely already pushed the delete).
      const deletePromises = resume
        ? []
        : deletedDocs.map(async ({ docId }) => {
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
    } finally {
      this._untrackedDuringResync = null;
    }
  }

  /**
   * One degraded-mode sync pass: flush pending and pull committed catch-up for every
   * tracked doc over plain requests while the push stream is down (DAB-831). Only
   * meaningful on transports whose sends don't ride the stream
   * (`sendRequiresStream === false`) — for those, a hostile network can hold the
   * stream down forever (an SSE-buffering middlebox never fires `onopen`) while every
   * fetch still succeeds; without this pass the pending backlog would wait for a
   * `connected` event that never arrives. Skips the re-subscribe — subscriptions
   * belong to an open stream (the server rejects them without one) — so live pushes
   * stay off; each pass is one round of send + catch-up per doc, riding `syncDoc`'s
   * serial gate, retry ladder, and reload-buffer guards. Re-schedules itself
   * (jittered, ~24-30s) until the stream connects, we go offline, or the transport is
   * stream-bound; the `connected` transition cancels it and `syncAllKnownDocs` takes
   * over.
   */
  protected async _syncAllDegraded(): Promise<void> {
    this._clearDegradedSync();
    if (!this._canSend() || this.state.connected || this.connection.sendRequiresStream !== false) return;
    try {
      // Branch metas first — branches must exist server-side before their doc content.
      // A rejection from the branch-store read (or any other surprise) must not escape
      // the `void` call sites as an unhandled rejection — see catch below. Liveness
      // note: if a store read HANGS (the WebKit IndexedDB-stall family) rather than
      // rejecting, the finally never runs and the loop stays dormant until the next
      // connection-state or online event re-arms it.
      await this.syncPendingBranchMetas();
      for (const docId of [...this.trackedDocs]) {
        // The stream may establish mid-pass (hand off to syncAllKnownDocs cleanly),
        // or disconnect()/offline may land mid-pass (stop sending immediately).
        if (this.state.connected || !this._canSend()) return;
        await this.syncDoc(docId);
      }
      // Report an honest global posture after a full pass: 'synced' only when every
      // tracked doc came through clean (per-doc failures latch their own docStates and
      // keep their own retry/reprobe machinery running).
      const allSynced =
        this.trackedDocs.size > 0 &&
        [...this.trackedDocs].every(id => this.docStates.state[id]?.syncStatus === 'synced');
      if (allSynced && !this.state.connected) {
        this.updateState({ syncStatus: 'synced' });
      }
    } catch (error) {
      console.error('Error during degraded sync pass:', error);
      this.onError.emit(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this._scheduleDegradedSync();
    }
  }

  /** Arm the next degraded-mode pass; no-op whenever it doesn't apply (see `_syncAllDegraded`). */
  protected _scheduleDegradedSync(): void {
    if (!this._canSend() || this.state.connected || this.connection.sendRequiresStream !== false) return;
    if (this._degradedSyncTimer !== null) return;
    this._degradedSyncTimer = globalThis.setTimeout(() => {
      this._degradedSyncTimer = null;
      void this._syncAllDegraded();
    }, jitterReprobeDelay(DEGRADED_SYNC_INTERVAL_MS));
  }

  protected _clearDegradedSync(): void {
    if (this._degradedSyncTimer !== null) {
      globalThis.clearTimeout(this._degradedSyncTimer);
      this._degradedSyncTimer = null;
    }
  }

  /**
   * Syncs a single document.
   * @param docId The ID of the document to sync.
   */
  @serialGate
  protected async syncDoc(docId: string): Promise<void> {
    if (!this._canSend() || !this.trackedDocs.has(docId)) return;

    this._initDocSyncState(docId, { syncStatus: 'syncing' });

    const doc = this.patches.getOpenDoc(docId);
    const algorithm = this._getAlgorithm(docId);
    // On the doc's first sync attempt this session, regardless of outcome, so a doc that
    // latches at 'error' can't strand a persisted quarantined change un-surfaced.
    this._resurfaceQuarantined(docId, algorithm);

    // Cast to BaseDoc for internal updateSyncStatus method (not on the PatchesDoc interface)
    const baseDoc = doc as BaseDoc | undefined;

    if (baseDoc) {
      baseDoc.updateSyncStatus('syncing');
    }
    let pending: Change[] | null | undefined;
    try {
      // Use algorithm to get pending changes to send
      pending = await algorithm.getPendingToSend(docId, doc as PatchesDoc<any> | undefined);

      if (pending && pending.length > 0) {
        await this.flushDoc(docId, pending);
      } else {
        const committedRev = await algorithm.getCommittedRev(docId);
        if (committedRev) {
          const serverChanges = await this.connection.getChangesSince(docId, committedRev);
          if (serverChanges.length > 0) {
            await this._applyServerChangesToDoc(docId, serverChanges);
          }
          // Nothing was flushed, so nothing else refreshes hasPending — and getPendingToSend
          // can itself empty the store (dropping an already-committed strand), leaving a
          // hasPending:true from the change that queued this sync stuck on until some later
          // flush. Re-read the store's real truth rather than assuming false: a concurrent
          // mint may have queued a change (and a follow-up sync) since the empty read above.
          this._updateDocSyncState(docId, { hasPending: await algorithm.hasPending(docId) });
        } else {
          // No committed rev means this is a new doc - fetch from server
          await this._reloadDocFromServer(docId, algorithm, true);
        }
      }
      this._updateDocSyncState(docId, { syncStatus: 'synced' });
      this._clearSyncRetry(docId);
      this._surfacedSyncErrors.delete(docId);
      if (baseDoc) {
        baseDoc.updateSyncStatus('synced');
      }
    } catch (err) {
      // Handle DOC_DELETED error (document was deleted while we were offline)
      if (this._isDocDeletedError(err)) {
        await this._handleRemoteDocDeleted(docId);
        return;
      }
      // A change that failed to apply (strict patch failure) means the local committed
      // state has diverged from the server's, or a corrupt change is in the stream.
      // Incremental catch-up can never get past it — refetching the same changes fails
      // the same way — so recover by pulling the authoritative snapshot. Surface the
      // original error first: unlike a benign rev gap, a failed apply is a corruption
      // signal telemetry must see even when recovery succeeds.
      let failure: unknown = err;
      if (failure instanceof ApplyChangesError) {
        console.error(`Failed to apply changes for doc ${docId}, reloading from server:`, failure);
        this.onError.emit(failure, { docId });
        try {
          await this._reloadDocFromServer(docId, algorithm);
          this._updateDocSyncState(docId, { syncStatus: 'synced' });
          this._clearSyncRetry(docId);
          this._surfacedSyncErrors.delete(docId);
          if (baseDoc) {
            baseDoc.updateSyncStatus('synced');
          }
          return;
        } catch (reloadErr) {
          if (this._isDocDeletedError(reloadErr)) {
            await this._handleRemoteDocDeleted(docId);
            return;
          }
          failure = reloadErr; // fall through to the transient/definitive handling below
        }
      }
      const syncError = failure instanceof Error ? failure : new Error(String(failure));
      // A status-less interruption is CONNECTION/environment trouble, not doc trouble.
      // Two classes land here: a network-level failure (fetch rejected without an HTTP
      // response, request timeout, transport with no live connection) and a cancelled
      // request/transaction (AbortError: page/worker teardown mid-sync, IndexedDB abort
      // under storage pressure). One unreachable server would otherwise latch every
      // tracked doc at 'error' — and `connected` can still read true while it happens
      // (fetches can fail while the SSE stream lives, or before the liveness watchdog
      // notices it died). Park the doc in the same stable waiting-for-connection
      // posture disconnect uses — never per-doc 'error' — and leave recovery with the
      // connection-level machinery: the fast retry ladder, then the slow background
      // re-probe, and any reconnect's syncAllKnownDocs. Genuine doc-level failures
      // (coded 4xx/5xx, apply failures) latch below as before.
      if (isNetworkError(failure) || isAbortError(failure)) {
        this._deferDocToConnectionRecovery(docId, baseDoc, pending, syncError);
        return;
      }
      // A 413 on one change is about SIZE, not content: re-split smaller and retry before the
      // ejection path below considers throwing the user's work into quarantine.
      if (this._tryResplitOversized(docId, failure)) return;
      // A rejection naming a corroborated poison change recovers by ejecting it into
      // quarantine so the rest of the queue can sync past it.
      if (await this._tryEjectPoisonChange(docId, algorithm, failure)) return;
      this._updateDocSyncState(docId, { syncStatus: 'error', syncError });
      if (baseDoc) {
        baseDoc.updateSyncStatus('error', syncError);
      }
      // Transient failures self-heal via a backed-off retry; definitive ones
      // (auth/payment/permission/not-found/gone) latch immediately. Surface the error
      // only when nothing is left to recover it — otherwise a self-healing reconnect blip
      // would spam onError/logs on every attempt. So we report a definitive failure, or a
      // transient one we've exhausted retries on while still connected; a failure that
      // coincides with a disconnect stays quiet, since the reconnect's syncAllKnownDocs
      // re-syncs everything.
      const retryable = this._isRetryableSyncError(failure);
      const willRetry = retryable && this._scheduleSyncRetry(docId);
      if (!willRetry) {
        this._clearSyncRetry(docId);
        const recoverableOnReconnect = retryable && !this._canSend();
        if (!recoverableOnReconnect && !this._surfacedSyncErrors.has(docId)) {
          this._surfacedSyncErrors.add(docId);
          console.error(`Error syncing doc ${docId}:`, failure);
          this.onError.emit(syncError, { docId });
        }
        // Left at 'error' with pending changes while the connection is up: nothing else
        // re-attempts this doc until a local edit or reconnect, so a server-side recovery
        // (a commit-path outage ending after the ladder, or a policy fix un-rejecting the
        // pending change) would never be noticed. Keep probing slowly in the background.
        // 410 never reaches here — it diverted to the remote-delete path above.
        if (pending?.length) {
          this._scheduleSyncReprobe(docId, retryable);
        }
      }
    }
  }

  /**
   * Pulls the authoritative snapshot from the server and resets local committed state to it,
   * keeping pending/optimistic work (the store keeps pending across saveDoc; doc.import()
   * re-applies optimistic ops). Used to hydrate a brand-new doc (no committed rev) and to
   * recover when incremental catch-up can't proceed — a change that fails to apply (see the
   * ApplyChangesError handling in syncDoc) or a flush the server answered with
   * docReloadRequired.
   *
   * Pending work is kept but NOT verbatim: it is first reconciled against the committed
   * tail the snapshot subsumes (see `ClientAlgorithm.reconcilePending`). A pending change
   * the server has ALREADY committed — e.g. a flush that succeeded on the wire but whose
   * echo failed to apply locally, the exact class this recovery handles — must be dropped
   * here, or doc.import() re-applies it on top of a state that already contains it (the
   * user sees their edits doubled) and the next flush re-sends it with a re-stamped baseRev
   * the server's idempotency dedupe no longer covers (permanently duplicated content for
   * every collaborator). Survivors are transformed into the snapshot's frame — a pure op
   * transform that never applies the tail, so it works even though applying it just failed.
   * `resolvedChanges` extends the resolved set with changes the caller already knows the
   * server committed (e.g. a batch answered with docReloadRequired).
   *
   * Two races with the in-flight fetch are also handled:
   *
   * - A committed-change broadcast landing mid-fetch can't be applied — the store may not have
   *   the doc yet, so the algorithm would drop it silently while the doc still reports
   *   'synced'. Such broadcasts are buffered (see `_receiveCommittedChanges`) and reconciled
   *   after the save: a contiguous tail applies directly, a gap pulls the authoritative tail.
   * - A local change minted mid-fetch is based on rev 0, not the fetched snapshot. Installing
   *   the snapshot would advance committedRev, and the next flush would re-stamp the change's
   *   baseRev without transforming its ops — a root-replace "init" would then overwrite the
   *   existing server doc, bypassing the server's baseRev-0 guard. With `flushPendingFirst`
   *   (the brand-new-doc hydration path), flush at the true baseRev instead of installing,
   *   keeping the server in the loop (it rejects root ops on an existing doc and heals the
   *   rest via docReloadRequired).
   */
  protected async _reloadDocFromServer(
    docId: string,
    algorithm: ClientAlgorithm,
    flushPendingFirst = false,
    resolvedChanges: Change[] = []
  ): Promise<void> {
    this._reloadBuffers.set(docId, []);
    try {
      // Read the rev the local committed state (and thus pending) sits on BEFORE overwriting it.
      const baseRev = await algorithm.getCommittedRev(docId);
      const snapshot = await this.connection.getDoc(docId);
      if (flushPendingFirst && snapshot.rev > 0 && (await algorithm.hasPending(docId))) {
        await this.flushDoc(docId);
        // A foreign broadcast that landed during the flush was parked in the reload buffer
        // (see `_receiveCommittedChanges`) — drain it before the finally destroys the buffer,
        // or the change is lost until the next full catch-up. The flush's commit response
        // already advanced committedRev (the server returns catchup changes + our own
        // committed changes, applied via `_applyServerChangesToDoc`), so a parked broadcast
        // may overlap what the flush applied: the drain's `rev > committedRev` filter drops
        // the overlap and its contiguity check refetches the authoritative tail on a gap.
        // If flushDoc throws we deliberately skip the drain — the throw propagates to
        // syncDoc's catch, whose retry/backoff re-runs the flush (its commit response
        // carries the catchup changes the dropped broadcast contained) and the reconnect
        // path re-syncs everything, so the buffered changes are recovered there.
        await this._drainReloadBuffer(docId, await algorithm.getCommittedRev(docId));
        return;
      }
      let reconciled = false;
      let committedTail: Change[] = [];
      // The envelope may carry a committed tail past its snapshot rev (`snapshot.rev` is the
      // last version boundary; `snapshot.changes` extends to the server head), and saveDoc
      // below installs ALL of it as committed. Pending must therefore be reconciled against
      // everything actually installed — through the envelope's last change — not just through
      // snapshot.rev: committedRev jumps to the installed head, so normal catch-up never
      // redelivers (snapshot.rev, head] and pending minted below head would be imported on
      // top of the head state un-rebased (strict apply throws, or ops land at stale offsets).
      // (The protocol type is PatchesState, but servers return the full snapshot envelope —
      // the stores make the same cast to install `changes`; older/LWW transports may omit it.)
      const installedChanges = (snapshot as PatchesSnapshot).changes;
      const installedRev = installedChanges?.length ? installedChanges[installedChanges.length - 1].rev : snapshot.rev;
      if (algorithm.reconcilePending && installedRev > baseRev && (await algorithm.hasPending(docId))) {
        // Changes past the installed head are excluded: the envelope doesn't contain them, so
        // the normal catch-up path will deliver them and rebase pending against them itself.
        committedTail = (await this.connection.getChangesSince(docId, baseRev)).filter(c => c.rev <= installedRev);
        if (committedTail.length > 0) {
          await algorithm.reconcilePending(docId, committedTail);
          reconciled = true;
        }
      }
      // Save via algorithm's store
      await algorithm.store.saveDoc(docId, snapshot);
      // Authoritative state is now installed: a committed change that fails to apply from here
      // on is failing on top of the server's own truth (see `_skipFlooredPoison`).
      this._markPoisonReloaded(docId);
      // Read back the actual committed rev (store may compute from changes)
      const committedRev = await algorithm.getCommittedRev(docId);
      this._updateDocSyncState(docId, {
        committedRev,
        // Reconciliation may have cleared every pending change (they were already committed);
        // refresh the flag so the doc doesn't read as having unsynced work indefinitely.
        ...(reconciled ? { hasPending: await algorithm.hasPending(docId) } : undefined),
      });
      // Re-read the snapshot from the algorithm's store so it includes any pending
      // changes the store kept across saveDoc. Passing `changes: []` here would let
      // doc.import() wipe in-memory pending state (OTDoc._pendingChanges) and LWW
      // echo tracking (_inFlightOpKeys), diverging the doc from its store.
      const fullSnapshot = await this._loadRepairedSnapshot(docId, algorithm, snapshot as PatchesSnapshot);
      if (fullSnapshot) {
        // resolvedChanges + committedTail as the resolved set: the open doc's in-memory
        // pending may still list changes reconcilePending just dropped as server-committed —
        // without this, the pending-preserving union would re-add them and reintroduce the
        // double-apply.
        this._applySnapshotPreservingPending(docId, fullSnapshot, [...resolvedChanges, ...committedTail]);
      }
      await this._drainReloadBuffer(docId, committedRev);
    } finally {
      this._reloadBuffers.delete(docId);
    }
  }

  /**
   * Reconciles broadcasts parked in `_reloadBuffers` while `_reloadDocFromServer` was
   * fetching/flushing: a contiguous tail past `committedRev` applies directly, a gap pulls
   * the authoritative tail. Loops because applying is async and more may buffer meanwhile;
   * the final empty check and the buffer removal (the caller's finally) share a microtask,
   * so nothing slips between them. The entry can also vanish mid-drain: a docReloadRequired
   * answered during a `flushPendingFirst` flush nests a second reload whose finally deletes
   * it. Anything parked there is redelivered by the next catch-up, so a missing entry means
   * nothing left to drain — never a crash.
   */
  private async _drainReloadBuffer(docId: string, committedRev: number): Promise<void> {
    let buffered = this._reloadBuffers.get(docId);
    while (buffered && buffered.length > 0) {
      this._reloadBuffers.set(docId, []);
      const tail = buffered.filter(c => c.rev > committedRev);
      if (tail.length > 0) {
        const contiguous = tail.every((c, i) => c.rev === committedRev + 1 + i);
        const changes = contiguous ? tail : await this.connection.getChangesSince(docId, committedRev);
        if (changes.length > 0) {
          await this._applyServerChangesToDoc(docId, changes);
          committedRev = changes[changes.length - 1].rev;
        }
      }
      buffered = this._reloadBuffers.get(docId);
    }
  }

  /**
   * Fold a branch merge's committed changes (as returned by the merge RPC) into the
   * open source doc, so the merged result materializes immediately instead of waiting
   * for the WebSocket/SSE echo — which isn't guaranteed to reach the initiating client
   * promptly when the REST commit and the subscription resolve to different backends.
   * `_applyServerChangesToDoc` rebases pending edits (lossless); a subclass override may
   * additionally broadcast the applied changes to other tabs.
   *
   * Idempotent, deduped by revision: if the echo (or a re-broadcast) already advanced the
   * doc to/past the merge, this is a no-op. If a concurrent commit opened a gap since our
   * last sync, fall back to `syncDoc` (pulls the authoritative tail, which includes the
   * merge). An empty merge is a no-op.
   */
  async applyMergeChanges(docId: string, mergeChanges: Change[]): Promise<void> {
    if (mergeChanges.length === 0) return;
    const committedRev = await this._getAlgorithm(docId).getCommittedRev(docId);
    const firstRev = mergeChanges[0].rev;
    const lastRev = mergeChanges[mergeChanges.length - 1].rev;
    if (committedRev >= lastRev) return; // already applied (echo / re-broadcast)
    if (committedRev === firstRev - 1) {
      await this._applyServerChangesToDoc(docId, mergeChanges);
    } else {
      await this.syncDoc(docId); // gap from a concurrent commit → pull the authoritative tail
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
    if (!this._canSend()) {
      throw new NetworkError('Cannot send changes: offline or not connected');
    }

    // Guarantee a docStates entry exists. flushDoc is protected/subclass-callable and
    // only checks trackedDocs above, not that _initDocSyncState already ran for this
    // doc — without this, a flush reached before that init is a silent no-op below
    // (_updateDocSyncState no-ops for an absent entry), so the doc looks like it never
    // synced even though the flush succeeded. Merges into any existing entry.
    this._initDocSyncState(docId, {});

    const algorithm = this._getAlgorithm(docId);

    try {
      if (!pending) {
        pending = (await algorithm.getPendingToSend(docId, this.patches.getOpenDoc(docId) as PatchesDoc<any>)) ?? [];
      }
      if (!pending.length) {
        return; // Nothing to flush
      }

      // The follow-up pass at the end of this method re-arms on every flush now, so it needs a
      // progress signal — without one, any state where a run commits but the queue does not
      // shrink is a continuous commit + IndexedDB cycle with nothing user-visible (an echo that
      // never carries the ids, a straggler the server rebases away without echoing it back, a
      // store write that silently no-ops). Serial-gating stops re-entrancy, not the loop. The
      // queue only ever drains from the front, so the head row leaving is the cheapest sound
      // proof that a pass accomplished something. Compared by id, NOT id@rev: a re-sequenced
      // head is the same row that did not drain.
      const headBefore = pending[0].id;

      const batches = breakChangesIntoBatches(pending, {
        maxPayloadBytes: this.maxPayloadBytes,
        maxStorageBytes: this._resplitBudgets.get(docId) ?? this.maxStorageBytes,
        maxUnsplittableBytes: this.maxUnsplittableBytes,
        sizeCalculator: this.sizeCalculator,
        docId,
      });

      // Splitting an oversized change re-identifies and renumbers part of the queue. The store
      // must hold exactly what we send: the commit echo clears pending by id, so a stored
      // original whose pieces were sent under other ids would survive, re-apply on top of its
      // own committed content, and duplicate it.
      const flattened = batches.flat();
      if (flattened.length !== pending.length) {
        await algorithm.replacePendingChanges?.(docId, pending, flattened);
        if (this.patches.getOpenDoc(docId)) {
          const fullSnapshot = await algorithm.loadDoc(docId);
          if (fullSnapshot) this.patches.applySnapshot(docId, fullSnapshot);
        }
        // Splitting collapsed every change to nothing (e.g. an oversized @txt op whose delta
        // carries no sendable ops): the local edits amount to a no-op. The queue was cleared
        // above (changes minted since the read survive in the store), so there is nothing to
        // put on the wire — batches would be [[]] here. Report the store's real hasPending
        // and finish; a change minted mid-replace re-triggers sync via its own onChange.
        if (flattened.length === 0) {
          const stillHasPending = await algorithm.hasPending(docId);
          this._updateDocSyncState(docId, { hasPending: stillHasPending, syncStatus: 'synced' });
          return;
        }
      }

      let reloadedMidFlush = false;

      for (const changeBatch of batches) {
        if (!this._canSend()) {
          throw new NetworkError('Cannot send changes: went offline or lost the connection during flush');
        }

        let commitResult;
        try {
          commitResult = await this.connection.commitChanges(docId, changeBatch);
        } catch (err) {
          // The server refused the batch as unusably stale against the doc's history (409
          // scope:'doc'): a baseRev-0 continuation it cannot transform, or a baseRev ahead of
          // its head. Retrying the same bytes can never succeed; the recovery the refusal
          // prescribes is a reload, which rebases the entire remaining queue — this refused
          // batch included, since nothing was committed or dropped — onto the true head. The
          // follow-up sync below then re-sends it from the store.
          if (this._isStaleDocError(err)) {
            await this._reloadDocFromServer(docId, algorithm, false);
            reloadedMidFlush = true;
            break;
          }
          throw err;
        }
        const { changes: committed, docReloadRequired } = commitResult;

        if (docReloadRequired) {
          // Our local state is stale (baseRev:0 on existing doc). Confirm the sent
          // changes (they were committed), then reload the full state from the server.
          await algorithm.confirmSent(docId, changeBatch);
          // The batch WAS committed — the server transformed it onto its tip, so the
          // snapshot reloaded below already contains its effects. OT's confirmSent is a
          // no-op (the normal path clears pending via the commit echo, which never
          // comes on this path), so drop the batch from the pending queue explicitly.
          // Leaving it there would re-apply its ops on import (duplicating content)
          // and re-send it on the next flush (re-committing it — the server's id
          // de-dup window `startAfter: baseRev` no longer covers the original commit).
          await algorithm.dropResolvedPending?.(docId, changeBatch, []);
          // Pass the batch as resolved so the pending-preserving import can't re-add it
          // from the open doc's stale in-memory queue.
          await this._reloadDocFromServer(docId, algorithm, false, changeBatch);
          // `batches` predates the reload, which replaced the committed state they were minted
          // against and rebased the rest of the queue onto the new head. Every remaining batch
          // still holds the pre-rebase copy of its ops at baseRev 0, and the server cannot
          // transform that onto a head it never saw: it stacks the ops verbatim over whatever
          // paths they touch, or reads the whole change log trying to rebase them. Stop sending
          // them and let the follow-up sync below flush what the store actually holds.
          reloadedMidFlush = true;
          break;
        } else {
          // Confirm sent first so server corrections (applied next) overwrite
          // any stale ops for fields the server won via LWW timestamp resolution.
          // For OT this order doesn't matter; for LWW it ensures applyServerChanges
          // is the last writer for corrected fields.
          const localCorrections = (await algorithm.confirmSent(docId, changeBatch)) ?? [];
          // LWW's guarded promotion resolved some sent ops against newer committed rows
          // (see ClientAlgorithm.confirmSent) — the open doc's optimistic values for those
          // paths are stale NOW, and the response apply below is a separate store
          // transaction that may never land (the ack-persist crash window). Re-sync the doc
          // from the store first so a lost response can't leave the doc diverged; the
          // response's own corrections then apply on top as usual.
          if (localCorrections.length > 0 && this.patches.getOpenDoc(docId)) {
            const fullSnapshot = await algorithm.loadDoc(docId);
            if (fullSnapshot) this._applySnapshotPreservingPending(docId, fullSnapshot, changeBatch);
          }
          await this._applyServerChangesToDoc(docId, committed);

          // Drop any sent change the server rebased away to a no-op (absent from
          // `committed`). applyServerChanges only clears pending whose ids the
          // server echoed back; a dropped change (e.g. a root-replace re-asserting
          // already-committed state) is never echoed and never rebases to empty, so
          // without this it is resent on every flush forever. Re-sync the open doc
          // from the store when we drop so its in-memory pending stays consistent.
          const dropped = (await algorithm.dropResolvedPending?.(docId, changeBatch, committed)) ?? 0;
          if (dropped > 0 && this.patches.getOpenDoc(docId)) {
            const fullSnapshot = await algorithm.loadDoc(docId);
            if (fullSnapshot) this._applySnapshotPreservingPending(docId, fullSnapshot, changeBatch);
          }
        }

        // Fetch remaining pending for next batch or check completion
        pending = (await algorithm.getPendingToSend(docId, this.patches.getOpenDoc(docId) as PatchesDoc<any>)) ?? [];
      }

      // The budget a 413 halved got this doc through, so stop paying for it: the next flush
      // starts from the configured budget again and re-halves only if the server objects again.
      this._resplitBudgets.delete(docId);
      const stillHasPending = await algorithm.hasPending(docId);
      this._updateDocSyncState(docId, { hasPending: stillHasPending, syncStatus: 'synced' });
      // Send the remainder, from the store rather than from `batches`: after a mid-flush reload
      // that rebased the queue, or when this pass drained its run and left a deferred one behind
      // — a mixed-baseRev queue flushes one frame per pass (see
      // OTAlgorithm._withConsistentBaseRev), and without this a deferred run would wait for the
      // next mint or reconnect. Gated on the head having moved (see `headBefore`) so a queue
      // that never shrinks stops instead of spinning. Sync is serial-gated, so this queues
      // exactly one follow-up pass instead of recursing, and that pass flushes on the reloaded
      // committedRev, which no longer answers docReloadRequired.
      const drained = pending.length > 0 && pending[0].id !== headBefore;
      if ((reloadedMidFlush || drained) && stillHasPending) void this.syncDoc(docId);
    } catch (err) {
      if (this._isDocDeletedError(err)) {
        await this._handleRemoteDocDeleted(docId);
        return;
      }
      // A status-less interruption (network-level failure or aborted request) never
      // latches per-doc 'error' — syncDoc's catch parks the doc for connection-level
      // recovery (see the interruption comment there). Even writing 'error' momentarily
      // here would leak the state to docStates subscribers (consumers broadcast every
      // transition) before the park overwrites it, so park directly instead; callers
      // that reach flushDoc outside syncDoc still get a stable (non-error) posture.
      if (isNetworkError(err) || isAbortError(err)) {
        this._updateDocSyncState(docId, { syncStatus: this._stableDocStatus(docId, pending) });
      } else {
        const flushError = err instanceof Error ? err : new Error(String(err));
        this._updateDocSyncState(docId, { syncStatus: 'error', syncError: flushError });
      }
      // Don't surface here — `syncDoc` (our only caller) owns the decision of whether
      // to log/emit: it stays quiet while a retry can still recover the doc, and
      // surfaces a latched failure exactly once. Emitting here too would double-report
      // every flush failure and spam onError on transient blips syncDoc means to swallow.
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
    // A broadcast landing while the doc's snapshot reload is in flight can't be applied yet —
    // the store may not have the doc, so the algorithm would drop it silently while
    // committedRev still advanced. Park it; the reload reconciles it after the save.
    const reloadBuffer = this._reloadBuffers.get(docId);
    if (reloadBuffer) {
      reloadBuffer.push(...serverChanges);
      return;
    }
    try {
      await this._applyServerChangesToDoc(docId, serverChanges);
    } catch (err) {
      // Two recoverable failure classes land here. Without recovery the batch is dropped and
      // `committedRev` freezes silently, so the client stops converging while believing it is
      // up to date.
      // - MissingChangesError: a non-contiguous server change (we missed an earlier event — a
      //   transient SSE drop the browser's replay didn't fully cover). syncDoc pulls the
      //   authoritative tail via getChangesSince, mirroring applyMergeChanges' gap fallback.
      // - ApplyChangesError: a change in the batch failed to apply (corrupt change or diverged
      //   local state). syncDoc's own ApplyChangesError fallback reloads the authoritative
      //   snapshot when the refetched tail can't be applied either, and emits onError for
      //   telemetry — a failed apply is a corruption signal, unlike a benign gap.
      if (this._isMissingChangesGap(err) || err instanceof ApplyChangesError) {
        try {
          await this.syncDoc(docId);
          return;
        } catch (syncErr) {
          this.onError.emit(syncErr as Error, { docId });
          return;
        }
      }
      this.onError.emit(err as Error, { docId });
    }
  }

  /** True when an error is the revision-gap thrown by applyCommittedChanges. */
  private _isMissingChangesGap(err: unknown): boolean {
    return err instanceof MissingChangesError;
  }

  /**
   * Imports a freshly loaded store snapshot into the open doc (via Patches.applySnapshot)
   * without wiping changes minted after the snapshot's pending set was read.
   *
   * `doc.import()` replaces the doc's pending queue wholesale with `snapshot.changes`.
   * The store read (`algorithm.loadDoc`) and the local mint pipeline are not mutually
   * serialized, so a change the user mints between the read and the import would vanish
   * from the open doc's contents and pending queue — while still sitting in the store —
   * silently diverging doc from store until the next full reload. Union the open doc's
   * in-memory pending changes into the snapshot by change id before importing.
   *
   * `resolvedChanges` are changes known to be committed/resolved on the server (their
   * effects are already inside `snapshot.state`) — those are never re-added, even if the
   * doc still lists them as pending.
   *
   * The merge is OT-shaped; docs without a pending change queue (LWWDoc tracks pending
   * ops in its store, not on the doc) fall through to a plain applySnapshot.
   */
  protected _applySnapshotPreservingPending(docId: string, snapshot: PatchesSnapshot, resolvedChanges: Change[]): void {
    const doc = this.patches.getOpenDoc(docId) as { getPendingChanges?: () => Change[] } | null | undefined;
    if (doc && typeof doc.getPendingChanges === 'function') {
      const have = new Set(snapshot.changes.map(c => c.id));
      const resolved = new Set(resolvedChanges.map(c => c.id));
      for (const change of doc.getPendingChanges()) {
        if (!have.has(change.id) && !resolved.has(change.id)) {
          snapshot.changes.push(change);
        }
      }
    }
    this.patches.applySnapshot(docId, snapshot);
  }

  /**
   * Applies server changes to a document using the algorithm.
   * The algorithm handles all algorithm-specific logic (OT rebasing, LWW merging, etc).
   */
  protected async _applyServerChangesToDoc(docId: string, serverChanges: Change[]): Promise<void> {
    const doc = this.patches.getOpenDoc(docId);
    const algorithm = this._getAlgorithm(docId);
    // The one choke point every committed batch reaches (flush echoes, broadcasts, catch-up,
    // merges, the reload drain), so the poison floor is applied here and nowhere else.
    const staged: CommittedPoisonSkippedError[] = [];
    const changes = this._skipFlooredPoison(docId, serverChanges, staged);

    // Guarantee a docStates entry exists for a tracked doc. This is reachable from
    // paths that don't run _initDocSyncState first — the public applyMergeChanges API
    // and the raw onChangesCommitted push both call this directly — so without this,
    // the committedRev update below silently no-ops for a doc whose entry hasn't been
    // created yet. Gated on trackedDocs so a genuinely-untracked doc still gets no entry.
    if (this.trackedDocs.has(docId)) {
      this._initDocSyncState(docId, {});
    }

    // Durable tip BEFORE applying: onServerCommit fires only for changes that become newly
    // durable now. A re-delivery carries revs already applied — DAB-773 echoes every flushed
    // commit back to its sender, and catchup can overlap a broadcast — and applyServerChanges
    // drops those, so emitting the raw batch would re-fire the same rev range and a per-change
    // consumer (word counts, journal drain) would double-count.
    const priorRev =
      (doc as { committedRev?: number } | null | undefined)?.committedRev ??
      this.docStates.state[docId]?.committedRev ??
      0;

    // Delegate to algorithm - it handles store updates and doc updates
    try {
      await algorithm.applyServerChanges(docId, changes, doc);
    } catch (err) {
      if (err instanceof ApplyChangesError) this._recordCommittedApplyFailure(docId, changes, err);
      throw err;
    }
    this._reportSkippedPoison(docId, staged);

    if (changes.length > 0) {
      const lastRev = changes[changes.length - 1].rev;
      this._updateDocSyncState(docId, { committedRev: lastRev });
      // The one choke point covering every path where server-committed changes became locally
      // durable (flush echoes, broadcasts, catchup, merges).
      const newlyDurable = changes.filter(c => c.rev > priorRev);
      if (newlyDurable.length > 0) this.patches.onServerCommit.emit(docId, newlyDurable);
    }
  }

  /**
   * Replace committed changes that have earned the skip floor with ops-less copies of
   * themselves, so the rest of the batch can apply.
   *
   * A committed change that fails strict apply deterministically latches the document on every
   * device forever: the recovery reload succeeds, the next catch-up re-delivers the change, and
   * it throws again. `applyChanges` refuses to skip for good reason (see its doc) — a client
   * that silently drops a change every other client applies diverges with zero signal. That
   * reasoning inverts once an authoritative snapshot has been installed and the SAME change
   * still fails: the history, not this replica, is what can't be applied, and the server itself
   * skips such a change when it replays committed history (`applyChangesForReconstruction`), so
   * skipping is what converges with server truth. `POISON_SKIP_FLOOR` + `reloadedSince` is the
   * evidence bar for that conclusion.
   *
   * Neutered rather than removed: the batch must stay rev-contiguous (the algorithms reject a
   * gapped committed batch) and the id must survive to confirm any pending copy, so an ops-less
   * copy is the exact shape of "applied, changed nothing" — leaving local state equal to what
   * `applyChangesForReconstruction` computes over the same history. The neutered change is what
   * gets persisted, so a later rebuild from the store can't resurrect the failure.
   */
  private _skipFlooredPoison(docId: string, changes: Change[], staged: CommittedPoisonSkippedError[]): Change[] {
    const memo = this._committedApplyFailures.get(docId);
    if (!memo?.size) return changes;
    let skipped: Change[] | undefined;
    for (let i = 0; i < changes.length; i++) {
      const entry = memo.get(changes[i].id);
      if (!entry || !isFlooredPoison(entry)) continue;
      skipped ??= changes.slice();
      skipped[i] = this._neuterPoison(docId, changes[i], entry.error, staged);
    }
    return skipped ?? changes;
  }

  /**
   * Materialize the snapshot `_reloadDocFromServer` just installed, skipping any committed
   * change in the server's own envelope that cannot apply, and re-installing the repaired
   * envelope so the store holds only appliable history.
   *
   * This is the recovery of last resort: the reload IS the fallback for an apply failure, so a
   * snapshot whose own committed tail won't materialize leaves nothing else to try — every
   * retry re-fetches identical bytes and the document latches forever (which is what it did
   * before this). The evidence bar the sync path spends two strikes establishing is met here by
   * construction: both the base state and the changes came straight from the server this
   * instant, so a change that fails against them is unappliable against authoritative truth —
   * precisely the condition under which the server replays with `applyChangesForReconstruction`.
   *
   * Bounded: a snapshot needing more than a handful of repairs is damaged beyond what skipping
   * can honestly recover, so the error propagates and the doc latches as before.
   *
   * Probe-and-repair one change at a time, rather than collecting the whole skip set in a single
   * `applyChangesForReconstruction` pass: `loadDoc` is the only oracle for what the store will
   * actually replay, and the shipped stores don't agree on it (`OTIndexedDBStore` drops committed
   * rows at or below the snapshot rev, `OTInMemoryStore` replays every row it was handed), so a
   * reconstruction pass here would neuter changes on a model the store may not share — losing ops
   * it would have applied. The cost is one committed-envelope rewrite per repair, capped by
   * `MAX_SNAPSHOT_REPAIRS`, on a document that currently cannot be opened at all.
   */
  private async _loadRepairedSnapshot(
    docId: string,
    algorithm: ClientAlgorithm,
    installed: PatchesSnapshot
  ): Promise<PatchesSnapshot | undefined> {
    const staged: CommittedPoisonSkippedError[] = [];
    for (let repairs = 0; ; repairs++) {
      let loaded: PatchesSnapshot | undefined;
      try {
        loaded = await algorithm.loadDoc(docId);
      } catch (err) {
        const changes = installed.changes;
        // Absent on older/LWW transports (see `_reloadDocFromServer`) — nothing to repair.
        if (!changes) throw err;
        const index =
          err instanceof ApplyChangesError && repairs < MAX_SNAPSHOT_REPAIRS
            ? changes.findIndex(change => change.id === err.changeId)
            : -1;
        if (index === -1) throw err;
        changes[index] = this._neuterPoison(docId, changes[index], err as ApplyChangesError, staged);
        await algorithm.store.saveDoc(docId, installed);
        continue;
      }
      this._reportSkippedPoison(docId, staged);
      return loaded;
    }
  }

  /**
   * Reduce a committed change to a no-op copy of itself — the shape of "applied, changed
   * nothing" — and stage its report for `_reportSkippedPoison`. Recorded as floored so every
   * later delivery of the same change skips it without re-earning the strikes.
   */
  private _neuterPoison(
    docId: string,
    change: Change,
    error: ApplyChangesError,
    staged: CommittedPoisonSkippedError[]
  ): Change {
    const entry = this._poisonEntry(docId, change.id, error);
    entry.failures = Math.max(entry.failures, POISON_SKIP_FLOOR);
    entry.reloadedSince = true;
    if (!entry.surfaced) staged.push(new CommittedPoisonSkippedError(docId, change.id, change.rev, entry.error));
    return { ...change, ops: [] };
  }

  /**
   * Report staged skips, exactly once per `(docId, changeId)` — only ever called once the
   * neutered batch is durable. Reporting at neuter time instead would assert a skip that a
   * later failure in the same batch rolls back: nothing persisted, the doc stays latched with
   * the raw poison still in its store, and `surfaced` guarantees no second report ever corrects
   * the record a repair sweep reads.
   */
  private _reportSkippedPoison(docId: string, staged: CommittedPoisonSkippedError[]): void {
    for (const skipped of staged) {
      const entry = this._committedApplyFailures.get(docId)?.get(skipped.changeId);
      if (entry?.surfaced) continue;
      if (entry) entry.surfaced = true;
      console.error(skipped.message, skipped.cause);
      this.onError.emit(skipped, { docId });
    }
  }

  /**
   * Record a committed change that failed strict apply, for `_skipFlooredPoison`'s floor.
   * Ignores a failure naming something outside the batch we handed over — the algorithms also
   * materialize PENDING changes on this path, and a pending change that won't apply is the
   * quarantine/ejection path's business, not this one.
   */
  private _recordCommittedApplyFailure(docId: string, changes: Change[], error: ApplyChangesError): void {
    if (!changes.some(change => change.id === error.changeId)) return;
    this._poisonEntry(docId, error.changeId, error).failures++;
  }

  /** Get-or-create this change's memo entry, evicting past the per-doc bound. */
  private _poisonEntry(docId: string, changeId: string, error: ApplyChangesError): PoisonMemoEntry {
    let memo = this._committedApplyFailures.get(docId);
    if (!memo) this._committedApplyFailures.set(docId, (memo = new Map()));
    const existing = memo.get(changeId);
    if (existing) {
      existing.error = trimApplyError(error);
      return existing;
    }
    const entry: PoisonMemoEntry = {
      failures: 0,
      reloadedSince: false,
      surfaced: false,
      error: trimApplyError(error),
    };
    memo.set(changeId, entry);
    if (memo.size > MAX_POISON_MEMO_ENTRIES) {
      // Oldest-first would evict the floored change itself — it is normally the first-seen entry
      // on the doc, being what started the trouble. Losing it re-latches the doc and re-reports a
      // skip this memo promises to report once, so a decided entry is the last thing to go.
      const victim = [...memo].find(([, e]) => !isFlooredPoison(e))?.[0] ?? memo.keys().next().value;
      if (victim !== undefined) memo.delete(victim);
    }
    return entry;
  }

  /**
   * Mark the doc's recorded apply failures as having survived an authoritative snapshot — the
   * half of the floor that distinguishes "this replica drifted" (which the reload just fixed)
   * from "the history is unappliable".
   *
   * Strikes racked up BEFORE this reload say nothing about the state now installed, and the
   * ordinary broadcast path racks them up without one: a commit is delivered more than once by
   * design (SSE broadcast + HTTP ack, re-broadcast, catch-up overlap, the reload drain), and
   * each delivery fails against the same unchanged local state. Counting those would skip a
   * change that had never once been tried against authoritative state — the drifted-replica
   * case the reload exists to fix losslessly. So they are clamped below the floor: at least one
   * failure must land ON TOP of the new snapshot. An entry already past the floor is left alone
   * — that decision was made on post-reload evidence, and re-opening it would send the doc back
   * around the latch loop.
   */
  private _markPoisonReloaded(docId: string): void {
    const memo = this._committedApplyFailures.get(docId);
    if (!memo) return;
    for (const entry of memo.values()) {
      if (!isFlooredPoison(entry)) entry.failures = Math.min(entry.failures, POISON_SKIP_FLOOR - 1);
      entry.reloadedSince = true;
    }
  }

  /**
   * Initiates the deletion process for a document both locally and on the server.
   * This now delegates the local tombstone marking to Patches.
   */
  protected async _handleDocDeleted(docId: string): Promise<void> {
    // Attempt server delete whenever a send can go out (deleteDoc is a plain request
    // on send-independent transports — it doesn't need the push stream).
    if (this._canSend()) {
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

    // Preserve syncing state if moving from connecting -> connected (and while
    // connecting). On a stream-bound transport a definitive drop resets to
    // 'unsynced' — sends are blocked until reconnect. On a send-independent
    // transport the drop branch fires on EVERY failed reconnect attempt (the
    // transport retries forever, backoff capped ~30s), and sends are unaffected —
    // resetting here would flap global status unsynced↔synced on that cadence for
    // every stream-blocked client, so the status is preserved instead.
    const newSyncStatus: DocSyncStatus =
      isConnected || isConnecting || this.connection.sendRequiresStream === false
        ? this.state.syncStatus // Preserve
        : 'unsynced'; // Reset

    this.updateState({ connected: isConnected, syncStatus: newSyncStatus });

    if (isConnected) {
      // Fresh connection session: syncAllKnownDocs below re-attempts every doc, so
      // drop the old retry ladders and let a still-failing doc surface once more.
      // (On WS the drop side already cleared these; on REST the drop deliberately
      // doesn't — see the else branch.)
      this._clearAllSyncRetries();
      // The stream is up — live pushes resume; the degraded-mode pass hands off here.
      this._clearDegradedSync();
      // A resumed stream (opened with a cursor) trusts the server's replay for the gap and
      // only flushes local pending; a cold connect re-syncs everything. The transport is the
      // authority: `resumedStream` is true only for a stream actually opened with the cursor,
      // and a server `resync` re-anchor clears it, so that follow-up `connected` full-syncs.
      const resume = this.connection.resumedStream ?? false;
      void this.syncAllKnownDocs({ resume });
    } else if (!isConnecting) {
      if (this.connection.sendRequiresStream !== false) {
        // Sends ride the stream, so they're blocked now. Drop pending retries — the
        // next reconnect's syncAllKnownDocs re-syncs everything — and reset any
        // stale 'syncing' statuses.
        this._clearAllSyncRetries();
        this._resetSyncingStatuses();
      }
      // Send-independent transport: a stream drop doesn't touch the send path, and
      // this branch fires on every failed reconnect attempt (~30s). Wiping the retry
      // ladders here would also wipe the error-surfacing dedup, re-emitting a latched
      // per-doc error (e.g. a 403) to console/telemetry every cycle; and resetting
      // per-doc 'syncing' would kick docs whose REST syncs are still legitimately in
      // flight. Keep sync state intact and just keep the degraded pass armed.
      // Scheduled (not run immediately) so a quick transport reconnect wins the race
      // and cancels it; a genuinely blocked stream gets its first pass within ~30s.
      this._scheduleDegradedSync();
    }
  }

  protected async _handleDocsTracked(docIds: string[], algorithmName?: AlgorithmName) {
    const newIds = docIds.filter(id => !this.trackedDocs.has(id));
    if (!newIds.length) return;

    // Snapshot current subscriptions before adding new docs
    const alreadySubscribed = this._getActiveSubscriptions();

    newIds.forEach(id => {
      this.trackedDocs.add(id);
      // A doc untracked then re-tracked inside one resync window must not keep its
      // untracked mark: syncAllKnownDocs' merge treats the set as "untracked during the
      // window and still untracked", and a stale mark there excludes the doc's fresh
      // store entry from the rebuilt docStates — the doc would silently stop syncing
      // until the next reconnect.
      this._untrackedDuringResync?.delete(id);
    });

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
        // Skip docs untracked while we were reading their stores above
        if (!this.trackedDocs.has(docId)) continue;
        this._initDocSyncState(docId, {
          committedRev,
          hasPending,
          syncStatus: committedRev === 0 ? 'unsynced' : 'synced',
        });
      }
    });

    if (this._canSend()) {
      // Subscriptions belong to an open stream (the server rejects them without one),
      // so only attempt them while connected; a degraded-mode sync still runs below.
      if (this.state.connected) {
        try {
          // Only subscribe to IDs not already covered by existing subscriptions
          const subscribeIds = this._filterSubscribeIds(newIds).filter(id => !alreadySubscribed.has(id));
          if (subscribeIds.length) {
            // Granted subset only — see the same pattern in syncAllKnownDocs (DAB-865).
            const granted = (await this.connection.subscribe(subscribeIds)) ?? [];
            granted.forEach(id => this._subscribedIds.add(id));
          }
        } catch (err) {
          // A failed subscribe must not skip the initial sync below — a doc with offline
          // pending changes would never send them (nothing retries a skipped syncDoc).
          console.warn(`Failed to subscribe newly tracked docs: ${newIds.join(', ')}`, err);
          this.onError.emit(err as Error);
        }
      }
      // Trigger sync for newly tracked docs immediately. Per-doc failures are handled
      // inside syncDoc (retry/backoff), so this never rejects.
      await Promise.all(newIds.map(id => this.syncDoc(id)));
    }
  }

  protected async _handleDocsUntracked(docIds: string[]) {
    const existingIds = docIds.filter(id => this.trackedDocs.has(id));
    if (!existingIds.length) return;

    // Snapshot current subscriptions before removing docs
    const subscribedBefore = this._getActiveSubscriptions();

    existingIds.forEach(id => {
      this.trackedDocs.delete(id);
      this._untrackedDuringResync?.add(id);
      this._clearSyncRetry(id);
      this._surfacedSyncErrors.delete(id);
      this._resplitBudgets.delete(id);
      this._committedApplyFailures.delete(id);
    });
    batch(() => {
      existingIds.forEach(id => this._updateDocSyncState(id, undefined));
    });

    // Only unsubscribe from subscriptions no longer needed by any remaining tracked doc
    const subscribedAfter = this._getActiveSubscriptions();
    const unsubscribeIds = [...subscribedBefore].filter(id => !subscribedAfter.has(id));

    if (this.state.connected && unsubscribeIds.length) {
      try {
        await this.connection.unsubscribe(unsubscribeIds);
        unsubscribeIds.forEach(id => this._subscribedIds.delete(id));
      } catch (err) {
        console.warn(`Failed to unsubscribe docs: ${unsubscribeIds.join(', ')}`, err);
      }
    }
  }

  protected _handleDocChange(docId: string): void {
    if (!this.trackedDocs.has(docId)) return;
    this._initDocSyncState(docId, { hasPending: true });
    if (!this._canSend()) return;
    this.syncDoc(docId);
  }

  /**
   * Unified handler for remote document deletion (both real-time notifications and offline discovery).
   * Cleans up local state and notifies the application with any pending changes that were lost.
   */
  protected async _handleRemoteDocDeleted(docId: string): Promise<void> {
    const algorithm = this._getAlgorithm(docId);

    // Get pending changes before cleanup so app can handle them
    const pendingChanges =
      (await algorithm.getPendingToSend(docId, this.patches.getOpenDoc(docId) as PatchesDoc<any>)) ?? [];

    // Close doc if open
    const doc = this.patches.getOpenDoc(docId);
    if (doc) {
      await this.patches.closeDoc(docId);
    }

    // Clean up tracking and local storage
    this.trackedDocs.delete(docId);
    this._untrackedDuringResync?.add(docId);
    this._clearSyncRetry(docId);
    this._surfacedSyncErrors.delete(docId);
    this._resplitBudgets.delete(docId);
    this._committedApplyFailures.delete(docId);
    this._updateDocSyncState(docId, undefined);
    await algorithm.confirmDeleteDoc(docId);

    // Notify application (with any pending changes that were lost). Awaited so an app that
    // shelves those changes has landed the write before we proceed, but bounded: subscribers
    // are app code running inside this doc's sync gate, and one that never settles would wedge
    // the doc permanently. On expiry, say so loudly and carry on.
    await this._emitRemoteDocDeleted(docId, pendingChanges);
  }

  /** Emits `onRemoteDocDeleted`, bounded by {@link REMOTE_DOC_DELETED_EMIT_TIMEOUT_MS}. */
  private async _emitRemoteDocDeleted(docId: string, pendingChanges: Change[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), REMOTE_DOC_DELETED_EMIT_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([this.onRemoteDocDeleted.emit(docId, pendingChanges), timeout]);
      if (result === 'timeout') {
        console.error(
          `onRemoteDocDeleted subscribers for doc ${docId} did not settle within ` +
            `${REMOTE_DOC_DELETED_EMIT_TIMEOUT_MS}ms; proceeding without them. ` +
            `${pendingChanges.length} pending change(s) may not have been shelved.`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Updates or removes a doc state entry immutably and notifies via store.
   * - Pass a Partial<DocSyncState> to merge into an existing entry. No-ops when the doc
   *   has no entry, so a late write from an in-flight sync can't resurrect an entry for
   *   a doc that was untracked or deleted while the request was in the air.
   * - Pass undefined to remove the entry.
   * Creation is explicit via `_initDocSyncState`.
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
      if (!(docId in currentDocs)) return;
      this._setDocSyncState(docId, updates);
    }
  }

  /**
   * Creates a doc state entry (merging into any existing one) for a doc known to be
   * tracked. Callers must be synchronous with a `trackedDocs.has(docId)` check —
   * creation from an async continuation is exactly what `_updateDocSyncState`'s
   * no-op-when-absent behavior exists to prevent.
   */
  protected _initDocSyncState(docId: string, state: Partial<DocSyncState>): void {
    this._setDocSyncState(docId, state);
  }

  private _setDocSyncState(docId: string, updates: Partial<DocSyncState>): void {
    const currentDocs = this.docStates.state;
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

  /**
   * A 409 the server scoped to the whole doc: the submission is unusable against the doc's
   * current history (a stale baseRev-0 continuation, or a baseRev ahead of the server head)
   * and resending it verbatim can never succeed — only a reload re-bases the queue onto the
   * doc's real history.
   */
  protected _isStaleDocError(err: unknown): boolean {
    return err instanceof StatusError && err.code === 409 && err.data?.scope === 'doc';
  }

  /** Retryable = any failure except a definitive auth/payment/permission/not-found/gone StatusError. */
  protected _isRetryableSyncError(err: unknown): boolean {
    // An op with no seam to split on measures the same every time; the ladder would just burn
    // attempts before latching on the identical error.
    if (isUnsplittableChangeError(err)) return false;
    // A 413 the server scoped to ONE change is deterministic on those bytes. By the time it
    // reaches this decision, `_tryResplitOversized` has already declined to shrink further
    // (no split budget configured, or the budget is at its floor), so the ladder would resend
    // the identical request. Latch like the splitter-refused case above; the slow reprobe and
    // any local edit still re-enter sync if the queue ever changes shape.
    if (err instanceof StatusError && err.code === 413 && err.data?.scope === 'change') return false;
    if (err instanceof StatusError) return !TERMINAL_SYNC_CODES.has(err.code);
    return true;
  }

  /**
   * The server refused ONE change as too large (413 scope:'change'). Our split budget is a client
   * estimate of what the backend stores; when it estimates high, halve this doc's budget and flush
   * again so the same edit goes up in smaller pieces. Bounded by {@link MIN_RESPLIT_STORAGE_BYTES}
   * so a 413 that isn't really about size latches the doc instead of looping.
   *
   * Only halves a budget the consumer configured: with no `maxStorageBytes` nothing splits at all,
   * and inventing one here would start re-cutting changes for a consumer that never asked.
   */
  private _tryResplitOversized(docId: string, failure: unknown): boolean {
    if (!(failure instanceof StatusError) || failure.code !== 413 || failure.data?.scope !== 'change') return false;
    if (!this.maxStorageBytes) return false;
    const current = this._resplitBudgets.get(docId) ?? this.maxStorageBytes;
    if (current <= MIN_RESPLIT_STORAGE_BYTES) return false;
    const next = Math.max(MIN_RESPLIT_STORAGE_BYTES, Math.floor(current / 2));
    this._resplitBudgets.set(docId, next);
    this._clearSyncRetry(docId);
    this._surfacedSyncErrors.delete(docId);
    const changeId = typeof failure.data.changeId === 'string' ? failure.data.changeId : '(unnamed)';
    console.warn(`Server refused change ${changeId} on doc ${docId} as too large; re-splitting at ${next} bytes`);
    // We are inside syncDoc's serialGate run, so this queues exactly one follow-up pass.
    void this.syncDoc(docId);
    return true;
  }

  /**
   * Eject the pending change a 4xx rejection names via `data: { changeId, scope: 'change' }`,
   * when the local strict-apply probe corroborates the server's attribution (see
   * docs/quarantine.md for the full contract and safety gates). Returns true when the doc
   * recovered this way; never throws, since an ejection failure falls back to the ordinary
   * error latch.
   */
  private async _tryEjectPoisonChange(docId: string, algorithm: ClientAlgorithm, failure: unknown): Promise<boolean> {
    try {
      if (!(failure instanceof StatusError) || failure.code < 400 || failure.code >= 500) return false;
      const data = failure.data;
      if (!data || typeof data.changeId !== 'string' || data.scope !== 'change') return false;
      if (!algorithm.verifyPendingChange || !algorithm.ejectPendingChange) return false;
      const ejections = this._ejectionCounts.get(docId) ?? 0;
      if (ejections >= MAX_DOC_EJECTIONS) return false;
      if (await algorithm.verifyPendingChange(docId, data.changeId)) return false;
      // onlyIfUnappliable: the probe above released its lock, so the algorithm must
      // re-corroborate atomically with the ejection — a broadcast in the gap can rebase
      // the queue and make the change valid again.
      const quarantined = await algorithm.ejectPendingChange(
        docId,
        data.changeId,
        failure.message,
        this.patches.getOpenDoc(docId),
        { onlyIfUnappliable: true }
      );
      if (!quarantined) return false;
      this._ejectionCounts.set(docId, ejections + 1);
      this._clearSyncRetry(docId);
      this._surfacedSyncErrors.delete(docId);
      console.warn(`Ejected unsyncable change ${data.changeId} from doc ${docId} into quarantine:`, failure);
      // Persisted entries were already re-surfaced at syncDoc entry; emit just the fresh one.
      this.patches.onChangeQuarantined.emit(docId, quarantined);
      // Re-enter sync for the surviving pending work. We are inside syncDoc's serialGate
      // run, so this queues exactly one follow-up after the current run returns.
      void this.syncDoc(docId);
      return true;
    } catch (ejectErr) {
      console.error(`Failed to eject change from doc ${docId}; falling back to the error latch:`, ejectErr);
      return false;
    }
  }

  /**
   * Emit persisted quarantine entries on a doc's first sync attempt each session so a
   * restart can't strand them un-surfaced. Fire-and-forget: a store read failure here
   * must not fail the sync that triggered it.
   */
  private _resurfaceQuarantined(docId: string, algorithm: ClientAlgorithm): void {
    if (this._quarantineResurfaced.has(docId) || !algorithm.listQuarantinedChanges) return;
    this._quarantineResurfaced.add(docId);
    algorithm
      .listQuarantinedChanges(docId)
      .then(entries => {
        for (const entry of entries) this.patches.onChangeQuarantined.emit(docId, entry);
      })
      .catch(() => undefined);
  }

  /**
   * Whether an outbound request can be attempted right now. On a transport whose
   * sends ride the push channel (WebSocket), that requires the connection to be up —
   * exactly the old gate. On a send-independent transport (REST/SSE) the stream only
   * gates *receiving* live pushes, never sending (DAB-831) — but that leg additionally
   * requires `_started` (connect() called, disconnect() not), because with `connected`
   * out of the equation the intent flag is the only thing that lets an explicit
   * disconnect/destroy actually stop the send path. The `=== false` polarity is
   * deliberate: an un-migrated implementer that doesn't declare `sendRequiresStream`
   * gets the conservative stream-bound behavior. This also governs the retry/reprobe
   * ladders: while online with the stream blocked on REST, no reconnect resync is
   * coming, so retries must keep running here instead of deferring to it.
   */
  protected _canSend(): boolean {
    if (onlineState.isOffline) return false;
    return this.state.connected || (this._started && this.connection.sendRequiresStream === false);
  }

  /**
   * The stable non-'error' posture for a doc — the same rule `_resetSyncingStatuses`
   * applies on disconnect: 'synced' when the doc has local data (`hasPending` still
   * marks any unsent work), 'unsynced' for a brand-new doc with nothing yet.
   * `pending` (when the caller carried some) also counts as local data:
   * docStates.hasPending can lag the store (only a completed flush refreshes it),
   * but a failed flush proves the pending exists.
   */
  private _stableDocStatus(docId: string, pending?: Change[] | null): DocSyncStatus {
    const entry = this.docStates.state[docId];
    const hasLocalData = (pending?.length ?? 0) > 0 || !!entry?.hasPending || (entry?.committedRev ?? 0) > 0;
    return hasLocalData ? 'synced' : 'unsynced';
  }

  /**
   * Recovery path for a sync attempt that died from a status-less interruption — a
   * network-level failure ({@link isNetworkError}: fetch rejected without an HTTP
   * response, request timeout, transport with no live connection) or a cancelled
   * request/transaction ({@link isAbortError}: page/worker teardown mid-sync,
   * IndexedDB abort under storage pressure). Neither is a verdict on the document,
   * so the doc is parked in the stable waiting-for-connection posture — never
   * per-doc 'error' — and recovery stays with the existing machinery: the
   * backed-off retry ladder while attempts remain, then the slow background
   * re-probe. The probe is armed even with nothing pending, unlike the
   * latched-'error' path: the connection can still read up while requests fail
   * (SSE alive, or a half-open stream the watchdog hasn't caught yet), and then no
   * reconnect resync is coming to re-attempt the pull — without the probe the doc
   * would neither probe nor recover. When disconnected/offline both schedulers
   * decline and the reconnect's `syncAllKnownDocs` owns recovery — the existing
   * offline path.
   *
   * Surfacing: network-class failures stay quiet at every stage — the connection
   * state is their user-facing signal, and one unreachable server would otherwise
   * emit for every tracked doc. A persistent abort is different: aborts come from
   * teardown (which kills these timers with the context) or storage pressure, so
   * one that outlives the full ladder while connected+online is a real environment
   * problem telemetry should hear about — exactly once, mirroring the
   * exhausted-transient contract, still without painting the doc.
   */
  private _deferDocToConnectionRecovery(
    docId: string,
    baseDoc: BaseDoc | undefined,
    pending: Change[] | null | undefined,
    failure: Error
  ): void {
    const stable = this._stableDocStatus(docId, pending);
    this._updateDocSyncState(docId, { syncStatus: stable });
    baseDoc?.updateSyncStatus(stable);
    if (this._scheduleSyncRetry(docId)) return;
    this._clearSyncRetry(docId);
    if (isAbortError(failure) && this._canSend() && !this._surfacedSyncErrors.has(docId)) {
      this._surfacedSyncErrors.add(docId);
      console.error(`Aborted request persisted past retries while syncing doc ${docId}:`, failure);
      this.onError.emit(failure, { docId });
    }
    this._scheduleSyncReprobe(docId, true);
  }

  /**
   * Schedule a backed-off re-sync of a doc that failed transiently, while connected.
   * Returns true if a retry was scheduled, false if it declined — either because we're
   * disconnected/offline (the reconnect's `syncAllKnownDocs` will recover the doc), or
   * because the per-doc attempt cap is reached. The cap bounds the retry storm for a doc
   * that keeps failing on a non-terminal error while the connection stays up; once it's
   * hit, `syncDoc` surfaces the error and the doc latches until the next external trigger
   * (a local edit, untrack, or reconnect) re-arms it from a clean slate.
   */
  protected _scheduleSyncRetry(docId: string): boolean {
    if (!this._canSend()) return false;
    const attempts = this._syncRetryAttempts.get(docId) ?? 0;
    if (attempts >= SYNC_RETRY_MAX_ATTEMPTS) return false;
    const delay = Math.min(SYNC_RETRY_BASE_MS * 2 ** attempts, SYNC_RETRY_MAX_MS);
    this._syncRetryAttempts.set(docId, attempts + 1);
    const existing = this._syncRetryTimers.get(docId);
    if (existing !== undefined) globalThis.clearTimeout(existing);
    const timer = globalThis.setTimeout(() => {
      this._syncRetryTimers.delete(docId);
      if (!this._canSend() || !this.trackedDocs.has(docId)) return;
      void this.syncDoc(docId);
    }, delay);
    this._syncRetryTimers.set(docId, timer);
    return true;
  }

  /**
   * Schedule a slow background re-probe for a doc the fast retry ladder gave up on
   * while the connection stayed up: a doc latched at 'error' with pending changes, or
   * a doc parked for connection recovery after a network-class failure (see
   * `_deferDocToConnectionRecovery`). Neither the exhausted ladder nor a reconnect
   * will touch the doc again, so without this the only recovery is a local edit.
   * The probe re-enters the normal `syncDoc` path with a fresh retry ladder;
   * if that fails again the ladder/probe cycle repeats. Exhausted transient failures
   * re-probe sooner than definitive rejections, which only heal via a server-side
   * policy change. One timer per doc; cleared alongside the fast retry state on
   * success, untrack, delete, and true disconnect (a reconnect re-arms only through
   * `syncAllKnownDocs` re-attempting the doc — never from here). A transient
   * `connecting` flap leaves the timer pending; it self-bails at fire time when it
   * finds the connection down rather than being cleared up front.
   */
  protected _scheduleSyncReprobe(docId: string, retryable: boolean): void {
    if (!this._canSend() || !this.trackedDocs.has(docId)) return;
    const delay = jitterReprobeDelay(retryable ? SYNC_REPROBE_EXHAUSTED_MS : SYNC_REPROBE_TERMINAL_MS);
    const existing = this._syncReprobeTimers.get(docId);
    if (existing !== undefined) globalThis.clearTimeout(existing);
    const timer = globalThis.setTimeout(() => {
      this._syncReprobeTimers.delete(docId);
      if (!this._canSend() || !this.trackedDocs.has(docId)) return;
      void this.syncDoc(docId);
    }, delay);
    this._syncReprobeTimers.set(docId, timer);
  }

  protected _clearSyncRetry(docId: string): void {
    const timer = this._syncRetryTimers.get(docId);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      this._syncRetryTimers.delete(docId);
    }
    this._syncRetryAttempts.delete(docId);
    const reprobe = this._syncReprobeTimers.get(docId);
    if (reprobe !== undefined) {
      globalThis.clearTimeout(reprobe);
      this._syncReprobeTimers.delete(docId);
    }
  }

  protected _clearAllSyncRetries(): void {
    for (const timer of this._syncRetryTimers.values()) globalThis.clearTimeout(timer);
    this._syncRetryTimers.clear();
    this._syncRetryAttempts.clear();
    for (const timer of this._syncReprobeTimers.values()) globalThis.clearTimeout(timer);
    this._syncReprobeTimers.clear();
    // A reconnect re-attempts every doc; let a still-failing one surface once more.
    this._surfacedSyncErrors.clear();
  }
}
