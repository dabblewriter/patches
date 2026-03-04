import { applyPatch } from '../json-patch/applyPatch.js';
import type { Change, PatchesSnapshot } from '../types.js';
import { BaseDoc } from './BaseDoc.js';

/**
 * LWW (Last-Write-Wins) document implementation.
 *
 * The `change()` method (inherited from BaseDoc) applies ops optimistically
 * to `state` and emits them via `onChange`. The LWWAlgorithm packages ops
 * with timestamps, persists them, and calls `applyChanges()` to confirm
 * the optimistic update (shifting from the FIFO queue and skipping the state setter).
 *
 * Note: LWWAlgorithm adds `ts` (timestamp) metadata to ops before persisting.
 * `applyPatch` ignores unknown op properties, so optimistic apply (raw ops)
 * and confirmed apply (timestamped ops) produce identical state.
 *
 * Unlike OTDoc, LWWDoc doesn't need to track committed vs pending state
 * separately - the algorithm handles all conflict resolution by timestamp.
 *
 * ## Wire Efficiency
 * For Worker-Tab communication, `applyChanges()` sends only changes over the wire,
 * not the full state.
 */
export class LWWDoc<T extends object = object> extends BaseDoc<T> {
  protected _committedRev: number;
  protected _hasPending: boolean;
  /** Confirmed state (from algorithm pipeline), used to recompute after server changes. */
  protected _baseState: T;

  /**
   * Creates an instance of LWWDoc.
   * @param id The unique identifier for this document.
   * @param snapshot Optional snapshot to initialize from.
   */
  constructor(id: string, snapshot?: PatchesSnapshot<T>) {
    const initialState = snapshot?.state ?? ({} as T);
    super(id, initialState);
    this._committedRev = snapshot?.rev ?? 0;
    this._hasPending = (snapshot?.changes?.length ?? 0) > 0;

    if (snapshot?.changes && snapshot.changes.length > 0) {
      const allOps = snapshot.changes.flatMap(c => c.ops);
      this.state = applyPatch(this.state, allOps, { partial: true });
    }
    this._baseState = this.state;
    this._checkLoaded();
  }

  /** Last committed revision number from the server. */
  get committedRev(): number {
    return this._committedRev;
  }

  /** Are there local changes that haven't been committed yet? */
  get hasPending(): boolean {
    return this._hasPending;
  }

  /**
   * Imports document state from a snapshot (e.g., for recovery when out of sync).
   * Resets state completely from the snapshot.
   */
  import(snapshot: PatchesSnapshot<T>): void {
    this._committedRev = snapshot.rev;
    this._hasPending = (snapshot.changes?.length ?? 0) > 0;
    this._optimisticOps = [];

    let currentState = snapshot.state;
    if (snapshot.changes && snapshot.changes.length > 0) {
      currentState = applyPatch(
        currentState,
        snapshot.changes.flatMap(c => c.ops),
        { partial: true }
      );
    }

    this._baseState = currentState;
    this._checkLoaded();
    this.state = currentState;
  }

  /**
   * Recomputes state from the base state plus remaining optimistic ops.
   */
  protected _recomputeState(): void {
    let newState = this._baseState;
    for (const ops of this._optimisticOps) {
      newState = applyPatch(newState, ops, { strict: true });
    }
    this.state = newState;
  }

  /**
   * Confirms changes from the algorithm pipeline.
   *
   * For LWW, all ops are applied in order. The method distinguishes between
   * committed and pending changes using `committedAt`:
   * - `committedAt > 0`: Server-committed change (updates committedRev, recomputes
   *   state with remaining optimistic ops preserved)
   * - `committedAt === 0`: Pending local change (shifts from optimistic queue,
   *   skips state update since change() already applied the ops)
   *
   * @param changes Array of changes to apply
   * @param hasPending If provided, overrides the inferred pending state.
   *   Used by LWWAlgorithm which knows the true pending state from the store.
   */
  override applyChanges(changes: Change[], hasPending?: boolean): void {
    if (changes.length === 0) return;

    let lastCommittedRev = this._committedRev;
    let hasPendingChanges = false;
    let hasServerChanges = false;

    for (const change of changes) {
      if (change.committedAt > 0) {
        lastCommittedRev = change.rev;
        hasServerChanges = true;
      } else {
        hasPendingChanges = true;
      }
    }

    this._committedRev = lastCommittedRev;
    this._hasPending = hasPending ?? hasPendingChanges;
    this._checkLoaded();

    if (hasServerChanges) {
      const allOps = changes.flatMap(c => c.ops);
      this._baseState = applyPatch(this._baseState, allOps, { partial: true });
      this._recomputeState();
    } else {
      const allOps = changes.flatMap(c => c.ops);
      this._baseState = applyPatch(this._baseState, allOps, { partial: true });

      if (this._optimisticOps.length > 0) {
        this._optimisticOps.shift();
      } else {
        // No prior optimistic apply (Worker-Tab sync or direct call).
        this._recomputeState();
      }
    }
  }
}
