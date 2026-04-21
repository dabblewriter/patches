import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot } from '../types.js';
import { BaseDoc } from './BaseDoc.js';

/**
 * LWW (Last-Write-Wins) document implementation.
 *
 * The `change()` method (inherited from BaseDoc) applies ops optimistically
 * to `state` and emits them via `onChange`. The LWWAlgorithm packages ops
 * with timestamps, persists them, and calls `applyChanges()` to confirm
 * the optimistic update (shifting from the FIFO queue and skipping the state setter).
 *
 * Note: LWWAlgorithm adds `ts` (timestamp) metadata to ops before persisting.
 * `applyPatch` ignores unknown op properties, so optimistic apply (raw ops)
 * and confirmed apply (timestamped ops) produce identical state.
 *
 * Unlike OTDoc, LWWDoc doesn't need to track committed vs pending state
 * separately - the algorithm handles all conflict resolution by timestamp.
 *
 * ## Wire Efficiency
 * For Worker-Tab communication, `applyChanges()` sends only changes over the wire,
 * not the full state.
 */
export class LWWDoc<T extends object = object> extends BaseDoc<T> {
  protected _committedRev: number;
  protected _hasPending: boolean;
  /** Confirmed state (from algorithm pipeline), used to recompute after server changes. */
  protected _baseState: T;
  /**
   * Content keys of pending local ops that have been applied to `_baseState` via the
   * local-confirmation path (`committedAt === 0`) but not yet echoed back from the server.
   *
   * We key by op CONTENT (JSON.stringify) rather than by Change id because the LWW
   * algorithm coalesces pending ops in its store and reissues a fresh sending Change
   * (with a new id) in `getPendingToSend()`. The server then echoes that re-issued id
   * back, so id-based echo detection would always fail. Op content (path + op + value
   * + ts) survives the reissue intact, since the LWW algorithm preserves the original
   * timestamped ops end-to-end.
   *
   * On a pure echo we skip both `_baseState += ops` (already applied locally) and
   * `_recomputeState()` (would just produce a structurally-identical state with a
   * fresh object identity, causing a spurious store emit mid-typing).
   */
  protected _inFlightOpKeys: Set<string> = new Set();

  /**
   * Creates an instance of LWWDoc.
   * @param id The unique identifier for this document.
   * @param snapshot Optional snapshot to initialize from.
   */
  constructor(id: string, snapshot?: PatchesSnapshot<T>) {
    const initialState = snapshot?.state ?? ({} as T);
    super(id, initialState);
    this._committedRev = snapshot?.rev ?? 0;
    this._hasPending = (snapshot?.changes?.length ?? 0) > 0;

    if (snapshot?.changes && snapshot.changes.length > 0) {
      const allOps = snapshot.changes.flatMap(c => c.ops);
      this.state = applyPatch(this.state, allOps, { partial: true });
      for (const op of allOps) this._inFlightOpKeys.add(opKey(op));
    }
    this._baseState = this.state;
    this._checkLoaded();
  }

  /** Last committed revision number from the server. */
  get committedRev(): number {
    return this._committedRev;
  }

  /** Are there local changes that haven't been committed yet? */
  get hasPending(): boolean {
    return this._hasPending;
  }

  /**
   * Imports document state from a snapshot (e.g., for recovery when out of sync).
   * Resets `_baseState` from the snapshot but PRESERVES outstanding optimistic ops
   * (re-applied on top of the new state, dropping any that fail).
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
    this._committedRev = snapshot.rev;
    this._hasPending = (snapshot.changes?.length ?? 0) > 0;
    this._inFlightOpKeys.clear();

    let baseState = snapshot.state;
    if (snapshot.changes && snapshot.changes.length > 0) {
      const allOps = snapshot.changes.flatMap(c => c.ops);
      baseState = applyPatch(baseState, allOps, { partial: true });
      for (const op of allOps) this._inFlightOpKeys.add(opKey(op));
    }
    this._baseState = baseState;

    let nextState = baseState;
    if (this._optimisticOps.length > 0) {
      const surviving: typeof this._optimisticOps = [];
      for (const ops of this._optimisticOps) {
        try {
          nextState = applyPatch(nextState, ops, { strict: true });
          surviving.push(ops);
        } catch {
          // Optimistic ops created against the prior state may not apply cleanly
          // to the imported state. Drop them — the algorithm's pendingOps store
          // is the source of truth for genuinely pending work.
        }
      }
      this._optimisticOps = surviving;
    }
    this._checkLoaded();
    this.state = nextState;
  }

  /**
   * Recomputes state from the base state plus remaining optimistic ops.
   */
  protected _recomputeState(): void {
    let newState = this._baseState;
    for (const ops of this._optimisticOps) {
      newState = applyPatch(newState, ops, { strict: true });
    }
    this.state = newState;
  }

