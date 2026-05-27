import { type Unsubscriber, signal } from 'easy-signal';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot } from '../types.js';
import { singleInvocation } from '../utils/concurrency.js';
import type { BaseDoc } from './BaseDoc.js';
import type { ClientAlgorithm } from './ClientAlgorithm.js';
import type { PatchesDoc, PatchesDocOptions } from './PatchesDoc.js';
import type { AlgorithmName } from './PatchesStore.js';

/**
 * Options for opening a document, passed through to `patches.openDoc()`.
 */
export interface OpenDocOptions {
  /** Optional metadata to attach to the document. */
  metadata?: Record<string, any>;
  /** Override the algorithm for this document (defaults to the Patches instance default). */
  algorithm?: AlgorithmName;
}

/**
 * Options for creating a Patches instance.
 * Provides algorithms map and optional default algorithm.
 */
export interface PatchesOptions {
  /** Map of algorithm name to algorithm instance. Each algorithm owns its store. */
  algorithms: Partial<Record<AlgorithmName, ClientAlgorithm>>;
  /** Default algorithm to use when opening docs. Must be a key in algorithms map. */
  defaultAlgorithm?: AlgorithmName;
  /** Initial metadata to attach to changes from this client (merged with per-doc metadata). */
  metadata?: Record<string, any>;
  /** Document-level options to pass to each PatchesDoc instance */
  docOptions?: PatchesDocOptions;
}

// Internal doc management structure
interface ManagedDoc<T extends object> {
  doc: PatchesDoc<T>;
  algorithm: ClientAlgorithm;
  unsubscribe: Unsubscriber;
}

/**
 * Main client-side entry point for the Patches library.
 * Manages document instances (`PatchesDoc`) and coordinates with algorithms.
 * Can be used standalone or with PatchesSync for network synchronization.
 *
 * Patches owns docs. Algorithms own their stores.
 */
export class Patches {
  protected options: PatchesOptions;
  protected docs: Map<string, ManagedDoc<any>> = new Map();
  private _changeQueues: Map<string, Promise<void>> = new Map();
  /** Doc IDs whose openDoc() body is currently in flight (between createDoc and this.docs.set). */
  private _openingDocs: Set<string> = new Set();
  /** Single-slot, latest-wins snapshot stash for docs in `_openingDocs`. Drained on open completion. */
  private _openingSnapshots: Map<string, PatchesSnapshot> = new Map();
  /**
   * Promises for in-flight openDoc() calls, awaited by close() so it can't tear down
   * algorithm/store state while an open is still resolving — which would otherwise let
   * the resolving open call this.docs.set against an already-cleared map with a doc
   * bound to closed algorithm internals.
   */
  private _openingPromises: Map<string, Promise<unknown>> = new Map();

  readonly docOptions: PatchesDocOptions;
  readonly algorithms: Partial<Record<AlgorithmName, ClientAlgorithm>>;
  readonly defaultAlgorithm: AlgorithmName;
  readonly trackedDocs = new Set<string>();

  // Public signals
  readonly onError = signal<(error: Error, context?: { docId?: string }) => void>();
  readonly onServerCommit = signal<(docId: string, changes: Change[]) => void>();
  readonly onTrackDocs = signal<(docIds: string[], algorithmName: AlgorithmName) => void>();
  readonly onUntrackDocs = signal<(docIds: string[]) => void>();
  readonly onDeleteDoc = signal<(docId: string) => void>();
  /** Emitted when a doc has pending changes ready to send */
  readonly onChange = signal<(docId: string) => void>();

  constructor(opts: PatchesOptions) {
    this.options = opts;
    this.algorithms = opts.algorithms;

    // Determine default algorithm
    const algorithmNames = Object.keys(opts.algorithms) as AlgorithmName[];
    if (algorithmNames.length === 0) {
      throw new Error('At least one algorithm must be provided');
    }
    this.defaultAlgorithm = opts.defaultAlgorithm ?? algorithmNames[0];
    if (!opts.algorithms[this.defaultAlgorithm]) {
      throw new Error(`Default algorithm '${this.defaultAlgorithm}' not found in algorithms map`);
    }

    this.docOptions = opts.docOptions ?? {};

    // Load tracked docs from all algorithm stores
    this.init();
  }

