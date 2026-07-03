import type { JSONPatchOp, State } from '../types.js';
import { getTypeLike } from './getType.js';
import { log } from './log.js';
import { isArrayPath } from './paths.js';
import { updateArrayIndexes } from './updateArrayIndexes.js';

/**
 * Check whether this operation is an add operation of some sort (add, copy, move).
 */
export function isAdd(state: State, op: JSONPatchOp, pathName: 'from' | 'path') {
  const like = getTypeLike(state, op);
  return (like === 'add' || like === 'copy' || like === 'move') && pathName === 'path';
}

/**
 * Check whether this operation unconditionally sets a whole new value at `path` (add, replace, or
 * the destination of a copy/move) — as opposed to ops that update the existing value in place
 * (@inc, @bit, @txt, …) or remove it.
 *
 * At an ARRAY INDEX (or an `/-` append), add/copy/move-in INSERT a new element rather than
 * overwrite the existing one, so they are never a hard set of the value at `path` — only a
 * replace-like op genuinely overwrites an array element.
 */
export function isHardSet(state: State, op: JSONPatchOp, path: string) {
  if (op.path !== path || op.soft) return false;
  const like = getTypeLike(state, op);
  if (like === 'replace') return true;
  if (like === 'add' || like === 'copy' || like === 'move') {
    return !isArrayPath(path, state) && !path.endsWith('/-');
  }
  return false;
}

/**
 * Transforms an array of ops, returning the original if there is no change, filtering out ops that are dropped.
 */
export function mapAndFilterOps(
  ops: JSONPatchOp[],
  iterator: (
    op: JSONPatchOp,
    index: number,
    breakAfter: (keepRest?: boolean) => void
  ) => JSONPatchOp | JSONPatchOp[] | null
): JSONPatchOp[] {
  let changed = false;
  const mapped: JSONPatchOp[] = [];
  let shouldBreak = false;
  let keepRest: boolean | undefined;
  const breakAfter = (keep?: boolean): void => {
    shouldBreak = true;
    keepRest = keep;
  };
  for (let i = 0; i < ops.length; i++) {
    const original = ops[i];
    // If an op was copied or moved to the same path, it is a no-op and should be removed
    if (original.from === original.path) {
      if (!changed) changed = true;
      continue;
    }
    let value = iterator(original, i, breakAfter);
    if (value && !Array.isArray(value) && value.from === value.path) value = null;
    if (!changed && value !== original) changed = true;
    if (Array.isArray(value)) mapped.push(...value);
    else if (value) mapped.push(value);
    if (shouldBreak) {
      if (keepRest) mapped.push(...ops.slice(i + 1));
      break;
    }
  }
  return changed ? mapped : ops;
}

/**
 * Remove operations that apply to a value which was removed.
 *
 * `thisOp` (when provided by set-like callers — add/replace/copy/move) enables the
 * last-writer-wins rule for `state.otherOpsFirst` transforms: when the ops being transformed
 * precede `thisOp` in the authoritative order and both unconditionally set `thisPath`, the
 * earlier set is superseded and dropped, and the walk continues so its dependents die too.
 *
 * Dropping the superseded set must not forget its WITHIN-PATCH downstream effects: when a later
 * op in the same patch moves/copies FROM `thisPath`, the destination was still overwritten by
 * the earlier patch even though the value at `thisPath` itself lost. The walk therefore tracks
 * the superseded set and composes it with the escaping move/copy into a set at the destination
 * (re-rooting any buffered edits under `thisPath` onto it), so later queue entries still see
 * the destination as overwritten. Without this, a committed `set /x` + `move /x -> /z` advanced
 * across a queue re-set of `/x` vanished entirely and concurrent ops under `/z` survived —
 * committing ops that fail strict apply (array paths) or resurrect stale children (objects).
 *
 * A superseded move-in consumed its source, so `remove <from>` is still owed; it is deferred so
 * a later escape can compose into `move <from> -> <dest>` instead, and flushed before any op
 * that touches the source (or at the end of the walk).
 */
