import { signal } from 'easy-signal';
import { MissingChangesError } from '../algorithms/ot/client/applyCommittedChanges.js';
import { applyChanges } from '../algorithms/ot/shared/applyChanges.js';
import { breakChanges } from '../algorithms/ot/shared/changeBatching.js';
import { computePendingEjection } from '../algorithms/ot/shared/ejectPendingChange.js';
import { rebaseChanges } from '../algorithms/ot/shared/rebaseChanges.js';
import { createChange } from '../data/change.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import { UnstoredPendingError } from '../net/error.js';
import type { Change, PatchesSnapshot, QuarantinedChange } from '../types.js';
import type { ClientAlgorithm } from './ClientAlgorithm.js';
import type { OTClientStore } from './OTClientStore.js';
import { OTDoc } from './OTDoc.js';
import type { PatchesDoc, PatchesDocOptions } from './PatchesDoc.js';
import type { TrackedDoc } from './PatchesStore.js';

/**
 * Bound on the conflict-safe replace retries (applyServerChanges / replacePendingChanges /
 * reconcilePending / ejectPendingChange). Each retry reads a strictly larger pending tail and
 * mints are human-paced, so the loop converges in one or two passes; the bound only guards
 * against a pathological store, and exceeding it throws rather than looping forever.
 */
const APPLY_CONFLICT_RETRIES = 10;

/**
 * Index of the first change whose rev is not exactly one past its predecessor's — i.e. the first
 * interior hole in a rev run — or -1 when the run is fully dense. Server revs are dense per doc, so
 * any such gap in a committed batch is a delivery defect, not a legitimate sparse batch. Shared by
 * the two rev-contiguity scans in this file (buildFrame's new-change frame and applyServerChanges'
 * branch selector). OTDoc.applyChanges deliberately keeps its own inline scan as an independent
 * last-line invariant that does not lean on this layer.
 */
function firstGapIndex(changes: Change[]): number {
  for (let i = 1; i < changes.length; i++) {
    if (changes[i].rev !== changes[i - 1].rev + 1) return i;
  }
  return -1;
}

/**
 * OT (Operational Transformation) algorithm implementation.
 *
 * OT uses revision-based history and rebasing for concurrent edits.
 * This algorithm owns an OT-compatible store and handles all OT-specific
 * logic.
 *
 * Cross-context safety lives in the store, not in this class: in-transaction rev assignment
 * (savePendingChanges) is the sole sequencer, and conflict-safe replace (applyServerChanges with
 * a pendingTailRev) keeps a foreign tab's mint from being wiped by a rebase. Any tab may mint;
 * the receive-side mutations here run only in the elected writer.
 */
export class OTAlgorithm implements ClientAlgorithm {
  readonly name = 'ot';
  readonly store: OTClientStore;

  /**
   * Failures this layer can report but not resolve — currently only
   * {@link UnstoredPendingError}. PatchesSync forwards these to its own onError so they reach
   * app telemetry without every consumer having to subscribe to the algorithm.
   */
  readonly onError = signal<(error: Error, context?: { docId?: string }) => void>();

  protected readonly _options: PatchesDocOptions;

  /**
   * Minimal per-doc mutex, kept at exactly the mint-vs-receive seam (see {@link _withDocLock}).
   * Cross-context safety is the store's job (R1 in-txn rev mint, R2 conflict-safe replace); this
   * lock only closes the same-instance hole those rev-only contracts cannot express — a mint
   * reading committedRev while a concurrent receive advances it (stale baseRev) or persisting ops
   * the receive rebased away in place.
   */
  private readonly _docLocks = new Map<string, Promise<unknown>>();