  /**
   * Loads tracked docs from all registered algorithm stores.
   * Extracted as a protected method so subclasses can override initialization behavior.
   */
  protected init(): void {
    const entries = Object.entries(this.algorithms).filter(([, a]) => Boolean(a)) as [AlgorithmName, ClientAlgorithm][];
    Promise.all(
      entries.map(([name, algorithm]) =>
        algorithm.listDocs().then(docs => {
          this.trackDocs(
            docs.map(({ docId }) => docId),
            name
          );
        })
      )
    ).catch(err => {
      console.error('Failed to load tracked docs during initialization:', err);
    });
  }

  /**
   * Gets an algorithm by name, throwing if not found.
   */
  protected _getAlgorithm(name: AlgorithmName): ClientAlgorithm {
    const algorithm = this.algorithms[name];
    if (!algorithm) {
      throw new Error(`Algorithm '${name}' not found`);
    }
    return algorithm;
  }

  /**
   * Gets the algorithm for an open document.
   */
  getDocAlgorithm(docId: string): ClientAlgorithm | undefined {
    return this.docs.get(docId)?.algorithm;
  }

  /**
   * Resolves the algorithm that owns a doc's data, including for closed docs.
   *
   * For open docs the answer is `managed.algorithm`. For closed docs we have to scan
   * each algorithm's `listDocs(true)` (mirroring openDoc's algorithm-detection loop)
   * — otherwise `deleteDoc('x')` for a closed doc that was opened with a non-default
   * algorithm would tombstone the wrong store (dropping the actual data on the floor
   * and writing a stranded tombstone in the default algorithm's store).
   * `includeDeleted=true` so we still find the right algorithm when the lookup is for
   * a doc mid-deletion.
   *
   * Precedence on ambiguity: returns the first algorithm whose store claims the docId,
   * iterated in `Object.values(this.algorithms)` insertion order. A docId should live
   * in exactly one algorithm; if multiple stores claim the same id (e.g. partial
   * migration), the algorithm passed first to the Patches constructor wins.
   *
   * Falls back to defaultAlgorithm only when no algorithm claims the docId — used by
   * deleteDoc on truly-new IDs (rare) so we still tombstone somewhere consistent.
   */
  protected async _resolveAlgorithmForDoc(docId: string): Promise<ClientAlgorithm> {
    const managed = this.docs.get(docId);
    if (managed) return managed.algorithm;
    for (const algo of Object.values(this.algorithms) as ClientAlgorithm[]) {
      const docs = await algo.listDocs(true);
      if (docs.some(d => d.docId === docId)) return algo;
    }
    return this._getAlgorithm(this.defaultAlgorithm);
  }

  // --- Public API Methods ---

  /**
   * Tracks the given document IDs, adding them to the set of tracked documents and notifying listeners.
   * Tracked docs are kept in sync with the server, even when not open locally.
   * This allows for background syncing and updates of unopened documents.
   * @param docIds - Array of document IDs to track.
   * @param algorithmName - Algorithm to use for tracking (defaults to defaultAlgorithm).
   */
  async trackDocs(docIds: string[], algorithmName?: AlgorithmName): Promise<void> {
    docIds = docIds.filter(id => !this.trackedDocs.has(id));
    if (!docIds.length) return;
    docIds.forEach(this.trackedDocs.add, this.trackedDocs);
    this.onTrackDocs.emit(docIds, algorithmName ?? this.defaultAlgorithm);
    const algorithm = this._getAlgorithm(algorithmName ?? this.defaultAlgorithm);
    await algorithm.trackDocs(docIds);
  }

