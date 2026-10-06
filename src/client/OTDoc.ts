import { applyPendingForView, salvagePendingForView } from '../algorithms/ot/client/applyPendingForView.js';
import { createStateFromSnapshot } from '../algorithms/ot/client/createStateFromSnapshot.js';
import { applyChanges as applyChangesToState } from '../algorithms/ot/shared/applyChanges.js';
import { rebaseChanges } from '../algorithms/ot/shared/rebaseChanges.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import { deepEqual } from '../json-patch/utils/deepEqual.js';
import { signal } from 'easy-signal';
import type { Change, PatchesSnapshot } from '../types.js';
import { BaseDoc } from './BaseDoc.js';

/** One change the algorithm minted from a parked optimistic entry (see `OTDoc._noteMinted`). */
interface MintedPiece {
  id: string;
  ops: JSONPatchOp[];
}

/**
 * OT (Operational Transformation) document implementation.
 * Uses a snapshot-based approach with revision tracking and rebasing
 * for handling concurrent edits.
 *
 * The `change()` method (inherited from BaseDoc) applies ops optimistically
 * to `state` and emits them via `onChange`. The OTAlgorithm packages ops into
 * Changes, persists them, and calls `applyChanges()` to confirm the optimistic
 * update (shifting from the FIFO queue and skipping the state setter).
 *
 * ## State Model
 * - `_committedState`: Base state from server (at `_committedRev`)
 * - `_pendingChanges`: Local changes not yet committed by server
 * - `_optimisticOps` (from BaseDoc): Ops applied by change() but not yet confirmed
 * - `_unstored`: the subset of optimistic entries the store refused and the outbox sends from
 *   memory instead (see `OTAlgorithm.queueUnstoredChange`); confirmed by their committed echo
 * - `state`: Live state = committedState + pendingChanges + optimistic ops applied
 *
 * ## Wire Efficiency
 * For Worker-Tab communication, only changes are sent over the wire (not full state).
 * The unified `applyChanges()` method handles both local and server changes.
 */
export class OTDoc<T extends object = object> extends BaseDoc<T> {
  /** Base state from the server at the committed revision. */
  protected _committedState: T;
  /** Last committed revision number from the server. */
  protected _committedRev: number;
  /** Local changes not yet committed by server. */
  protected _pendingChanges: Change[];
  /**
   * Optimistic entries the store refused that the outbox has taken over, keyed by the stable
   * change id they were queued under (see `OTAlgorithm.queueUnstoredChange`). The value is the
   * SAME array the optimistic queue holds, so an in-place rebase keeps both in step. An entry
   * here is confirmed by its committed echo arriving with that id — the one path a change that
   * never had a store row can be confirmed on — and must then leave the queue, or its ops apply
   * a second time on top of the committed copy.
   */
  private _unstored = new Map<string, JSONPatchOp[]>();
  /**
   * Committed revs reported for outbox rows before their echo reached this doc (a follower tab
   * told by the writer, see `_noteUnstoredCommitted`). Consulted by `import()`: a snapshot at
   * or past that rev already holds the change, so the entry must not re-apply on top of it.
   */
  private _unstoredCommittedRevs = new Map<string, number>();
  /**
   * The change ids the algorithm minted for a parked optimistic entry, keyed by the entry's own
   * array (see `_noteMinted`). This is how an own echo that beats its mint confirmation is
   * recognised: by the id it carries, whatever its bytes — the server may have transformed it, or
   * `breakChanges` may have split it into pieces — and never by bytes alone, which a foreign
   * change can share (DAB-1409). One piece shares the entry's array, so in-place rebases keep it
   * current; several pieces hold their own arrays, rebased piece by piece.
   */
  private _minted = new Map<JSONPatchOp[], MintedPiece[]>();
  /**
   * Committed changes this doc treated as foreign although their ops byte-match a parked
   * optimistic entry it holds no minted id for. Diagnostic only: such a change is NOT adopted (a
   * foreign twin adopted as ours drops the local edit), but a mint path that skipped
   * `_noteMinted` would show up here instead of as a silent double-apply.
   */
  readonly onSuspectedOwnEcho = signal<(changeIds: string[]) => void>();
  /**
   * Ids of changes this doc has folded into `_committedState`, with the rev each landed at.
   * Consulted wherever a pending list is taken from outside the doc — the rebased pending an
   * echo hands back, a snapshot's `changes` on import, a local mint confirmation — so a row the
   * committed tier already contains is never applied a second time on top of its own committed
   * copy (DAB-1366). The store retires a committed row from its pending tier inside a `[docs]`
   * transaction that can take seconds on a slow IndexedDB; until it settles, the algorithm keeps
   * handing that row back as pending, and `applyPendingForView` would strict-apply it again — a
   * re-applied `add` never throws, it just inserts once more. Bounded: entries fall off in rev
   * order once the map grows past `MAX_COMMITTED_IDS`; the lag this guards is seconds, not
   * thousands of revs.
   */
  private _committedIds = new Map<string, number>();
  private static readonly MAX_COMMITTED_IDS = 1024;

