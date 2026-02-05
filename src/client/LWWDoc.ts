import { applyPatch } from '../json-patch/applyPatch.js';
import type { Change, PatchesSnapshot } from '../types.js';
import { BaseDoc } from './BaseDoc.js';

/**
 * LWW (Last-Write-Wins) document implementation.
 *
 * The `change()` method (inherited from BaseDoc) captures ops and emits them
 * via `onChange` - it does NOT apply locally. The LWWStrategy handles:
 * - Packaging ops with timestamps
 * - Merging with pending fields
 * - Updating the doc's state via `applyChanges()`
 *
 * Unlike OTDoc, LWWDoc doesn't need to track committed vs pending state
 * separately - the strategy handles all conflict resolution by timestamp.
 *
 * ## Wire Efficiency
 * For Worker-Tab communication, `applyChanges()` sends only changes over the wire,
 * not the full state.
 */
export class LWWDoc<T extends object = object> extends BaseDoc<T> {
  protected _committedRev: number;
  protected _hasPending: boolean;

  /**
   * Creates an instance of LWWDoc.
   * @param id The unique identifier for this document.
   * @param snapshot Optional snapshot to initialize from.
   */
  constructor(id: string, snapshot?: PatchesSnapshot<T>) {
    const initialState = snapshot?.state ?? ({} as T);
    super(id, initialState);
    this._committedRev = snapshot?.rev ?? 0;
    // If snapshot has pending changes, mark as having pending
    this._hasPending = (snapshot?.changes?.length ?? 0) > 0;

    // Apply any pending changes from snapshot to get current state
    if (snapshot?.changes && snapshot.changes.length > 0) {
      for (const change of snapshot.changes) {
        for (const op of change.ops) {
          this._state = applyPatch(this._state, [op], { partial: true });
        }
      }
    }
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
    this._state = snapshot.state;
    this._committedRev = snapshot.rev;
    this._hasPending = (snapshot.changes?.length ?? 0) > 0;

    // Apply any pending changes from snapshot
    if (snapshot.changes && snapshot.changes.length > 0) {
      for (const change of snapshot.changes) {
        for (const op of change.ops) {
          this._state = applyPatch(this._state, [op], { partial: true });
        }
      }
    }

    this.onUpdate.emit(this._state);
  }

  /**
   * Applies changes to the document state.
   * Used for Worker→Tab communication where only changes are sent over the wire.
   *
   * For LWW, all ops are applied in order. The method distinguishes between
   * committed and pending changes using `committedAt`:
   * - `committedAt > 0`: Server-committed change (updates committedRev)
   * - `committedAt === 0`: Pending local change (marks hasPending = true)
   *
   * @param changes Array of changes to apply
   */
  applyChanges(changes: Change[]): void {
    if (changes.length === 0) return;

    // Apply all ops from all changes
    for (const change of changes) {
      for (const op of change.ops) {
        this._state = applyPatch(this._state, [op], { partial: true });
      }
    }

    // Update metadata based on changes
    // Find the last committed change to get the new committedRev
    let lastCommittedRev = this._committedRev;
    let hasPendingChanges = false;

    for (const change of changes) {
      if (change.committedAt > 0) {
        lastCommittedRev = change.rev;
      } else {
        hasPendingChanges = true;
      }
    }

    this._committedRev = lastCommittedRev;
    this._hasPending = hasPendingChanges;

    this.onUpdate.emit(this._state);
  }
}
