import { signal } from 'easy-signal';
import { MissingChangesError } from '../algorithms/ot/client/applyCommittedChanges.js';
import { reconstructMintFrame } from '../algorithms/ot/shared/applyChanges.js';
import { breakChanges, getJSONByteSize } from '../algorithms/ot/shared/changeBatching.js';
import { computePendingEjection, LossyEjectionError } from '../algorithms/ot/shared/ejectPendingChange.js';
import { rebaseChanges } from '../algorithms/ot/shared/rebaseChanges.js';
import { createChange } from '../data/change.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import {
  PendingDeferredError,
  UnstoredFrameLostError,
  UnstoredOutboxOverflowError,
  UnstoredPendingError,
} from '../net/error.js';
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
 * Ceilings on the outbox, per doc (see {@link OTAlgorithm._outbox}). The outbox exists for a
 * store that keeps refusing writes, and a latched doc keeps taking changes, so without a bound a
 * long degraded session grows the resend batch without limit against a server with its own body
 * limits (the 413 wedges of DAB-1131 / DAB-1246 are the worked cases). 500 rows is hours of
 * human-paced typing; 2 MiB of serialised ops is under the wire budget a single flush is
 * expected to carry. Past either, new rows are REFUSED and reported
 * ({@link UnstoredOutboxOverflowError}) — never evicted: a queued row is content the server has
 * not confirmed, and the newest row is the one the app was just told about and can still shelve.
 * Bytes are measured once, at queue time (a rebase moves a row's ops but does not grow them
 * materially).
 */
const MAX_OUTBOX_ROWS = 500;
const MAX_OUTBOX_BYTES = 2 * 1024 * 1024;

/**
 * How many confirmed outbox ids to remember per doc, so a row forwarded again after its echo
 * was consumed (a follower re-sending what it already sent) is not queued a second time — its
 * committed copy is on the server, the server would dedupe it, and with no echo coming it would
 * otherwise be resent on every flush for the life of the session. Oldest-first eviction; the
 * window only has to cover the forwarding round-trip, not the session.
 */
const MAX_CONFIRMED_OUTBOX_IDS = 200;

/**
 * A row held back by {@link OTAlgorithm._withConsistentBaseRev} this many times is reported
 * ({@link PendingDeferredError}). One deferral is the designed DAB-951 behaviour — the flush
 * sends one frame per pass and the follow-up pass sends the rest — so only the second, which
 * means the follow-up did not clear it, is a signal.
 */
const DEFERRAL_REPORT_THRESHOLD = 2;

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
/**
 * A change in the outbox: a row the store refused (see {@link OTAlgorithm.queueUnstoredChange})
 * or one accepted from another context ({@link OTAlgorithm.acceptUnstoredChanges}).
 *
 * A row is LIVE while `ops` is set: `ops` is the open doc's own optimistic-queue array, so the
 * doc's receive-rebases keep the row in frame and it is re-minted from `doc`'s pointers at send
 * time (baseRev = the doc's committedRev then). A row without `ops` is FROZEN: `change.baseRev`
 * is the committed frame its ops are expressed in — the doc's frame when it closed or when a
 * rebuild could not walk it forward, or the frame another context minted it in — and it goes on
 * the wire at that baseRev, no relabel; {@link OTAlgorithm.applyServerChanges} walks it forward
 * through every committed batch that extends its frame so it stays sendable in one batch with
 * the store queue. `doc` on a frozen row is bookkeeping only (the doc that still holds its
 * memory-only entry, if any).
 *
 * A row with `committedRev` set is a STUB: the commit response of a flush this instance sent has
 * confirmed it (see {@link OTAlgorithm.confirmUnstoredCommitted}), so its content is on the
 * server and it is reported, listed and counted as pending no more — but it stays in the outbox,
 * and goes out with every batch, until the frame later rows are minted in covers that rev. The
 * doc only advances when the store accepts the response's apply, and a store that refuses it (the
 * condition the outbox exists for) leaves the doc's frame — and the row in the doc's optimistic
 * queue — where it was: every later edit is minted on top of the row, and sent WITHOUT it the
 * server transforms the edit against the row's committed copy (an insert at /items/1 expressed
 * over the row's insert at /items/0 lands at /items/2). Sent with it, the server dedupes the stub
 * by id and keeps its committed copy out of the transform set, and the later rows stay in its
 * shadow. A stub is retired when the doc's own echo or import covers its rev (a frozen stub, when
 * its echo comes through {@link OTAlgorithm.applyServerChanges}); it counts toward the ceiling,
 * which is the honest bound while the doc cannot advance.
 */
interface OutboxRow {
  change: Change;
  ops?: JSONPatchOp[];
  doc?: OTDoc<any>;
  metadata?: Record<string, any>;
  /** Serialised size of the ops at queue time, against {@link MAX_OUTBOX_BYTES}. */
  bytes: number;
  /** Set once the commit response confirmed the row: the rev it committed at (a stub). */
  committedRev?: number;
}

/**
 * Reads the committed span `(fromRev, toRev]` of a doc from the server (see
 * {@link OTAlgorithm.setCommittedSpanFetcher}). May throw; the algorithm then falls back.
 */
export type CommittedSpanFetcher = (docId: string, fromRev: number, toRev: number) => Promise<Change[]>;

export class OTAlgorithm implements ClientAlgorithm {
  readonly name = 'ot';
  readonly store: OTClientStore;

  /**
   * Outbox rows committed by the server, keyed on the echo that confirmed them (see
   * {@link applyServerChanges}). Carries the committed copies — the app reports and, in a
   * multi-tab deployment, forwards them to the context that minted the row so it can drop its
   * memory-only entry (`Patches.noteUnstoredCommitted`).
   */
  readonly onUnstoredCommitted = signal<(docId: string, changes: Change[]) => void>();

