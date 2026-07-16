import { applyCommittedChanges } from '../algorithms/ot/client/applyCommittedChanges.js';
import { applyChanges } from '../algorithms/ot/shared/applyChanges.js';
import { breakChanges } from '../algorithms/ot/shared/changeBatching.js';
import { computePendingEjection } from '../algorithms/ot/shared/ejectPendingChange.js';
import { rebaseChanges } from '../algorithms/ot/shared/rebaseChanges.js';
import { createChange } from '../data/change.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot, QuarantinedChange } from '../types.js';
import type { ClientAlgorithm } from './ClientAlgorithm.js';
import type { OTClientStore } from './OTClientStore.js';
import { OTDoc } from './OTDoc.js';
import type { PatchesDoc, PatchesDocOptions } from './PatchesDoc.js';
import type { TrackedDoc } from './PatchesStore.js';

/**
 * How far back in the committed tail to scan for a change id — on an idempotent retry (in
 * case the original submit committed between attempts) and when checking a suspect pending
 * change for an already-committed copy (DAB-607). Also bounds the per-doc in-memory record
 * of committed ids. Bounded so the scans stay cheap; a just-committed change sits at the
 * head, so a small window catches the realistic cases.
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

  /**
   * Per-doc record of recently committed change ids applied by this instance (see
   * {@link _noteCommittedIds}). Used to recognize a stranded pending copy of an
   * already-committed change regardless of how rebases have re-stamped it.
   */
  private readonly _recentCommittedIds = new Map<string, Set<string>>();

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
    const pending = await this._dropCommittedStragglers(docId, snapshot.changes, snapshot.rev);
    if (pending.length === 0) return null;
    return this._withConsistentBaseRev(docId, pending, snapshot.rev);
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

      // If doc is open, add any in-memory pending changes not yet in store. Identity is
      // the change ID — the rev comparison alone re-injects id-duplicates whenever the
      // doc's frame has drifted from the store's (a torn reload renumbers the store queue
      // while the open doc still holds the old frame), and a duplicated pending change
      // eventually commits twice once its rebased baseRev moves past the server's dedup
      // window (P3 duplicate, fuzz seed 1000319). The rev guard stays as the ordering
      // filter: a stale lower-frame copy of a change the store rebased away must not
      // resurrect either.
      if (doc) {
        const otDoc = doc as OTDoc<T>;
        const inMemoryPending = otDoc.getPendingChanges();
        const latestRev = currentSnapshot.changes[currentSnapshot.changes.length - 1]?.rev ?? currentSnapshot.rev;
        const storedIds = new Set(currentSnapshot.changes.map(change => change.id));
        const newChanges = inMemoryPending.filter(change => change.rev > latestRev && !storedIds.has(change.id));
        currentSnapshot.changes.push(...newChanges);
      }

      // A pending change whose id this instance has already seen committed-and-applied is a
      // strand (a raced pending write re-queued it after its echo cleared it). Drop it before
      // the rebase: leaving it in the queue advances foreign ops through content the committed
      // state already contains (shifting the tail's frame) and re-sends it as a duplicate on
      // the next flush (DAB-607). Safe because ids enter the memory only AFTER their batch's
      // store write resolved — committedRev is past them, so a remembered id can never be a
      // live echo arriving in this batch's newServerChanges (which rebaseChanges must keep for
      // its in-walk frame advance).
      const remembered = this._recentCommittedIds.get(docId);
      if (remembered && currentSnapshot.changes.length > 0) {
        currentSnapshot.changes = currentSnapshot.changes.filter(change => !remembered.has(change.id));
      }

      // Use the OT algorithm to apply server changes and rebase pending
      const newSnapshot = applyCommittedChanges(currentSnapshot, serverChanges);

      // Save to store atomically
      await this.store.applyServerChanges(docId, serverChanges, newSnapshot.changes);
      this._noteCommittedIds(docId, serverChanges);

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

      // Install the reconciled tail AND swap the pending queue in ONE store transaction.
      // Both halves of this call were once separate steps, and each seam was a real bug:
      // - drop-then-save for the pending swap discarded the ENTIRE rebased set when the
      //   save leg failed after the drop leg committed (P3 silent-loss, fuzz seed 1000126);
      // - swapping pending WITHOUT installing the tail (leaving that to the caller's
      //   later saveDoc) left the store torn when that save failed: pending renumbered
      //   onto the tail's frame while committedRev lagged behind it. Mints then numbered
      //   off the stale frame (a non-monotonic queue) and the doc/store frame skew made
      //   a resend sail past the server's baseRev-scoped id dedup — the same change
      //   committed twice (P3 duplicate, fuzz seed 1000319).
      // The store contract makes this pairing native: applyServerChanges appends the
      // committed changes and replaces pending atomically. The caller's subsequent
      // saveDoc merely compacts what is then already-consistent state.
      await this.store.applyServerChanges(docId, committedChanges, rebased);
      this._noteCommittedIds(docId, committedChanges);
    });
  }

  // --- Quarantine (poison-pill ejection) ---

  /**
   * Local strict-apply probe corroborating a server rejection of a pending change: does the
   * named change apply cleanly against the frame it was minted in — committed state advanced
   * through its predecessors in the pending queue? Returns true when it applies cleanly, or
   * when no pending change matches the id.
   *
   * Unlike LWW (whose sending change is always based on committed-only state), an OT pending
   * change is a sequential program: change N is expressed on top of changes 1..N-1, so the
   * probe must advance through the predecessors to reach the right base — probing against
   * committed-only or full-pending state would both misjudge it.
   *
   * PatchesSync auto-ejects only when this returns FALSE (the server's suspicion is
   * corroborated by a genuinely un-appliable change). A change the server rejected on policy
   * grounds — e.g. a role that may not write this path — still applies cleanly locally, so it
   * returns true and the doc latches with `data.changeId` surfaced for the app to eject on
   * consent (see docs/quarantine.md).
   */
  async verifyPendingChange(docId: string, changeId: string): Promise<boolean> {
    return this._withDocLock(docId, async () => {
      const snapshot = await this.store.getDoc(docId);
      if (!snapshot) return true;
      const index = snapshot.changes.findIndex(change => change.id === changeId);
      if (index === -1) return true;
      // Reconstruct the frame the named change was minted in. If a PREDECESSOR won't
      // strict-apply, we can't build that frame — so we can't corroborate the server's
      // suspicion about THIS change. Fail toward true (don't auto-eject; the doc latches for
      // app consent), never toward a false that would auto-discard a change we couldn't probe.
      let preState;
      try {
        preState = applyChanges(snapshot.state, snapshot.changes.slice(0, index));
      } catch {
        return true;
      }
      try {
        applyPatch(preState, snapshot.changes[index].ops, { strict: true, silent: true });
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * Move the named pending change into quarantine and rebase its successors as though it had
   * never been minted, then bring the open doc back in line with the store. The rebase math
   * lives in {@link computePendingEjection}; this method sequences it under the doc lock and
   * persists the result atomically via the store.
   *
   * Returns null (nothing mutated) when the id doesn't match a pending change, or when the
   * ejected change can't be inverted — a mismatch leaves the doc latched rather than risking a
   * half-rebased queue.
   */
  async ejectPendingChange(
    docId: string,
    changeId: string,
    reason: string,
    doc?: PatchesDoc<any>
  ): Promise<QuarantinedChange | null> {
    const quarantined = await this._withDocLock(docId, async () => {
      const snapshot = await this.store.getDoc(docId);
      if (!snapshot) return null;
      let ejection;
      try {
        ejection = computePendingEjection(snapshot.state, snapshot.rev, snapshot.changes, changeId);
      } catch (err) {
        console.error(`Cannot eject change ${changeId} from doc ${docId} (inversion failed); leaving it latched:`, err);
        return null;
      }
      if (!ejection) return null;
      return this.store.quarantinePendingChange(docId, ejection.poison, reason, ejection.newPending);
    });
    if (!quarantined) return null;

    // The commit that named this change was rejected, so no server echo is coming for it. The
    // store no longer holds it (nor its influence on the successors), so rebuild the open doc
    // from the reconciled store state. import() (not applyChanges) because ejection doesn't
    // advance committedRev — there is no incremental step to apply.
    if (doc) {
      const snapshot = await this.loadDoc(docId);
      (doc as OTDoc<any>).import(snapshot ?? { state: {}, rev: 0, changes: [] });
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

  async trackDocs(docIds: string[]): Promise<void> {
    return this.store.trackDocs(docIds, 'ot');
  }

  async untrackDocs(docIds: string[]): Promise<void> {
    docIds.forEach(docId => this._recentCommittedIds.delete(docId));
    return this.store.untrackDocs(docIds);
  }

  async listDocs(includeDeleted?: boolean): Promise<TrackedDoc[]> {
    return this.store.listDocs(includeDeleted);
  }

  async getCommittedRev(docId: string): Promise<number> {
    return this.store.getCommittedRev(docId);
  }

  async deleteDoc(docId: string): Promise<void> {
    this._recentCommittedIds.delete(docId);
    // Under the lock too: a delete must not race an in-flight mint/apply for the doc.
    return this._withDocLock(docId, () => this.store.deleteDoc(docId));
  }

  async confirmDeleteDoc(docId: string): Promise<void> {
    this._recentCommittedIds.delete(docId);
    return this._withDocLock(docId, () => this.store.confirmDeleteDoc(docId));
  }

  async close(): Promise<void> {
    this._recentCommittedIds.clear();
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
   * A pending change that is already committed is a strand: a raced pending write re-queued it
   * after its echo cleared it. Re-sending it commits a duplicate — its baseRev has advanced
   * past the original commit, outside the server's `startAfter: baseRev` id dedup (DAB-607).
   * Two detectors, both matched by id, dropped from the store and the outgoing batch:
   * - The in-memory committed-id record catches any strand from this instance's session,
   *   including one a later foreign rebase re-stamped to a clean baseRev (rebaseChanges
   *   re-stamps every survivor, so baseRev alone can't be trusted).
   * - The recent committed tail in the store covers strands predating this instance. Only
   *   stale-baseRev queues pay that read; a store without `listChanges` skips it. Bounded by
   *   {@link RECENT_COMMITTED_ID_WINDOW}, so a strand older than the window (or compacted
   *   into a snapshot) can still slip through — the server-side guard is the eventual
   *   backstop for that tail risk.
   */
  private async _dropCommittedStragglers(docId: string, pending: Change[], committedRev: number): Promise<Change[]> {
    const remembered = this._recentCommittedIds.get(docId);
    const committedIds = new Set<string>();
    for (const change of pending) {
      if (remembered?.has(change.id)) committedIds.add(change.id);
    }
    if (this.store.listChanges && !pending.every(c => c.baseRev === committedRev)) {
      const recent = await this._recentCommittedChanges(docId, committedRev);
      // listChanges merges committed and pending rows; only server-committed copies count
      // (committedAt is server-stamped, 0 on pending), so a torn pending row can't self-confirm.
      for (const change of recent) {
        if (change.committedAt > 0 && change.rev <= committedRev) committedIds.add(change.id);
      }
    }
    if (committedIds.size === 0) return pending;

    const stranded: Change[] = [];
    const survivors: Change[] = [];
    for (const change of pending) {
      (committedIds.has(change.id) ? stranded : survivors).push(change);
    }
    if (stranded.length === 0) return pending;
    console.warn(
      `[patches] Dropping ${stranded.length} already-committed pending change(s) for ${docId} ` +
        `(${stranded.map(c => c.id).join(',')}) instead of re-sending them as duplicates.`
    );
    await this._withDocLock(docId, () =>
      this.store.dropPendingChanges(
        docId,
        stranded.map(c => c.id)
      )
    );
    // Remember store-scan hits too: an open doc's in-memory copy of a dropped strand can be
    // re-injected into the store by a later receive (applyServerChanges' pending merge), and
    // only the id record survives the rebase re-stamping to catch it again.
    this._noteCommittedIds(docId, stranded);
    return survivors;
  }

  /**
   * Record committed change ids so a strand of any of them can be recognized later, after
   * rebases have re-stamped its baseRev/rev beyond recognition. Call only AFTER the store
   * write for the batch resolves: an id in this record must imply committedRev is past it,
   * or the receive-side strand filter could strip a live echo out of the rebase walk.
   * Bounded per doc; eviction only weakens detection (falls back to the store scan).
   */
  private _noteCommittedIds(docId: string, committedChanges: Change[]): void {
    let ids = this._recentCommittedIds.get(docId);
    if (!ids) this._recentCommittedIds.set(docId, (ids = new Set()));
    for (const change of committedChanges) {
      ids.delete(change.id);
      ids.add(change.id);
    }
    while (ids.size > RECENT_COMMITTED_ID_WINDOW) {
      ids.delete(ids.values().next().value!);
    }
  }

  /** The most recent committed tail (bounded by {@link RECENT_COMMITTED_ID_WINDOW}), for id scans. */
  private async _recentCommittedChanges(docId: string, committedRev: number): Promise<Change[]> {
    if (!this.store.listChanges) return [];
    const since = Math.max(0, committedRev - RECENT_COMMITTED_ID_WINDOW);
    return this.store.listChanges(docId, { startAfter: since });
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
    const recent = await this._recentCommittedChanges(docId, committedRev);
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