  /**
   * Creates an instance of OTDoc.
   * @param id The unique identifier for this document.
   * @param snapshot Optional snapshot to initialize from (state, rev, pending changes).
   */
  constructor(id: string, snapshot?: PatchesSnapshot<T>) {
    const initialState = snapshot?.state ?? ({} as T);
    super(id, initialState);
    this._committedState = this.state;
    this._committedRev = snapshot?.rev ?? 0;
    this._pendingChanges = snapshot?.changes ?? [];

    // If pending changes provided, recompute live state
    if (this._pendingChanges.length > 0) {
      try {
        this.state = applyChangesToState(this._committedState, this._pendingChanges);
      } catch {
        // Pending changes are corrupt (conflicting ops from accumulated sessions).
        // Apply one-by-one, leaving the changes that fail out of this doc's view. Later
        // changes created on committed state may still apply even when earlier ones
        // conflict.
        //
        // This shortens the VIEW and this instance's in-memory queue, nothing else. The
        // store keeps every row: nothing writes the shortened queue back, the send path
        // reads the store (OTAlgorithm._collectPending), and the first receive hands the
        // store's rows back to this doc. So a change left out here is still sent, in its
        // place in the queue, and leaving it out does not unblock anything behind it.
        // Nor does failing strict apply here mean the server refuses it: commitChanges
        // does not strict-apply what it is sent. Its one correction is for array indexes, and
        // it is conditional: skipped with `normalizeArrayIndices === false`, with
        // `historicalImport`, or when the state read fails. Where it runs, an `add` past the
        // end is clamped to an append, but a `remove`/`replace`/`move` on a missing element
        // is dropped, and any other change that fails to apply is committed as sent. When the
        // server cannot correct the row, it commits poison: every client's strict replay
        // rejects it, this one included once the echo arrives (DAB-1557). A change the
        // server refuses by name leaves the queue through ejection (docs/quarantine.md).
        //
        // A later change built on one that was left out is left out with it. It would not
        // fail on its own: an `add` beneath an entry that was never created makes the missing
        // parent as a bare container, and the view would hold that half-formed entry in place
        // of the real one. A row waiting on an older frame is a different case — frame debt,
        // not corruption — and stays in this doc's queue, out of the view, as do the rows
        // that need it; none of those are reported. See salvagePendingForView.
        //
        // Each change left out is captured on `droppedPendingChanges` (a historical name,
        // see BaseDoc) so `Patches.openDoc` reports it via `onPendingDropped`: the doc
        // opens without work the host's queue may still send, and the app may want its own
        // copy before the server has ruled on it.
        const salvaged = salvagePendingForView(this._committedState, this._committedRev, this._pendingChanges);
        const valid = salvaged.kept;
        this.droppedPendingChanges.push(...salvaged.dropped);
        this._pendingChanges = valid;
        this.state = salvaged.state;
        // Strict apply failing only on rows waiting on an older frame is not corruption: they are
        // held out of the view and stay queued, with nothing left out of the queue to report.
        if (salvaged.dropped.length > 0) {
          // Hardcoded console.error rather than an onSkippedChange-style hook (the
          // convention applyChangesForReconstruction uses): the constructor is invoked
          // through ClientAlgorithm.createDoc(docId, snapshot), which has no options
          // plumb-through, and no consumer can have subscribed to anything yet. The
          // structured channel is Patches.onPendingDropped, emitted from openDoc right
          // after construction — this log is the fallback signal for non-Patches hosts
          // and for opens that happen before any subscriber exists. Ids and revs only,
          // never content.
          const failed = salvaged.dropped.length - salvaged.dependents;
          const reason = salvaged.dependents
            ? `${failed} failed strict apply against rev ${this._committedRev}, ${salvaged.dependents} built on one that did`
            : `failed strict apply against rev ${this._committedRev}`;
          console.error(
            `OTDoc(${id}): left ${this.droppedPendingChanges.length} of ${
              this.droppedPendingChanges.length + valid.length
            } pending changes out of the view at hydration (${reason}; not removed here, so a host that sends from its store will still send them):`,
            this.droppedPendingChanges.map(c => `${c.id}@${c.rev}`).join(', ')
          );
        }
      }
    }
    this._checkLoaded();
  }

  /** Last committed revision number from the server. */
  get committedRev(): number {
    return this._committedRev;
  }

  /** Are there local changes that haven't been committed yet? */
  get hasPending(): boolean {
    return this._pendingChanges.length > 0;
  }

  /**
   * Returns the pending changes for this document.
   * @returns The pending changes.
   */
  getPendingChanges(): Change[] {
    return this._pendingChanges;
  }

