import { createId } from 'crypto-id';
import { type Unsubscriber, signal } from 'easy-signal';
import type { JSONPatchOp } from '../json-patch/types.js';
import { isDefectiveChangeError, isRejectionError } from '../net/error.js';
import type { Change, PatchesSnapshot, QuarantinedChange } from '../types.js';
import { singleInvocation } from '../utils/concurrency.js';
import type { BaseDoc } from './BaseDoc.js';
import type { ClientAlgorithm } from './ClientAlgorithm.js';
import type { PatchesDoc, PatchesDocOptions } from './PatchesDoc.js';
import type { AlgorithmName } from './PatchesStore.js';

/**
 * Backoff for re-submitting a change whose mint failed transiently/ambiguously
 * (timeout, abort, network death, store hiccup — anything that is not an
 * authoritative rejection). Doubles per attempt from the base, capped at the max.
 * Attempts are unbounded: the only correct terminal states for un-persisted user
 * ops are a definitive server rejection or instance teardown — giving up and
 * discarding them is data loss (the failure that motivated this: a wedged hub's
 * 30s RPC timeouts erasing just-typed text that nothing had rejected).
 */
const CHANGE_RETRY_BASE_MS = 1_000;
const CHANGE_RETRY_MAX_MS = 30_000;

/**
 * Total submit attempts for an ambiguous/environment failure before the doc's write path is
 * latched: the initial attempt plus 2 retries. Bounded (unlike an authoritative rejection or a
 * defective change, which are terminal on the first failure) because an environment that is still
 * failing after a few backed-off attempts is broken, not momentarily hiccupping — silently
 * retrying it forever lets the user keep typing memory-only words with no signal that nothing is
 * being saved (the DAB-830 loss pattern). On exhaustion the ops are KEPT (never discarded — they
 * may yet land) and the write path is latched until the app calls {@link Patches.retrySavingChanges}.
 */
const MAX_CHANGE_SUBMIT_ATTEMPTS = 3;

/**
 * Length of the stable change id minted per captured change (base-62). Stable
 * across retries so the server's commit dedup recognizes a re-submission of a
 * change whose first attempt MAY have landed, instead of committing a duplicate.
 */
const STABLE_CHANGE_ID_LENGTH = 12;

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

// Internal doc management structure. `refCount` tracks how many callers
// currently hold the doc open via `openDoc`; `closeDoc` only tears the doc
// down when the count hits zero, so independent consumers can each manage
// their own open/close lifecycle without stomping on one another.
interface ManagedDoc<T extends object> {
  doc: PatchesDoc<T>;
  algorithm: ClientAlgorithm;
  unsubscribe: Unsubscriber;
  refCount: number;
  // Merged instance + per-doc metadata captured at open. Reused by retrySavingChanges() to
  // re-mint retained optimistic ops with the same metadata a normal change() on this doc uses.
  metadata: Record<string, any>;
}

/**
 * Context passed to {@link Patches.onError} for a failed change submit. Classifies the failure so
 * the app can respond correctly — retry silently, surface a "couldn't save" alert, or offer a
 * manual retry. See {@link Patches._processDocChange} for the three failure classes.
 */
