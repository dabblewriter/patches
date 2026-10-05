import { applyPatch } from '../../../json-patch/applyPatch.js';
import { getTypes } from '../../../json-patch/ops/index.js';
import type { JSONPatchOp } from '../../../json-patch/types.js';
import { pathExistsInState } from '../../../json-patch/utils/softWrites.js';
import type { Change } from '../../../types.js';
import { applyChanges, ApplyChangesError } from '../shared/applyChanges.js';

/**
 * Committed state advanced through the pending queue, for the OPTIMISTIC VIEW.
 *
 * The queue is the wire contract, and it can legitimately hold a row left on an older frame: a
 * mint that landed while its doc lagged the store keeps its TRUE baseRev so the server — which
 * holds every committed change past it — can run the transform the client no longer can
 * (DAB-951; see `OTAlgorithm._withConsistentBaseRev`). Such a row's ops address a frame the
 * committed state has moved past, so they may not apply against it. That is debt the flush seam
 * is deliberately carrying, not corruption: it must not throw, and the row must not be dropped
 * from the queue — dropping it would discard an unsent edit locally, the very loss the honest
 * baseRev exists to prevent. It simply has no place in the view until its commit echoes back.
 *
 * Strict apply runs first, so a frame-consistent queue — and a deferred row that happens to
 * still apply — behaves exactly as before. Only when that throws are the frame-debt rows left
 * out. A failure that survives their removal is a genuine invariant break and rethrows.
 *
 * A current-frame row built on a row that was left out is left out with it (and stays queued
 * just the same): its ops address structure that row would have created, and `add`/`replace`
 * do not fail on a missing parent — they create it, so the row would put a container holding
 * only its own write where the whole value belongs. See {@link salvagePendingForView} for how
 * "built on" is decided.
 */
export function applyPendingForView<T>(committedState: T, committedRev: number, pending: Change[]): T {
  try {
    return applyChanges(committedState, pending);
  } catch (err) {
    if (pending.every(change => change.baseRev >= committedRev)) throw err;
    return walkPending(committedState, committedRev, pending, false).state;
  }
}

export interface SalvagedPending<T> {
  /** Committed state advanced through the changes that are in the view. */
  state: T;
  /** `pending` without `dropped`, in queue order. Includes rows that are queued but not in the view. */
  kept: Change[];
  /** The changes taken out of the queue, in queue order. */
  dropped: Change[];
  /** How many of `dropped` did not fail themselves, and went because a change they were built on did. */
  dependents: number;
}

/**
 * {@link applyPendingForView} for a queue it throws on: the view is built one change at a time
 * and a current-frame change that fails strict apply is dropped instead of aborting the walk.
 *
 * The queue is a sequential program, so a change cannot be taken out of it alone — the ones
 * after it were written on top of it. `computePendingEjection` handles that by inverting the
 * removed change and walking the inverse through its successors, which is not available here:
 * a change that does not apply cannot be inverted. What can still be read off it is the part of
 * that inverse which removes structure — the paths its ops would have written that do not
 * exist in the state it failed against. A later change is built on the dropped one when an op
 * of it writes beneath such a path, or reads or removes the path itself, while the path is
 * still missing at the point that op runs, and it is dropped whole along with it. Left in the
 * queue it would not fail: `add` and `replace` create the missing containers of their path, so
 * it would apply as a container holding nothing but its own write.
 *
 * An op that writes a value AT a missing path supplies it as authored and is not a dependent;
 * once any surviving change has put something there the path is no longer missing. An append
 * (`/-`) is not tracked — it names a position, not a place a later op can be scoped to — and
 * neither is the shift a dropped array insert would have given the indexes after it.
 *
 * The paths a dropped dependent would have created are missing too, so the rule carries down
 * a chain of creates.
 *
 * Frame-debt rows are never dropped (see {@link applyPendingForView}): they are kept queued
 * and out of the view, and so are the current-frame rows built on them.
 */
export function salvagePendingForView<T>(
  committedState: T,
  committedRev: number,
  pending: Change[]
): SalvagedPending<T> {
  return walkPending(committedState, committedRev, pending, true);
}