  /**
   * Change ids already reported as unstored, per doc (see {@link UnstoredPendingError}). The store
   * cannot recover a row it never took, so the condition never clears: without this the same row
   * is reported on every read of the queue, for the life of the doc. Mirrors
   * `PatchesSync._surfacedSyncErrors`. Cleared when the doc is untracked or deleted — the next
   * tracking of that doc is a fresh lifetime.
   *
   * Deliberately unbounded, unlike the poison memo's MAX_POISON_MEMO_ENTRIES cap: entries here are
   * short id strings (not retained error graphs), growth requires the store to keep losing rows on
   * one tracked doc, and evicting an id resumes the per-attempt alarm spam this latch exists to
   * stop. Lifecycle clearing is the bound.
   */
  private readonly _reportedUnstored = new Map<string, Set<string>>();

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
    id?: string
  ): Promise<Change[]> {
    if (ops.length === 0) return [];

    return this._withDocLock(docId, async () => {
      // Re-check under the lock: ops arrays are shared with the doc's optimistic queue, and a
      // receive-rebase that ran while we waited may have rebased them away.
      if (ops.length === 0) return [];

      // Revision info from the open doc; else from the store (no state materialization).
      // Provisional only — savePendingChanges re-stamps rev in its own transaction from the
      // persisted tail, the sole cross-context sequencer.
      let committedRev: number;
      let pendingRev: number;
      if (doc) {
        const otDoc = doc as OTDoc<T>;
        const pendingChanges = otDoc.getPendingChanges();
        committedRev = otDoc.committedRev;
        pendingRev = pendingChanges[pendingChanges.length - 1]?.rev ?? committedRev;
      } else {
        committedRev = await this.store.getCommittedRev(docId);
        const pending = await this.store.getPendingChanges(docId);
        pendingRev = pending[pending.length - 1]?.rev ?? committedRev;
      }

      const changes = this._createChangesFromOps(committedRev, pendingRev, ops, metadata, id, docId);
      if (changes.length === 0) return [];

      // Re-stamps each change's rev in place from the persisted tail; the objects below carry it.
      await this.store.savePendingChanges(docId, changes);

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

  /**
   * The queue to put on the wire. Store rows are ground truth — the same contract the receive
   * path uses (see {@link _collectPending}) — because the store is the sole rev sequencer: a
   * context sharing it mints at the STORE's tail, which can be a rev this doc's in-memory
   * mirror already occupies. Keying the read off the mirror's tail therefore withheld any row
   * at or below it: unsent until a later echo rebuilt the queue from the store, by which point
   * changes minted after it had committed ahead of it — and the rebase against them could
   * transform it away entirely, losing content that was already persisted (DAB-946).
   *
   * Reading the store also puts foreign-context rows minted at their own committedRev into the
   * batch, so mixed baseRevs stop being rare here; {@link _withConsistentBaseRev} must transform
   * the stragglers rather than relabel them, which is #145. Ship the two together.
   *
   * Store-authoritative cuts both ways: a row the doc holds that the store does not, at or below
   * the store tail, is never put on the wire. That is deliberate (see {@link _collectPending}),
   * but it is content the user can see, so it is reported on {@link onError} rather than
   * withheld in silence.
   */
  async getPendingToSend(docId: string, doc?: PatchesDoc<any>): Promise<Change[] | null> {
    const otDoc = doc as OTDoc<any> | undefined;
    // Only the doc-merge floor needs it, and that branch needs a doc; without one the store read
    // it would take is discarded, so don't pay for it (the tailRev seed is unused here).
    const committedRev = otDoc?.committedRev ?? 0;
    const { pending, withheld } = await this._collectPending(docId, otDoc, committedRev);
    // Before the empty-queue return: a withheld row is exactly the case where the rest of the
    // queue can be empty and every other signal reads as fully synced.
    if (withheld.length > 0) {
      const reported = this._reportedUnstored.get(docId) ?? new Set<string>();
      const fresh = withheld.filter(c => !reported.has(c.id)).map(c => c.id);
      if (fresh.length > 0) {
        fresh.forEach(id => reported.add(id));
        this._reportedUnstored.set(docId, reported);
        this.onError.emit(new UnstoredPendingError(docId, fresh), { docId });
      }
    }
    if (pending.length === 0) return null;
    return this._withConsistentBaseRev(docId, pending);
  }

  /**
   * See {@link ClientAlgorithm.collectUnsyncedForDiscard}. The union {@link _collectPending}
   * already computes: the sendable queue plus the withheld doc-only rows the send path refuses
   * — refuses because they are not durable, which on a discard is the reason to include them.
   * Raw rows, no {@link _withConsistentBaseRev}: this is a shelf payload, not a wire batch, and
   * no report — the doc is legitimately vanishing, so the store-integrity alarm would misfire
   * (and the once-per-doc latch stays untouched for any doc that survives).
   */
  async collectUnsyncedForDiscard(docId: string, doc?: PatchesDoc<any>): Promise<Change[]> {
    const otDoc = doc as OTDoc<any> | undefined;
    const { pending, withheld } = await this._collectPending(docId, otDoc, otDoc?.committedRev ?? 0);
    return [...pending, ...withheld];
  }

  /** See {@link ClientAlgorithm.peekPendingHead} — the store's head row, no send-path work. */
  async peekPendingHead(docId: string): Promise<Change | null> {
    const [head] = await this.store.getPendingChanges(docId, { limit: 1 });
    return head ?? null;
  }

  async applyServerChanges<T extends object>(
    docId: string,
    serverChanges: Change[],
    doc: PatchesDoc<T> | undefined
  ): Promise<Change[]> {
    if (serverChanges.length === 0) return [];

    // Under the doc lock so a concurrent local mint on this instance can't read a stale
    // committedRev (see {@link _withDocLock}). Cross-tab foreign mints are handled by the R2
    // conflict loop below, not the lock.
    return this._withDocLock(docId, async () => {
      const otDoc = doc as OTDoc<T> | undefined;

      // Split into changes new to this frame and ones already reflected (a commit can be delivered
      // more than once: SSE broadcast + HTTP ack, re-broadcast, catchup overlap), flagging a gap.
      // Rev arithmetic is the complete gap signal — no state materialization. The
      // MissingChangesError shape matches applyCommittedChanges', so PatchesSync still routes a
      // gap to syncDoc recovery.
      const buildFrame = (base: number) => {
        const newC: Change[] = [];
        const staleC: Change[] = [];
        for (const change of serverChanges) (change.rev > base ? newC : staleC).push(change);
        let gap = false;
        // The actual hole boundary for an INTERIOR gap, so the throw below can report the real
        // missing revs. Undefined for a leading-edge gap, where newServerChanges[0].rev is already
        // the right diagnostic.
        let gapAt: { expected: number; got: number } | undefined;
        if (newC.length > 0 && newC[0].rev !== base + 1) {
          const first = newC[0];
          const isRootReplaceCatchup =
            first.ops.length === 1 && first.ops[0].op === 'replace' && first.ops[0].path === '';
          gap = !isRootReplaceCatchup;
        }
        // Interior contiguity: server revs are dense, so a hole *between* new changes (e.g.
        // [148, 151] with 149/150 dropped by a partial fan) is a delivery defect, not a
        // root-replace catchup. The first-element check above only sees the leading edge; catch
        // an interior hole too so it routes to MissingChangesError recovery (or the store-rev
        // re-check below) rather than being written to the store and skipping content.
        if (!gap) {
          const i = firstGapIndex(newC);
          if (i !== -1) {
            gap = true;
            gapAt = { expected: newC[i - 1].rev + 1, got: newC[i].rev };
          }
        }
        return { newC, staleC, gap, gapAt };
      };

      // Trust the open doc's committedRev optimistically. The one case it is wrong is a torn
      // reload — reconcilePending advanced the store's committed tail but the doc's re-import
      // faulted — leaving the doc a frame behind the store (never ahead). That reads as a gap, so
      // re-check the store's committedRev (the authority) before declaring one; the aligned path
      // stays store-read-free.
      let committedRev = otDoc ? otDoc.committedRev : await this.store.getCommittedRev(docId);
      let { newC: newServerChanges, staleC: staleServerChanges, gap, gapAt } = buildFrame(committedRev);
      if (gap && otDoc) {
        const storeRev = await this.store.getCommittedRev(docId);
        if (storeRev > committedRev) {
          committedRev = storeRev;
          ({ newC: newServerChanges, staleC: staleServerChanges, gap, gapAt } = buildFrame(committedRev));
        }
      }
      if (gap) {
        // sinceRev MUST stay committedRev — recovery pulls the tail from there and that is correct
        // regardless of where the hole is. Only the diagnostic expected/got reflect the actual
        // hole: an interior gap reports its real boundary (gapAt), a leading-edge gap the first
        // new rev.
        throw new MissingChangesError(
          gapAt?.expected ?? committedRev + 1,
          gapAt?.got ?? newServerChanges[0].rev,
          committedRev
        );
      }

      // Rebase pending and persist, retrying if a foreign mint raced the replace (R2). Each retry
      // re-reads the queue (now including the foreign rows) and recomputes.
      let rebased: Change[] = [];
      let applied = false;
      for (let attempt = 0; attempt < APPLY_CONFLICT_RETRIES; attempt++) {
        const { pending, tailRev } = await this._collectPending(docId, otDoc, committedRev);
        let pendingSet = pending;
        // A pending copy of a change already reflected in committedRev (stale echo) must be
        // dropped before the rebase, matching applyCommittedChanges; rebaseChanges drops the new
        // echoes.
        if (staleServerChanges.length > 0 && pendingSet.length > 0) {
          const staleIds = new Set(staleServerChanges.map(c => c.id));
          pendingSet = pendingSet.filter(c => !staleIds.has(c.id));
        }
        rebased = this._rebasePendingPreservingFrameDebt(newServerChanges, pendingSet, committedRev);
        const result = await this.store.applyServerChanges(docId, serverChanges, rebased, tailRev);
        if (result !== 'conflict') {
          applied = true;
          break;
        }
      }
      if (!applied) {
        throw new Error(`applyServerChanges for ${docId} did not converge after ${APPLY_CONFLICT_RETRIES} attempts`);
      }

      const changesToBroadcast = [...serverChanges, ...rebased];

      if (otDoc) {
        // `serverChanges` is internally contiguous when the frame passed the gap check above,
        // EXCEPT when the store-rev re-check re-anchored the frame off a higher store rev and so
        // absorbed an interior-gapped batch. That is broader than the newC-emptied case: if the
        // store rev sits at the hole's trailing edge (store at 150 for a batch [148, 151]), the
        // rebuilt frame passes with a NON-empty newC = [151] — leading edge clean off the store
        // rev — yet the original batch [148, 151] is still non-contiguous. Re-scan the actual
        // `serverChanges` array (not newC) here so either shape rebuilds from the store instead of
        // advancing the in-memory watermark past skipped content via the incremental apply.
        const contiguous = firstGapIndex(serverChanges) === -1;
        if (contiguous && otDoc.committedRev === serverChanges[0].rev - 1) {
          otDoc.applyChanges(changesToBroadcast);
        } else {
          // Misaligned (root-replace catchup, a stale re-delivery, or an interior-gapped batch):
          // rebuild from the store — the complete, authoritative committed state — the only
          // remaining getDoc in the receive path, paid on the rare path only.
          const snapshot = await this.loadDoc(docId);
          if (snapshot) otDoc.import(snapshot as PatchesSnapshot<T>);
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
    const oldIds = new Set(oldChanges.map(c => c.id));
    for (let attempt = 0; attempt < APPLY_CONFLICT_RETRIES; attempt++) {
      // Preserve any changes minted after oldChanges was read, renumbered after the new queue.
      // `newChanges` may be empty: splitting can collapse a pending set to nothing (e.g. an
      // oversized @txt op whose delta carries no sendable ops) — clear the old pending and
      // renumber any survivors straight off the committed rev then.
      const committedRev = await this.store.getCommittedRev(docId);
      const current = await this.store.getPendingChanges(docId);
      const tailRev = current.length > 0 ? current[current.length - 1].rev : committedRev;
      let rev = newChanges.length > 0 ? newChanges[newChanges.length - 1].rev : committedRev;
      const mintedSince = current.filter(c => !oldIds.has(c.id)).map(c => ({ ...c, rev: ++rev }));
      const result = await this.store.applyServerChanges(docId, [], [...newChanges, ...mintedSince], tailRev);
      if (result !== 'conflict') return;
    }
    throw new Error(`replacePendingChanges for ${docId} did not converge after ${APPLY_CONFLICT_RETRIES} attempts`);
  }

  async dropResolvedPending(docId: string, sentChanges: Change[], committedChanges: Change[]): Promise<number> {
    // A sent change the server didn't echo back in its response was rebased away to a no-op (its
    // content was already committed). It will never return as a server change, and an op like a
    // root-level replace never reduces to empty under rebase, so it would be resent on every
    // flush. Drop those by id.
    const survived = new Set(committedChanges.map(c => c.id));
    const droppedIds = sentChanges.filter(c => !survived.has(c.id)).map(c => c.id);
    if (droppedIds.length === 0) return 0;
    await this.store.dropPendingChanges(docId, droppedIds);
    return droppedIds.length;
  }

  async reconcilePending(docId: string, committedChanges: Change[]): Promise<void> {
    if (committedChanges.length === 0) return;
    for (let attempt = 0; attempt < APPLY_CONFLICT_RETRIES; attempt++) {
      const pending = await this.store.getPendingChanges(docId);
      if (pending.length === 0) return;
      const tailRev = pending[pending.length - 1].rev;

      // Drops pending the server already committed (matched by id) and transforms the
      // survivors into the tail's frame — a pure op transform that never applies the tail, so
      // it is safe even when the local committed state is corrupt (which is why the
      // snapshot-reload recovery calling this exists at all). The tail starts at the frame the
      // queue sits on (see the interface contract), so tail[0].rev - 1 anchors the frame-debt
      // check: a row minted a frame behind keeps its true baseRev instead of being relabeled.
      const rebased = this._rebasePendingPreservingFrameDebt(committedChanges, pending, committedChanges[0].rev - 1);

      // Install the reconciled tail AND swap the pending queue in ONE store transaction, retrying
      // if a foreign mint raced the replace (R2).
      const result = await this.store.applyServerChanges(docId, committedChanges, rebased, tailRev);
      if (result !== 'conflict') return;
    }
    throw new Error(`reconcilePending for ${docId} did not converge after ${APPLY_CONFLICT_RETRIES} attempts`);
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
    const snapshot = await this.store.getDoc(docId);
    if (!snapshot) return true;
    const index = snapshot.changes.findIndex(change => change.id === changeId);
    if (index === -1) return true;
    // Reconstruct the frame the named change was minted in. If a PREDECESSOR won't strict-apply,
    // we can't build that frame — so we can't corroborate the server's suspicion about THIS
    // change. Fail toward true (don't auto-eject; the doc latches for app consent), never toward
    // a false that would auto-discard a change we couldn't probe.
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
  }

  /**
   * Move the named pending change into quarantine and rebase its successors as though it had
   * never been minted, then bring the open doc back in line with the store. The rebase math
   * lives in {@link computePendingEjection}; this method sequences it and persists the result
   * atomically via the store, retrying if a foreign mint raced the replace (R2).
   *
   * Returns null (nothing mutated) when the id doesn't match a pending change, or when
   * `opts.onlyIfUnappliable` is set and the change now applies cleanly in its frame — a
   * server rebase between the caller's probe and this call can make yesterday's poison
   * committable, and ejecting it then would quarantine valid work and drop its dependents.
   *
   * @throws When the change can't be safely inverted (it no longer applies to its own
   *   frame, or a predecessor doesn't). Nothing is mutated and the doc stays latched.
   *   The throw is deliberate: callers must be able to tell "nothing to eject" (null)
   *   from "eject impossible" — collapsing both into null lets an app dismiss a consent
   *   flow as resolved while the doc is still wedged.
   */
  async ejectPendingChange(
    docId: string,
    changeId: string,
    reason: string,
    doc?: PatchesDoc<any>,
    opts?: { onlyIfUnappliable?: boolean }
  ): Promise<QuarantinedChange | null> {
    for (let attempt = 0; attempt < APPLY_CONFLICT_RETRIES; attempt++) {
      const snapshot = await this.store.getDoc(docId);
      if (!snapshot) return null;

      // Store tail read here, BEFORE the doc-only merge below. R2's conflict check in
      // quarantinePendingChange compares it against the store's own pending rows, so a doc-only
      // rev merged into snapshot.changes must not inflate it past the store tail — that would hide
      // a foreign mint landing at store-tail+1, which the replace then wipes.
      let tailRev = snapshot.rev;
      for (const c of snapshot.changes) if (c.rev > tailRev) tailRev = c.rev;

      // Merge doc-only in-memory pending (a torn store write) so the import below can't drop a
      // change that exists only in the open doc; it rides the rebase as a successor. Identity is
      // the change id — the rev guard keeps a stale lower-frame copy the store rebased away from
      // resurrecting.
      if (doc) {
        const otDoc = doc as OTDoc<any>;
        const inMemoryPending = otDoc.getPendingChanges();
        const latestRev = snapshot.changes[snapshot.changes.length - 1]?.rev ?? snapshot.rev;
        const storedIds = new Set(snapshot.changes.map(change => change.id));
        const newChanges = inMemoryPending.filter(change => change.rev > latestRev && !storedIds.has(change.id));
        snapshot.changes.push(...newChanges);
      }

      // The auto-eject path re-corroborates here (its earlier verifyPendingChange probe ran
      // outside any lock, and a broadcast may have rebased the queue since). Same failure posture
      // as the probe: a frame we can't reconstruct means we can't corroborate, so don't eject.
      if (opts?.onlyIfUnappliable) {
        const index = snapshot.changes.findIndex(change => change.id === changeId);
        if (index === -1) return null;
        let preState;
        try {
          preState = applyChanges(snapshot.state, snapshot.changes.slice(0, index));
        } catch {
          return null;
        }
        try {
          applyPatch(preState, snapshot.changes[index].ops, { strict: true, silent: true });
          return null; // Applies cleanly now — no longer poison; a plain retry will commit it.
        } catch {
          // Still un-appliable — proceed with the ejection.
        }
      }

      const ejection = computePendingEjection(snapshot.state, snapshot.rev, snapshot.changes, changeId);
      if (!ejection) return null;

      const quarantined = await this.store.quarantinePendingChange(
        docId,
        ejection.poison,
        reason,
        ejection.newPending,
        tailRev
      );
      if (quarantined === 'conflict') continue;
      if (!quarantined) return null;

      // The commit that named this change was rejected, so no server echo is coming for it.
      // Rebuild the open doc from the post-ejection snapshot already in hand, immediately after
      // the conflict-checked persist (same async frame) so a queued mint can't read the doc's
      // stale poison-inclusive frame. import() (not applyChanges) because ejection doesn't
      // advance committedRev. A rebuild failure must not mask the durable ejection: the entry is
      // persisted and reported; the doc heals on its next import.
      if (doc) {
        try {
          (doc as OTDoc<any>).import({ state: snapshot.state, rev: snapshot.rev, changes: ejection.newPending });
        } catch (err) {
          console.error(`Ejected change ${changeId} from doc ${docId}, but rebuilding the open doc failed:`, err);
        }
      }
      return quarantined;
    }
    throw new Error(`ejectPendingChange for ${docId} did not converge after ${APPLY_CONFLICT_RETRIES} attempts`);
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
    docIds.forEach(id => this._reportedUnstored.delete(id));
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
    this._reportedUnstored.delete(docId);
    return this.store.confirmDeleteDoc(docId);
  }

  async close(): Promise<void> {
    return this.store.close();
  }

  // --- Private helpers ---

  /**
   * Run `fn` exclusively per `docId`, FIFO. Kept at exactly one seam — mint (handleDocChange)
   * vs receive (applyServerChanges) on this instance — which the store's rev-only contracts (R1
   * in-txn mint, R2 conflict replace) cannot express: without it a mint reads committedRev while
   * a concurrent receive advances it (stale baseRev) or persists ops the receive rebased away in
   * place. Cross-context (multi-tab) safety is the store's, not this lock's — foreign tabs run
   * their own instance. All other former call sites are unlocked; they rely on the R2 contract.
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
   * The server requires every change in one flush batch to share a baseRev — the batch is a
   * sequential program expressed against that committed frame. The queue can carry rows from
   * more than one frame: a mint lands while its doc is a frame behind the store (a torn reload,
   * a follower tab that hasn't received the writer's broadcast yet), so its baseRev — and its
   * ops — sit on an older frame than siblings the receive path already rebased.
   *
   * Those frames are not interchangeable. Relabeling a straggler to the newest frame commits
   * its ops WITHOUT the transform across the intervening committed changes — committed history
   * that can never apply (the DAB-946 poison class; DAB-951). The client cannot run that
   * transform here: the committed span the straggler missed is already collapsed into local
   * state. The server can — it holds every committed change past any baseRev — so flush one
   * frame at a time: return the queue's leading run of same-baseRev changes at its TRUE
   * baseRev and leave the rest pending (flushDoc queues a follow-up pass for them; see also
   * {@link _rebasePendingPreservingFrameDebt}, which keeps a deferred row's frame honest
   * across receives). A consistent queue is a no-op.
   */
  private _withConsistentBaseRev(docId: string, batch: Change[]): Change[] {
    const baseRev = batch[0].baseRev;
    let end = 1;
    while (end < batch.length && batch[end].baseRev === baseRev) end++;
    if (end === batch.length) return batch;
    console.warn(
      `[patches] Mixed baseRev in pending queue for ${docId}: flushing ${end} change(s) at baseRev ${baseRev}, ` +
        `deferring ${batch.length - end} on other frame(s) to a follow-up flush (DAB-951).`
    );
    return batch.slice(0, end);
  }

  /**
   * Rebase the pending queue against a committed server tail without laundering frame debt.
   * `frameRev` is the committed frame the queue sits on — the frame `serverChanges` extends.
   *
   * A row minted a frame behind (`baseRev < frameRev`, see {@link _withConsistentBaseRev}) is
   * NOT in the frame this walk crosses: transforming it against `serverChanges` and relabeling
   * it to the new tip — what {@link rebaseChanges} does to every survivor — would silently
   * advance its label across the span it was already behind on, recreating the mislabeled
   * commit the flush seam refuses. Such rows keep their ops and true baseRev (dropped only when
   * `serverChanges` echoes their id — a true-baseRev flush coming back committed) and are
   * re-sequenced into their queue position; the server transforms them across everything past
   * their baseRev when they flush. Later rows minted by OTHER contexts were expressed without
   * the straggler in frame, so the walk must not advance the server ops through it either —
   * the straggler is skipped entirely, not walked. A frame-consistent queue (the invariant
   * case) takes the plain {@link rebaseChanges} path unchanged.
   */
  private _rebasePendingPreservingFrameDebt(serverChanges: Change[], pending: Change[], frameRev: number): Change[] {
    if (serverChanges.length === 0 || pending.length === 0) return pending;
    const staleIds = new Set(pending.filter(c => c.baseRev < frameRev).map(c => c.id));
    if (staleIds.size === 0) return rebaseChanges(serverChanges, pending);

    const serverIds = new Set(serverChanges.map(c => c.id));
    const rebased = rebaseChanges(
      serverChanges,
      pending.filter(c => !staleIds.has(c.id))
    );
    const rebasedById = new Map(rebased.map(c => [c.id, c]));
    let rev = serverChanges[serverChanges.length - 1].rev;
    const result: Change[] = [];
    for (const c of pending) {
      const row = staleIds.has(c.id) ? (serverIds.has(c.id) ? undefined : c) : rebasedById.get(c.id);
      if (row) result.push({ ...row, rev: ++rev });
    }
    return result;
  }

  /**
   * The pending queue to rebase and the store tail it covers. Store rows are ground truth; when a
   * doc is open its in-memory pending is merged by change id for a torn store write (a change
   * persisted only to the doc), guarded by rev so a stale lower-frame copy the store rebased away
   * can't resurrect (P3 duplicate, fuzz seed 1000319).
   *
   * The rev guard holds on both paths, but for two different reasons — decided here rather than
   * inherited from one of them:
   * - receive: a doc-only row at or below the store tail is a copy the store already rebased
   *   away, so folding it back in resurrects it (P3 above).
   * - send: the same row is not durable. Transmitting content the durable queue never accepted
   *   would leave the server holding state no local rebuild reproduces — a worse divergence than
   *   not sending — and carving the send path out re-opens the split authority this class closed.
   *
   * So the store stays authoritative and the row is withheld; `withheld` carries those rows out
   * so {@link getPendingToSend} can report the condition ({@link UnstoredPendingError}) instead
   * of leaving it indistinguishable from a fully synced doc.
   *
   * That report names one cause — a store write that reported success without persisting — and
   * that reading holds only while `latestRev` is a real store row. With an empty store queue it
   * falls back to `committedRev`, where a doc-only row at or below it would be a stale mirror
   * entry for something already committed, not a lost durable row. No reachable producer is known
   * for that case: {@link OTDoc.applyChanges} re-sequences surviving pending strictly above the
   * new committedRev, and {@link dropResolvedPending} re-syncs the open doc from the store on the
   * paths that drop rows. If a change to the rev-sequencing invariant ever opens that window,
   * split the two cases rather than let the error keep asserting the cause it can no longer prove.
   *
   * `tailRev` is the max STORE row rev, never the doc-merged max: R2's conflict check compares it
   * against the store's own pending rows, so a doc-only rev folded in here would push tailRev past
   * the store tail and hide a foreign mint landing at store-tail+1, which the replace then wipes.
   */
  private async _collectPending<T extends object>(
    docId: string,
    doc: OTDoc<T> | undefined,
    committedRev: number
  ): Promise<{ pending: Change[]; tailRev: number; withheld: Change[] }> {
    const storePending = await this.store.getPendingChanges(docId);
    let pending = storePending;
    let withheld: Change[] = [];
    if (doc) {
      const inMemory = doc.getPendingChanges();
      const latestRev = storePending[storePending.length - 1]?.rev ?? committedRev;
      const storedIds = new Set(storePending.map(c => c.id));
      const docOnly = inMemory.filter(c => !storedIds.has(c.id));
      const merged = docOnly.filter(c => c.rev > latestRev);
      if (merged.length > 0) pending = [...storePending, ...merged];
      withheld = docOnly.filter(c => c.rev <= latestRev);
    }
    let tailRev = committedRev;
    for (const c of storePending) if (c.rev > tailRev) tailRev = c.rev;
    return { pending, tailRev, withheld };
  }

  /**
   * Creates Change objects from raw ops. An optional `id` mints the (first) change with a
   * caller-supplied stable id so a retried submit is idempotent end-to-end (the server dedups
   * resubmitted commits by change id). `docId` is carried only on oversized-op reports.
   */
  protected _createChangesFromOps(
    committedRev: number,
    pendingRev: number,
    ops: JSONPatchOp[],
    metadata: Record<string, any>,
    id?: string,
    docId?: string
  ): Change[] {
    const rev = pendingRev + 1;

    let changes = [createChange(committedRev, rev, ops, metadata, id)];

    if (this._options.maxStorageBytes) {
      changes = breakChanges(changes, this._options.maxStorageBytes, this._options.sizeCalculator, {
        maxUnsplittableBytes: this._options.maxUnsplittableBytes,
        docId,
      });
    }

    return changes;
  }
}
