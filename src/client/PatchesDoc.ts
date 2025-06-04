import { createStateFromSnapshot } from '../algorithms/client/createStateFromSnapshot.js';
import { makeChange } from '../algorithms/client/makeChange.js';
import { applyChanges } from '../algorithms/shared/applyChanges.js';
import { signal, type Unsubscriber } from '../event-signal.js';
import type { JSONPatch } from '../json-patch/JSONPatch.js';
import type { Change, PatchesSnapshot, SyncingState } from '../types.js';

/**
 * Options for creating a PatchesDoc instance
 */
export interface PatchesDocOptions {
  /**
   * Maximum size in bytes for a single payload (network message).
   * Changes exceeding this will be split into multiple smaller changes.
   */
  maxPayloadBytes?: number;
}

/**
 * Represents a document synchronized using JSON patches.
 * Manages committed state, pending (local-only) changes, and
 * changes currently being sent to the server.
 */
export class PatchesDoc<T extends object = object> {
  protected _id: string | null = null;
  protected _state: T;
  protected _snapshot: PatchesSnapshot<T>;
  protected _changeMetadata: Record<string, any> = {};
  protected _syncing: SyncingState = null;
  protected readonly _maxPayloadBytes?: number;

  /** Subscribe to be notified before local state changes. */
  readonly onBeforeChange = signal<(change: Change) => void>();
  /** Subscribe to be notified after local state changes are applied. */
  readonly onChange = signal<(changes: Change[]) => void>();
  /** Subscribe to be notified whenever state changes from any source. */
  readonly onUpdate = signal<(newState: T) => void>();
  /** Subscribe to be notified when syncing state changes. */
  readonly onSyncing = signal<(newSyncing: SyncingState) => void>();

  /**
   * Creates an instance of PatchesDoc.
   * @param initialState Optional initial state.
   * @param initialMetadata Optional metadata to add to generated changes.
   * @param options Additional options for the document.
   */
  constructor(initialState: T = {} as T, initialMetadata: Record<string, any> = {}, options: PatchesDocOptions = {}) {
    this._state = structuredClone(initialState);
    this._snapshot = { state: this._state, rev: 0, changes: [] };
    this._changeMetadata = initialMetadata;
    this._maxPayloadBytes = options.maxPayloadBytes;
  }

  /** The unique identifier for this document, once assigned. */
  get id(): string | null {
    return this._id;
  }

  /** Current local state (committed + pending). */
  get state(): T {
    return this._state;
  }

  /** Are we currently syncing this document? */
  get syncing(): SyncingState {
    return this._syncing;
  }

  /** Last committed revision number from the server. */
  get committedRev(): number {
    return this._snapshot.rev;
  }

  /** Are there local changes that haven't been sent yet? */
  get hasPending(): boolean {
    return this._snapshot.changes.length > 0;
  }

  /** Subscribe to be notified whenever the state changes. */
  subscribe(onUpdate: (newValue: T) => void): Unsubscriber {
    const unsub = this.onUpdate(onUpdate);
    onUpdate(this._state);
    return unsub;
  }

  /**
   * Exports the document state for persistence.
   * NOTE: Any changes currently marked as `sending` are included in the
   * `changes` array alongside `pending` changes. On import, all changes
   * are treated as pending.
   */
  export(): PatchesSnapshot<T> {
    return structuredClone(this._snapshot);
  }

  /**
   * Imports previously exported document state.
   * Resets sending state and treats all imported changes as pending.
   */
  import(snapshot: PatchesSnapshot<T>) {
    this._snapshot = structuredClone(snapshot);
    this._state = createStateFromSnapshot(snapshot);
    this.onUpdate.emit(this._state);
  }

  /**
   * Sets metadata to be added to future changes.
   */
  setChangeMetadata(metadata: Record<string, any>) {
    this._changeMetadata = metadata;
  }

  /**
   * Applies an update to the local state, generating a patch and adding it to pending changes.
   * @param mutator Function modifying a draft state.
   * @returns The generated Change object or null if no changes occurred.
   */
  change(mutator: (draft: T, patch: JSONPatch) => void): Change[] {
    const changes = makeChange(this._snapshot, mutator, this._changeMetadata, this._maxPayloadBytes);
    if (changes.length === 0) {
      return changes;
    }
    this._state = applyChanges(this._state, changes);
    this._snapshot.changes.push(...changes);
    this.onChange.emit(changes);
    this.onUpdate.emit(this._state);
    return changes;
  }

  /**
   * Returns the pending changes for this document.
   * @returns The pending changes.
   */
  getPendingChanges(): Change[] {
    return this._snapshot.changes;
  }

  /**
   * Applies committed changes to the document. Should only be called from a sync provider.
   * @param serverChanges The changes to apply.
   * @param rebasedPendingChanges The rebased pending changes to apply.
   */
  applyCommittedChanges(serverChanges: Change[], rebasedPendingChanges: Change[]) {
    // Ensure server changes are sequential to the current committed revision
    if (this._snapshot.rev !== serverChanges[0].rev - 1) {
      throw new Error('Cannot apply committed changes to a doc that is not at the correct revision');
    }
    const pendingIds = new Set(rebasedPendingChanges.map(c => c.id));

    // Apply server changes to the base state of the snapshot
    this._snapshot.state = applyChanges(this._snapshot.state, serverChanges);
    this._snapshot.rev = serverChanges[serverChanges.length - 1].rev;

    // The rebasedPendingChanges are the new complete set of pending changes
    this._snapshot.changes = rebasedPendingChanges;

    // Recalculate the live state from the updated snapshot
    this._state = createStateFromSnapshot(this._snapshot);
    this.onUpdate.emit(this._state);
  }

  /**
   * Assigns an identifier to this document. Can only be set once.
   * @param id The unique identifier for the document.
   * @throws Error if the ID has already been set.
   */
  setId(id: string): void {
    if (this._id !== null && this._id !== id) {
      throw new Error(`Document ID cannot be changed once set. Current: ${this._id}, Attempted: ${id}`);
    }
    if (this._id === null) {
      this._id = id;
    }
  }

  /**
   * Updates the syncing state of the document.
   * @param newSyncing The new syncing state.
   */
  updateSyncing(newSyncing: SyncingState) {
    this._syncing = newSyncing;
    this.onSyncing.emit(newSyncing);
  }

  toJSON(): PatchesSnapshot<T> {
    return this.export();
  }
}