export interface ChangeErrorContext {
  docId?: string;
  /** Whether the ops were kept and will be re-submitted (true) or the submit has stopped (false). */
  willRetry?: boolean;
  /** Zero-based submit attempt this error is for (environment bucket). */
  attempt?: number;
  /**
   * Which failure class this is:
   * - `rejection`   — the server/store authoritatively refused the change (terminal StatusError:
   *   401/402/403/404/410). The optimistic ops were rolled back.
   * - `defective`   — the change's own data can never be persisted (non-cloneable value, key/shape
   *   violation — a bug in the producing code). Terminal; the optimistic ops were rolled back.
   * - `environment` — a transport/storage failure that is NOT a verdict on the ops (the write may
   *   have landed or may land later). Retried a bounded number of times, then the doc's write path
   *   is latched with the ops KEPT applied.
   */
  kind?: 'rejection' | 'defective' | 'environment';
  /** True when this fires because the doc's write path is already latched, so persistence was skipped. */
  latched?: boolean;
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
  /**
   * Per-doc epoch, bumped when a change fails and the doc's optimistic queue is rolled
   * back. Changes queued behind the failure captured ops against state that included it,
   * so their processing is skipped when their captured epoch is stale.
   */
  private _changeEpochs: Map<string, number> = new Map();
  /**
   * Docs whose write path is latched (docId → the error that exhausted its submit retries).
   * While latched, changes are NOT persisted — the ops stay applied optimistically in memory so
   * the user's text stays visible, but nothing is minted or sent. Cleared by
   * {@link retrySavingChanges}, which re-drives the retained optimistic ops through the submit path.
   */
  private _writeLatches: Map<string, Error> = new Map();
  /**
   * Per optimistic-entry stable change id (entry ops array → id). A change re-driven by
   * {@link retrySavingChanges} after its write path was latched re-mints under the SAME id its
   * failed submit used, so the server's id-based commit dedup still collapses the ambiguous case
   * where a latched submit had actually landed — a fresh id would double-commit it. Keyed by the
   * entry's ops array (stable by reference across in-place rebases — the same ref
   * {@link BaseDoc._getOptimisticEntries} hands back), so it self-clears via GC once the entry is
   * confirmed and dropped; no explicit teardown needed.
   */
  private _changeStableIds: WeakMap<JSONPatchOp[], string> = new WeakMap();
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

  /** True once close() has run; parks the change-submit retry loops. */
  private _closed = false;
  /**
   * Wake functions for change-submit retry backoffs currently sleeping, so close()
   * can cancel their timers and let the loops observe `_closed` immediately instead
   * of firing against torn-down algorithm stores.
   */
  private _retryWakeups = new Set<() => void>();

  // Public signals
  /**
   * Emitted on failures. For a failed change submit, `context` ({@link ChangeErrorContext})
   * classifies the failure: `willRetry` says whether the ops were kept for re-submission, and
   * `kind` names the failure class (`rejection` / `defective` / `environment`). `latched: true`
   * marks an error emitted because the doc's write path is already latched.
   */
  readonly onError = signal<(error: Error, context?: ChangeErrorContext) => void>();
  /**
   * Fires after server-committed changes are durably applied to the local store, carrying only
   * the changes newly durable on this delivery — a re-delivered rev (echo, catchup/broadcast
   * overlap) is filtered out, so a per-change consumer sees each committed change exactly once.
   */
  readonly onServerCommit = signal<(docId: string, changes: Change[]) => void>();
  readonly onTrackDocs = signal<(docIds: string[], algorithmName: AlgorithmName) => void>();
  readonly onUntrackDocs = signal<(docIds: string[]) => void>();
  readonly onDeleteDoc = signal<(docId: string) => void>();
  /** Emitted when a doc has pending changes ready to send */
  readonly onChange = signal<(docId: string) => void>();
  /**
   * Emitted when a pending change is ejected into quarantine, and for persisted entries
   * on their doc's first sync attempt each session (so a restart can't strand one
   * un-surfaced). At-least-once: consumers should key on docId + changeId.
   */
  readonly onChangeQuarantined = signal<(docId: string, quarantined: QuarantinedChange) => void>();

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
   * Opens a document by ID, loading its state from the store and setting up
   * change listeners.
   *
   * Refcounted: each call to `openDoc` increments a per-doc reference count,
   * and `closeDoc` decrements it. The doc is only torn down (listener removed,
   * cache entry deleted) when the count drops to zero. This means independent
   * callers can each manage their own open/close lifecycle for the same doc
   * without one's `closeDoc` ripping the doc out from under another. Callers
   * MUST pair `openDoc` and `closeDoc` symmetrically — if you stop using a
   * doc, close it once, exactly once.
   *
   * @param docId - The document ID to open.
   * @param opts - Optional metadata and algorithm override.
   * @returns The opened PatchesDoc instance.
   */
  async openDoc<T extends object>(docId: string, opts: OpenDocOptions = {}): Promise<PatchesDoc<T>> {
    // The actual open (load snapshot, create doc, register listener) is
    // deduped per docId via `_openDocOnce` — concurrent first-time opens for
    // the same doc share one in-flight promise so we don't double-create.
    // Refcount increments here, AFTER the open settles, so every caller of
    // `openDoc` contributes one ref regardless of cache hit/miss.
    await this._openDocOnce(docId, opts);
    const managed = this.docs.get(docId)!;
    managed.refCount += 1;
    return managed.doc as PatchesDoc<T>;
  }