  /**
   * Untracks the given document IDs, removing them from the set of tracked documents and notifying listeners.
   * Untracked docs will no longer be kept in sync with the server.
   * Closes any open docs and removes them from the store.
   * @param docIds - Array of document IDs to untrack.
   */
  async untrackDocs(docIds: string[]): Promise<void> {
    docIds = docIds.filter(id => this.trackedDocs.has(id));
    if (!docIds.length) return;
    docIds.forEach(this.trackedDocs.delete, this.trackedDocs);
    this.onUntrackDocs.emit(docIds);

    // Capture algorithm mapping BEFORE closing docs (closeDoc removes from this.docs).
    // For closed docs, `_resolveAlgorithmForDoc` scans each algorithm's store rather than
    // defaulting — a closed doc opened on a non-default algorithm must be untracked from
    // the algorithm that actually has its data.
    const byAlgorithm = new Map<ClientAlgorithm, string[]>();
    for (const docId of docIds) {
      const algorithm = await this._resolveAlgorithmForDoc(docId);
      const list = byAlgorithm.get(algorithm) ?? [];
      list.push(docId);
      byAlgorithm.set(algorithm, list);
    }

    // Close any open PatchesDoc instances
    const closedPromises = docIds.filter(id => this.docs.has(id)).map(id => this.closeDoc(id));
    await Promise.all(closedPromises);

    // Untrack from each doc's algorithm
    await Promise.all([...byAlgorithm.entries()].map(([algorithm, ids]) => algorithm.untrackDocs(ids)));
  }

  /**
   * Opens a document by ID, loading its state from the store and setting up change listeners.
   * If the doc is already open, returns the existing instance.
   * @param docId - The document ID to open.
   * @param opts - Optional metadata and algorithm override.
   * @returns The opened PatchesDoc instance.
   */
  @singleInvocation(true) // ensure a second call to openDoc with the same docId returns the same promise while opening
  async openDoc<T extends object>(docId: string, opts: OpenDocOptions = {}): Promise<PatchesDoc<T>> {
    const existing = this.docs.get(docId);
    if (existing) return existing.doc as PatchesDoc<T>;

    // Mark this doc as "opening" so any concurrent applySnapshot() call stashes its
    // snapshot in `_openingSnapshots` instead of dropping it on the floor. Both the
    // opening flag and the stash are cleared in the finally block on every exit —
    // a failed open intentionally drops the stash so a) it can't be drained against
    // a doc that never opened, b) `applySnapshot` doesn't have to handle a stash-but-
    // not-opening state, and c) the broadcaster's next emission will repopulate it.
    this._openingDocs.add(docId);
    // Register a deferred so close() can await the body without us having to pass the
    // openDoc promise to itself. Safe under @singleInvocation(true) — only one body
    // per docId can be in flight, so the map entry is single-writer per key. The
    // resolve fires unconditionally from the finally below.
    let resolveOpening!: () => void;
    this._openingPromises.set(
      docId,
      new Promise<void>(resolve => {
        resolveOpening = resolve;
      })
    );
    // Snapshot whether the doc was already tracked before this open. If openDoc fails
    // after we called trackDocs, we unwind via untrackDocs so the doc isn't left in a
    // "tracked but never opened" zombie state. Skipped when the doc was pre-tracked —
    // we don't want to untrack a subscription that existed before this call.
    const wasTracked = this.trackedDocs.has(docId);
    try {
      // Determine the algorithm for this doc:
      // 1. Use opts.algorithm if explicitly provided
      // 2. Otherwise, check if already tracked and read persisted algorithm
      // 3. Fall back to defaultAlgorithm
      let algorithmName = opts.algorithm;

      if (!algorithmName) {
        // Check all algorithm stores to see if this doc is already tracked
        for (const algo of Object.values(this.algorithms) as ClientAlgorithm[]) {
          const docs = await algo.listDocs(false);
          const tracked = docs.find(d => d.docId === docId);
          if (tracked?.algorithm) {
            algorithmName = tracked.algorithm;
            break;
          }
        }
        algorithmName = algorithmName ?? this.defaultAlgorithm;
      }

      const algorithm = this._getAlgorithm(algorithmName);

      // Ensure the doc is tracked before proceeding
      await this.trackDocs([docId], algorithmName);

      // Load initial state from store via algorithm
      const snapshot = await algorithm.loadDoc(docId);
      const mergedMetadata = { ...this.options.metadata, ...opts.metadata };

      // Create the appropriate doc type via algorithm (now takes docId and snapshot)
      const doc = algorithm.createDoc<T>(docId, snapshot);

      // Wire up flush() so it can await the in-flight change queue for this doc.
      const baseDoc = doc as unknown as BaseDoc<T>;
      baseDoc._setFlushAwaiter(() => this._changeQueues.get(docId));

      // Set up local listener -> algorithm handles packaging ops
      const unsubscribe = doc.onChange(ops => this._handleDocChange(docId, ops, doc, algorithm, mergedMetadata));
      this.docs.set(docId, { doc: doc as PatchesDoc<any>, algorithm, unsubscribe });

      // Drain any snapshot that arrived during the open. Done synchronously after
      // `this.docs.set` so no further applySnapshot calls can stash to the slot.
      // Strict `>` guard: doc.import() unconditionally replaces internal pending-state
      // (OTDoc._pendingChanges, LWWDoc._inFlightOpKeys) from snapshot.changes — calling
      // it at equal rev with the stripped `changes: []` we receive over PatchesSync
      // would wipe legitimate in-flight ops mid-typing. Only fresher snapshots warrant
      // the reset.
      const pending = this._openingSnapshots.get(docId);
      if (pending && pending.rev > baseDoc.committedRev) {
        baseDoc.import(pending as PatchesSnapshot<T>);
      }

      return doc;
    } catch (err) {
      // If we added this doc to the tracked set during this open, unwind the
      // trackDocs side-effects (in-memory set, algorithm.store, onTrackDocs subscribers)
      // so a failed open doesn't leave a tracked-but-unopened doc behind. If untrack
      // itself fails we still rethrow the original openDoc error (it's the actionable
      // one for the caller), but emit the untrack failure via onError so observers can
      // see the zombie state — otherwise the very bug this fix targets recurs silently.
      if (!wasTracked && this.trackedDocs.has(docId)) {
        try {
          await this.untrackDocs([docId]);
        } catch (untrackErr) {
          this.onError.emit(untrackErr as Error, { docId });
        }
      }
      throw err;
    } finally {
      this._openingDocs.delete(docId);
      this._openingSnapshots.delete(docId);
      this._openingPromises.delete(docId);
      resolveOpening();
    }
  }

