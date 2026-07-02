import { applyCommittedChanges } from '../algorithms/ot/client/applyCommittedChanges.js';
import { breakChanges } from '../algorithms/ot/shared/changeBatching.js';
import { rebaseChanges } from '../algorithms/ot/shared/rebaseChanges.js';
import { createChange } from '../data/change.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot } from '../types.js';
import type { ClientAlgorithm } from './ClientAlgorithm.js';
import type { OTClientStore } from './OTClientStore.js';
import { OTDoc } from './OTDoc.js';
import type { PatchesDoc, PatchesDocOptions } from './PatchesDoc.js';
import type { TrackedDoc } from './PatchesStore.js';

/**
 * On an idempotent retry, how far back in the committed tail to scan for the change id in
 * case the original submit committed between attempts. Bounded so the scan stays cheap; a
 * just-committed change sits at the head, so a small window catches the realistic cases.
 */
const RECENT_COMMITTED_ID_WINDOW = 200;

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

  /** Per-doc FIFO mutex (see {@link _withDocLock}). */
  private readonly _docLocks = new Map<string, Promise<unknown>>();

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

  async listChanges(docId: string, options?: { startAfter?: number }): Promise<Change[]> {
    if (!this.store.listChanges) throw new Error('Store does not support listChanges');
    return this.store.listChanges(docId, options);
  }

  async handleDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T> | undefined,
    metadata: Record<string, any>,
    id?: string,
    isRetry?: boolean
  ): Promise<Change[]> {
    if (ops.length === 0) return [];

    // Serialize per-doc so a concurrent receive-rebase and this mint can't read the
    // same rev and clobber each other at the [docId, rev] store key (silent change loss).
    return this._withDocLock(docId, async () => {
      // Re-check under the lock: ops arrays are shared with the doc's optimistic queue,
      // and a receive-rebase that ran while we waited may have rebased them away.
      if (ops.length === 0) return [];

      // Idempotent retry: if this exact caller-minted change id was already accepted on a
      // prior attempt (the submit RPC timed out *after* the hub had persisted it), return the
      // existing change instead of minting+persisting+applying a duplicate. Only runs on a
      // retry, so the first submit keeps its fast path.
      if (isRetry && id) {
        const existing = await this._findChangeById(docId, doc, id);
        if (existing.length > 0) return existing;
      }

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
      const changes = this._createChangesFromOps(committedRev, pendingRev, ops, metadata, id);

      if (changes.length === 0) return [];

      // Save to store
      await this.store.savePendingChanges(docId, changes);

      // Apply changes to doc if provided (uncommitted changes have committedAt === 0)
      if (doc) {
        (doc as OTDoc<T>).applyChanges(changes);
      }

      return changes;
    });
  }

  async hasPending(docId: string): Promise<boolean> {
    const pending = await this.store.getPendingChanges(docId);
    return pending.length > 0;
  }

  async getPendingToSend(docId: string): Promise<Change[] | null> {
    // getDoc reads pending and the rev it's based on in one store transaction, so a concurrent
    // receive-rebase can't advance committedRev between the two reads. Heal only the outgoing
    // batch; the next server echo rebases the stored copy into agreement.
    const snapshot = await this.store.getDoc(docId);
    if (!snapshot || snapshot.changes.length === 0) return null;
    return this._withConsistentBaseRev(docId, snapshot.changes, snapshot.rev);
  }

  async applyServerChanges<T extends object>(
    docId: string,
    serverChanges: Change[],
    doc: PatchesDoc<T> | undefined
  ): Promise<Change[]> {
    if (serverChanges.length === 0) return [];

    // Serialize per-doc so this receive-rebase and a concurrent local mint can't read the
    // same rev and clobber each other at the [docId, rev] store key (silent change loss).
    return this._withDocLock(docId, async () => {
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
    });
  }

  async confirmSent(_docId: string, _changes: Change[]): Promise<void> {
    // For OT, nothing special needed here.
    // The server response (applyServerChanges) handles everything.
    // Pending changes remain until server commits them back.
  }

  async replacePendingChanges(docId: string, oldChanges: Change[], newChanges: Change[]): Promise<void> {
    return this._withDocLock(docId, async () => {
      // Preserve any changes minted after oldChanges was read, renumbered after the new queue.
      // `newChanges` may be empty: splitting can collapse a pending set to nothing (e.g. an
      // oversized @txt op whose delta carries no sendable ops breaks into zero pieces). The
      // local edits then amount to a no-op — clear the old pending and renumber any survivors
      // straight off the committed rev instead of reading `.rev` off an empty array.
      const oldIds = new Set(oldChanges.map(c => c.id));
      const current = await this.store.getPendingChanges(docId);
      let rev = newChanges.length > 0 ? newChanges[newChanges.length - 1].rev : await this.store.getCommittedRev(docId);
      const mintedSince = current.filter(c => !oldIds.has(c.id)).map(c => ({ ...c, rev: ++rev }));
      // applyServerChanges with no server changes atomically replaces the pending queue
      await this.store.applyServerChanges(docId, [], [...newChanges, ...mintedSince]);
    });
  }

  async dropResolvedPending(docId: string, sentChanges: Change[], committedChanges: Change[]): Promise<number> {
    return this._withDocLock(docId, async () => {
      // A sent change the server didn't echo back in its response was rebased away
      // to a no-op (its content was already committed). It will never return as a
      // server change, so applyServerChanges' rebase can't clear it — and an op like
      // a root-level replace never reduces to empty under rebase, so it would be
      // resent on every flush. Drop those by id.
      const survived = new Set(committedChanges.map(c => c.id));
      const droppedIds = sentChanges.filter(c => !survived.has(c.id)).map(c => c.id);
      if (droppedIds.length === 0) return 0;
      await this.store.dropPendingChanges(docId, droppedIds);
      return droppedIds.length;
    });
  }

  async reconcilePending(docId: string, committedChanges: Change[]): Promise<void> {
    if (committedChanges.length === 0) return;
    return this._withDocLock(docId, async () => {
      const pending = await this.store.getPendingChanges(docId);
      if (pending.length === 0) return;

      // rebaseChanges drops pending the server already committed (matched by id) and
      // transforms the survivors into the tail's frame — a pure op transform that never
      // applies the tail, so it is safe even when the local committed state is corrupt
      // (which is why the snapshot-reload recovery calling this exists at all).
      const rebased = rebaseChanges(committedChanges, pending);

      // Replace pending without touching committed history. Drop must come first: the
      // rebased changes keep their original ids, so saving them before dropping would let
      // the id-matched delete remove the rebased copies too. The crash window between the
      // two store calls loses at most the pending tail — recoverable and bounded — whereas
      // keeping an already-committed pending change doubles content permanently.
      await this.store.dropPendingChanges(
        docId,
        pending.map(c => c.id)
      );
      if (rebased.length > 0) {
        await this.store.savePendingChanges(docId, rebased);
      }
    });
  }

  // --- Store forwarding methods ---

  async trackDocs(docIds: string[]): Promise<void> {
    return this.store.trackDocs(docIds, 'ot');
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
    // Under the lock too: a delete must not race an in-flight mint/apply for the doc.
    return this._withDocLock(docId, () => this.store.deleteDoc(docId));
  }

  async confirmDeleteDoc(docId: string): Promise<void> {
    return this._withDocLock(docId, () => this.store.confirmDeleteDoc(docId));
  }

  async close(): Promise<void> {
    return this.store.close();
  }

  // --- Private helpers ---

  /**
   * Run `fn` exclusively per `docId`: same-doc calls run one at a time, FIFO, each to
   * completion (none collapsed or dropped). Makes a read-modify-write on a doc's pending
   * changes atomic against another, so a receive-rebase and a local mint can't interleave
   * between each other's read and write and clobber one change at the shared [docId, rev] key.
   *
   * The lock is per-instance, so it relies on a single OTAlgorithm serving both mint and
   * receive for a given doc (true today); two instances over one database would still race.
   * handleDocChange is additionally serialized upstream by Patches._changeQueues (mint-vs-mint,
   * which also owns onChange/optimistic-rollback); this adds the mint-vs-receive exclusion that
   * queue lacks. The overlap is harmless — independent locks, no contention.
   */
  private _withDocLock<R>(docId: string, fn: () => Promise<R>): Promise<R> {
    const prior = this._docLocks.get(docId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // Stored tail never rejects, so one failed op doesn't reject the whole chain; the caller
    // still sees `run`'s real outcome. GC the map entry once this is the last queued op.
    const tail = run.catch(() => undefined);
    this._docLocks.set(docId, tail);
    void tail.then(() => {
      if (this._docLocks.get(docId) === tail) this._docLocks.delete(docId);
    });
    return run;
  }

  /**
   * Pending OT changes all sit on `committedRev`, so the queue must share `baseRev ===
   * committedRev` — the consistency the server enforces. Re-stamp any straggler a receive-vs-mint
   * race left on a stale baseRev, and warn loudly: the re-stamp is only correct when the missed
   * rebases were pure own-change echoes (the common case). If foreign changes landed between the
   * straggler's stale baseRev and `committedRev`, its ops are in an unreconstructible frame and
   * the re-stamp commits them at shifted offsets — a straggler should never exist under the
   * per-doc lock, so any warning here points at a multi-writer store (two hubs over one database).
   */
  private _withConsistentBaseRev(docId: string, pending: Change[], committedRev: number): Change[] {
    if (pending.every(c => c.baseRev === committedRev)) return pending;
    const stale = pending.filter(c => c.baseRev !== committedRev);
    console.warn(
      `[patches] Re-stamping ${stale.length} pending change(s) for ${docId} from baseRev ` +
        `${stale.map(c => c.baseRev).join(',')} to ${committedRev}. This indicates a mint/rebase ` +
        `race (likely two client instances over one store) and can misplace ops if foreign ` +
        `changes landed in between.`
    );
    return pending.map(c => (c.baseRev === committedRev ? c : { ...c, baseRev: committedRev }));
  }

  /**
   * Find an already-stored change by its (stable, caller-supplied) id, for idempotent
   * retries. Checks pending first — the dominant case, since a "Call timed out" means the
   * hub was slow/wedged so the change is still pending when the retry arrives (pending lives
   * in shared IndexedDB, so this also covers a leader handoff to a fresh hub). As a bounded
   * backstop, scans the most-recent committed tail in case the original committed between
   * attempts.
   */
  protected async _findChangeById<T extends object>(
    docId: string,
    doc: PatchesDoc<T> | undefined,
    id: string
  ): Promise<Change[]> {
    const pending = doc ? (doc as OTDoc<T>).getPendingChanges() : await this.store.getPendingChanges(docId);
    const fromPending = pending.filter(c => c.id === id);
    if (fromPending.length > 0) return fromPending;

    if (!this.store.listChanges) return [];
    const committedRev = doc ? (doc as OTDoc<T>).committedRev : await this.store.getCommittedRev(docId);
    const since = Math.max(0, committedRev - RECENT_COMMITTED_ID_WINDOW);
    const recent = await this.store.listChanges(docId, { startAfter: since });
    return recent.filter(c => c.id === id);
  }

  /**
   * Creates Change objects from raw ops. An optional `id` mints the (first) change with a
   * caller-supplied stable id so a retried submit is idempotent end-to-end.
   */
  protected _createChangesFromOps(
    committedRev: number,
    pendingRev: number,
    ops: JSONPatchOp[],
    metadata: Record<string, any>,
    id?: string
  ): Change[] {
    const rev = pendingRev + 1;

    let changes = [createChange(committedRev, rev, ops, metadata, id)];

    if (this._options.maxStorageBytes) {
      changes = breakChanges(changes, this._options.maxStorageBytes, this._options.sizeCalculator);
    }

    return changes;
  }
}