  @singleInvocation(true)
  private async _openDocOnce(docId: string, opts: OpenDocOptions = {}): Promise<void> {
    if (this.docs.has(docId)) return;

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

      // A just-closed instance of this doc may still be draining its change queue
      // (closeDoc awaits it, but callers may not await closeDoc). Wait it out so the
      // snapshot read below includes those writes — otherwise the reopened doc mints
      // its next change at the same rev and silently overwrites the in-flight one.
      await this._changeQueues.get(docId);

      // Load initial state from store via algorithm
      const snapshot = await algorithm.loadDoc(docId);
      const mergedMetadata = { ...this.options.metadata, ...opts.metadata };

      // Create the appropriate doc type via algorithm (now takes docId and snapshot)
      const doc = algorithm.createDoc<any>(docId, snapshot);

      // Wire up flush() so it can await the in-flight change queue for this doc.
      const baseDoc = doc as unknown as BaseDoc<any>;
      baseDoc._setFlushAwaiter(() => this._changeQueues.get(docId));

      // Set up local listener -> algorithm handles packaging ops
      const unsubscribe = doc.onChange(ops => this._handleDocChange(docId, ops, doc, algorithm, mergedMetadata));
      // refCount starts at 0; the outer `openDoc` increments it for the caller
      // (and any concurrent callers awaiting the shared `_openDocOnce` promise).
      this.docs.set(docId, {
        doc: doc as PatchesDoc<any>,
        algorithm,
        unsubscribe,
        refCount: 0,
        metadata: mergedMetadata,
      });

      // Drain any snapshot that arrived during the open. Done synchronously after
      // `this.docs.set` so no further applySnapshot calls can stash to the slot.
      // Strict `>` guard: doc.import() unconditionally replaces internal pending-state
      // (OTDoc._pendingChanges, LWWDoc._inFlightOpKeys) from snapshot.changes — calling
      // it at equal rev with the stripped `changes: []` we receive over PatchesSync
      // would wipe legitimate in-flight ops mid-typing. Only fresher snapshots warrant
      // the reset.
      const pending = this._openingSnapshots.get(docId);
      if (pending && pending.rev > baseDoc.committedRev) {
        baseDoc.import(pending as PatchesSnapshot<any>);
      }
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
   * Releases one reference to an open document. The doc is fully closed
   * (listener removed, cache entry evicted, change queue drained then cleared)
   * only when the last outstanding `openDoc` is matched by its `closeDoc`.
   * Calling `closeDoc` on a doc that isn't open is a no-op.
   * @param docId - The document ID to close.
   * @param options - Optional: set untrack to true to also untrack the doc
   *   on the final close.
   */
  async closeDoc(
    docId: string,
    { untrack = false, force = false }: { untrack?: boolean; force?: boolean } = {}
  ): Promise<void> {
    const managed = this.docs.get(docId);
    if (!managed) return;
    if (!force) {
      if (managed.refCount > 0) managed.refCount -= 1;
      if (managed.refCount > 0) return;
    }
    managed.unsubscribe();
    this.docs.delete(docId);
    // Drain the in-flight change queue before finishing teardown so pending mints
    // land in the store first — a reopen's snapshot must include them, and an
    // untrack must not race a write that would resurrect the doc's data. The entry
    // is only deleted if a reopen hasn't already queued fresh work behind it.
    const drain = this._changeQueues.get(docId);
    if (drain) {
      await drain;
      if (this._changeQueues.get(docId) === drain) this._changeQueues.delete(docId);
    }
    // Drop any write latch with the doc. Done AFTER the drain so changes still queued during
    // teardown keep hitting the latch's skip-and-return (rather than persisting against a doc being
    // closed); once drained, the latch's retained optimistic ops live only in this in-memory doc
    // (never persisted), so they go with it. A later openDoc must then start unlatched and persist
    // normally instead of inheriting a stale latch that would silently skip every save. (close()
    // clears all latches; this is the per-doc closeDoc / untrackDocs / deleteDoc teardown path.)
    this._writeLatches.delete(docId);
    if (untrack) {
      await this.untrackDocs([docId]);
    }
  }

  /**
   * Deletes a document by ID, closing it if open, untracking it, and removing it from the store.
   * Emits the onDeleteDoc signal.
   * @param docId - The document ID to delete.
   */
  async deleteDoc(docId: string): Promise<void> {
    // Wait out any in-flight open for this id so the doc registers and gets
    // force-closed below — otherwise the open resumes after the tombstone and
    // leaves a live doc over a deleted, untracked store entry. The opening
    // deferred resolves unconditionally (never rejects), mirroring close().
    await this._openingPromises.get(docId);

    // Resolve algorithm by store membership rather than defaulting. For a closed doc
    // opened on a non-default algorithm, defaulting would tombstone the wrong store
    // (writing a stranded tombstone in the default algorithm while leaving the real
    // data untouched in the other algorithm). Resolved before closeDoc/untrackDocs so
    // a doc that's open right now still wins via `managed.algorithm`.
    const algorithm = await this._resolveAlgorithmForDoc(docId);

    // Close if open locally. `force` so we evict regardless of outstanding
    // refs — the doc is being deleted, every consumer needs to release it.
    if (this.docs.has(docId)) {
      await this.closeDoc(docId, { force: true });
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
   * Ejects a pending change into quarantine so the rest of the doc's pending work can
   * sync past it: the app-consent path for a rejection PatchesSync could not corroborate
   * locally (the latched sync error carries `data.changeId`; the app asks the user, then
   * calls this). Content stays recoverable via {@link listQuarantinedChanges} until
   * discarded. Call it while the doc's sync is latched at 'error'; ejecting during an
   * in-flight flush can race the server accepting the change.
   *
   * @returns The quarantined entry, or null when nothing matched (already committed,
   *   already ejected, or an algorithm without ejection support).
   * @throws When the change matched but cannot be safely ejected (e.g. an OT queue whose
   *   poison can't be inverted). The doc is still wedged — surface it rather than treating
   *   it as resolved.
   */
  async ejectPendingChange(
    docId: string,
    changeId: string,
    reason = 'app-requested'
  ): Promise<QuarantinedChange | null> {
    const algorithm = await this._resolveAlgorithmForDoc(docId);
    if (!algorithm.ejectPendingChange) return null;
    const quarantined = await algorithm.ejectPendingChange(docId, changeId, reason, this.getOpenDoc(docId));
    if (quarantined) {
      this.onChangeQuarantined.emit(docId, quarantined);
      // Nudge sync to flush the surviving pending work.
      this.onChange.emit(docId);
    }
    return quarantined;
  }

  /** Lists quarantined changes for one doc, or across all algorithms when docId is omitted. */
  async listQuarantinedChanges(docId?: string): Promise<QuarantinedChange[]> {
    if (docId !== undefined) {
      const algorithm = await this._resolveAlgorithmForDoc(docId);
      return (await algorithm.listQuarantinedChanges?.(docId)) ?? [];
    }
    const algorithms = Object.values(this.algorithms) as ClientAlgorithm[];
    const lists = await Promise.all(algorithms.map(a => a.listQuarantinedChanges?.() ?? []));
    // Dedup by [docId, changeId]: in shared-database setups every algorithm store reads the
    // same `quarantinedChanges` object store, so without this each entry appears once per
    // algorithm.
    const seen = new Set<string>();
    return lists.flat().filter(entry => {
      const key = `${entry.docId}\u0000${entry.changeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Permanently removes a quarantined change. The app's decision, never automatic. */
  async discardQuarantinedChange(docId: string, changeId: string): Promise<void> {
    const algorithm = await this._resolveAlgorithmForDoc(docId);
    await algorithm.discardQuarantinedChange?.(docId, changeId);
  }

  /**
   * Closes all open documents and cleans up listeners and store connections.
   * Should be called when shutting down the client.
   */
  async close(): Promise<void> {
    // Park the change-submit retry loops first: set the flag, then cancel every
    // sleeping backoff so the loops wake, observe `_closed`, and exit without
    // re-submitting against the algorithm stores we are about to close. The ops
    // they were retrying stay applied on their (discarded) docs — teardown never
    // rolls anything back.
    this._closed = true;
    for (const wake of [...this._retryWakeups]) wake();

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
    this._changeEpochs.clear();
    this._writeLatches.clear();
    this._openingDocs.clear();
    this._openingSnapshots.clear();

    // Close all algorithms (each closes its store)
    await Promise.all(Object.values(this.algorithms).map(s => s?.close()));

    this.onChange.clear();
    this.onChangeQuarantined.clear();
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
    if (ops.length === 0) return Promise.resolve();
    const managed = this.docs.get(docId);
    const algorithm = this.getDocAlgorithm(docId) ?? this.algorithms[this.defaultAlgorithm];
    if (!algorithm) throw new Error(`No algorithm found for document ${docId}`);
    // Take an optimistic slot like change() does. applyChanges confirmations shift the
    // FIFO queue 1:1, so a submitted change without its own slot would consume a user
    // change's slot instead — double-applying the user's ops and dropping these.
    if (managed) (managed.doc as unknown as BaseDoc<any>)._applyOptimistic(ops);
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
    const epoch = this._changeEpochs.get(docId) ?? 0;
    const prev = this._changeQueues.get(docId) ?? Promise.resolve();
    const current = prev.then(() => {
      // A change that failed while this one was queued rolled back the doc's whole
      // optimistic queue — including these ops, which were captured against state
      // that contained the failure. Skip them instead of persisting a change whose
      // base no longer exists. (Checked before the latch: a rolled-back change's ops
      // were already discarded, so it must skip silently rather than emit a latched error.)
      if (doc && (this._changeEpochs.get(docId) ?? 0) !== epoch) return;
      // The doc's write path is latched by a prior exhausted submit. Do NOT attempt
      // persistence: the ops stay applied optimistically in memory (nothing minted or sent);
      // emit so the app knows this change wasn't saved. Persistence resumes only when the app
      // calls retrySavingChanges().
      const latchError = this._writeLatches.get(docId);
      if (latchError) {
        this.onError.emit(latchError, { docId, willRetry: false, kind: 'environment', latched: true });
        return;
      }
      return this._processDocChange(docId, ops, doc, algorithm, metadata);
    });
    this._changeQueues.set(
      docId,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      current.catch(() => {})
    );
    return current;
  }

  /**
   * Rolls back a doc's optimistic queue for a terminal failure (authoritative rejection or
   * defective change). Bumps the per-doc epoch BEFORE rolling back so changes already queued
   * behind this failure — whose optimistic ops the rollback just discarded — are skipped.
   */
  private _rollbackDoc<T extends object>(docId: string, baseDoc: BaseDoc<T> | undefined): void {
    if (baseDoc && typeof baseDoc.rollbackOptimistic === 'function') {
      this._changeEpochs.set(docId, (this._changeEpochs.get(docId) ?? 0) + 1);
      baseDoc.rollbackOptimistic();
    }
  }

  /**
   * Mints/persists one captured change via the algorithm, classifying a failure into one of
   * three buckets:
   *
   * - **Authoritative rejection** (terminal StatusError — the server/store definitively refused
   *   the change): roll back the optimistic ops and bump the per-doc epoch so dependent changes
   *   queued behind are skipped. Discarding is correct — the work was rejected. `kind: 'rejection'`.
   * - **Defective change** (its own data can never be persisted — a non-cloneable value, a
   *   key/shape violation; see {@link isDefectiveChangeError}): a bug in the producing code, so
   *   every retry throws the identical error. Terminal like a rejection — roll the un-savable
   *   change back and bump the epoch — but flagged `kind: 'defective'` so the app can surface it
   *   (a change that can NEVER be saved, distinct from a server refusal). Working around the value
   *   is forbidden; the app must alert the user.
   * - **Ambiguous / environment failure** (timeout, abort, network death, storage fault): the
   *   write MAY have landed (or may land on a later attempt) and nothing rejected it — discarding
   *   the ops would silently delete the user's un-persisted work. The ops stay applied (and queued
   *   in `_optimisticOps`) and the submit is re-issued with backoff, up to
   *   {@link MAX_CHANGE_SUBMIT_ATTEMPTS}. Re-submitting cannot duplicate: a rejected IndexedDB
   *   transaction is atomic, so a failed savePendingChanges persisted nothing; the stable change
   *   id also backstops the server's commit dedup for the ambiguous case where the write did land.
   *   On exhausting the attempts the ops are KEPT (never discarded — they may yet land) and the
   *   doc's write path is LATCHED (`kind: 'environment'`, `willRetry: false`); persistence resumes
   *   only when the app calls {@link retrySavingChanges}.
   *
   * The retry runs inside the per-doc change queue, so later changes wait behind it in capture
   * order — required for OT correctness (their ops assume this change's ops are already in the doc
   * frame). While the backoff sleeps, server changes still rebase the kept ops in place
   * (OTDoc._rebaseOptimisticOps holds the same array reference), so the eventual re-mint packages
   * correctly-based ops. If the change is confirmed through another path while waiting, the
   * optimistic entry is shifted off the queue and the retry loop detects that and stops.
   */
  private async _processDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T>,
    algorithm: ClientAlgorithm,
    metadata: Record<string, any>
  ): Promise<void> {
    // Stable across every retry of this submit AND across a later retrySavingChanges re-drive of
    // the same optimistic entry: keyed by the entry's ops array so the id survives the latch,
    // keeping the server's commit dedup effective if a latched submit had actually landed (see
    // {@link _changeStableIds}). A brand-new entry (including one typed while latched) mints fresh.
    let stableId = this._changeStableIds.get(ops);
    if (!stableId) {
      stableId = createId(STABLE_CHANGE_ID_LENGTH);
      this._changeStableIds.set(ops, stableId);
    }
    const baseDoc = doc as unknown as BaseDoc<T> | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        await algorithm.handleDocChange(docId, ops, doc, metadata, stableId);
        this.onChange.emit(docId);
        return;
      } catch (err) {
        // 1) Authoritative rejection — the server/store definitively refused this change.
        if (isRejectionError(err)) {
          console.error(`Rejected doc change for ${docId}:`, err);
          this._rollbackDoc(docId, baseDoc);
          this.onError.emit(err as Error, { docId, willRetry: false, kind: 'rejection' });
          return;
        }

        // 2) Defective change — its own data can never be saved; retrying is provably useless.
        if (isDefectiveChangeError(err)) {
          console.error(`Defective doc change for ${docId} (cannot be saved, not retrying):`, err);
          this._rollbackDoc(docId, baseDoc);
          this.onError.emit(err as Error, { docId, willRetry: false, kind: 'defective' });
          return;
        }

        // 3) Ambiguous / environment failure — not a verdict on the ops. Retry bounded, then latch.
        if (attempt + 1 >= MAX_CHANGE_SUBMIT_ATTEMPTS) {
          // Closing: don't repopulate the latch map close() just cleared — the instance and its
          // optimistic ops are being discarded, and close() already parked the retry loops.
          if (this._closed) return;
          // Exhausted: do NOT roll back (the ops may have landed or may yet land — discarding
          // would delete un-persisted work). Latch the write path so no further change on this
          // doc is minted/sent until the app retries; the ops stay applied optimistically.
          console.error(
            `Doc change for ${docId} failed ${MAX_CHANGE_SUBMIT_ATTEMPTS} times; latching write path:`,
            err
          );
          this._writeLatches.set(docId, err as Error);
          this.onError.emit(err as Error, { docId, willRetry: false, kind: 'environment', attempt });
          return;
        }

        console.warn(`Transient failure handling doc change for ${docId} (attempt ${attempt + 1}), will retry:`, err);
        this.onError.emit(err as Error, { docId, willRetry: true, kind: 'environment', attempt });
        await this._retryDelay(attempt);
        // Torn down while sleeping: leave the ops in place (nothing is rolled back
        // on teardown) and stop — the algorithm/store is closing or closed.
        if (this._closed) return;
        // Rebased away to a no-op while waiting — nothing left to submit.
        if (ops.length === 0) return;
        // Confirmed through another path while waiting (its optimistic entry was
        // shifted by applyChanges) — re-submitting would double-apply.
        if (baseDoc && typeof baseDoc._hasOptimisticEntry === 'function' && !baseDoc._hasOptimisticEntry(ops)) {
          return;
        }
      }
    }
  }

  /**
   * Whether the doc's write path is currently latched — a prior change submit exhausted its
   * bounded retries ({@link MAX_CHANGE_SUBMIT_ATTEMPTS}), so changes on this doc are applied
   * optimistically in memory but not persisted. Cleared by {@link retrySavingChanges}.
   */
  isWriteLatched(docId: string): boolean {
    return this._writeLatches.has(docId);
  }

  /** The doc IDs whose write path is currently latched. Read-only snapshot. */
  get writeLatchedDocs(): string[] {
    return [...this._writeLatches.keys()];
  }

  /**
   * Clears the write latch on a doc (or all latched docs when `docId` is omitted) and re-drives
   * its retained optimistic ops through the normal submit path, in capture order. Called by the
   * app after a latching environment failure — e.g. when the user hits a "retry saving" action or
   * connectivity/storage is known to have recovered.
   *
   * Each re-driven submit goes through the same three-bucket logic as any other change, so a
   * still-broken environment simply re-latches the doc (and a now-authoritative rejection rolls
   * back). Ordering is preserved by re-enqueuing onto the per-doc change queue; the queue is first
   * drained to a fixed point WITH the latch still set, so a change captured during the latched
   * window can't process the same optimistic entry out from under the re-drive.
   */
  async retrySavingChanges(docId?: string): Promise<void> {
    const ids = docId != null ? [docId] : [...this._writeLatches.keys()];
    await Promise.all(ids.map(id => this._retrySavingDoc(id)));
  }

  private async _retrySavingDoc(docId: string): Promise<void> {
    if (!this._writeLatches.has(docId)) return;
    const managed = this.docs.get(docId);
    if (!managed) {
      // Doc closed while latched — nothing open to re-drive; just drop the latch.
      this._writeLatches.delete(docId);
      return;
    }
    // Drain the per-doc queue to a fixed point with the latch STILL set, so every change captured
    // during the latched window has run its skip-and-return. Clearing the latch with work still
    // queued would let that queued change mint the same optimistic entry the re-drive submits next.
    while (true) {
      const tail = this._changeQueues.get(docId);
      if (!tail) break;
      await tail;
      if (this._changeQueues.get(docId) === tail) break;
    }
    if (this._closed || !this._writeLatches.has(docId)) return;
    this._writeLatches.delete(docId);
    // Re-drive the retained optimistic entries (snapshot the queue; the same inner op arrays the
    // live queue holds, so confirmation shifts line up). Enqueued synchronously here so they take
    // their FIFO slots before any concurrent change() can, preserving capture order.
    const baseDoc = managed.doc as unknown as BaseDoc<any>;
    const entries = typeof baseDoc._getOptimisticEntries === 'function' ? baseDoc._getOptimisticEntries() : [];
    await Promise.all(
      entries.map(entryOps => this._handleDocChange(docId, entryOps, managed.doc, managed.algorithm, managed.metadata))
    );
  }

  /**
   * Sleeps for the change-submit retry backoff (exponential, capped), registering
   * a wakeup so close() can cancel the timer and resolve immediately.
   */
  private _retryDelay(attempt: number): Promise<void> {
    // An attempt that was in flight (not sleeping) when close() ran settles after
    // the wakeup sweep — don't let it start a fresh timer that outlives the close.
    if (this._closed) return Promise.resolve();
    const ms = Math.min(CHANGE_RETRY_MAX_MS, CHANGE_RETRY_BASE_MS * 2 ** attempt);
    return new Promise<void>(resolve => {
      const wake = () => {
        clearTimeout(timer);
        this._retryWakeups.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this._retryWakeups.add(wake);
    });
  }
}