  /**
   * Applies a snapshot received out-of-band (multi-tab broadcast, WebRTC peer gossip,
   * any server-push pattern that isn't sequenced through openDoc). Handles the open /
   * opening / closed cases consistently so transports don't have to.
   *
   * - **Open** (already in `docs`): imports if `snapshot.rev > doc.committedRev`. Strict
   *   `>` (not `>=`) because doc.import() resets internal pending-state from
   *   snapshot.changes; firing it on every equal-rev duplicate broadcast would wipe
   *   in-flight ops mid-typing.
   * - **Opening** (openDoc in flight): stashes in a single-slot map, keeping the
   *   highest-rev snapshot seen. openDoc drains the slot before resolving so the returned
   *   doc reflects the snapshot.
   * - **Neither**: dropped. Patches doesn't track snapshots for docs it isn't managing.
   *
   * Idempotent. No-op on stale or unknown docs. Never throws.
   */
  applySnapshot<T extends object>(docId: string, snapshot: PatchesSnapshot<T>): void {
    const managed = this.docs.get(docId);
    if (managed) {
      const baseDoc = managed.doc as unknown as BaseDoc<T>;
      if (snapshot.rev > baseDoc.committedRev) {
        baseDoc.import(snapshot);
      }
      return;
    }
    if (this._openingDocs.has(docId)) {
      // Highest-rev wins, not last-write-wins: out-of-order delivery from mesh/peer
      // transports mustn't clobber a higher-rev snapshot with a lower one.
      const existing = this._openingSnapshots.get(docId);
      if (!existing || snapshot.rev > existing.rev) {
        this._openingSnapshots.set(docId, snapshot);
      }
    }
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
      this._changeQueues.delete(docId);
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
    // Resolve algorithm by store membership rather than defaulting. For a closed doc
    // opened on a non-default algorithm, defaulting would tombstone the wrong store
    // (writing a stranded tombstone in the default algorithm while leaving the real
    // data untouched in the other algorithm). Resolved before closeDoc/untrackDocs so
    // a doc that's open right now still wins via `managed.algorithm`.
    const algorithm = await this._resolveAlgorithmForDoc(docId);

    // Close if open locally
    if (this.docs.has(docId)) {
      await this.closeDoc(docId);
    }
    // Unsubscribe from server if tracked (deletes the doc from the store before the next step adds a tombstone)
    if (this.trackedDocs.has(docId)) {
      await this.untrackDocs([docId]);
    }
    // Mark document as deleted in store (adds a tombstone until sync commits it)
    await algorithm.deleteDoc(docId);
    await this.onDeleteDoc.emit(docId);
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
  async close(): Promise<void> {
    // Drain in-flight openDoc() bodies first. Without this, an open resolving after
    // close() cleared the maps would call this.docs.set against an emptied map with
    // a doc bound to closed algorithm internals. allSettled so a failed open during
    // shutdown still lets close() complete cleanly.
    if (this._openingPromises.size > 0) {
      await Promise.allSettled([...this._openingPromises.values()]);
    }

    // Clean up local PatchesDoc listeners
    this.docs.forEach(managed => managed.unsubscribe());
    this.docs.clear();
    this._changeQueues.clear();
    this._openingDocs.clear();
    this._openingSnapshots.clear();

    // Close all algorithms (each closes its store)
    await Promise.all(Object.values(this.algorithms).map(s => s?.close()));

    this.onChange.clear();
    this.onDeleteDoc.clear();
    this.onUntrackDocs.clear();
    this.onTrackDocs.clear();
    this.onServerCommit.clear();
    this.onError.clear();
  }

  /**
   * Submits ops for a document through the serialized change queue.
   * Used by PatchesBranchClient to merge branch changes without racing
   * against concurrent user edits on the same document.
   */
  submitDocChange(docId: string, ops: JSONPatchOp[], metadata: Record<string, any> = {}): Promise<void> {
    const managed = this.docs.get(docId);
    const algorithm = this.getDocAlgorithm(docId) ?? this.algorithms[this.defaultAlgorithm];
    if (!algorithm) throw new Error(`No algorithm found for document ${docId}`);
    return this._handleDocChange(docId, ops, managed?.doc as PatchesDoc<any>, algorithm, metadata);
  }

  /**
   * Internal handler for doc changes. Called when doc.onChange emits ops.
   * Serializes calls per docId to prevent concurrent handleDocChange from
   * creating changes with the same rev (which would overwrite each other
   * in IndexedDB's [docId, rev] keyed pendingChanges store).
   */
  protected _handleDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T>,
    algorithm: ClientAlgorithm,
    metadata: Record<string, any>
  ): Promise<void> {
    const prev = this._changeQueues.get(docId) ?? Promise.resolve();
    const current = prev.then(() => this._processDocChange(docId, ops, doc, algorithm, metadata));
    this._changeQueues.set(
      docId,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      current.catch(() => {})
    );
    return current;
  }

  private async _processDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T>,
    algorithm: ClientAlgorithm,
    metadata: Record<string, any>
  ): Promise<void> {
    try {
      await algorithm.handleDocChange(docId, ops, doc, metadata);
      this.onChange.emit(docId);
    } catch (err) {
      console.error(`Error handling doc change for ${docId}:`, err);
      const baseDoc = doc as unknown as BaseDoc<T>;
      if (typeof baseDoc.rollbackOptimistic === 'function') {
        baseDoc.rollbackOptimistic();
      }
      this.onError.emit(err as Error, { docId });
    }
  }
}
