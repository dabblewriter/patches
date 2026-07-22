import { MissingChangesError } from '../algorithms/ot/client/applyCommittedChanges.js';
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
 * Bound on the conflict-safe replace retries (applyServerChanges / replacePendingChanges /
 * reconcilePending / ejectPendingChange). Each retry reads a strictly larger pending tail and
 * mints are human-paced, so the loop converges in one or two passes; the bound only guards
 * against a pathological store, and exceeding it throws rather than looping forever.
 */
const APPLY_CONFLICT_RETRIES = 10;

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

  protected readonly _options: PatchesDocOptions;

  /**
   * Minimal per-doc mutex, kept at exactly the mint-vs-receive seam (see {@link _withDocLock}).
   * Cross-context safety is the store's job (R1 in-txn rev mint, R2 conflict-safe replace); this
   * lock only closes the same-instance hole those rev-only contracts cannot express — a mint
   * reading committedRev while a concurrent receive advances it (stale baseRev) or persisting ops
   * the receive rebased away in place.
   */
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

      const changes = this._createChangesFromOps(committedRev, pendingRev, ops, metadata, id);
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

  async getPendingToSend(docId: string, doc?: PatchesDoc<any>): Promise<Change[] | null> {
    let batch: Change[];
    if (doc) {
      // Trust the open doc for pending; a ranged store read picks up any foreign tab's mints
      // (rev past the doc's tail) and appends them raw. The serial flush and the commit echo
      // rebase make that safe — the doc learns of them through the echo.
      const otDoc = doc as OTDoc<any>;
      const pending = otDoc.getPendingChanges();
      const tail = pending[pending.length - 1]?.rev ?? otDoc.committedRev;
      const delta = await this.store.getPendingChanges(docId, { startAfterRev: tail });
      // Filter the delta against the doc's own pending by id: a custom store that ignores
      // startAfterRev (back-compat) would return the whole queue, folding the doc's pending in
      // twice — a duplicate commit the server's id dedup would otherwise have to catch.
      const have = new Set(pending.map(c => c.id));
      batch = [...pending, ...delta.filter(c => !have.has(c.id))];
    } else {
      batch = await this.store.getPendingChanges(docId);
    }
    if (batch.length === 0) return null;
    return this._withConsistentBaseRev(docId, batch);
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
          for (let i = 1; i < newC.length; i++) {
            if (newC[i].rev !== newC[i - 1].rev + 1) {
              gap = true;
              break;
            }
          }
        }
        return { newC, staleC, gap };
      };

      // Trust the open doc's committedRev optimistically. The one case it is wrong is a torn
      // reload — reconcilePending advanced the store's committed tail but the doc's re-import
      // faulted — leaving the doc a frame behind the store (never ahead). That reads as a gap, so
      // re-check the store's committedRev (the authority) before declaring one; the aligned path
      // stays store-read-free.
      let committedRev = otDoc ? otDoc.committedRev : await this.store.getCommittedRev(docId);
      let { newC: newServerChanges, staleC: staleServerChanges, gap } = buildFrame(committedRev);
      if (gap && otDoc) {
        const storeRev = await this.store.getCommittedRev(docId);
        if (storeRev > committedRev) {
          committedRev = storeRev;
          ({ newC: newServerChanges, staleC: staleServerChanges, gap } = buildFrame(committedRev));
        }
      }
      if (gap) {
        throw new MissingChangesError(committedRev + 1, newServerChanges[0].rev, committedRev);
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
        rebased = newServerChanges.length > 0 ? rebaseChanges(newServerChanges, pendingSet) : pendingSet;
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
        // EXCEPT when a store-rev re-check absorbed an interior-gapped frame (newC emptied), in
        // which case the original batch is still non-contiguous — verify it here so such a batch
        // rebuilds from the store instead of advancing the in-memory watermark past skipped
        // content via the incremental apply.
        let contiguous = true;
        for (let i = 1; i < serverChanges.length; i++) {
          if (serverChanges[i].rev !== serverChanges[i - 1].rev + 1) {
            contiguous = false;
            break;
          }
        }
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

      // rebaseChanges drops pending the server already committed (matched by id) and transforms
      // the survivors into the tail's frame — a pure op transform that never applies the tail, so
      // it is safe even when the local committed state is corrupt (which is why the
      // snapshot-reload recovery calling this exists at all).
      const rebased = rebaseChanges(committedChanges, pending);

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
   * The server requires every change in one flush batch to share a baseRev. A torn reload —
   * reconcilePending advances the store's committed tail (rebasing pending to the new frame),
   * then saveDoc/import faults before the open doc follows — leaves the doc a frame behind the
   * store, so the next mint stamps its baseRev off the stale doc while the store queue already
   * moved on. Neither the in-txn rev mint nor the conflict-safe replace expresses baseRev, so
   * normalize the outgoing batch here: bump any straggler up to the freshest frame present (the
   * majority, already correctly rebased). The stragglers' ops are then a frame behind their
   * label — the server transforms them as concurrent edits and every replica converges the same
   * way; the commit echo rebases the stored copies into agreement. A consistent queue is a no-op.
   */
  private _withConsistentBaseRev(docId: string, batch: Change[]): Change[] {
    let maxBase = batch[0].baseRev;
    for (const c of batch) if (c.baseRev > maxBase) maxBase = c.baseRev;
    if (batch.every(c => c.baseRev === maxBase)) return batch;
    console.warn(
      `[patches] Normalizing ${batch.filter(c => c.baseRev !== maxBase).length} pending change(s) for ${docId} to ` +
        `baseRev ${maxBase} for a consistent flush (torn-reload straggler).`
    );
    return batch.map(c => (c.baseRev === maxBase ? c : { ...c, baseRev: maxBase }));
  }

  /**
   * The pending queue to rebase and the store tail it covers. Store rows are ground truth; when a
   * doc is open its in-memory pending is merged by change id for a torn store write (a change
   * persisted only to the doc), guarded by rev so a stale lower-frame copy the store rebased away
   * can't resurrect (P3 duplicate, fuzz seed 1000319).
   *
   * `tailRev` is the max STORE row rev, never the doc-merged max: R2's conflict check compares it
   * against the store's own pending rows, so a doc-only rev folded in here would push tailRev past
   * the store tail and hide a foreign mint landing at store-tail+1, which the replace then wipes.
   */
  private async _collectPending<T extends object>(
    docId: string,
    doc: OTDoc<T> | undefined,
    committedRev: number
  ): Promise<{ pending: Change[]; tailRev: number }> {
    const storePending = await this.store.getPendingChanges(docId);
    let pending = storePending;
    if (doc) {
      const inMemory = doc.getPendingChanges();
      const latestRev = storePending[storePending.length - 1]?.rev ?? committedRev;
      const storedIds = new Set(storePending.map(c => c.id));
      const docOnly = inMemory.filter(c => c.rev > latestRev && !storedIds.has(c.id));
      if (docOnly.length > 0) pending = [...storePending, ...docOnly];
    }
    let tailRev = committedRev;
    for (const c of storePending) if (c.rev > tailRev) tailRev = c.rev;
    return { pending, tailRev };
  }

  /**
   * Creates Change objects from raw ops. An optional `id` mints the (first) change with a
   * caller-supplied stable id so a retried submit is idempotent end-to-end (the server dedups
   * resubmitted commits by change id).
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