  /** Ids of optimistic entries currently handed to the outbox (store-refused, memory-only). */
  get unstoredChangeIds(): string[] {
    return [...this._unstored.keys()];
  }

  /**
   * Internal: hand an optimistic entry to the outbox under `id`. Called by
   * `OTAlgorithm.queueUnstoredChange` when the store has refused the entry's persist and the
   * change will be sent from memory instead. `ops` must be the entry's own array (the reference
   * `change()` emitted and the optimistic queue holds), so rebases stay shared and the echo can
   * find the entry to confirm. Returns whether the entry is still held — an array that has left
   * the queue (a write confirmed through another path while the last attempt timed out) takes
   * no mark, and the caller must queue nothing for it.
   */
  _markUnstored(id: string, ops: JSONPatchOp[]): boolean {
    if (!this._optimisticOps.includes(ops)) return false;
    this._unstored.set(id, ops);
    // The outbox sends the entry whole, under `id`; its echo is recognised by that id from here.
    this._minted.delete(ops);
    return true;
  }

  /**
   * Internal: the algorithm has minted `changes` from the optimistic entry `ops` — one change, or
   * several when `breakChanges` split it. Called before the algorithm awaits the store, so the
   * ids are known before any echo of them can exist. An echo carrying one of these ids is then
   * this entry's own committed copy, however the server rewrote its ops; a piece's echo retires
   * that piece, and the entry keeps only what is still in flight (DAB-1409).
   *
   * A re-mint (a retried persist) replaces the record: an unsplit change keeps its stable id
   * across attempts, so nothing is lost. Split pieces get fresh ids per attempt, so the echo of
   * an earlier attempt's pieces is not recognised — that needs deterministic piece ids.
   */
  _noteMinted(changes: Change[], ops: JSONPatchOp[]): void {
    if (changes.length === 0 || !this._optimisticOps.includes(ops)) return;
    // An outbox entry (a re-drive under its stable id) is already recognised by that id, and the
    // outbox sends it whole — pieces recorded beside it would split one echo's bookkeeping in two.
    if ([...this._unstored.values()].includes(ops)) return;
    const pieces =
      changes.length === 1 ? [{ id: changes[0].id, ops }] : changes.map(c => ({ id: c.id, ops: [...c.ops] }));
    this._minted.set(ops, pieces);
  }

  /** The parked entry a minted change id belongs to, with its pieces. */
  private _mintedEntryOf(id: string): { entry: JSONPatchOp[]; pieces: MintedPiece[] } | undefined {
    for (const [entry, pieces] of this._minted) {
      if (pieces.some(piece => piece.id === id)) return { entry, pieces };
    }
    return undefined;
  }

  /**
   * Point a minted entry at the pieces still in flight, rewriting the entry in place so a queued
   * mint holding the array follows it. No pieces left → the entry leaves the optimistic queue.
   */
  private _setMintedPieces(entry: JSONPatchOp[], pieces: MintedPiece[]): void {
    const ops = pieces.flatMap(piece => piece.ops);
    entry.length = 0;
    entry.push(...ops);
    if (entry.length === 0) {
      this._minted.delete(entry);
      this._optimisticOps = this._optimisticOps.filter(e => e !== entry);
      return;
    }
    this._minted.set(entry, pieces.length === 1 ? [{ id: pieces[0].id, ops: entry }] : pieces);
  }

  /**
   * Internal: the store accepted the row after all (a `retrySavingChanges` re-drive minted it
   * under the same id). The normal local-confirm shift owns the entry from here, and its echo
   * will match the pending row rather than an outbox entry.
   */
  _forgetUnstored(id: string): void {
    this._unstored.delete(id);
    this._unstoredCommittedRevs.delete(id);
  }

  /**
   * Internal: drop outbox entries from the optimistic queue WITHOUT recomputing state. Used when
   * their content is known to be on the server already — the server resolved them away (their
   * ops were a no-op against the committed tip) or a snapshot about to be imported holds them —
   * and the caller is about to re-sync the doc from that authoritative state. Returns the ids
   * actually dropped. Emptied in place so a mint still queued for the entry skips it.
   */
  _dropUnstored(ids: Iterable<string>): string[] {
    const dropped: string[] = [];
    for (const id of ids) {
      const ops = this._unstored.get(id);
      if (!ops) continue;
      ops.length = 0;
      this._optimisticOps = this._optimisticOps.filter(entry => entry !== ops);
      this._unstored.delete(id);
      this._unstoredCommittedRevs.delete(id);
      dropped.push(id);
    }
    return dropped;
  }

