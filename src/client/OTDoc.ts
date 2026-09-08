import { applyPendingForView } from '../algorithms/ot/client/applyPendingForView.js';
import { createStateFromSnapshot } from '../algorithms/ot/client/createStateFromSnapshot.js';
import { applyChanges as applyChangesToState } from '../algorithms/ot/shared/applyChanges.js';
import { rebaseChanges } from '../algorithms/ot/shared/rebaseChanges.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot } from '../types.js';
import { BaseDoc } from './BaseDoc.js';

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
        this.state = applyPendingForView(this._committedState, this._committedRev, this._pendingChanges);
      } catch {
        // Pending changes are corrupt (conflicting ops from accumulated sessions).
        // Apply one-by-one, dropping changes that fail. Later changes created on
        // committed state may still apply even when earlier ones conflict.
        //
        // Dropping (not keeping) is deliberate for liveness: a change that fails strict
        // apply here would also fail server-side at flush, and a rejected change at the
        // head of the queue wedges every commit behind it. But the drop must never be
        // SILENT — the next pending persist makes the truncation permanent, which is
        // user work destroyed with zero signal. Each dropped change is captured on
        // `droppedPendingChanges` so `Patches.openDoc` surfaces it via
        // `onPendingDropped` and the app can preserve the content.
        let state = this._committedState;
        const valid: Change[] = [];
        for (const c of this._pendingChanges) {
          if (c.baseRev < this._committedRev) {
            // Frame debt, not corruption (see applyPendingForView): this row is waiting to
            // flush at its own baseRev for the server to transform. Keep it queued and out of
            // the view — dropping it here would destroy an unsent edit.
            valid.push(c);
            continue;
          }
          try {
            state = applyPatch(state, c.ops, { strict: true });
            valid.push(c);
          } catch {
            this.droppedPendingChanges.push(c);
          }
        }
        this._pendingChanges = valid;
        this.state = state;
        // Hardcoded console.error rather than an onSkippedChange-style hook (the
        // convention applyChangesForReconstruction uses): the constructor is invoked
        // through ClientAlgorithm.createDoc(docId, snapshot), which has no options
        // plumb-through, and no consumer can have subscribed to anything yet. The
        // structured channel is Patches.onPendingDropped, emitted from openDoc right
        // after construction — this log is the fallback signal for non-Patches hosts
        // and for drops that occur before any subscriber exists. Ids and revs only,
        // never content.
        console.error(
          `OTDoc(${id}): dropped ${this.droppedPendingChanges.length} of ${
            this.droppedPendingChanges.length + valid.length
          } pending changes at hydration (failed strict apply against rev ${this._committedRev}):`,
          this.droppedPendingChanges.map(c => `${c.id}@${c.rev}`).join(', ')
        );
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
    return true;
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

  /** Drop bookkeeping for entries that have left the optimistic queue by any path. */
  private _pruneUnstored(): void {
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
      const pendingOpKeys = snapshot.changes.map(c => JSON.stringify(c.ops));
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
    const syntheticId = (ops: JSONPatchOp[], i: number) => idByOps.get(ops) ?? `${tag}-${i}`;
    const synthetic: Change[] = this._optimisticOps.map((ops, i) => ({
      id: syntheticId(ops, i),
      ops,
      rev: 0,
      baseRev: 0,
      createdAt: 0,
      committedAt: 0,
    }));
    // Thread the optimistic queue behind the pending queue so the server ops advance
    // through both frames in order — the same walk rebaseChanges does server-side.
    const rebased = rebaseChanges(serverChanges, [...this._pendingChanges, ...synthetic]);
    const opsById = new Map(rebased.map(c => [c.id, c.ops]));
    this._optimisticOps = this._optimisticOps.filter((ops, i) => {
      // transformPatch hands back its input array UNTOUCHED when no op needed
      // transforming, so `rebased` can hold this very array. Copy before clearing —
      // otherwise a no-op rebase (a foreign change on unrelated paths, the common
      // case) empties both aliases and destroys the in-flight ops instead of
      // keeping them.
      const newOps = [...(opsById.get(syntheticId(ops, i)) ?? [])];
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
      const priorPendingIds = new Set(this._pendingChanges.map(c => c.id));
      const isOwn = (c: Change) => priorPendingIds.has(c.id) || this._unstored.has(c.id);
      const isPureEcho = serverChanges.length > 0 && serverChanges.every(isOwn);

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

      this._committedState = applyChangesToState(this._committedState, serverChanges);
      this._committedRev = serverChanges[serverChanges.length - 1].rev;
      this._pendingChanges = rebasedPending;
      this._checkLoaded();
      if (!isPureEcho) {
        this._recomputeState();
      }
    } else {
      this._pendingChanges.push(...changes);
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
