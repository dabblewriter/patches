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

  /** Per-doc FIFO mutex (see {@link _withDocLock}). */
  private readonly _docLocks = new Map<string, Promise<unknown>>();

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
    metadata: Record<string, any>,
    // LWW resolves by timestamp+path and is not part of the stable-id retry path; accept the
    // params to satisfy the ClientAlgorithm interface but ignore them.
    _id?: string,
    _isRetry?: boolean
  ): Promise<Change[]> {
    if (ops.length === 0) return [];

    // Serialize per-doc so getPendingToSend's read-build-clear can't interleave with this
    // read-consolidate-save and wipe an op saved between its read and its clear.
    return this._withDocLock(docId, async () => {
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
    });
  }

  async hasPending(docId: string): Promise<boolean> {
    const sendingChange = await this.store.getSendingChange(docId);
    if (sendingChange) return true;
    const pendingOps = await this.store.getPendingOps(docId);
    return pendingOps.length > 0;
  }

  async getPendingToSend(docId: string): Promise<Change[] | null> {
    // Under the doc lock: saveSendingChange clears ALL pending ops, so an op minted by a
    // concurrent handleDocChange between the read and the clear would be silently lost.
    return this._withDocLock(docId, async () => {
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
    });
  }

  async applyServerChanges<T extends object>(
    docId: string,
    serverChanges: Change[],
    doc: PatchesDoc<T> | undefined
  ): Promise<Change[]> {
    if (serverChanges.length === 0) return [];

    return this._withDocLock(docId, async () => {
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
    });
  }

  async confirmSent(docId: string, changes: Change[]): Promise<void> {
    // Confirm only the ops in this batch: a sending change split across wire batches must keep
    // its unconfirmed remainder in the sending slot so a disconnect between batches resends it
    return this._withDocLock(docId, () =>
      this.store.confirmSendingChange(
        docId,
        changes.flatMap(c => c.ops)
      )
    );
  }

  // --- Store forwarding methods ---

  /**
   * Run `fn` exclusively per `docId`: same-doc calls run one at a time, FIFO, each to
   * completion. Makes each read-modify-write composition over the doc's pending/sending state
   * atomic against the others (mint vs send-capture vs receive vs confirm), since the store
   * calls are individually transactional but their compositions are not.
   */
  private _withDocLock<R>(docId: string, fn: () => Promise<R>): Promise<R> {
    const prior = this._docLocks.get(docId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.catch(() => undefined);
    this._docLocks.set(docId, tail);
    void tail.then(() => {
      if (this._docLocks.get(docId) === tail) this._docLocks.delete(docId);
    });
    return run;
  }

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