  /**
   * Internal: drop outbox entries whose ops could not be carried into the frame the doc is about
   * to sit on (see `OTAlgorithm._refuseOutboxRows`) and recompute state from what is left.
   *
   * Unlike {@link _dropUnstored}, these entries are NOT on the server: they are handed to the app
   * to shelve, and the doc has to stop showing them, because the import that follows re-applies
   * surviving optimistic ops RAW — putting ops from the old frame into the new one — and
   * `retrySavingChanges` would then re-drive the entry at the doc's new committedRev, the relabel
   * this algorithm's invariant forbids. Removed rather than left visible: their content reaches
   * the writer again through the shelf, in a frame it was actually transformed into.
   */
  _dropRefusedUnstored(ids: Iterable<string>): string[] {
    const dropped = this._dropUnstored(ids);
    if (dropped.length > 0) this._recomputeState();
    return dropped;
  }

  /**
   * Internal: an outbox row of this doc is known to be committed at `rev` — told by another
   * context (the writer tab that sent it) rather than by an echo through `applyChanges`. If this
   * doc is already at or past that rev the committed copy is in its state and the entry is
   * dropped now (the view was double-applying it); otherwise the rev is remembered so the
   * import or echo that brings this doc up to it drops the entry then.
   */
  _noteUnstoredCommitted(id: string, rev: number): void {
    if (!this._unstored.has(id)) return;
    if (rev <= this._committedRev) {
      this._dropUnstored([id]);
      this._recomputeState();
      return;
    }
    this._unstoredCommittedRevs.set(id, rev);
  }

  /** Remember that `changes` are now part of `_committedState`, pruning the oldest beyond the cap. */
  private _rememberCommitted(changes: Change[]): void {
    for (const change of changes) this._committedIds.set(change.id, change.rev);
    // Map iteration is insertion order and committed revs only ever rise, so the front is the
    // oldest. Deleting from the front keeps the most recent MAX_COMMITTED_IDS.
    if (this._committedIds.size > OTDoc.MAX_COMMITTED_IDS) {
      const excess = this._committedIds.size - OTDoc.MAX_COMMITTED_IDS;
      let n = 0;
      for (const id of this._committedIds.keys()) {
        if (n++ >= excess) break;
        this._committedIds.delete(id);
      }
    }
  }

  /**
   * A pending list taken from outside the doc, with every row the committed tier already holds
   * removed. Such a row is not queued work: its committed copy is in `_committedState`, and
   * applying it again from the pending tier is exactly the double-count of DAB-1366. Dropping it
   * here loses nothing — the server has it — and keeps the view one row shorter than it would
   * otherwise read, which is the difference between the next minted index landing in range and
   * landing one past the end.
   */
  private _withoutCommitted(pending: Change[]): Change[] {
    if (this._committedIds.size === 0 || pending.length === 0) return pending;
    const kept = pending.filter(c => !this._committedIds.has(c.id));
    return kept.length === pending.length ? pending : kept;
  }

  /**
   * Report committed changes treated as foreign whose ops byte-match a parked optimistic entry
   * this doc holds no minted id or outbox mark for. They are NOT adopted. DAB-1366 adopted them,
   * which recognised an own echo that beat its mint — but by bytes, so a server-transformed or
   * split echo was missed and a foreign twin was taken for ours, dropping the local edit
   * (DAB-1409). Own echoes are now recognised by the ids `_noteMinted` records before the store
   * write; a hit here means some mint path did not record them. Consumes each entry at most once.
   */
  private _flagSuspectedOwnEchoes(serverChanges: Change[], isOwn: (c: Change) => boolean): void {
    if (this._optimisticOps.length === 0) return;
    const marked = new Set(this._unstored.values());
    const candidates = this._optimisticOps.filter(ops => ops.length > 0 && !marked.has(ops) && !this._minted.has(ops));
    if (candidates.length === 0) return;
    const keys: (string | null)[] = candidates.map(ops => JSON.stringify(ops));
    const suspected: string[] = [];
    for (const change of serverChanges) {
      if (isOwn(change)) continue;
      const i = keys.indexOf(JSON.stringify(change.ops));
      if (i === -1) continue;
      keys[i] = null;
      suspected.push(change.id);
    }
    if (suspected.length > 0) void this.onSuspectedOwnEcho.emit(suspected);
  }

  /**
   * Committed echoes of minted pieces: each retires its piece, and the entry keeps only the
   * pieces still in flight — emptied and dropped from the optimistic queue once none remain. On
   * the rebase path `_rebaseOptimisticOps` has already done this (the echoed pieces were walked
   * out of the queue), so a piece no longer recorded is skipped. Idempotent either way.
   */
  private _confirmMintedEchoes(serverChanges: Change[]): void {
    if (this._minted.size === 0) return;
    for (const change of serverChanges) {
      const minted = this._mintedEntryOf(change.id);
      if (!minted) continue;
      this._setMintedPieces(
        minted.entry,
        minted.pieces.filter(piece => piece.id !== change.id)
      );
    }
  }

