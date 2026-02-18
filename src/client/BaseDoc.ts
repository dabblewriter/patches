import { ReadonlyStoreClass, signal, store, type Store } from 'easy-signal';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import { isDocLoaded } from '../shared/utils.js';
import type { Change, ChangeMutator, DocSyncStatus, PatchesSnapshot } from '../types.js';
import type { PatchesDoc } from './PatchesDoc.js';

/**
 * Abstract base class for document implementations.
 * Contains shared state and methods used by both OTDoc and LWWDoc.
 *
 * The `change()` method captures ops and emits them via `onChange` - it does NOT
 * apply locally. The algorithm handles packaging ops, persisting them, and updating
 * the doc's state via `applyChanges()`.
 *
 * Internal methods (updateSyncStatus, applyChanges, import) are on this class but not
 * on the PatchesDoc interface, as they're only used by Algorithm and PatchesSync.
 */
export abstract class BaseDoc<T extends object = object> extends ReadonlyStoreClass<T> implements PatchesDoc<T> {
  protected _id: string;

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
   * Captures an update to the document, emitting JSON Patch ops via onChange.
   * Does NOT apply locally - the algorithm handles state updates via applyChanges.
   * @param mutator Function that uses JSONPatch methods with type-safe paths.
   */
  change(mutator: ChangeMutator<T>): void {
    const patch = createJSONPatch(mutator);
    if (patch.ops.length === 0) {
      return;
    }
    this.onChange.emit(patch.ops);
  }

  // --- Internal methods (not on PatchesDoc interface) ---

  /**
   * Updates the sync status of the document.
   * Called by PatchesSync - not part of the app-facing PatchesDoc interface.
   * @param status The new sync status.
   * @param error Optional error when status is 'error'.
   */
  updateSyncStatus(status: DocSyncStatus, error?: Error): void {
    this.syncError.state = status === 'error' ? error : undefined;
    this.syncStatus.state = status;
    this._checkLoaded();
  }

  /** Latches _isLoaded to true when the doc has data or sync has resolved. */
  protected _checkLoaded(): void {
    if (!this.isLoaded.state && isDocLoaded(this.committedRev, this.hasPending, this.syncStatus.state)) {
      this.isLoaded.state = true;
    }
  }

  /**
   * Applies changes to the document state.
   * Called by Algorithm for local changes and broadcasts - not part of PatchesDoc interface.
   *
   * For OT: Distinguishes committed (committedAt > 0) vs pending (committedAt === 0) changes.
   * For LWW: Applies all ops from changes and updates metadata.
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