  /**
   * The outbox: per doc, changes with NO store row that still have to reach the server.
   *
   * The send path reads the store (see {@link _collectPending}) because the store is the sole
   * rev sequencer, and a doc-only copy of a row the store already rebased away must never go on
   * the wire. A change the store REFUSED is a different thing — there is no store row for it to
   * conflict with and no rebased copy to duplicate — and until this existed it had exactly one
   * fate: kept in memory until the tab closed, then gone (the DAB-830 loss pattern; storage
   * hardening A1). Only rows the store never accepted enter here, only after the persist has
   * exhausted its bounded retries, and only via {@link queueUnstoredChange} /
   * {@link acceptUnstoredChanges}. A row leaves when its committed echo arrives
   * ({@link applyServerChanges}), when the server resolves it away ({@link dropResolvedPending}),
   * or when the store accepts it after all ({@link handleDocChange} under the same id). A row
   * the commit response confirmed stays as a stub until the doc's frame covers its rev (see
   * {@link OutboxRow}); a row that can neither be walked nor frozen across a span is refused
   * and reported ({@link _rebaseOutboxRows}).
   *
   * Memory only, by design: a reload loses the outbox. Nothing here is a second durability
   * tier — the app's shelf and the server's shelf back it.
   */
  private readonly _outbox = new Map<string, OutboxRow[]>();

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

  /**
   * Docs whose outbox overflow has been reported (see {@link UnstoredOutboxOverflowError}).
   * Cleared when the doc's outbox drains, so a later episode on the same doc reports again, and
   * on the same lifecycle events as {@link _reportedUnstored}.
   */
  private readonly _reportedOverflow = new Set<string>();

  /**
   * Ids of outbox rows this instance has confirmed or retired, per doc, most recent last and
   * capped at {@link MAX_CONFIRMED_OUTBOX_IDS} (see {@link acceptUnstoredChanges}).
   */
  private readonly _confirmedUnstored = new Map<string, Set<string>>();

  /**
   * How many times each pending row has been held back by {@link _withConsistentBaseRev}, per
   * doc (see {@link DEFERRAL_REPORT_THRESHOLD}). Same bound argument as {@link _reportedUnstored}:
   * entries are short ids that only enter on a deferral, and lifecycle clearing is the bound.
   */
  private readonly _deferrals = new Map<string, Map<string, number>>();

  /**
   * Reads a committed span from the server when the store cannot supply it (see
   * {@link _rebaseOutboxRows}). Supplied by the sync layer ({@link setCommittedSpanFetcher});
   * absent, an unreadable span under a row that depends on pending rows refuses the row.
   */
  private _fetchCommittedSpan?: CommittedSpanFetcher;

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

      // The store took a row the outbox was carrying (a retrySavingChanges re-drive under the
      // same stable id): the pending row is now the copy that gets sent and confirmed, so the
      // outbox copy must go — or the row goes out twice in one batch. Retired AFTER the local
      // confirm, in a finally: if applyChanges throws, the doc still holds the entry, and an
      // outbox that had already forgotten the row would leave nothing to resend it while the
      // next store rebuild re-applied the entry on top of the committed copy.
      try {
        if (doc) {
          (doc as OTDoc<T>).applyChanges(changes);
        }
      } finally {
        if (id) {
          this._removeOutboxRows(docId, [id]);
          (doc as OTDoc<T> | undefined)?._forgetUnstored(id);
        }
      }