  /** Drop bookkeeping for entries that have left the optimistic queue by any path. */
  private _pruneUnstored(): void {
    for (const ops of this._minted.keys()) {
      if (!this._optimisticOps.includes(ops)) this._minted.delete(ops);
    }
    if (this._unstored.size === 0) return;
    for (const [id, ops] of this._unstored) {
      if (!this._optimisticOps.includes(ops)) {
        this._unstored.delete(id);
        this._unstoredCommittedRevs.delete(id);
      }
    }
  }

  /**
   * Committed echoes of outbox entries: the committed copy is (about to be) in
   * `_committedState`, so the entry must leave the optimistic queue. On the mixed path
   * `_rebaseOptimisticOps` has already dropped it (rebaseChanges walks an echoed id out of the
   * queue untransformed); on the pure-echo path nothing else touches the queue, so it is
   * removed here. Idempotent either way.
   */
  private _confirmUnstoredEchoes(serverChanges: Change[]): void {
    if (this._unstored.size === 0) return;
    for (const change of serverChanges) {
      const ops = this._unstored.get(change.id);
      if (!ops) continue;
      ops.length = 0;
      this._optimisticOps = this._optimisticOps.filter(entry => entry !== ops);
      this._unstored.delete(change.id);
      this._unstoredCommittedRevs.delete(change.id);
    }
  }

  /**
   * Imports document state from a snapshot (e.g., for recovery when out of sync).
   * Resets committed/pending state from the snapshot but PRESERVES outstanding
   * optimistic ops (re-applied on top of the new state, dropping any that fail).
   *
   * Why preserve optimistic ops: import() can be called by sync recovery /
   * cross-tab snapshot broadcast paths while the user is mid-typing. Wiping
   * `_optimisticOps` would silently regress the input back to the snapshot
   * value, causing visible "text jumps" and lost characters.
   *
   * Stale-snapshot guard: snapshots older than the current `_committedRev`
   * are ignored — we already know more than the caller does.
   */
  import(snapshot: PatchesSnapshot<T>): void {
    if (snapshot.rev < this._committedRev) return;
    // The snapshot is at or past every rev in `_committedIds`, so its state already holds all of
    // them; a stale row for one in `snapshot.changes` (read from a store still retiring it) must
    // not re-apply on top (DAB-1366).
    const pending = this._withoutCommitted(snapshot.changes);
    if (pending !== snapshot.changes) snapshot = { ...snapshot, changes: pending };
    this._committedState = snapshot.state;
    this._committedRev = snapshot.rev;
    this._pendingChanges = snapshot.changes;
    this._checkLoaded();

    let newState: T = createStateFromSnapshot(snapshot);
    if (this._optimisticOps.length > 0) {
      // De-dup optimistic ops already represented in the snapshot's pending changes.
      // A local change can be persisted by the store (and so come back inside
      // `snapshot.changes`) before its own confirmation has shifted the op off
      // `_optimisticOps` — e.g. a sync-recovery `loadDoc()` whose snapshot already
      // contains the just-typed change while its echo broadcast was dropped. Without
      // this, `createStateFromSnapshot` applies the op (it is in `snapshot.changes`)
      // AND the surviving optimistic op re-applies it on top, duplicating content for
      // non-idempotent ops (text inserts, array appends). Match by structural op
      // equality, consuming each pending change at most once so genuinely-distinct
      // identical edits are preserved. See OTDoc.spec "SNAPIMP-1".
      //
      // Minted pieces the snapshot already carries are matched by id first: a split entry's rows
      // are its pieces, which never byte-match the whole entry, so it would re-apply on top of
      // them. What is left of the entry is the pieces still to come (DAB-1409).
      const snapshotIds = new Set(snapshot.changes.map(c => c.id));
      const idMatched = new Set<string>();
      for (const [entry, pieces] of [...this._minted]) {
        const remaining = pieces.filter(piece => !snapshotIds.has(piece.id));
        if (remaining.length === pieces.length) continue;
        for (const piece of pieces) if (snapshotIds.has(piece.id)) idMatched.add(piece.id);
        this._setMintedPieces(entry, remaining);
      }
      // A row consumed by id is spent: left in the byte match, it would let a second, identical
      // entry match it and be emptied — that edit then never shows and never sends.
      const pendingOpKeys = snapshot.changes.filter(c => !idMatched.has(c.id)).map(c => JSON.stringify(c.ops));
      // Outbox entries a writer has reported committed at a rev this snapshot covers: the
      // snapshot state already holds them, so re-applying the entry would duplicate it.
      const committedUnstored = new Set<JSONPatchOp[]>();
      for (const [id, rev] of this._unstoredCommittedRevs) {
        const ops = this._unstored.get(id);
        if (ops && rev <= snapshot.rev) committedUnstored.add(ops);
      }
      const surviving: typeof this._optimisticOps = [];
      for (const ops of this._optimisticOps) {
        if (committedUnstored.has(ops)) {
          ops.length = 0;
          continue;
        }
        const matchIndex = pendingOpKeys.indexOf(JSON.stringify(ops));
        if (matchIndex !== -1) {
          // Already applied via createStateFromSnapshot — consume the match and skip.
          // Emptied in place so a mint still queued for this entry doesn't re-mint
          // ops the snapshot already holds as pending.
          pendingOpKeys[matchIndex] = null as unknown as string;
          ops.length = 0;
          continue;
        }
        try {
          newState = applyPatch(newState, ops, { strict: true });
          surviving.push(ops);
        } catch {
          // Optimistic ops created against the prior state may not apply cleanly
          // to the imported state (e.g., parent path was replaced). Drop them
          // (emptied in place so a queued mint skips them) — the algorithm will
          // retry/reissue any genuinely pending work.
          ops.length = 0;
        }
      }
      this._optimisticOps = surviving;
      this._pruneUnstored();
    }
    this.state = newState;
  }

