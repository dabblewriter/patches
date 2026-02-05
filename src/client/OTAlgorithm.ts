import { applyCommittedChanges } from '../algorithms/client/applyCommittedChanges.js';
import { breakChanges } from '../algorithms/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot } from '../types.js';
import type { ClientAlgorithm } from './ClientAlgorithm.js';
import type { OTClientStore } from './OTClientStore.js';
import { OTDoc } from './OTDoc.js';
import type { PatchesDoc, PatchesDocOptions } from './PatchesDoc.js';
import type { TrackedDoc } from './PatchesStore.js';

/**
 * OT (Operational Transformation) algorithm implementation.
 *
 * OT uses revision-based history and rebasing for concurrent edits.
 * This algorithm owns an OT-compatible store and handles all OT-specific
 * logic.
 */
export class OTAlgorithm implements ClientAlgorithm {
  readonly name = 'ot';
  readonly store: OTClientStore;

  protected readonly _options: PatchesDocOptions;

  constructor(store: OTClientStore, options: PatchesDocOptions = {}) {
    this.store = store;
    this._options = options;
  }

  createDoc<T extends object>(docId: string, snapshot?: PatchesSnapshot<T>): PatchesDoc<T> {
    return new OTDoc<T>(docId, snapshot);
  }

  async loadDoc(docId: string): Promise<PatchesSnapshot | undefined> {
    return this.store.getDoc(docId);
  }

  async handleDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T> | undefined,
    metadata: Record<string, any>
  ): Promise<Change[]> {
    if (ops.length === 0) return [];

    // Get revision info from doc if available, otherwise from store
    let committedRev: number;
    let pendingRev: number;

    if (doc) {
      const otDoc = doc as OTDoc<T>;
      const pendingChanges = otDoc.getPendingChanges();
      committedRev = otDoc.committedRev;
      pendingRev = pendingChanges[pendingChanges.length - 1]?.rev ?? committedRev;
    } else {
      // Worker scenario: get from store
      const snapshot = await this.store.getDoc(docId);
      committedRev = snapshot?.rev ?? 0;
      const pendingChanges = snapshot?.changes ?? [];
      pendingRev = pendingChanges[pendingChanges.length - 1]?.rev ?? committedRev;
    }

    // Create changes from ops
    const changes = this._createChangesFromOps(committedRev, pendingRev, ops, metadata);

    if (changes.length === 0) return [];

    // Save to store
    await this.store.savePendingChanges(docId, changes);

    // Apply changes to doc if provided (uncommitted changes have committedAt === 0)
    if (doc) {
      (doc as OTDoc<T>).applyChanges(changes);
    }

    return changes;
  }

  async getPendingToSend(docId: string): Promise<Change[] | null> {
    const pending = await this.store.getPendingChanges(docId);
    return pending.length > 0 ? pending : null;
  }

  async applyServerChanges<T extends object>(
    docId: string,
    serverChanges: Change[],
    doc: PatchesDoc<T> | undefined
  ): Promise<Change[]> {
    if (serverChanges.length === 0) return [];

    // Get current snapshot from store
    const currentSnapshot = await this.store.getDoc(docId);
    if (!currentSnapshot) {
      console.warn(`Cannot apply server changes to non-existent doc: ${docId}`);
      return [];
    }

    // If doc is open, add any in-memory pending changes not yet in store
    if (doc) {
      const otDoc = doc as OTDoc<T>;
      const inMemoryPending = otDoc.getPendingChanges();
      const latestRev = currentSnapshot.changes[currentSnapshot.changes.length - 1]?.rev ?? currentSnapshot.rev;
      const newChanges = inMemoryPending.filter(change => change.rev > latestRev);
      currentSnapshot.changes.push(...newChanges);
    }

    // Use the OT algorithm to apply server changes and rebase pending
    const newSnapshot = applyCommittedChanges(currentSnapshot, serverChanges);

    // Save to store atomically
    await this.store.applyServerChanges(docId, serverChanges, newSnapshot.changes);

    // Build the changes to return for broadcast
    const changesToBroadcast = [...serverChanges, ...newSnapshot.changes];

    // Update doc if open
    if (doc) {
      const otDoc = doc as OTDoc<T>;
      if (otDoc.committedRev === serverChanges[0].rev - 1) {
        // Doc is at the right revision, can apply incrementally
        otDoc.applyChanges(changesToBroadcast);
      } else {
        // Doc is out of sync, do a full import
        otDoc.import(newSnapshot as PatchesSnapshot<T>);
      }
    }

    return changesToBroadcast;
  }

  async confirmSent(_docId: string, _changes: Change[]): Promise<void> {
    // For OT, nothing special needed here.
    // The server response (applyServerChanges) handles everything.
    // Pending changes remain until server commits them back.
  }

  // --- Store forwarding methods ---

  async trackDocs(docIds: string[]): Promise<void> {
    return this.store.trackDocs(docIds);
  }

  async untrackDocs(docIds: string[]): Promise<void> {
    return this.store.untrackDocs(docIds);
  }

  async listDocs(includeDeleted?: boolean): Promise<TrackedDoc[]> {
    return this.store.listDocs(includeDeleted);
  }

  async getCommittedRev(docId: string): Promise<number> {
    return this.store.getCommittedRev(docId);
  }

  async deleteDoc(docId: string): Promise<void> {
    return this.store.deleteDoc(docId);
  }

  async confirmDeleteDoc(docId: string): Promise<void> {
    return this.store.confirmDeleteDoc(docId);
  }

  async close(): Promise<void> {
    return this.store.close();
  }

  // --- Private helpers ---

  /**
   * Creates Change objects from raw ops.
   */
  protected _createChangesFromOps(
    committedRev: number,
    pendingRev: number,
    ops: JSONPatchOp[],
    metadata: Record<string, any>
  ): Change[] {
    const rev = pendingRev + 1;

    let changes = [createChange(committedRev, rev, ops, metadata)];

    if (this._options.maxStorageBytes) {
      changes = breakChanges(changes, this._options.maxStorageBytes, this._options.sizeCalculator);
    }

    return changes;
  }
}