export function updateRemovedOps(
  state: State,
  thisPath: string,
  otherOps: JSONPatchOp[],
  updatableObject = false,
  opOp?: string,
  customHandler?: (op: JSONPatchOp) => any,
  thisOp?: JSONPatchOp
) {
  const softPrefixes = new Set();
  const thisOpWins = !!(state.otherOpsFirst && thisOp && isHardSet(state, thisOp, thisPath));
  // Composition only makes sense where a set at thisPath overwrites a single value (never at an
  // array index, where positional shifting — not LWW — is the semantics).
  const composable = thisOpWins && !isArrayPath(thisPath, state);
  /** The superseded hard set at thisPath whose effect may still escape via a later move/copy. */
  let superseded: JSONPatchOp | undefined;
  /** Deferred `remove <from>` owed by a superseded move-in (cancelled if composed into a move). */
  let owedRemove: JSONPatchOp | undefined;
  /** Ops between the superseded set and an escape that edit the superseded value in place. */
  let trailing: JSONPatchOp[] = [];

  // Literal sets compose by value; copy/move compose by reference, which is only sound when
  // the referenced source is fully disjoint from thisPath (the queue owns thisPath now).
  const isComposableSet = (op: JSONPatchOp) =>
    op.op === 'add' ||
    op.op === 'replace' ||
    ((op.op === 'copy' || op.op === 'move') &&
      !!op.from &&
      !op.from.startsWith(`${thisPath}/`) &&
      !thisPath.startsWith(`${op.from}/`));

  /** Does `op` touch the superseded copy/move source (invalidating by-reference composition)? */
  const touchesSource = (op: JSONPatchOp): boolean => {
    const src = superseded?.from;
    if (!src) return false;
    for (const p of [op.path, op.from]) {
      if (p && (p === src || p.startsWith(`${src}/`) || src.startsWith(`${p}/`))) return true;
    }
    return false;
  };

  const clearSuperseded = () => {
    superseded = undefined;
    trailing = [];
    const flush = owedRemove;
    owedRemove = undefined;
    return flush;
  };

  /** Re-root a buffered edit of the superseded value onto the escape destination. */
  const rebase = (op: JSONPatchOp, dest: string): JSONPatchOp => {
    const mapped = { ...op };
    if (mapped.path.startsWith(`${thisPath}/`)) mapped.path = dest + mapped.path.slice(thisPath.length);
    if (mapped.from?.startsWith(`${thisPath}/`)) mapped.from = dest + mapped.from.slice(thisPath.length);
    return mapped;
  };

  const mapped = mapAndFilterOps(otherOps, (op, index, breakAfter) => {
    const opLike = getTypeLike(state, op);
    const canMergeCustom = customHandler && opOp === op.op;

    // An op touching the superseded move-in's source consumes/recreates it: the owed removal
    // must land before it, and by-reference composition is no longer sound. Escapes of the
    // superseded value (move/copy FROM thisPath) are exempt — the escape branch below owns
    // their interaction with the source.
    let flushed: JSONPatchOp | undefined;
    const isEscape = !updatableObject && op.from === thisPath && (opLike === 'move' || opLike === 'copy');
    if (superseded && !isEscape && touchesSource(op)) {
      flushed = clearSuperseded();
    }
    const emit = (value: JSONPatchOp | JSONPatchOp[] | null): JSONPatchOp | JSONPatchOp[] | null => {
      if (!flushed) return value;
      if (value == null) return flushed;
      return Array.isArray(value) ? [flushed, ...value] : [flushed, value];
    };

    if (thisPath === op.path && opLike !== 'remove' && !canMergeCustom && !op.soft) {
      if (thisOpWins && isHardSet(state, op, thisPath)) {
        // otherOps happened first and thisOp re-set the same path: the earlier set is
        // superseded. Keep walking (no break): later ops depending on the superseded value
        // must die — unless a later move/copy escapes it (see composition above).
        const priorFlush = clearSuperseded();
        if (composable && isComposableSet(op)) {
          superseded = op;
          if (op.op === 'move') owedRemove = { op: 'remove', path: op.from! };
          return emit(priorFlush ?? null);
        }
        // Not composition-eligible (an in-place @-op like, or an array-index replace): a losing
        // move-in still consumed its source — export that removal immediately.
        const residual = opLike === 'move' ? { op: 'remove', path: op.from! } : null;
        return emit(priorFlush ? (residual ? [priorFlush, residual] : priorFlush) : residual);
      }
      // Once an operation sets this value again, we can assume the following ops were working on that and not the
      // old value so they can be kept
      if (op.op !== 'test') {
        breakAfter(true); // stop and keep the remaining ops as-is
      }
      // The kept rest may touch a superseded move-in's source; flush the owed removal first.
      if (superseded) flushed = clearSuperseded() ?? flushed;
      return emit(op);
    }

    const { path, from } = op;
    if (path === thisPath && canMergeCustom) {
      const customOp = customHandler(op);
      if (customOp) return emit(customOp);
    }

    if (!updatableObject && from === thisPath) {
      // Because of the check above, moves and copies will only hit here when the "from" field matches. Whether this
      // op removed or overwrote the value at thisPath, the other patch's move/copy never got it, so ops following the
      // move/copy that target its destination must be dropped rather than let them clobber unrelated data
      if (superseded && (opLike === 'move' || opLike === 'copy')) {
        // Within-patch escape of the superseded value: compose the superseded set with this
        // move/copy into a set at the destination, then re-root the buffered in-place edits.
        let composed: JSONPatchOp | undefined;
        if (superseded.op === 'add' || superseded.op === 'replace') {
          composed = { op: 'add', path: op.path, value: superseded.value };
        } else if (superseded.op === 'copy' || superseded.op === 'move') {
          // A copy escape must not consume the source — only a move escape of a superseded
          // move-in (whose source removal is still owed) composes into a move, subsuming it.
          const composedOp = superseded.op === 'move' && opLike === 'move' && owedRemove ? 'move' : 'copy';
          composed = { op: composedOp, from: superseded.from, path: op.path };
        }
        const entangled =
          composed?.from &&
          (composed.path.startsWith(`${composed.from}/`) || composed.from.startsWith(`${composed.path}/`));
        if (composed && !entangled) {
          const result: JSONPatchOp[] = [];
          // A composed move/copy back onto its own source is a no-op — emit only the edits,
          // and the value is back home, so a superseded move-in's source removal is no longer owed.
          if (composed.from === composed.path) owedRemove = undefined;
          else result.push(composed);
          result.push(...trailing.map(t => rebase(t, op.path)));
          if (opLike === 'move') {
            // The value escaped: thisPath is gone in the earlier patch's frame from here on.
            if (superseded.op === 'move') owedRemove = undefined; // consumed by the composed move
            const flush = clearSuperseded();
            if (flush) result.push(flush);
          }
          // A copy leaves the source in place — keep tracking for further escapes.
          return emit(result);
        }
        // Fall through to the kill behavior when composition isn't possible.
      }
      if (opLike === 'move') {
        // We need the rest of the otherOps to be adjusted against this "move"
        breakAfter();
        return emit(transformRemove(state, op.path, otherOps.slice(index + 1)));
      } else if (opLike === 'copy') {
        // We need future ops on the copied object to be removed
        breakAfter();
        let rest = transformRemove(state, thisPath, otherOps.slice(index + 1));
        rest = transformRemove(state, op.path, rest);
        return emit(rest);
      }
    }

    if (op.soft && path === thisPath) {
      softPrefixes.add(path);
      return emit(null);
    }

    const samePath =
      (!updatableObject && path === thisPath) || (!softPrefixes.has(thisPath) && path.startsWith(`${thisPath}/`));
    const sameFrom =
      (!updatableObject && from === thisPath) || (!softPrefixes.has(thisPath) && from?.startsWith(`${thisPath}/`));
    if (samePath || sameFrom) {
      if (superseded) {
        if (path === thisPath && opLike === 'remove') {
          // The superseded value was removed before it could escape — nothing left to track.
          return emit(clearSuperseded() ?? null);
        }
        const pathWithin = path.startsWith(`${thisPath}/`);
        const fromWithin = !from || from.startsWith(`${thisPath}/`);
        if (pathWithin && fromWithin) {
          // An in-place edit of the superseded value: buffer it so an escape can re-root it.
          trailing.push(op);
          return emit(null);
        }
        // A move OUT of the superseded subtree (or similar) — too entangled to compose.
        return emit(clearSuperseded() ?? null);
      }
      log('Removing', op);
      return emit(null);
    }
    return emit(op);
  });

  // A superseded move-in whose owed source removal was never composed or flushed still
  // consumed its source — emit the removal at the end of the walk.
  return owedRemove ? [...mapped, owedRemove] : mapped;
}

export function transformRemove(
  state: State,
  thisPath: string,
  otherOps: JSONPatchOp[],
  isRemove?: boolean
): JSONPatchOp[] {
  if (isArrayPath(thisPath, state)) {
    return updateArrayIndexes(state, thisPath, otherOps, -1, isRemove);
  } else {
    return updateRemovedOps(state, thisPath, otherOps);
  }
}
