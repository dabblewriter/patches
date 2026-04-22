import { createStateFromSnapshot } from '../algorithms/ot/client/createStateFromSnapshot.js';
import { applyChanges as applyChangesToState } from '../algorithms/ot/shared/applyChanges.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { Change, PatchesSnapshot } from '../types.js';
import { BaseDoc } from './BaseDoc.js';

/**
 * OT (Operational Transformation) document implementation.
 * Uses a snapshot-based approach with revision tracking and rebasing
 * for handling concurrent edits.
 *
 * The `change()` method (inherited from BaseDoc) applies ops optimistically
 * to `state` and emits them via `onChange`. The OTAlgorithm packages ops into
 * Changes, persists them, and calls `applyChanges()` to confirm the optimistic
 * update (shifting from the FIFO queue and skipping the state setter).
 *
 * ## State Model
 * - `_committedState`: Base state from server (at `_committedRev`)
 * - `_pendingChanges`: Local changes not yet committed by server
 * - `_optimisticOps` (from BaseDoc): Ops applied by change() but not yet confirmed
 * - `state`: Live state = committedState + pendingChanges + optimistic ops applied
 *
 * ## Wire Efficiency
 * For Worker-Tab communication, only changes are sent over the wire (not full state).
 * The unified `applyChanges()` method handles both local and server changes.
 */
export class OTDoc<T extends object = object> extends BaseDoc<T> {
  /** Base state from the server at the committed revision. */
  protected _committedState: T;
  /** Last committed revision number from the server. */
  protected _committedRev: number;
  /** Local changes not yet committed by server. */
  protected _pendingChanges: Change[];

  /**
   * Creates an instance of OTDoc.
   * @param id The unique identifier for this document.
   * @param snapshot Optional snapshot to initialize from (state, rev, pending changes).
   */
  constructor(id: string, snapshot?: PatchesSnapshot<T>) {
    const initialState = snapshot?.state ?? ({} as T);
    super(id, initialState);
    this._committedState = this.state;
    this._committedRev = snapshot?.rev ?? 0;
    this._pendingChanges = snapshot?.changes ?? [];

    // If pending changes provided, recompute live state
    if (this._pendingChanges.length > 0) {
      try {
        this.state = applyChangesToState(this._committedState, this._pendingChanges);
      } catch {
        // Pending changes are corrupt (conflicting ops from accumulated sessions).
        // Apply one-by-one, skipping changes that fail. Later changes created on
        // committed state may still apply even when earlier ones conflict.
        let state = this._committedState;
        const valid: Change[] = [];
        for (const c of this._pendingChanges) {
          try {
            state = applyPatch(state, c.ops, { strict: true });
            valid.push(c);
          } catch {
            // Skip this corrupt change
          }
        }
        this._pendingChanges = valid;
        this.state = state;
      }
    }
    this._checkLoaded();
  }

  /** Last committed revision number from the server. */
  get committedRev(): number {
    return this._committedRev;
  }

  /** Are there local changes that haven't been committed yet? */
  get hasPending(): boolean {
    return this._pendingChanges.length > 0;
  }

  /**
   * Returns the pending changes for this document.
   * @returns The pending changes.
   */
  getPendingChanges(): Change[] {
    return this._pendingChanges;
  }

