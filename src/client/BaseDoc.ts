import { batch, ReadonlyStoreClass, signal, store, type Store } from 'easy-signal';
import { applyPatch } from '../json-patch/applyPatch.js';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import { isDocLoaded } from '../shared/utils.js';
import type { Change, ChangeMutator, DocSyncStatus, PatchesSnapshot } from '../types.js';
import type { PatchesDoc } from './PatchesDoc.js';

/**
 * Abstract base class for document implementations.
 * Contains shared state and methods used by both OTDoc and LWWDoc.
 *
 * The `change()` method captures ops, applies them optimistically to `state`,
 * and emits them via `onChange`. The algorithm handles packaging ops into Changes,
 * persisting them, and confirming the optimistic update via `applyChanges()`.
 *
 * The mapping is strictly 1:1: one `change()` call produces one `applyChanges()`
 * confirmation. A FIFO queue tracks outstanding optimistic ops so that
 * `_recomputeState()` can reconstruct the full state (committed + pending +
 * optimistic) when server changes arrive or during error recovery.
 *
 * Internal methods (updateSyncStatus, applyChanges, import, rollbackOptimistic)
 * are on this class but not on the PatchesDoc interface, as they're only used
 * by Algorithm and PatchesSync.
 */
export abstract class BaseDoc<T extends object = object> extends ReadonlyStoreClass<T> implements PatchesDoc<T> {
  protected _id: string;

  /**
   * FIFO queue of ops applied optimistically by change() but not yet confirmed
   * by applyChanges(). The 1:1 mapping between change() and applyChanges()
   * means confirmation simply shifts from the front. The ops are stored (not
   * just counted) so _recomputeState() can reconstruct the full state when
   * server changes arrive during the optimistic window.
   *
   * Entry arrays are shared by reference with the pending mint (change() emits the
   * same array it queues), so OTDoc can rebase them IN PLACE when server changes
   * land before the mint runs — the mint then packages the rebased ops. An entry
   * rebased away entirely is emptied and removed; its mint sees empty ops and skips.
   */
  protected _optimisticOps: JSONPatchOp[][] = [];

  /** Current sync status of this document. */
  readonly syncStatus = store<DocSyncStatus>('unsynced');

  /** Whether the document has completed its initial load. Sticky: once true, never reverts to false. */
  readonly isLoaded: Store<boolean> = store(false);

  /** Error from the last failed sync attempt, if any. */
  readonly syncError: Store<Error | undefined> = store<Error | undefined>(undefined);

  /**
   * Subscribe to be notified when the user makes local changes.
   * Emits the JSON Patch ops captured from the change() call.
   * The algorithm handles packaging these into Changes.
   */
  readonly onChange = signal<(ops: JSONPatchOp[]) => void>();

  /**
   * Creates an instance of BaseDoc.
   * @param id The unique identifier for this document.
   * @param initialState Optional initial state.
   */
  constructor(id: string, initialState: T = {} as T) {
    super(initialState);
    this._id = id;
  }

  /** The unique identifier for this document. */
  get id(): string {
    return this._id;
  }

  /** Last committed revision number from the server. */
  abstract get committedRev(): number;

  /** Are there local changes that haven't been committed yet? */
  abstract get hasPending(): boolean;

  /**
   * Captures an update to the document, applies it optimistically to state,
   * and emits the ops via onChange for async persistence.
   *
   * State is updated synchronously (easy-signal's store.set() drains
   * subscribers synchronously) so the UI sees changes immediately.
   * The algorithm later confirms via applyChanges(), which shifts from
   * the FIFO queue and skips the state update (avoiding double notifications).
   *
   * @param mutator Function that uses JSONPatch methods with type-safe paths.
   */
  change(mutator: ChangeMutator<T>): void {
    const patch = createJSONPatch(mutator);
    if (patch.ops.length === 0) {
      return;
    }
    this._applyOptimistic(patch.ops);
    this.onChange.emit(patch.ops);
  }

  /**
   * Internal: applies raw ops optimistically to state and takes a slot in the FIFO
   * confirmation queue — the same path change() uses. Called by Patches.submitDocChange
   * so submitted ops hold their own 1:1 slot; without one, applyChanges' confirmation
   * shift would consume a user change's slot instead (double-applying the user's ops
   * and never applying the submitted ones).
   */
  _applyOptimistic(ops: JSONPatchOp[]): void {
    this.state = applyPatch(this.state, ops, { strict: true });
    this._optimisticOps.push(ops);
  }

