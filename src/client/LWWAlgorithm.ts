import { consolidateOps } from '../algorithms/lww/consolidateOps.js';
import { mergeServerWithLocal } from '../algorithms/lww/mergeServerWithLocal.js';
// MissingChangesError is algorithm-agnostic (a rev-gap signal PatchesSync recovers from via
// getChangesSince); it lives in the OT tree for historical reasons.
import { MissingChangesError } from '../algorithms/ot/client/applyCommittedChanges.js';
import { createChange } from '../data/change.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot, QuarantinedChange } from '../types.js';
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

  /**
   * Change ids of the batch most recently confirmed via {@link confirmSent}, per doc.
   * The commit response that follows carries the same ids; {@link applyServerChanges}
   * uses them to recognize the response and exempt it from the stale-batch guard —
   * a response's corrections are authoritative even when its rev doesn't advance ours
   * (e.g. a retried send whose every op lost to already-known newer-ts fields).
   */
  private readonly _expectedResponseIds = new Map<string, Set<string>>();

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
      // Cross-batch ordering guard. The server assigns increasing revs (one per commit) and
      // committedRev = R means every committed field through rev R is already incorporated
      // (responses carry the full catch-up window, broadcasts carry whole commits). Three
      // cases per incoming change, walked with a cursor so multi-change batches stay ordered:
      // - STALE (rev <= cursor with baseRev also behind): everything in it is already
      //   reflected locally; applying it would regress newer committed fields to older
      //   values (the field-keyed store has no cross-batch comparison). Skip it wholesale.
      // - GAP (baseRev > cursor): we missed an earlier commit (e.g. a dropped SSE event).
      //   Silently advancing would strand the missed ops forever — no later catch-up asks
      //   below the advanced rev — so throw MissingChangesError; PatchesSync recovers by
      //   pulling the tail via getChangesSince (same contract as OT).
      // - Our own commit response (matched by the change ids confirmSent recorded) is exempt
      //   from both: its baseRev is the rev we sent from (behind by design on a retry), and
      //   its correction ops must apply even when they carry old revs — the server's
      //   resolution of what we sent, not a re-delivery.
      const committedRev = await this.store.getCommittedRev(docId);
      const expectedIds = this._expectedResponseIds.get(docId);
      let cursor = committedRev;
      const effectiveChanges: Change[] = [];
      for (const change of serverChanges) {
        // Non-destructive match: a server that echoes commits back to the origin client
        // delivers the SAME id twice — once as a broadcast, once as the commit response. A
        // destructive first-match let the broadcast consume the exemption, and the response's
        // correction ops (the server's resolution of what we sent) then stale-skipped
        // (DAB-601). The set is replaced wholesale by the next confirmSent, so tolerating the
        // duplicate is safe; re-applying an echo is idempotent for the field-keyed store.
        if (expectedIds?.has(change.id)) {
          effectiveChanges.push(change);
          cursor = Math.max(cursor, change.rev);
          continue;
        }
        if (change.rev <= cursor && change.baseRev < cursor) continue; // stale re-delivery
        if (change.baseRev > cursor) {
          throw new MissingChangesError(cursor + 1, change.rev, cursor);
        }
        effectiveChanges.push(change);
        cursor = Math.max(cursor, change.rev);
      }
      if (effectiveChanges.length === 0) return [];

      // Apply server changes to store (preserves sendingChange and pendingOps)
      await this.store.applyServerChanges(docId, effectiveChanges);

      // Merge server changes with sending + pending ops so a concurrent foreign broadcast
      // arriving mid-flight can't clobber the in-flight value in the open doc. By the time our
      // own commit response arrives, confirmSent has already cleared the sending slot, so the
      // server's correction ops apply unshadowed (a sending op that legitimately loses self-heals
      // there). Pending ops come last so a newer pending op at the same path wins the merge.
      const sendingChange = await this.store.getSendingChange(docId);
      const pendingOps = await this.store.getPendingOps(docId);
      const mergedChanges = mergeServerWithLocal(effectiveChanges, [...(sendingChange?.ops ?? []), ...pendingOps]);

      if (doc) {
        const hasPending = pendingOps.length > 0 || !!sendingChange;
        (doc as LWWDoc<T>).applyChanges(mergedChanges, hasPending);
      }

      // Return mergedChanges changes for broadcast (no rebasing needed for LWW)
      return mergedChanges;
    });
  }

  async confirmSent(docId: string, changes: Change[]): Promise<JSONPatchOp[]> {
    // Remember the batch's ids so the commit response that follows is recognized as such
    // (see _expectedResponseIds). Replaced wholesale per confirm — at most one commit
    // response is outstanding per doc, so ids from an aborted earlier flush can't pile up.
    this._expectedResponseIds.set(docId, new Set(changes.map(c => c.id)));
    // Confirm only the ops in this batch: a sending change split across wire batches must keep
    // its unconfirmed remainder in the sending slot so a disconnect between batches resends it.
    // Returns the store's LOCAL corrections (sent ops that lost to a newer committed row, or
    // folded deltas): a non-empty result means the open doc's optimistic values for those
    // paths are stale and the caller must re-sync the doc from the store — without waiting on
    // the commit response, whose apply is a separate transaction that may never land (the
    // ack-persist crash window).
    return this._withDocLock(docId, () =>
      this.store.confirmSendingChange(
        docId,
        changes.flatMap(c => c.ops)
      )
    );
  }

  /**
   * Local strict-apply probe against committed-only state. The only pending identity the
   * server can name is the sending change's id; pendingOps have no ids.
   */
  async verifyPendingChange(docId: string, changeId: string): Promise<boolean> {
    return this._withDocLock(docId, async () => {
      const sending = await this.store.getSendingChange(docId);
      if (!sending || sending.id !== changeId) return true;
      const { state } = await this.store.getCommittedState(docId);
      try {
        applyPatch(state, sending.ops, { strict: true, silent: true });
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * Eject the sending change into quarantine (one store transaction) and rebuild the
   * open doc without it; pendingOps minted since capture survive and flush next.
   */
  async ejectPendingChange(
    docId: string,
    changeId: string,
    reason: string,
    doc?: PatchesDoc<any>,
    opts?: { onlyIfUnappliable?: boolean }
  ): Promise<QuarantinedChange | null> {
    const quarantined = await this._withDocLock(docId, async () => {
      // Re-corroborate under the lock when asked (see ClientAlgorithm.ejectPendingChange):
      // the sending slot is immutable, but committed state can advance between the caller's
      // probe and this call, making the change appliable again.
      if (opts?.onlyIfUnappliable) {
        const sending = await this.store.getSendingChange(docId);
        if (sending && sending.id === changeId) {
          const { state } = await this.store.getCommittedState(docId);
          try {
            applyPatch(state, sending.ops, { strict: true, silent: true });
            return null; // Applies cleanly now — no longer poison; a plain retry will commit it.
          } catch {
            // Still un-appliable — proceed with the ejection.
          }
        }
      }
      return this.store.quarantineSendingChange(docId, changeId, reason);
    });
    if (!quarantined) return null;
    // The commit that triggered ejection was rejected, so no response is coming for it.
    this._expectedResponseIds.delete(docId);
    // import() rebuilds the open doc from the store (which no longer holds the ejected
    // ops); applySnapshot won't work here because ejection doesn't advance the committed
    // rev past its strictly-greater guard.
    if (doc) {
      const snapshot = await this.loadDoc(docId);
      (doc as LWWDoc).import(snapshot ?? { state: {}, rev: 0, changes: [] });
    }
    return quarantined;
  }

  async listQuarantinedChanges(docId?: string): Promise<QuarantinedChange[]> {
    return this.store.listQuarantinedChanges(docId);
  }

  async discardQuarantinedChange(docId: string, changeId: string): Promise<void> {
    return this.store.discardQuarantinedChange(docId, changeId);
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
    for (const docId of docIds) this._expectedResponseIds.delete(docId);
    return this.store.untrackDocs(docIds);
  }

  async listDocs(includeDeleted?: boolean): Promise<TrackedDoc[]> {
    return this.store.listDocs(includeDeleted);
  }

  async getCommittedRev(docId: string): Promise<number> {
    return this.store.getCommittedRev(docId);
  }

  async deleteDoc(docId: string): Promise<void> {
    this._expectedResponseIds.delete(docId);
    return this.store.deleteDoc(docId);
  }

  async confirmDeleteDoc(docId: string): Promise<void> {
    return this.store.confirmDeleteDoc(docId);
  }

  async close(): Promise<void> {
    return this.store.close();
  }
}
