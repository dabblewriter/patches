import { createId } from 'crypto-id';
import { signal, type Unsubscriber } from '../event-signal.js';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { JSONPatch } from '../json-patch/JSONPatch.js';
import type { Change, PatchesSnapshot } from '../types.js';
import { applyChanges, rebaseChanges } from '../utils.js';

/**
 * Represents a document synchronized using JSON patches.
 * Manages committed state, pending (local-only) changes, and
 * changes currently being sent to the server.
 */
export class PatchesDoc<T extends object = object> {
  protected _id: string | null = null;
  protected _state: T;
  protected _committedState: T;
  protected _committedRev: number;
  protected _pendingChanges: Change[] = [];
  protected _sendingChanges: Change[] = [];
  protected _changeMetadata: Record<string, any> = {};

  /** Subscribe to be notified before local state changes. */
  readonly onBeforeChange = signal<(change: Change) => void>();
  /** Subscribe to be notified after local state changes are applied. */
  readonly onChange = signal<(change: Change) => void>();
  /** Subscribe to be notified whenever state changes from any source. */
  readonly onUpdate = signal<(newState: T) => void>();

  /**
   * Creates an instance of PatchesDoc.
   * @param initialState Optional initial state.
   * @param initialMetadata Optional metadata to add to generated changes.
   */
  constructor(initialState: T = {} as T, initialMetadata: Record<string, any> = {}) {
    this._committedState = structuredClone(initialState);
    this._state = structuredClone(initialState);
    this._committedRev = 0;
    this._changeMetadata = initialMetadata;
  }

  /** The unique identifier for this document, once assigned. */
  get id(): string | null {
    return this._id;
  }

  /** Current local state (committed + sending + pending). */
  get state(): T {
    return this._state;
  }

  /** Last committed revision number from the server. */
  get committedRev(): number {
    return this._committedRev;
  }

  /** Are there changes currently awaiting server confirmation? */
  get isSending(): boolean {
    return this._sendingChanges.length > 0;
  }

  /** Are there local changes that haven't been sent yet? */
  get hasPending(): boolean {
    return this._pendingChanges.length > 0;
  }