  /**
   * Imports document state from a snapshot (e.g., for recovery when out of sync).
   * Resets committed/pending state from the snapshot but PRESERVES outstanding
   * optimistic ops (re-applied on top of the new state, dropping any that fail).
   *
   * Why preserve optimistic ops: import() can be called by sync recovery /
   * cross-tab snapshot broadcast paths while the user is mid-typing. Wiping
   * `_optimisticOps` would silently regress the input back to the snapshot
   * value, causing visible "text jumps" and lost characters.
   *
   * Stale-snapshot guard: snapshots older than the current `_committedRev`
   * are ignored — we already know more than the caller does.
   */
  import(snapshot: PatchesSnapshot<T>): void {
    if (snapshot.rev < this._committedRev) return;
    this._committedState = snapshot.state;
    this._committedRev = snapshot.rev;
    this._pendingChanges = snapshot.changes;
    this._checkLoaded();

    let newState: T = createStateFromSnapshot(snapshot);
    if (this._optimisticOps.length > 0) {
      const surviving: typeof this._optimisticOps = [];
      for (const ops of this._optimisticOps) {
        try {
          newState = applyPatch(newState, ops, { strict: true });
          surviving.push(ops);
        } catch {
          // Optimistic ops created against the prior state may not apply cleanly
          // to the imported state (e.g., parent path was replaced). Drop them
          // — the algorithm will retry/reissue any genuinely pending work.
        }
      }
      this._optimisticOps = surviving;
    }
    this.state = newState;
  }

  /**
   * Recomputes state from committed + pending + remaining optimistic ops.
   */
  protected _recomputeState(): void {
    let newState: T = applyChangesToState(this._committedState, this._pendingChanges);
    for (const ops of this._optimisticOps) {
      newState = applyPatch(newState, ops, { strict: true });
    }
    this.state = newState;
  }

  /**
   * Confirms changes from the algorithm pipeline.
   *
   * Distinguishes between committed and pending changes using `committedAt`:
   * - `committedAt > 0`: Server-committed change (updates committed state, recomputes
   *   with remaining optimistic ops preserved)
   * - `committedAt === 0`: Local change confirmation (shifts from optimistic queue,
   *   skips state update since change() already applied the ops)
   *
   * For server changes, all committed changes come first, followed by rebased pending.
   *
   * @param changes Array of changes to apply
   */
  applyChanges(changes: Change[]): void {
    if (changes.length === 0) return;

    if (changes[0].committedAt > 0) {
      const serverEndIndex = changes.findIndex(c => c.committedAt === 0);
      const serverChanges = serverEndIndex === -1 ? changes : changes.slice(0, serverEndIndex);
      const rebasedPending = serverEndIndex === -1 ? [] : changes.slice(serverEndIndex);

      if (this._committedRev !== serverChanges[0].rev - 1) {
        throw new Error('Cannot apply committed changes to a doc that is not at the correct revision');
      }

      // Pure echo: every server change confirms one of our own pending changes (no foreign
      // concurrent ops). The recomputed state is data-identical to the current state, so we
      // skip _recomputeState() to avoid emitting a redundant store update with a fresh object
      // identity. UI subscribers (Vue shallowRef, Svelte stores, etc.) see no spurious update
      // mid-typing.
      //
      // The `serverChanges.length > 0` guard is currently redundant (the outer branch only
      // runs when `changes[0].committedAt > 0`, which guarantees at least one server change),
      // but defends against `[].every() === true` if a future refactor weakens the invariant.
      const priorPendingIds = new Set(this._pendingChanges.map(c => c.id));
      const isPureEcho = serverChanges.length > 0 && serverChanges.every(c => priorPendingIds.has(c.id));

      this._committedState = applyChangesToState(this._committedState, serverChanges);
      this._committedRev = serverChanges[serverChanges.length - 1].rev;
      this._pendingChanges = rebasedPending;
      this._checkLoaded();
      if (!isPureEcho) {
        this._recomputeState();
      }
    } else {
      this._pendingChanges.push(...changes);
      this._checkLoaded();

      if (this._optimisticOps.length > 0) {
        this._optimisticOps.shift();
      } else {
        // No prior optimistic apply (Worker-Tab sync or direct call).
        this.state = applyChangesToState(this.state, changes);
      }
    }
  }

  /**
   * Returns the document snapshot for serialization.
   */
  toJSON(): PatchesSnapshot<T> {
    return {
      state: this._committedState,
      rev: this._committedRev,
      changes: this._pendingChanges,
    };
  }
}