function walkPending<T>(
  committedState: T,
  committedRev: number,
  pending: Change[],
  salvage: boolean
): SalvagedPending<T> {
  let state = committedState;
  const kept: Change[] = [];
  const dropped: Change[] = [];
  let dependents = 0;
  // Paths an earlier change would have created that nothing in the view has: `lost` when that
  // change was dropped, `deferred` when it is still queued and only held out of the view.
  const lost = new Set<string>();
  const deferred = new Set<string>();
  // Rows queued but held out of the view: frame-debt rows and the current-frame rows built on them.
  const held = new Set<Change>();

  for (let i = 0; i < pending.length; i++) {
    const change = pending[i];
    if (change.baseRev < committedRev) {
      // Frame debt, not corruption: waiting to flush at its own baseRev. Queued, not shown.
      kept.push(change);
      held.add(change);
      noteCreated(state, change.ops, deferred);
      continue;
    }
    if (buildsOn(state, change.ops, lost)) {
      dropped.push(change);
      dependents++;
      noteCreated(state, change.ops, lost);
      continue;
    }
    if (buildsOn(state, change.ops, deferred)) {
      kept.push(change);
      held.add(change);
      noteCreated(state, change.ops, deferred);
      continue;
    }
    try {
      state = applyPatch(state, change.ops, { strict: true });
      kept.push(change);
    } catch (cause) {
      if (needsDeferred(state, change.ops, pending, i, held)) {
        // Not beneath anything the older-frame row would have created, but it applies only with
        // that row's effects (an insert that shifted an index, say). Held out with it, still queued.
        kept.push(change);
        held.add(change);
        noteCreated(state, change.ops, deferred);
        continue;
      }
      if (!salvage) throw new ApplyChangesError(change.id, change.rev, i, cause);
      dropped.push(change);
      noteCreated(state, change.ops, lost);
    }
  }
  return { state, kept, dropped, dependents };
}

/**
 * Would `ops`, which failed against `state`, apply if the held-out rows before index `end`
 * were in the view? Those rows (older-frame rows and the current-frame rows held out with them)
 * are replayed best-effort in queue order on top of `state` (older-frame rows address a frame it
 * has moved past, so ops that no longer fit are skipped).
 */
function needsDeferred(state: unknown, ops: JSONPatchOp[], pending: Change[], end: number, held: Set<Change>): boolean {
  if (!Array.isArray(ops)) return false;
  let shadow = state;
  let any = false;
  for (let i = 0; i < end; i++) {
    const row = pending[i];
    if (!held.has(row) || !Array.isArray(row.ops)) continue;
    any = true;
    shadow = applyPatch(shadow, row.ops.filter(isOp), { silent: true });
  }
  if (!any) return false;
  try {
    applyPatch(shadow, ops, { strict: true });
    return true;
  } catch {
    return false;
  }
}

/** A well-formed op: the pending queue is persisted data and a row in it can be malformed. */
function isOp(op: JSONPatchOp): boolean {
  return op != null && typeof op.path === 'string';
}

/** Does `op` put a value at its path, as opposed to removing or only reading what is there? */
function writes(op: JSONPatchOp): boolean {
  const like = getTypes()[op.op]?.like;
  return like !== 'remove' && like !== 'test';
}

/**
 * Record the paths `ops` would have created in `state`, had they been applied to it: for each
 * written path, its shallowest ancestor that does not exist (the path itself when its parent does).
 */
function noteCreated(state: unknown, ops: JSONPatchOp[], into: Set<string>): void {
  if (!Array.isArray(ops)) return;
  for (const op of ops) {
    if (!isOp(op) || !writes(op) || op.path.endsWith('/-')) continue;
    const segments = op.path.split('/');
    for (let n = 2; n <= segments.length; n++) {
      const prefix = segments.slice(0, n).join('/');
      if (!pathExistsInState(state, prefix)) {
        into.add(prefix);
        break;
      }
    }
  }
}

/** Does `op` need something to already be at `path` — to read, to remove, or to write beneath? */
function reaches(op: JSONPatchOp, path: string): boolean {
  const beneath = `${path}/`;
  if (typeof op.from === 'string' && (op.from === path || op.from.startsWith(beneath))) return true;
  return op.path.startsWith(beneath) || (op.path === path && !writes(op));
}

/** Does any of `ops` reach one of the `missing` paths while it is still missing? */
function buildsOn(state: unknown, ops: JSONPatchOp[], missing: Set<string>): boolean {
  if (missing.size === 0 || !Array.isArray(ops)) return false;
  // Judged where the op runs: an earlier op of the same change may have created the path.
  let before = state;
  for (const op of ops) {
    if (!isOp(op)) continue;
    for (const path of missing) {
      if (reaches(op, path) && !pathExistsInState(before, path)) return true;
    }
    before = applyPatch(before, [op], { silent: true });
  }
  return false;
}