  /**
   * Recomputes state from committed + pending + remaining optimistic ops.
   */
  protected _recomputeState(): void {
    // Belt and braces: every assignment of `_pendingChanges` from outside is already cleaned,
    // but the view must never be built from a row the committed tier holds (DAB-1366).
    this._pendingChanges = this._withoutCommitted(this._pendingChanges);
    let newState: T = applyPendingForView(this._committedState, this._committedRev, this._pendingChanges);
    this._optimisticOps = this._optimisticOps.filter(ops => {
      try {
        newState = applyPatch(newState, ops, { strict: true });
        return true;
      } catch {
        // Ops invalidated by a rebase or rollback are dropped; emptied in place so
        // a queued mint holding the same array skips them.
        ops.length = 0;
        return false;
      }
    });
    this._pruneUnstored();
    this.state = newState;
  }

  /**
   * Rebases ops still awaiting their mint (queued by change() but not yet packaged
   * into a Change) into the post-server frame. Without this, a server change landing
   * between change() and its queued mint leaves the raw ops in the pre-server frame:
   * _recomputeState re-applies them position-shifted and the mint stamps them at the
   * new committedRev, committing misplaced ops verbatim.
   *
   * Arrays are mutated IN PLACE: the queued mint holds the same array reference that
   * change() emitted, so transforming here retargets the mint too. Entries that
   * transform away entirely are emptied (the mint skips empty ops) and dropped.
   */
  private _rebaseOptimisticOps(serverChanges: Change[]): void {
    const tag = `optimistic-${Math.random().toString(36).slice(2)}`;
    // An outbox entry rides under its real change id: rebaseChanges then treats its committed
    // echo as one of ours (dropped from the queue untransformed, successors' frames already
    // include it) instead of as a foreign change to transform the entry against — which would
    // re-express the entry on top of its own committed copy and apply it twice.
    const idByOps = new Map<JSONPatchOp[], string>();
    for (const [id, ops] of this._unstored) idByOps.set(ops, id);
    // A minted entry rides under its minted id the same way. A split one rides as its pieces, in
    // order, under theirs: a piece's echo is then walked out on its own while a foreign change
    // between two pieces still meets the later ones (DAB-1409).
    for (const [ops, pieces] of this._minted) if (pieces.length === 1) idByOps.set(ops, pieces[0].id);
    const syntheticId = (ops: JSONPatchOp[], i: number) => idByOps.get(ops) ?? `${tag}-${i}`;
    const toSynthetic = (id: string, ops: JSONPatchOp[]): Change => ({
      id,
      ops,
      rev: 0,
      baseRev: 0,
      createdAt: 0,
      committedAt: 0,
    });
    const split = new Map<JSONPatchOp[], MintedPiece[]>();
    const idOf = new Map<JSONPatchOp[], string>();
    const synthetic: Change[] = this._optimisticOps.flatMap((ops, i) => {
      const pieces = this._minted.get(ops);
      if (pieces && pieces.length > 1) {
        split.set(ops, pieces);
        return pieces.map(piece => toSynthetic(piece.id, piece.ops));
      }
      idOf.set(ops, syntheticId(ops, i));
      return [toSynthetic(idOf.get(ops)!, ops)];
    });
    // Thread the optimistic queue behind the pending queue so the server ops advance
    // through both frames in order — the same walk rebaseChanges does server-side.
    const rebased = rebaseChanges(serverChanges, [...this._pendingChanges, ...synthetic]);
    const opsById = new Map(rebased.map(c => [c.id, c.ops]));
    for (const [entry, pieces] of split) {
      // Pieces echoed or transformed away are gone from `rebased`; the rest carry their new ops.
      const surviving = pieces
        .filter(piece => opsById.has(piece.id))
        .map(piece => ({ id: piece.id, ops: [...opsById.get(piece.id)!] }));
      this._setMintedPieces(entry, surviving);
    }
    this._optimisticOps = this._optimisticOps.filter(ops => {
      if (split.has(ops)) return true; // rewritten above (or already dropped from the queue)
      // transformPatch hands back its input array UNTOUCHED when no op needed
      // transforming, so `rebased` can hold this very array. Copy before clearing —
      // otherwise a no-op rebase (a foreign change on unrelated paths, the common
      // case) empties both aliases and destroys the in-flight ops instead of
      // keeping them.
      const newOps = [...(opsById.get(idOf.get(ops)!) ?? [])];
      ops.length = 0;
      ops.push(...newOps);
      return ops.length > 0;
    });
  }