  /** Subscribe to be notified whenever value changes. */
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
    return {
      state: this._committedState,
      rev: this._committedRev,
      // Includes sending and pending changes. On import, all become pending.
      changes: [...this._sendingChanges, ...this._pendingChanges],
    };
  }

  /**
   * Imports previously exported document state.
   * Resets sending state and treats all imported changes as pending.
   */
  import(snapshot: PatchesSnapshot<T>) {
    this._committedState = structuredClone(snapshot.state); // Use structuredClone
    this._committedRev = snapshot.rev;
    this._pendingChanges = snapshot.changes ?? []; // All imported changes become pending
    this._sendingChanges = []; // Reset sending state on import
    this._recalculateLocalState();
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
  change(mutator: (draft: T, patch: JSONPatch) => void): Change | null {
    const patch = createJSONPatch(this._state, mutator);
    if (patch.ops.length === 0) {
      return null;
    }

    // Determine the client-side rev for local ordering before server assigns final rev.
    const lastPendingRev = this._pendingChanges[this._pendingChanges.length - 1]?.rev;
    const lastSendingRev = this._sendingChanges[this._sendingChanges.length - 1]?.rev;
    const latestLocalRev = Math.max(this._committedRev, lastPendingRev ?? 0, lastSendingRev ?? 0);

    // It's the baseRev that matters for sending.
    const change: Change = {
      rev: latestLocalRev + 1, // Tentative rev for local sorting
      id: createId(),
      ops: patch.ops,
      baseRev: this._committedRev,
      created: Date.now(),
      ...(Object.keys(this._changeMetadata).length > 0 && { metadata: { ...this._changeMetadata } }),
    };

    this.onBeforeChange.emit(change);

    // Apply to local state immediately
    this._state = patch.apply(this._state);
    this._pendingChanges.push(change);

    this.onChange.emit(change);
    this.onUpdate.emit(this._state);

    return change;
  }

  /**
   * Retrieves pending changes and marks them as sending.
   * @returns Array of changes ready to be sent to the server.
   * @throws Error if changes are already being sent.
   */
  getUpdatesForServer(): Change[] {
    if (this.isSending) {
      // It's generally simpler if the client waits for confirmation before sending more.
      // If overlapping requests are needed, state management becomes much more complex.
      throw new Error('Cannot get updates while previous batch is awaiting confirmation.');
    }
    if (!this.hasPending) {
      return [];
    }

    this._sendingChanges = this._pendingChanges;
    this._pendingChanges = [];

    return this._sendingChanges;
  }

  /**
   * Processes the server's response to a batch of changes sent via `getUpdatesForServer`.
   * @param serverCommit The array of committed changes from the server.
   *                     Expected to be empty (`[]`) if the sent batch was a no‑op,
   *                     or contain **one or more** `Change` objects consisting of:
   *                       • any missing history since the client's `baseRev`, followed by
   *                       • the server‑side result of the client's batch (typically the
   *                         transformed versions of the changes the client sent).
   * @throws Error if the input format is unexpected or application fails.
   */
  applyServerConfirmation(serverCommit: Change[]): void {
    if (!Array.isArray(serverCommit)) {
      throw new Error('Invalid server confirmation format: Expected an array.');
    }

    if (!this.isSending) {
      console.warn('Received server confirmation but no changes were marked as sending.');
      // Decide how to handle this - ignore? Apply if possible?
      // For now, let's ignore if the server sent something unexpected.
      if (serverCommit.length === 0) return; // Ignore empty confirmations if not sending
      // If server sent a commit unexpectedly, it implies a state mismatch. Hard to recover.
      // Maybe apply cautiously if rev matches?
      const commit = serverCommit[0];
      if (commit && commit.rev === this._committedRev + 1) {
        console.warn('Applying unexpected server commit cautiously.');
        // Proceed as if confirmation was expected
      } else {
        throw new Error('Received unexpected server commit with mismatching revision.');
      }
    }

    if (serverCommit.length === 0) {
      // Server confirmed no change; discard the sending changes.
      this._sendingChanges = [];
    } else {
      // Server responded with one *or more* changes:
      //   1. possibly earlier missing revisions produced by other clients
      //   2. followed by the server‑side commit(s) that correspond to the batch we sent.

      // Basic sanity check – final revision in the array should advance committedRev.
      const lastChange = serverCommit[serverCommit.length - 1];
      if (!lastChange.rev || lastChange.rev <= this._committedRev) {
        throw new Error(`Server commit invalid final revision: ${lastChange.rev}, expected > ${this._committedRev}`);
      }

      // 1. Discard the confirmed _sendingChanges first so that the delegated
      //    external‑update path does not attempt to rebase them.
      this._sendingChanges = [];

      // 2. Apply everything through the common external‑update handler which
      //    will update committed state, revision, rebase pending changes, etc.
      this.applyExternalServerUpdate(serverCommit);

      return; // done – external handler emitted updates
    }

    // For the zero‑length confirmation path we still need to recalc state and
    // notify listeners (the 1‑change path is handled by applyExternalServerUpdate).
    this._recalculateLocalState();
    this.onUpdate.emit(this._state);
  }

  /**
   * Applies incoming changes from the server that were *not* initiated by this client.
   * @param externalServerChanges An array of sequential changes from the server.
   */
  applyExternalServerUpdate(externalServerChanges: Change[]): void {
    if (externalServerChanges.length === 0) {
      return;
    }

    const firstChange = externalServerChanges[0];
    // Allow for gaps if server sends updates out of order, but warn.
    if (firstChange.rev && firstChange.rev <= this._committedRev) {
      console.warn(
        `Ignoring external server update starting at revision ${firstChange.rev} which is <= current committed ${this._committedRev}`
      );
      return; // Ignore already processed or irrelevant changes
    }
    // if (firstChange.rev && firstChange.rev !== this._committedRev + 1) {
    //   console.warn(`External server update starting at ${firstChange.rev} does not directly follow committed ${this._committedRev}`);
    //   // Handle potential gaps - request resync? Apply cautiously?
    // }

    const lastChange = externalServerChanges[externalServerChanges.length - 1];

    // 1. Apply to committed state
    try {
      this._committedState = applyChanges(this._committedState, externalServerChanges);
    } catch (error) {
      console.error('Failed to apply external server update to committed state:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Critical sync error applying external server update: ${errorMessage}`);
    }

    // 2. Update committed revision
    if (lastChange.rev) {
      this._committedRev = lastChange.rev;
    } else {
      console.error('External server update missing revision on last change.');
      // Cannot reliably update revision - potential state divergence
    }

    // 3. Rebase *both* sending and pending changes against the external changes
    if (this.isSending) {
      this._sendingChanges = rebaseChanges(externalServerChanges, this._sendingChanges);
    }
    if (this.hasPending) {
      this._pendingChanges = rebaseChanges(externalServerChanges, this._pendingChanges);
    }

    // 4. Recalculate local state
    this._recalculateLocalState();

    // 5. Notify listeners
    this.onUpdate.emit(this._state);
  }

  /**
   * Handles the scenario where sending changes to the server failed.
   * Moves the changes that were in the process of being sent back to the
   * beginning of the pending queue to be retried later.
   */
  handleSendFailure(): void {
    if (this.isSending) {
      console.warn(`Handling send failure: Moving ${this._sendingChanges.length} changes back to pending queue.`);
      // Prepend sending changes back to pending queue to maintain order and prioritize retry
      this._pendingChanges.unshift(...this._sendingChanges);
      this._sendingChanges = [];
      // Do NOT recalculate state here, as the state didn't actually advance
      // due to the failed send. The state should still reflect the last known
      // good state + pending changes (which now includes the failed ones).
    } else {
      console.warn('handleSendFailure called but no changes were marked as sending.');
    }
  }

  /** Recalculates _state from _committedState + _sendingChanges + _pendingChanges */
  protected _recalculateLocalState(): void {
    try {
      this._state = applyChanges(this._committedState, [...this._sendingChanges, ...this._pendingChanges]);
    } catch (error) {
      console.error('CRITICAL: Error recalculating local state after update:', error);
      // This indicates a potentially serious issue with patch application or rebasing logic.
      // Re-throw the error to allow higher-level handling (e.g., trigger resync)
      throw error;
    }
  }

  /**
   * @deprecated Use export() - kept for backward compatibility if needed.
   */
  toJSON(): PatchesSnapshot<T> {
    console.warn('PatchesDoc.toJSON() is deprecated. Use export() instead.');
    return this.export();
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
}