  /**
   * Confirms changes from the algorithm pipeline.
   *
   * For LWW, all ops are applied in order. The method distinguishes between
   * committed and pending changes using `committedAt`:
   * - `committedAt > 0`: Server-committed change (updates committedRev, recomputes
   *   state with remaining optimistic ops preserved)
   * - `committedAt === 0`: Pending local change (shifts from optimistic queue,
   *   skips state update since change() already applied the ops)
   *
   * @param changes Array of changes to apply
   * @param hasPending If provided, overrides the inferred pending state.
   *   Used by LWWAlgorithm which knows the true pending state from the store.
   */
  override applyChanges(changes: Change[], hasPending?: boolean): void {
    if (changes.length === 0) return;

    let lastCommittedRev = this._committedRev;
    let hasPendingChanges = false;
    let hasServerChanges = false;

    for (const change of changes) {
      if (change.committedAt > 0) {
        lastCommittedRev = change.rev;
        hasServerChanges = true;
      } else {
        hasPendingChanges = true;
      }
    }

    this._committedRev = lastCommittedRev;
    this._hasPending = hasPending ?? hasPendingChanges;
    this._checkLoaded();

    // Pure-echo detection must read the in-flight set BEFORE we mutate it. A pure echo means
    // every server-side op in this batch matches the content of an op we previously applied
    // locally (no foreign concurrent ops, no fresh local ops mixed in).
    //
    // We key by op CONTENT rather than Change id because the LWW algorithm reissues a
    // fresh sending Change id in `getPendingToSend()` — see _inFlightOpKeys docstring.
    const isPureEcho =
      hasServerChanges &&
      !hasPendingChanges &&
      changes.every(c => c.ops.every(op => this._inFlightOpKeys.has(opKey(op))));

    // Maintain the in-flight tracker uniformly: add new local op keys, retire any echoed
    // server op keys. This is independent of which branch we take below.
    for (const c of changes) {
      if (c.committedAt > 0) {
        for (const op of c.ops) this._inFlightOpKeys.delete(opKey(op));
      } else {
        for (const op of c.ops) this._inFlightOpKeys.add(opKey(op));
      }
    }

    if (hasServerChanges) {
      // For pure echoes, _baseState already has these ops applied (via the local-confirmation
      // path), so re-applying is wasteful and the recomputed state would be data-identical
      // with a fresh object identity, causing a spurious store emit. Skip both.
      if (isPureEcho) return;

      const allOps = changes.flatMap(c => c.ops);
      this._baseState = applyPatch(this._baseState, allOps, { partial: true });
      this._recomputeState();
    } else {
      const allOps = changes.flatMap(c => c.ops);
      this._baseState = applyPatch(this._baseState, allOps, { partial: true });

      if (this._optimisticOps.length > 0) {
        this._optimisticOps.shift();
      } else {
        // No prior optimistic apply (Worker-Tab sync or direct call).
        this._recomputeState();
      }
    }
  }
}

/**
 * Stable content key for an op. Two ops produced from the same source (same path, op,
 * value, and `ts` from LWWAlgorithm) round-trip through JSON with identical key order in
 * V8/JavaScriptCore, so JSON.stringify is sufficient as an equality fingerprint.
 *
 * Orphan keys (ops that were consolidated away in the algorithm's pending store before
 * being sent) remain in `_inFlightOpKeys` indefinitely. They're bounded by session
 * length and act as harmless extra positives for the echo check.
 */
function opKey(op: JSONPatchOp): string {
  return JSON.stringify(op);
}