  /**
   * Confirms changes from the algorithm pipeline.
   *
   * Distinguishes between committed and pending changes using `committedAt`:
   * - `committedAt > 0`: Server-committed change (updates committed state, recomputes
   *   with remaining optimistic ops preserved)
   * - `committedAt === 0`: Local change confirmation (shifts from optimistic queue,
   *   skips state update since change() already applied the ops)
   *
   * For server changes, all committed changes come first, followed by rebased pending.
   *
   * @param changes Array of changes to apply
   */
  applyChanges(changes: Change[]): void {
    if (changes.length === 0) return;

    if (changes[0].committedAt > 0) {
      const serverEndIndex = changes.findIndex(c => c.committedAt === 0);
      const serverChanges = serverEndIndex === -1 ? changes : changes.slice(0, serverEndIndex);
      const rebasedPending = serverEndIndex === -1 ? [] : changes.slice(serverEndIndex);

      if (this._committedRev !== serverChanges[0].rev - 1) {
        throw new Error('Cannot apply committed changes to a doc that is not at the correct revision');
      }

      // Committed revs are dense per doc, so an interior hole in this batch (e.g. [148, 151]
      // with 149/150 dropped by a partial fan / self-echo exclusion) is always a delivery
      // defect. Without this guard the present ops apply and `_committedRev` advances to the
      // LAST rev, silently skipping the missing content — a doc that reads as caught up
      // (committedRev == store rev) while its state is behind, which the reconciliation audit
      // cannot detect (it gates on store rev being strictly greater). Refuse it instead; the
      // OT receive path routes a non-contiguous batch to a full store rebuild.
      //
      // Deliberately a plain Error, NOT MissingChangesError: this is a last-line invariant that
      // signals a CALLER bug (the algorithm layer must never hand this method a gapped committed
      // batch), not a recoverable transport gap. A MissingChangesError here would route through
      // PatchesSync's getChangesSince gap-recovery and mask the bug as a transient network hole.
      // Nothing depends on the type today (OTAlgorithm is the only committed-path caller); the
      // note is here so a future reader does not "fix" it into the recoverable class.
      for (let i = 1; i < serverChanges.length; i++) {
        if (serverChanges[i].rev !== serverChanges[i - 1].rev + 1) {
          throw new Error(
            `Cannot apply committed changes with a gap at rev ${serverChanges[i - 1].rev} → ${serverChanges[i].rev}`
          );
        }
      }

      // Pure echo: every server change confirms one of our own pending changes (no foreign
      // concurrent ops). The recomputed state is data-identical to the current state, so we
      // skip _recomputeState() to avoid emitting a redundant store update with a fresh object
      // identity. UI subscribers (Vue shallowRef, Svelte stores, etc.) see no spurious update
      // mid-typing.
      //
      // The `serverChanges.length > 0` guard is currently redundant (the outer branch only
      // runs when `changes[0].committedAt > 0`, which guarantees at least one server change),
      // but defends against `[].every() === true` if a future refactor weakens the invariant.
      // Outbox entries (`_unstored`) count as ours too: a change sent from memory has no
      // pending row, so its committed echo is recognised by the id it was queued under.
      // Apply the committed rows FIRST, into a local: it is the one step here that can throw
      // (a row the history cannot apply — poison), and everything after it mutates the doc in
      // place. Ordered the other way, a throw left the optimistic queue and the outbox entries
      // rebased across the span's foreign rows while committedRev, _committedState and state
      // stayed put — and a caller that retries the same span (OTAlgorithm._catchUpDocToStore,
      // three times and then on every retrySavingChanges re-drive) shifted the retained ops
      // once more per attempt, so the change kept on screen for an honest re-drive drifted one
      // span further from the doc's view each time. A throwing span now leaves the doc, the
      // optimistic queue and the outbox entries exactly as they were — including the outbox
      // marks the echo adoption below would otherwise leave behind (DAB-1366).
      const committedState = applyChangesToState(this._committedState, serverChanges);

      const priorPendingIds = new Set(this._pendingChanges.map(c => c.id));
      // An own echo that beats its mint confirmation has neither a pending row nor an outbox mark;
      // it is recognised by the id the algorithm minted it under (DAB-1366, DAB-1409).
      const mintedOps = (c: Change) => this._mintedEntryOf(c.id)?.pieces.find(piece => piece.id === c.id)?.ops;
      const isOwn = (c: Change) => priorPendingIds.has(c.id) || this._unstored.has(c.id) || mintedOps(c) !== undefined;
      this._flagSuspectedOwnEchoes(serverChanges, isOwn);
      // An echo is only "pure" if it came back as sent. The server may rewrite an own change on
      // commit — an out-of-range array index clamped or dropped (DAB-1557), or transformed past a
      // foreign commit (DAB-1409) — and then the committed state differs from the view built from
      // our copy, so the view must recompute.
      const sentOps = (c: Change) =>
        this._pendingChanges.find(p => p.id === c.id)?.ops ?? this._unstored.get(c.id) ?? mintedOps(c);
      const isPureEcho = serverChanges.length > 0 && serverChanges.every(c => isOwn(c) && deepEqual(sentOps(c), c.ops));

      // Must run against the OLD pending queue (the frame the optimistic ops live in),
      // so before _pendingChanges is replaced below. Pure echoes need no rebase — the
      // optimistic frames already include our own changes.
      if (!isPureEcho && this._optimisticOps.length > 0) {
        this._rebaseOptimisticOps(serverChanges);
      }
      // The committed copies of echoed outbox entries land in _committedState below; the entries
      // themselves must leave the optimistic queue (already gone on the rebase path; removed
      // here on the pure-echo path) or their ops apply a second time on top.
      this._confirmUnstoredEchoes(serverChanges);
      this._confirmMintedEchoes(serverChanges);

      this._committedState = committedState;
      this._committedRev = serverChanges[serverChanges.length - 1].rev;
      this._rememberCommitted(serverChanges);
      // The rebased pending the algorithm hands back is read from the store, which may not yet
      // have retired the rows this very batch committed (its `[docs]` transaction can lag by
      // seconds). Those rows are now inside `_committedState`; keeping them queued would
      // re-apply them on the next rebuild (DAB-1366).
      this._pendingChanges = this._withoutCommitted(rebasedPending);
      this._checkLoaded();
      // The pure-echo skip assumes the recomputed state would be data-identical to the current
      // one. That stops holding when the algorithm's rebase handed back FEWER rows than the doc
      // was queuing, none of them echoed: a row it declined to carry (a quarantined change the
      // store had ejected in another context) is still applied in the current state, and only
      // a recompute takes its effect back out of the view.
      const kept = new Set(this._pendingChanges.map(c => c.id));
      const echoed = new Set(serverChanges.map(c => c.id));
      let droppedPending = false;
      for (const id of priorPendingIds) {
        if (!kept.has(id) && !echoed.has(id) && !this._committedIds.has(id)) {
          droppedPending = true;
          break;
        }
      }
      if (!isPureEcho || droppedPending) {
        this._recomputeState();
      }
    } else {
      // A local mint confirmation for a change whose echo already landed (the store's write
      // settled after the server round-trip) is not new pending work: its committed copy is
      // already in `_committedState`, and the echo path has already retired its optimistic op.
      const fresh = this._withoutCommitted(changes);
      if (fresh.length === 0) {
        // Nothing to queue — but the optimistic entry may still be parked. The echo retired it
        // only if it matched structurally; a server-TRANSFORMED echo (a foreign commit landed
        // first) does not match, is treated as foreign, and leaves the entry in the queue —
        // where `_recomputeState` re-applies it on top of its committed copy. Retire it by its
        // own array reference (the mint holds the array `change()` emitted), never by a blind
        // shift, which would take a different, still-in-flight edit. Recompute so the doubled
        // copy leaves the view now rather than on the next foreign change.
        const minted = new Set(changes.map(c => c.ops));
        const before = this._optimisticOps.length;
        this._optimisticOps = this._optimisticOps.filter(ops => !minted.has(ops));
        if (this._optimisticOps.length !== before) {
          this._pruneUnstored();
          this._recomputeState();
        }
        this._checkLoaded();
        return;
      }
      this._pendingChanges.push(...fresh);
      this._checkLoaded();

      if (this._optimisticOps.length > 0) {
        this._optimisticOps.shift();
        this._pruneUnstored();
      } else {
        // No prior optimistic apply (Worker-Tab sync or direct call).
        this.state = applyChangesToState(this.state, changes);
      }
    }
  }

  /**
   * Returns the document snapshot for serialization.
   */
  toJSON(): PatchesSnapshot<T> {
    return {
      state: this._committedState,
      rev: this._committedRev,
      changes: this._pendingChanges,
    };
  }
}
