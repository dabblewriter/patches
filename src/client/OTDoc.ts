import { createStateFromSnapshot } from '../algorithms/ot/client/createStateFromSnapshot.js';
import { applyChanges as applyChangesToState } from '../algorithms/ot/shared/applyChanges.js';
import type { Change, PatchesSnapshot } from '../types.js';
import { BaseDoc } from './BaseDoc.js';

/**
 * OT (Operational Transformation) document implementation.
 * Uses a snapshot-based approach with revision tracking and rebasing
 * for handling concurrent edits.
 *
 * The `change()` method (inherited from BaseDoc) captures ops and emits them
 * via `onChange` - it does NOT apply locally. The OTStrategy handles packaging
 * ops into Changes, persisting them, and calling `applyChanges()` to update state.
 *
 * ## State Model
 * - `_committedState`: Base state from server (at `_committedRev`)
 * - `_pendingChanges`: Local changes not yet committed by server
 * - `_state` (from BaseDoc): Live state = committedState + pendingChanges applied
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
    this._committedState = this._state;
    this._committedRev = snapshot?.rev ?? 0;
    this._pendingChanges = snapshot?.changes ?? [];

    // If pending changes provided, recompute live state
    if (this._pendingChanges.length > 0) {
      this._state = applyChangesToState(this._committedState, this._pendingChanges);
    }
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
   * Resets state and treats all imported changes as pending.
   */
  import(snapshot: PatchesSnapshot<T>): void {
    this._committedState = snapshot.state;
    this._committedRev = snapshot.rev;
    this._pendingChanges = snapshot.changes;
    this._state = createStateFromSnapshot(snapshot);
    this.onUpdate.emit(this._state);
  }

  /**
   * Unified entry point for applying changes.
   * Used for Worker→Tab communication where only changes are sent over the wire.
   *
   * The method distinguishes between committed and pending changes using `committedAt`:
   * - `committedAt > 0`: Server-committed change (apply to committed state)
   * - `committedAt === 0`: Pending local change (append to pending)
   *
   * For server changes, all committed changes come first, followed by rebased pending.
   *
   * @param changes Array of changes to apply
   */
  applyChanges(changes: Change[]): void {
    if (changes.length === 0) return;

    // Check if these are server changes (first change is committed)
    if (changes[0].committedAt > 0) {
      // Split into committed and rebased pending
      const serverEndIndex = changes.findIndex(c => c.committedAt === 0);
      const serverChanges = serverEndIndex === -1 ? changes : changes.slice(0, serverEndIndex);
      const rebasedPending = serverEndIndex === -1 ? [] : changes.slice(serverEndIndex);

      // Ensure server changes are sequential to the current committed revision
      if (this._committedRev !== serverChanges[0].rev - 1) {
        throw new Error('Cannot apply committed changes to a doc that is not at the correct revision');
      }

      // Apply server changes to the committed state
      this._committedState = applyChangesToState(this._committedState, serverChanges);
      this._committedRev = serverChanges[serverChanges.length - 1].rev;

      // The rebasedPendingChanges are the new complete set of pending changes
      this._pendingChanges = rebasedPending;

      // Recalculate the live state
      this._state = applyChangesToState(this._committedState, this._pendingChanges);
    } else {
      // These are local changes - apply to live state and add to pending
      this._state = applyChangesToState(this._state, changes);
      this._pendingChanges.push(...changes);
    }

    // Notify listeners
    this.onUpdate.emit(this._state);
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