      return changes;
    });
  }

  async hasPending(docId: string): Promise<boolean> {
    if (this.hasUnstoredChanges(docId)) return true;
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
    // Outbox rows ride BEHIND the store queue, in one batch with it: a memory-only change was
    // expressed on top of the doc's pending rows, and the server transforms a batch member only
    // against committed changes that are not the sender's own — so a pending row that has
    // already committed (resent here, deduped there) is walked out of the transform set
    // untouched rather than applied to the outbox row a second time. Sent alone it would be.
    // Every row goes out at the frame its ops are really in (a live row: the doc's committedRev
    // now; a frozen row: its own baseRev), so a row on another frame than the store queue is
    // deferred by _withConsistentBaseRev like any straggler, never relabeled into a frame it
    // was not transformed into. No store read here: nothing relabels, so nothing needs the
    // store's frame.
    //
    // Confirmed stubs ride too, for the same reason the live rows ride behind the store queue:
    // until the doc's frame covers a stub, every later row was minted over it, and only a batch
    // that carries the stub keeps the server from transforming those rows against its committed
    // copy (the server dedupes the stub by id). A batch of nothing BUT stubs has no such row to
    // shadow and is not sent.
    const outbox = this._outboxToSend(docId, pending, otDoc?.committedRev, true);
    const toSend = [...pending, ...outbox];
    if (toSend.length === 0) return null;
    if (pending.length === 0 && outbox.every(c => this._isStub(docId, c.id))) return null;
    return this._withConsistentBaseRev(docId, toSend);
  }

  /**
   * Install (or clear) the reader {@link _rebaseOutboxRows} falls back to when the store cannot
   * supply the committed span a live row has to cross and the row depends on in-frame pending
   * rows — the one case where freezing the row is not honest (see there). PatchesSync wires
   * this to the connection's `getChangesSince`.
   */
  setCommittedSpanFetcher(fetch: CommittedSpanFetcher | undefined): void {
    this._fetchCommittedSpan = fetch;
  }

  // --- Outbox (store-refused changes sent from memory) ---

  /**
   * Hand an optimistic entry the store refused to the outbox, to be sent from memory on the next
   * flush. Called by `Patches` on the exhausted-retry branch of a persist (and for changes made
   * while that doc's write path is latched), never from the normal path: the store is still
   * written first on every change, and this only runs once the persist has failed its bounded
   * attempts. `ops` must be the entry's own array — the reference `change()` emitted, which the
   * doc's optimistic queue holds — so a receive-rebase keeps the row in frame and the echo can
   * confirm the entry (see `OTDoc._markUnstored`). `id` is the stable id the failed persist used,
   * so a later successful persist and resend under it cannot double-commit (server id dedup).
   *
   * Returns the provisional change (baseRev = the doc's committedRev now, a rev after its
   * pending tail; both re-stamped at send time), or null when nothing was queued: empty ops, no
   * open doc to mint from (the caller reports that on its own emit, `unstored: false`), the
   * entry no longer held, or the outbox full (reported here, {@link UnstoredOutboxOverflowError}).
   * An id already queued returns its existing row.
   */
  queueUnstoredChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T> | undefined,
    metadata: Record<string, any>,
    id: string
  ): Change | null {
    if (ops.length === 0 || !doc) return null;
    const rows = this._outbox.get(docId) ?? [];
    // Already queued (a re-drive that failed again): still unstored, still on its way.
    const queued = rows.find(row => row.change.id === id);
    if (queued) return queued.change;
    const otDoc = doc as OTDoc<T>;
    // The entry must still be held: a write that landed and was confirmed through another
    // path while the last attempt was timing out has left the queue, and a row for it would
    // carry the id onto the wire a second time.
    if (!otDoc._markUnstored(id, ops)) return null;
    const bytes = this._sizeOf(ops);
    if (this._outboxRefuses(docId, rows, bytes)) {
      otDoc._forgetUnstored(id); // stays an ordinary optimistic entry, memory-only
      return null;
    }
    const change = this._mintOutboxChange(otDoc, ops, metadata, id, rows.length);
    rows.push({ change, ops, doc: otDoc, metadata, bytes });
    this._outbox.set(docId, rows);
    return change;
  }

  /**
   * Accept outbox rows minted by ANOTHER context (a follower tab whose store refused them and
   * that cannot send), to go out with this instance's next flush as they stand — their baseRev is
   * the frame they were expressed in and the server transforms from there. Deduped by id against
   * rows already queued AND against the ids this instance recently confirmed or retired
   * ({@link _confirmedUnstored}): a row forwarded again after its echo was consumed is on the
   * server already, and queued again it would be resent on every flush with no echo left to
   * clear it. Rows past the outbox ceiling are refused and reported (see
   * {@link UnstoredOutboxOverflowError}). Returns the number accepted.
   */
  acceptUnstoredChanges(docId: string, changes: Change[]): number {
    const rows = this._outbox.get(docId) ?? [];
    const queued = new Set(rows.map(row => row.change.id));
    const confirmed = this._confirmedUnstored.get(docId);
    let accepted = 0;
    for (const change of changes) {
      if (queued.has(change.id) || confirmed?.has(change.id) || change.ops.length === 0) continue;
      const bytes = this._sizeOf(change.ops);
      if (this._outboxRefuses(docId, rows, bytes)) break;
      queued.add(change.id);
      rows.push({ change: { ...change, ops: [...change.ops] }, bytes });
      accepted++;
    }
    if (accepted > 0) this._outbox.set(docId, rows);
    return accepted;
  }

  /**
   * The outbox rows for a doc as they stand now (copies); frozen rows keep their own frame.
   * Confirmed stubs are not listed: their content is on the server (see {@link OutboxRow}).
   */
  listUnstoredChanges(docId: string): Change[] {
    return this._outboxToSend(docId, []);
  }

  /** Whether the doc has outbox rows the server has not confirmed (stubs do not count). */
  hasUnstoredChanges(docId: string): boolean {
    return (this._outbox.get(docId) ?? []).some(row => row.committedRev === undefined);
  }

  /** Whether the outbox row `id` of `docId` is a confirmed stub (see {@link OutboxRow}). */
  private _isStub(docId: string, id: string): boolean {
    return this._outbox.get(docId)?.find(row => row.change.id === id)?.committedRev !== undefined;
  }

  /** Drop every outbox row for a doc (the doc's optimistic queue was rolled back). */
  discardUnstoredChanges(docId: string): void {
    this._outbox.delete(docId);
    this._reportedOverflow.delete(docId);
  }

  /**
   * The open doc is closing: freeze its rows in the frame they are in now (see
   * {@link _freezeOutboxRow}). The live arrays stop being rebased once the doc is gone; from here
   * {@link applyServerChanges} walks the frozen rows forward instead, and they go on the wire at
   * their own baseRev. The reference to the closing doc is dropped with the live state.
   */
  detachUnstoredChanges<T extends object>(docId: string, doc: PatchesDoc<T>): void {
    this._freezeOutboxRows(docId, doc as OTDoc<T>, true);
  }

  /** Freeze every live row of `doc` at the frame it is in now (see {@link _freezeOutboxRow}). */
  private _freezeOutboxRows(docId: string, doc: OTDoc<any>, detach = false): void {
    const gone: string[] = []; // rebased away: nothing left to send
    for (const row of this._outbox.get(docId) ?? []) {
      if (row.doc !== doc || !row.ops) continue;
      if (row.ops.length === 0) gone.push(row.change.id);
      else this._freezeOutboxRow(row, doc, detach);
    }
    if (gone.length > 0) this._removeOutboxRows(docId, gone);
  }

  /**
   * Walk the live outbox rows of `doc` through the committed span the doc is about to jump over
   * without the contiguous receive path (a rebuild from the store, a snapshot reload), from the
   * doc's committedRev up to exactly `targetRev` — the rev the doc will sit on afterwards. The
   * rows' arrays are the doc's own optimistic entries, so — exactly like _rebaseOptimisticOps —
   * they are rewritten IN PLACE, threaded behind the doc's in-frame pending queue and under
   * their real ids (an echo inside the span walks the row out rather than being transformed
   * against it), so both the doc's view (the import re-applies them raw) and the next re-mint
   * are in the new frame.
   *
   * The span is anchored on the DOC's frame, not the caller's: a doc a frame behind the store
   * (a torn reload) has the range between its rev and where `tail` starts to cross as well, and
   * that comes from the store. The store's rows are not trusted blind — `listChanges` returns
   * pending rows too, and a compaction or a torn envelope write can leave the committed run
   * short — so only a run of COMMITTED rows that starts at the doc's rev + 1, is contiguous and
   * ends at `targetRev` is walked. Anything else freezes the rows at the doc's frame instead
   * (see {@link _freezeOutboxRow}): an honest baseRev the server transforms from, never a
   * re-mint in a frame the ops are not in.
   *
   * The freeze is honest only while no IN-FRAME PENDING row sits under the outbox rows. A row
   * expressed over a store pending row P (P at /items/0, the row at /items/1 behind it) that is
   * frozen at the old frame while P is rebased to the new one becomes a straggler: P flushes
   * first and commits, the row goes alone at its frozen baseRev, and the server transforms it
   * against P's committed copy as well — P is no longer in its batch, so it is not "own" —
   * landing it a slot late (the #145 shape). So when the store cannot supply the span and such
   * rows exist, the span is taken from the server instead ({@link setCommittedSpanFetcher});
   * and when that is not possible either, the rows are REFUSED rather than frozen: dropped from
   * the outbox and reported ({@link UnstoredFrameLostError}) so the app shelves them, their
   * entries left in the doc as ordinary optimistic entries (visible, memory-only, re-driven by
   * `retrySavingChanges`). A frozen row that depends on a pending row is not safe to send alone.
   */
  private async _rebaseOutboxRows(docId: string, doc: OTDoc<any>, targetRev: number, tail?: Change[]): Promise<void> {
    const rows = (this._outbox.get(docId) ?? []).filter(row => row.doc === doc && row.ops);
    if (rows.length === 0) return;
    const frameRev = doc.committedRev;
    if (targetRev <= frameRev) return; // the doc already covers the target; nothing to cross
    // The frame-behind stragglers of the doc's queue are skipped exactly as
    // _rebasePendingPreservingFrameDebt skips them; the in-frame rows are what the outbox rows
    // were expressed over.
    const inFrame = doc.getPendingChanges().filter(c => c.baseRev >= frameRev);
    const isComplete = (span: Change[] | undefined): span is Change[] =>
      !!span &&
      span.length > 0 &&
      span[0].rev === frameRev + 1 &&
      span[span.length - 1].rev === targetRev &&
      firstGapIndex(span) === -1;
    let committed: Change[] | undefined;
    try {
      const given = (tail ?? []).filter(c => c.committedAt > 0 && c.rev > frameRev && c.rev <= targetRev);
      // The span between the doc's frame and where the given tail starts (all of it, without a
      // tail) is the store's.
      const bridgeTo = given[0]?.rev ?? targetRev + 1;
      let bridge: Change[] = [];
      if (bridgeTo > frameRev + 1) {
        if (!this.store.listChanges) throw new Error('Store does not support listChanges');
        const read = await this.store.listChanges(docId, { startAfter: frameRev });
        bridge = read.filter(c => c.committedAt > 0 && c.rev > frameRev && c.rev < bridgeTo);
      }
      committed = [...bridge, ...given].sort((a, b) => a.rev - b.rev);
    } catch {
      committed = undefined;
    }
    if (!isComplete(committed) && inFrame.length > 0) {
      // The store's span is unusable and the rows depend on pending rows: the server holds
      // every committed change past the doc's frame, so ask it before giving up on the walk.
      committed = undefined;
      if (this._fetchCommittedSpan) {
        try {
          const fetched = await this._fetchCommittedSpan(docId, frameRev, targetRev);
          const span = fetched.filter(c => c.committedAt > 0 && c.rev > frameRev && c.rev <= targetRev);
          committed = [...span].sort((a, b) => a.rev - b.rev);
        } catch {
          committed = undefined;
        }
      }
      if (!isComplete(committed)) {
        this._refuseOutboxRows(docId, doc, rows, frameRev, targetRev);
        return;
      }
    }
    if (!isComplete(committed)) {
      this._freezeOutboxRows(docId, doc);
      return;
    }
    // Echoes inside the span: the store took the committed copy while the doc was torn. Those
    // rows are confirmed by the span itself — dropped from the outbox and the doc's queue (the
    // snapshot about to be imported holds them) and reported like any other echo (a stub the
    // response already reported is not reported again).
    const spanIds = new Set(committed.map(c => c.id));
    const echoed = rows.filter(row => spanIds.has(row.change.id));
    if (echoed.length > 0) {
      const ids = echoed.map(row => row.change.id);
      const fresh = new Set(echoed.filter(row => row.committedRev === undefined).map(row => row.change.id));
      this._removeOutboxRows(docId, ids);
      doc._dropUnstored(ids);
      if (fresh.size > 0) {
        this.onUnstoredCommitted.emit(
          docId,
          committed.filter(c => fresh.has(c.id))
        );
      }
    }
    const live = rows.filter(row => !spanIds.has(row.change.id));
    if (live.length === 0) return;
    // Under their real ids, behind the in-frame pending rows they were expressed over.
    const synthetic: Change[] = live.map(row => ({ ...row.change, ops: row.ops! }));
    const rebased = rebaseChanges(committed, [...inFrame, ...synthetic]);
    const opsById = new Map(rebased.map(c => [c.id, c.ops]));
    for (const row of live) {
      const next = [...(opsById.get(row.change.id) ?? [])];
      row.ops!.length = 0;
      row.ops!.push(...next);
    }
  }

  /**
   * Stop re-minting a row from its doc: copy the live ops as they stand and stamp the doc's
   * committedRev as the row's true baseRev. From here it goes on the wire at that baseRev and
   * {@link applyServerChanges} walks it forward through the committed batches that extend its
   * frame. The doc keeps its optimistic entry (and its `_unstored` mark), so the echo still
   * confirms it; the row keeps the doc for that bookkeeping unless it is closing (`detach`).
   */
  private _freezeOutboxRow(row: OutboxRow, doc: OTDoc<any>, detach = false): void {
    if (!row.ops) return;
    row.change = { ...row.change, baseRev: doc.committedRev, ops: [...row.ops] };
    delete row.ops;
    if (detach) delete row.doc;
  }

  /**
   * The rows cannot be carried across `(fromRev, toRev]` and depend on in-frame pending rows, so
   * neither a walk nor a freeze is honest (see {@link _rebaseOutboxRows}): drop them from the
   * outbox and report them, with their ops as they stand, so the app shelves them. The doc keeps
   * each entry as an ordinary optimistic entry — visible, memory-only, re-driven under the same
   * stable id by `retrySavingChanges` — with its outbox mark removed, exactly as a row the
   * ceiling refused. Stubs are left alone: their content is on the server, their ops only carry
   * the id the server dedupes, and the doc's own bookkeeping retires their entries.
   */
  private _refuseOutboxRows(docId: string, doc: OTDoc<any>, rows: OutboxRow[], fromRev: number, toRev: number): void {
    const unconfirmed = rows.filter(row => row.committedRev === undefined);
    if (unconfirmed.length === 0) return;
    const refused = unconfirmed.filter(row => row.ops!.length > 0);
    const changes: Change[] = refused.map(row => ({ ...row.change, baseRev: fromRev, ops: [...row.ops!] }));
    this._removeOutboxRows(
      docId,
      unconfirmed.map(row => row.change.id)
    );
    for (const row of unconfirmed) doc._forgetUnstored(row.change.id);
    if (changes.length > 0) this.onError.emit(new UnstoredFrameLostError(docId, changes, fromRev, toRev), { docId });
  }

  /**
   * Walk the frozen rows sitting on `frameRev` through `serverChanges` — a committed batch that
   * extends that frame — behind the in-frame pending queue those rows were expressed over, with
   * the same {@link rebaseChanges} walk the store queue gets. A pending row's echo drops from the
   * walk untransformed, so a frozen row expressed over pending P comes out with P in frame at
   * the new tip; a foreign change is advanced through P before it meets the row. `change.ops`
   * and `baseRev` are written back, so the row is sendable in one batch with the store queue at
   * the new frame. A row whose ops transform away is dropped (nothing left to send); a row the
   * batch echoes is left for the caller's echo handling. Rows on any other frame are not touched
   * — a row below the frame is a straggler that flushes alone at its own baseRev.
   */
  private _walkFrozenOutboxRows(docId: string, frameRev: number, serverChanges: Change[], pending: Change[]): void {
    if (serverChanges.length === 0) return;
    const rows = (this._outbox.get(docId) ?? []).filter(row => !row.ops && row.change.baseRev === frameRev);
    if (rows.length === 0) return;
    const serverIds = new Set(serverChanges.map(c => c.id));
    const inFrame = pending.filter(c => c.baseRev >= frameRev);
    const rebased = rebaseChanges(serverChanges, [...inFrame, ...rows.map(row => row.change)]);
    const byId = new Map(rebased.map(c => [c.id, c]));
    const tip = serverChanges[serverChanges.length - 1].rev;
    const gone: string[] = [];
    for (const row of rows) {
      if (serverIds.has(row.change.id)) continue;
      const next = byId.get(row.change.id);
      if (next) row.change = { ...row.change, baseRev: tip, rev: next.rev, ops: next.ops };
      else gone.push(row.change.id);
    }
    if (gone.length > 0) this._removeOutboxRows(docId, gone);
  }

  /**
   * Another context reports outbox rows committed (see {@link onUnstoredCommitted} on the sending
   * side). Rows this instance still carries are dropped — their content is on the server — and
   * an open doc drops its memory-only entries once its state covers the committed rev. No
   * report of its own: the sender already made it, and a follower re-emitting it would hand the
   * app the same rows twice.
   */
  noteUnstoredCommitted(docId: string, committed: Change[]): void {
    this._confirmOutboxRows(docId, committed);
  }

  /**
   * See {@link ClientAlgorithm.confirmUnstoredCommitted}: the commit response of a flush THIS
   * instance sent. Outbox rows among `committed` are confirmed here, before the response reaches
   * the store, and reported on {@link onUnstoredCommitted} once — the echo through
   * {@link applyServerChanges} then finds nothing left to report. A store that refuses the
   * response's apply (the condition the outbox exists for) therefore cannot keep the row
   * unconfirmed and reported on every flush.
   *
   * The row is NOT dropped here: it becomes a stub (see {@link OutboxRow}) that keeps going out
   * with every batch until the doc's frame covers its committed rev. Dropped, and with the doc's
   * frame stuck below that rev by the refused apply, every later edit — minted on top of the
   * row — would go out alone and be transformed against the row's committed copy.
   */
  confirmUnstoredCommitted(docId: string, committed: Change[]): void {
    if (committed.length === 0) return;
    const rows = this._outbox.get(docId);
    if (!rows?.length) return;
    const confirmed: Change[] = [];
    const ids: string[] = [];
    for (const row of rows) {
      if (row.committedRev !== undefined) continue; // a stub resent: reported already
      const copy = committed.find(c => c.id === row.change.id);
      if (!copy) continue;
      row.committedRev = copy.rev;
      ids.push(row.change.id);
      confirmed.push(copy);
      row.doc?._noteUnstoredCommitted(row.change.id, copy.rev);
    }
    if (confirmed.length === 0) return;
    this._rememberConfirmed(docId, ids);
    // The doc may already sit at or past the rev (its echo arrived by broadcast before the
    // response): then there is nothing to shadow and the stub retires now.
    this._retireCoveredStubs(docId);
    this.onUnstoredCommitted.emit(docId, confirmed);
  }

  /** Drop the outbox rows `committed` names and tell their doc; returns the committed copies. */
  private _confirmOutboxRows(docId: string, committed: Change[]): Change[] {
    if (committed.length === 0) return [];
    const removed = this._removeOutboxRows(
      docId,
      committed.map(c => c.id)
    );
    const confirmed: Change[] = [];
    for (const row of removed) {
      const copy = committed.find(c => c.id === row.change.id);
      if (!copy) continue;
      confirmed.push(copy);
      row.doc?._noteUnstoredCommitted(row.change.id, copy.rev);
    }
    return confirmed;
  }

  /**
   * Retire the stubs of `docId` whose doc's frame now covers their committed rev (see
   * {@link OutboxRow}): nothing minted from here on can be in their shadow. A frozen stub has no
   * doc to ask and retires on its echo through {@link applyServerChanges}.
   */
  private _retireCoveredStubs(docId: string): void {
    const covered = (this._outbox.get(docId) ?? [])
      .filter(row => row.committedRev !== undefined && row.doc && row.doc.committedRev >= row.committedRev)
      .map(row => row.change.id);
    if (covered.length > 0) this._removeOutboxRows(docId, covered);
  }

  /** Serialised size of `ops` for the outbox ceiling, by the configured calculator if any. */
  private _sizeOf(ops: JSONPatchOp[]): number {
    try {
      return this._options.sizeCalculator ? this._options.sizeCalculator(ops) : getJSONByteSize(ops);
    } catch {
      return 0;
    }
  }

  /**
   * Whether a row of `bytes` would take the doc's outbox past {@link MAX_OUTBOX_ROWS} or
   * {@link MAX_OUTBOX_BYTES}. Reports the overflow once per episode (the latch clears when the
   * outbox drains, see {@link _removeOutboxRows}).
   */
  private _outboxRefuses(docId: string, rows: OutboxRow[], bytes: number): boolean {
    const used = rows.reduce((n, row) => n + row.bytes, 0);
    if (rows.length < MAX_OUTBOX_ROWS && used + bytes <= MAX_OUTBOX_BYTES) return false;
    if (!this._reportedOverflow.has(docId)) {
      this._reportedOverflow.add(docId);
      this.onError.emit(new UnstoredOutboxOverflowError(docId, rows.length, used, MAX_OUTBOX_ROWS, MAX_OUTBOX_BYTES), {
        docId,
      });
    }
    return true;
  }

  /** Mint an outbox row's wire form from the doc's pointers as they stand. */
  private _mintOutboxChange(
    otDoc: OTDoc<any>,
    ops: JSONPatchOp[],
    metadata: Record<string, any>,
    id: string,
    offset: number,
    pendingTail?: number
  ): Change {
    const pendingChanges = otDoc.getPendingChanges();
    const tail = pendingTail ?? pendingChanges[pendingChanges.length - 1]?.rev ?? otDoc.committedRev;
    return createChange(otDoc.committedRev, tail + 1 + offset, [...ops], metadata, id);
  }

  /**
   * The outbox rows for a doc in wire order, revs sequenced after `pending`. A live row is
   * re-minted from its doc's pointers now (its ops may have been rebased since it was queued,
   * and its baseRev is wherever the doc's committedRev sits); a frozen row goes at its OWN
   * baseRev — the frame its ops are in — with only its rev re-sequenced, and never below the
   * rev it was minted with, so an all-frozen outbox is not re-stamped from zero. Nothing here
   * relabels a baseRev: a row on another frame than the store queue is a straggler for
   * {@link _withConsistentBaseRev}, and {@link _walkFrozenOutboxRows} is what moves a frozen row
   * into a new frame. `committedRev` (the open doc's, when known) only seeds the rev sequence
   * for an empty store queue.
   *
   * Stubs (see {@link OutboxRow}) are included only for the wire (`withStubs`): a listing or a
   * discard shelf wants the rows the server has not confirmed. Stubs the doc's frame has come
   * to cover are retired first.
   */
  private _outboxToSend(docId: string, pending: Change[], committedRev?: number, withStubs = false): Change[] {
    this._retireCoveredStubs(docId);
    const rows = this._outbox.get(docId);
    if (!rows?.length) return [];
    let rev = pending[pending.length - 1]?.rev ?? committedRev;
    const out: Change[] = [];
    for (const row of rows) {
      if (row.committedRev !== undefined && !withStubs) continue;
      if (row.ops && row.doc) {
        if (row.ops.length === 0) continue; // rebased away; nothing left to send
        // createdAt is the original mint's: the server's offline-session versioning keys on it.
        const minted = this._mintOutboxChange(row.doc, row.ops, row.metadata ?? {}, row.change.id, 0, rev);
        out.push({ ...minted, createdAt: row.change.createdAt });
        rev = minted.rev;
      } else {
        if (row.change.ops.length === 0) continue;
        const next = rev === undefined ? row.change.rev : Math.max(rev + 1, row.change.rev);
        out.push({ ...row.change, rev: next, ops: [...row.change.ops] });
        rev = next;
      }
    }
    return out;
  }

  /**
   * Drop the named rows. Their ids are remembered as confirmed/retired for
   * {@link acceptUnstoredChanges} (oldest evicted past {@link MAX_CONFIRMED_OUTBOX_IDS}), and a
   * doc whose outbox drained releases its overflow latch so a later episode reports again.
   */
  private _removeOutboxRows(docId: string, ids: string[]): OutboxRow[] {
    const rows = this._outbox.get(docId);
    if (!rows?.length) return [];
    const drop = new Set(ids);
    const removed = rows.filter(row => drop.has(row.change.id));
    if (removed.length === 0) return [];
    const kept = rows.filter(row => !drop.has(row.change.id));
    if (kept.length > 0) this._outbox.set(docId, kept);
    else {
      this._outbox.delete(docId);
      this._reportedOverflow.delete(docId);
    }
    this._rememberConfirmed(
      docId,
      removed.map(row => row.change.id)
    );
    return removed;
  }

  /** Remember `ids` as confirmed/retired for {@link acceptUnstoredChanges}, newest last, bounded. */
  private _rememberConfirmed(docId: string, ids: string[]): void {
    const confirmed = this._confirmedUnstored.get(docId) ?? new Set<string>();
    for (const id of ids) {
      confirmed.delete(id); // re-insert so it is the newest
      confirmed.add(id);
    }
    while (confirmed.size > MAX_CONFIRMED_OUTBOX_IDS) confirmed.delete(confirmed.values().next().value!);
    this._confirmedUnstored.set(docId, confirmed);
  }

  /**
   * See {@link ClientAlgorithm.collectUnsyncedForDiscard}. The union {@link _collectPending}
   * already computes — the sendable queue plus the withheld doc-only rows the send path refuses
   * because they are not durable, which on a discard is the reason to include them — followed by
   * quarantine, the other durable tier holding content the user can still recover and that
   * `confirmDeleteDoc` is about to drop.
   *
   * Raw rows, no {@link _withConsistentBaseRev}: this is a shelf payload, not a wire batch, and
   * no report. Skipping the alarm is right on the notification/push route, where nothing has
   * probed the queue yet and the doc is legitimately vanishing. It is not a claim that the alarm
   * never fires for a deleted doc: the discovery routes reach here from a catch whose `try`
   * already called {@link getPendingToSend}, which reports and consumes the once-per-doc latch
   * before DOC_DELETED is thrown. What this guarantees is that the shelf read adds no report of
   * its own, and leaves the latch untouched for any doc that survives.
   */
  async collectUnsyncedForDiscard(docId: string, doc?: PatchesDoc<any>, excludeIds?: Set<string>): Promise<Change[]> {
    const otDoc = doc as OTDoc<any> | undefined;
    const { pending, withheld } = await this._collectPending(docId, otDoc, otDoc?.committedRev ?? 0);
    const outbox = this._outboxToSend(docId, pending, otDoc?.committedRev);
    const rows = excludeIds?.size
      ? [...pending, ...withheld, ...outbox].filter(c => !excludeIds.has(c.id))
      : [...pending, ...withheld, ...outbox];
    const quarantined = await this.store.listQuarantinedChanges?.(docId);
    return quarantined?.length ? [...rows, ...quarantined.map(q => q.change)] : rows;
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
      let pendingSet: Change[] = [];
      let applied = false;
      for (let attempt = 0; attempt < APPLY_CONFLICT_RETRIES; attempt++) {
        const { pending, tailRev } = await this._collectPending(docId, otDoc, committedRev);
        pendingSet = pending;
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

      // Frozen outbox rows on this frame cross the batch the same way the store queue just did
      // (behind the pre-rebase pending set), with or without an open doc: a frozen row is not
      // in any doc's optimistic queue, so nothing else keeps it in frame.
      this._walkFrozenOutboxRows(docId, committedRev, newServerChanges, pendingSet);

      // Echoes of outbox rows: the store never held them, so this — or the commit response
      // (confirmUnstoredCommitted), which normally gets there first and leaves a stub — is
      // where they are confirmed. The doc drops its entries on its own aligned path
      // (applyChanges recognises the ids); the misaligned rebuild below imports a snapshot that
      // already holds them, so the entries are dropped first there or the import re-applies
      // them on top. A stub's echo retires it; it was reported from the response.
      const echoed = this._removeOutboxRows(
        docId,
        serverChanges.map(c => c.id)
      );
      const echoedIds = new Set(echoed.map(row => row.change.id));
      const reportIds = new Set(echoed.filter(row => row.committedRev === undefined).map(row => row.change.id));

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
          otDoc._dropUnstored(echoedIds);
          const snapshot = await this.loadDoc(docId);
          if (snapshot) {
            // import() re-applies the surviving optimistic ops RAW on the new snapshot — it
            // does not transform them into its frame — so a live outbox row would go out with
            // ops in the old frame under the new committedRev. Walk the rows through the
            // committed span the doc is about to jump over, up to exactly the snapshot's rev
            // (the store holds it), the way _rebaseOptimisticOps walks a contiguous receive,
            // so the re-mint is in frame; rows the span cannot be read for are frozen.
            await this._rebaseOutboxRows(docId, otDoc, snapshot.rev);
            otDoc.import(snapshot as PatchesSnapshot<T>);
          }
        }
        // The doc's frame moved: stubs it now covers have nothing left to shadow.
        this._retireCoveredStubs(docId);
      }

      if (reportIds.size > 0) {
        this.onUnstoredCommitted.emit(
          docId,
          serverChanges.filter(c => reportIds.has(c.id))
        );
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
    // A stub (see OutboxRow) rides in the batch only to be deduped; its content is on the
    // server whether or not this response echoed the committed copy again, so its absence is
    // never "resolved away" — and its doc entry retires on the doc's own frame, not here.
    const droppedIds = sentChanges.filter(c => !survived.has(c.id) && !this._isStub(docId, c.id)).map(c => c.id);
    if (droppedIds.length === 0) return 0;
    // Outbox rows have no store row to drop, but the same fate: unechoed means resolved away,
    // and their memory-only entries must leave the doc's queue or the caller's re-sync from the
    // store re-applies them on top of the state that already holds their content.
    const outboxRows = this._removeOutboxRows(docId, droppedIds);
    for (const row of outboxRows) row.doc?._dropUnstored([row.change.id]);
    const storeIds = droppedIds.filter(id => !outboxRows.some(row => row.change.id === id));
    if (storeIds.length > 0) await this.store.dropPendingChanges(docId, storeIds);
    return droppedIds.length;
  }

  async reconcilePending(docId: string, committedChanges: Change[]): Promise<void> {
    if (committedChanges.length === 0) return;
    // The snapshot reload that calls this ends in an import that re-applies optimistic ops
    // raw (see applyServerChanges' misaligned branch): walk the live outbox rows through the
    // same tail first, so a later re-mint from the doc is in the reloaded frame. Anchored on
    // the DOC's frame (it can sit behind the tail's — a torn reload), so the span between the
    // two is crossed as well, from the store.
    const outboxDoc = (this._outbox.get(docId) ?? []).find(row => row.ops && row.doc)?.doc;
    if (outboxDoc) {
      await this._rebaseOutboxRows(
        docId,
        outboxDoc,
        committedChanges[committedChanges.length - 1].rev,
        committedChanges
      );
    }
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
    // Reconstruct the frame the named change was minted in — in-frame predecessors only, so a
    // straggler from a lagging context can't fail a probe it was never part of (DAB-1028). If an
    // in-frame PREDECESSOR won't strict-apply, we can't build that frame — so we can't
    // corroborate the server's suspicion about THIS change. Fail toward true (don't auto-eject;
    // the doc latches for app consent), never toward a false that would auto-discard a change we
    // couldn't probe.
    let preState;
    try {
      preState = reconstructMintFrame(snapshot.state, snapshot.changes, index);
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
   * @throws {LossyEjectionError} When `opts.onlyIfLossless` is set and the computed
   *   ejection would drop or rewrite successor ops (see {@link PendingEjection.lossless}).
   *   Nothing is mutated; the caller chose the latch over the loss.
   */
  async ejectPendingChange(
    docId: string,
    changeId: string,
    reason: string,
    doc?: PatchesDoc<any>,
    opts?: { onlyIfUnappliable?: boolean; onlyIfLossless?: boolean }
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
          preState = reconstructMintFrame(snapshot.state, snapshot.changes, index);
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

      // Checked HERE, inside the converge loop on the freshly-read snapshot, not by a
      // caller-side probe: the queue can rebase (or the user can mint a successor) between
      // any outside read and this run, and a gate with that gap would approve an ejection
      // that drops the successor minted inside it. A whole-doc poison (the root-replace
      // wedge, DAB-832) fails this for any real successor — its inverse drops every
      // descendant-path op behind it — which is exactly the caller's signal to leave the
      // queue latched instead.
      if (opts?.onlyIfLossless && !ejection.lossless) {
        throw new LossyEjectionError(
          `Ejecting change ${changeId} from doc ${docId} would drop or rewrite queued successor changes`
        );
      }

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
    docIds.forEach(id => this._forgetDoc(id));
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
    this._forgetDoc(docId);
    return this.store.confirmDeleteDoc(docId);
  }

  async close(): Promise<void> {
    this._outbox.clear();
    this._reportedUnstored.clear();
    this._reportedOverflow.clear();
    this._confirmedUnstored.clear();
    this._deferrals.clear();
    this.onUnstoredCommitted.clear();
    return this.store.close();
  }

  /** A doc's lifetime here is over (untracked or deleted): drop its outbox and every memo. */
  private _forgetDoc(docId: string): void {
    this._outbox.delete(docId);
    this._reportedUnstored.delete(docId);
    this._reportedOverflow.delete(docId);
    this._confirmedUnstored.delete(docId);
    this._deferrals.delete(docId);
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
    // The warn is invisible in the field, and a deferred row is otherwise indistinguishable
    // from a sent one (hasPending is true either way; nothing ever confirms it). The first
    // deferral is the design; the same row deferred AGAIN means the follow-up pass did not
    // clear it, and that is reported — once per row (see DEFERRAL_REPORT_THRESHOLD).
    const deferred = batch.slice(end);
    const counts = this._deferrals.get(docId) ?? new Map<string, number>();
    const stuck: Change[] = [];
    for (const change of deferred) {
      if (this._isStub(docId, change.id)) continue; // on the server already; nothing is stuck
      const n = (counts.get(change.id) ?? 0) + 1;
      counts.set(change.id, n);
      if (n === DEFERRAL_REPORT_THRESHOLD) stuck.push(change);
    }
    this._deferrals.set(docId, counts);
    if (stuck.length > 0) {
      const frames = [...new Set(stuck.map(c => c.baseRev))];
      this.onError.emit(
        new PendingDeferredError(
          docId,
          stuck.map(c => c.id),
          baseRev,
          frames
        ),
        { docId }
      );
    }
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