  /**
   * Rolls back all outstanding optimistic applies and recomputes state from
   * confirmed state only. Called by Patches._handleDocChange when the
   * algorithm rejects ops. Any remaining in-flight changes will apply
   * normally via the fallback path in applyChanges().
   */
  rollbackOptimistic(): void {
    this._optimisticOps = [];
    this._recomputeState();
  }

  /**
   * Returns the tail of Patches' in-flight change queue for this doc, or undefined
   * if there is no work pending. Wired by Patches.openDoc(); standalone docs (no
   * Patches) have no queue, so flush() short-circuits.
   */
  private _flushAwaiter?: () => Promise<void> | undefined;
  /** Latches true the first time _setFlushAwaiter is called. Standalone docs stay false. */
  private _flushAwaiterWired = false;

  /** Internal: called by Patches.openDoc to wire up flush()'s queue accessor. */
  _setFlushAwaiter(getter: () => Promise<void> | undefined): void {
    this._flushAwaiter = getter;
    this._flushAwaiterWired = true;
  }

  /**
   * Resolves when the in-flight change queue for this doc has settled and
   * `_optimisticOps` is empty. Loops so that change() calls made during the
   * await are also drained.
   *
   * Standalone docs (never wired to a Patches queue) resolve immediately — they have
   * no consumer to drain optimistic ops, so awaiting would hang forever. For a doc
   * that WAS wired but whose queue entry has been cleared (post-closeDoc with an
   * in-flight chain), we yield to the macrotask queue until the captured chain
   * shifts the ops.
   *
   * **setTimeout(0) yield**: per the HTML spec, nested setTimeout(0) is clamped to
   * 4ms after the 5th level — so a flush spinning over many in-flight ops post-close
   * adds ~4ms per remaining iteration. The clamp is the cost of letting IndexedDB
   * macrotasks run; `Promise.resolve()` would starve them.
   */
  async flush(): Promise<void> {
    if (!this._flushAwaiterWired) return;
    while (true) {
      const tail = this._flushAwaiter?.();
      if (!tail) {
        if (this._optimisticOps.length === 0) return;
        // The queue map entry was cleared (e.g., closeDoc) but a captured handler chain
        // may still be draining ops. Yield to the macrotask queue — `Promise.resolve()`
        // only drains microtasks, which would starve the IndexedDB callbacks the chain
        // depends on.
        await new Promise<void>(r => setTimeout(r, 0));
        continue;
      }
      await tail;
      // After awaiting, check whether a new change() appended a fresh queue tail.
      // If the tail object is the same and optimistic ops are drained, we're done.
      if (this._flushAwaiter?.() === tail && this._optimisticOps.length === 0) return;
    }
  }

  /**
   * Recomputes state from confirmed state (committed + pending) plus any
   * remaining optimistic ops. Subclass-specific because each algorithm
   * tracks committed/pending state differently.
   */
  protected abstract _recomputeState(): void;

  // --- Internal methods (not on PatchesDoc interface) ---

  /**
   * Updates the sync status of the document.
   * Called by PatchesSync - not part of the app-facing PatchesDoc interface.
   * @param status The new sync status.
   * @param error Optional error when status is 'error'.
   */
  updateSyncStatus(status: DocSyncStatus, error?: Error): void {
    // Batch so isLoaded is latched before subscribers run; otherwise a syncStatus
    // subscriber sees the new status but stale isLoaded (empty rev-0 docs never "load").
    batch(() => {
      this.syncError.state = status === 'error' ? error : undefined;
      this.syncStatus.state = status;
      this._checkLoaded();
    });
  }

  /** Latches _isLoaded to true when the doc has data or sync has resolved. */
  protected _checkLoaded(): void {
    if (!this.isLoaded.state && isDocLoaded(this.committedRev, this.hasPending, this.syncStatus.state)) {
      this.isLoaded.state = true;
    }
  }

  /**
   * Confirms changes from the algorithm pipeline.
   * For local changes (committedAt === 0): shifts from the optimistic queue
   * and skips the state update since change() already applied them.
   * For server changes (committedAt > 0): updates committed state and
   * recomputes with any remaining optimistic ops.
   *
   * @param changes Array of changes to apply.
   */
  abstract applyChanges(changes: Change[]): void;

  /**
   * Imports a full snapshot, resetting doc state.
   * Used for recovery when doc gets out of sync - not part of PatchesDoc interface.
   *
   * @param snapshot The snapshot to import.
   */
  abstract import(snapshot: PatchesSnapshot<T>): void;
}
