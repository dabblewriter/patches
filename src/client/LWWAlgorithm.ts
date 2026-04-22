import { consolidateOps } from '../algorithms/lww/consolidateOps.js';
import { mergeServerWithLocal } from '../algorithms/lww/mergeServerWithLocal.js';
import { createChange } from '../data/change.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot } from '../types.js';
import type { ClientAlgorithm } from './ClientAlgorithm.js';
import type { LWWClientStore } from './LWWClientStore.js';
import { LWWDoc } from './LWWDoc.js';
import type { PatchesDoc } from './PatchesDoc.js';
import type { TrackedDoc } from './PatchesStore.js';

/**
 * LWW (Last-Write-Wins) algorithm implementation.
 *
 * LWW uses timestamps for field-level conflict resolution.
 * This algorithm owns an LWW-compatible store and handles all LWW-specific
 * logic including consolidation of ops.
 *
 * Key differences from OT:
 * - Single pending change at a time (not a list)
 * - Field-level storage with timestamps
 * - No rebasing - timestamps determine winner
 * - Doc is very thin (just state, no committed/pending tracking)
 */
export class LWWAlgorithm implements ClientAlgorithm {
  readonly name = 'lww';
  readonly store: LWWClientStore;

  constructor(store: LWWClientStore) {
    this.store = store;
  }

  createDoc<T extends object>(docId: string, snapshot?: PatchesSnapshot<T>): PatchesDoc<T> {
    return new LWWDoc<T>(docId, snapshot);
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

    const timestamp = Date.now();

    // Add timestamps to ops
    const timedOps: JSONPatchOp[] = ops.map(op => ({ ...op, ts: timestamp }));

    // Get existing pending ops that may need consolidation
    const pathPrefixes = timedOps.map(op => op.path);
    const existingOps = await this.store.getPendingOps(docId, pathPrefixes);

    // Consolidate new ops with existing ops
    const { opsToSave, pathsToDelete } = consolidateOps(existingOps, timedOps);

    // Save consolidated ops to store
    await this.store.savePendingOps(docId, opsToSave, pathsToDelete);

    // Create a change for broadcast using original timedOps (not consolidated opsToSave).
    // This preserves user intent for local listeners - e.g., "user incremented by 5 twice"
    // vs the consolidated "counter increased by 10". Store consolidation is an internal
    // optimization that shouldn't leak to observers. (uncommitted, so committedAt = 0)
    const committedRev = doc?.committedRev ?? (await this.store.getCommittedRev(docId));
    const changes = [createChange(committedRev, committedRev + 1, timedOps, metadata)];

    // Apply changes to doc if provided (local change always means pending).
    //
    // Echo-tracking override: the doc tracks `opsToSave` (the consolidated ops
    // that will actually be sent to the server) instead of `timedOps` (the
    // user-intent ops carried in the Change). Without the override, combinable
    // ops like `@inc` would never echo-match — `timedOps` carries `@inc 1` but
    // the server echoes back `@inc 2` after consolidation. Using `opsToSave`
    // lets the doc match the server echo exactly.
    //
    // Retire prior pending op keys at paths now overwritten by `opsToSave`,
    // preventing orphan-key accumulation during fast typing.
    if (doc) {
      const existingByPath = new Map(existingOps.map(op => [op.path, op]));
      const retiredInFlightOps = opsToSave
        .map(op => existingByPath.get(op.path))
        .filter((op): op is JSONPatchOp => op !== undefined);
      (doc as LWWDoc<T>).applyChanges(changes, true, {
        inFlightOpsOverride: opsToSave,
        retiredInFlightOps,
      });
    }

    return changes;
  }

  async hasPending(docId: string): Promise<boolean> {
    const sendingChange = await this.store.getSendingChange(docId);
    if (sendingChange) return true;
    const pendingOps = await this.store.getPendingOps(docId);
    return pendingOps.length > 0;
  }

  async getPendingToSend(docId: string): Promise<Change[] | null> {
    // Check for existing sending change first (for retry)
    const sendingChange = await this.store.getSendingChange(docId);
    if (sendingChange) {
      return [sendingChange];
    }

    // Get pending ops and build a change
    const pendingOps = await this.store.getPendingOps(docId);
    if (pendingOps.length === 0) {
      return null;
    }

    // Build change from pending ops
    const committedRev = await this.store.getCommittedRev(docId);
    const change = createChange(committedRev, committedRev + 1, pendingOps);

    // Atomically save as sending change and clear pending ops
    await this.store.saveSendingChange(docId, change);

    return [change];
  }

  async applyServerChanges<T extends object>(
    docId: string,
    serverChanges: Change[],
    doc: PatchesDoc<T> | undefined
  ): Promise<Change[]> {
    if (serverChanges.length === 0) return [];

    // Apply server changes to store (preserves sendingChange and pendingOps)
    await this.store.applyServerChanges(docId, serverChanges);

    // Merge server changes with pending ops only (not sending ops, which the
    // server just committed). Sending ops are already reflected in serverChanges;
    // including them would cause mergeServerWithLocal to shadow newer pending
    // ops at the same path (non-delta ops like "replace" drop local values
    // when the server touches the same path).
    const sendingChange = await this.store.getSendingChange(docId);
    const pendingOps = await this.store.getPendingOps(docId);
    const mergedChanges = mergeServerWithLocal(serverChanges, pendingOps);

    if (doc) {
      const hasPending = pendingOps.length > 0 || !!sendingChange;
      (doc as LWWDoc<T>).applyChanges(mergedChanges, hasPending);
    }

    // Return mergedChanges changes for broadcast (no rebasing needed for LWW)
    return mergedChanges;
  }

  async confirmSent(docId: string, _changes: Change[]): Promise<void> {
    // Use the LWW-specific confirmSendingChange
    await this.store.confirmSendingChange(docId);
  }

  // --- Store forwarding methods ---

  async trackDocs(docIds: string[]): Promise<void> {
    return this.store.trackDocs(docIds, 'lww');
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
}
