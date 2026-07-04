import type { JSONPatchOp, JSONPatchOpHandler, State } from '../types.js';
import { getOpData } from '../utils/getOpData.js';
import { getTypeLike } from '../utils/getType.js';
import { log } from '../utils/log.js';
import { isAdd, isHardSet, mapAndFilterOps, updateRemovedOps } from '../utils/ops.js';
import { getArrayPrefixAndIndex, getIndexAndEnd, isArrayPath } from '../utils/paths.js';
import { getValue, pluckWithShallowCopy } from '../utils/pluck.js';
import { toArrayIndex } from '../utils/toArrayIndex.js';
import { updateArrayIndexes } from '../utils/updateArrayIndexes.js';
import { add } from './add.js';

export const move: JSONPatchOpHandler = {
  like: 'move',

  apply(state, path, from: string) {
    if (path === from) return;
    let value: any;
    const [keys, lastKey, target] = getOpData(state, from);

    if (target === null) {
      return `[op:move] path not found: ${from}`;
    }

    if (Array.isArray(target)) {
      const index = toArrayIndex(target, lastKey);
      if (index < 0 || target.length <= index) {
        return `[op:move] invalid array index: ${path}`;
      }
      value = target[index];
      pluckWithShallowCopy(state, keys, true).splice(index, 1);
    } else {
      value = target[lastKey];
      delete pluckWithShallowCopy(state, keys, true)[lastKey];
    }

    return add.apply(state, path, value);
  },

  invert(_state, { path, from }) {
    return { op: 'move', from: path, path: '' + from };
  },

  transform(state, thisOp, otherOps) {
    log('Transforming', otherOps, 'against "move"', thisOp);
    let removed = false;
    const { from, path } = thisOp as { from: string; path: string };
    if (from === path) return otherOps;

    const [fromPrefix, fromIndex] = getArrayPrefixAndIndex(state, from);
    const [pathPrefix, pathIndex] = getArrayPrefixAndIndex(state, path);
    const isPathArray = pathPrefix !== undefined;
    const isSameArray = isPathArray && pathPrefix === fromPrefix;

    /*
    A move needs to do a "remove" and an "add" at once with `from` and `path`. If it is being moved from one location in
    an array to another in the same array, this needs to be handled special.

    1. Ops that were added to where the move lands when not an array should be removed just like with an add/copy
    2. Ops that were added to where the move came from should be translated to the new path
    3. Ops that are in an array with the moved item after need to be adjusted up or down
      3a. But, ops that were translated to the new path shouldn't get adjusted up or down by these adjustments
    */

    // otherOpsFirst: otherOps precede this move in the authoritative order (see transformPatch).
    // "This move wins" is only correct when the MIRROR half of the diamond lets this move
    // survive — a queue move dies in the mirror whenever an earlier committed op consumed or
    // clobbered its source (a same-source move, or a hard set at the source or an ancestor of
    // it). When that happens the committed side's effects must survive this direction too, or
    // the two halves disagree and later queue entries are transformed against a frame that never
    // existed, committing ops that fail strict apply everywhere they replay (DAB-601).
    const mirrorKiller = state.otherOpsFirst ? findMirrorKiller(state, otherOps, from) : undefined;

    // A move removes the value from one place then adds it to another, update the paths and add a marker to them so
    // they won't be altered by `updateArrayIndexes`, then remove the markers afterwards
    const inputOps = otherOps;
    otherOps = mapAndFilterOps(otherOps, (otherOp, index, breakAfter) => {
      if (removed) {
        // The moved value was removed by an earlier op in this patch, so this side's state (moved then removed) now
        // matches the space these ops were written in; mark them so the array shifts below leave them untouched
        return protectOp(otherOp);
      }
      const opLike = getTypeLike(state, otherOp);
      if (opLike === 'remove' && from === otherOp.path) {
        // Once an operation removes the moved value, the following ops should be working on the old location and not
        // not the new one. Allow the following operations (which may include add/remove) to affect the old location
        removed = true;
      }
      if (state.otherOpsFirst && opLike === 'move' && otherOp.from === from && !mirrorKiller) {
        // Concurrent moves of the same source where the queue move SURVIVES the mirror (the
        // mirror follows it through this committed move and nothing in the committed tail kills
        // it): the queue (later) move wins the value's final home. Drop the committed move and
        // map its trailing ops onto our destination via a synthetic move — the value they were
        // written against lives at `path` now. The results are marked so the phases below leave
        // them untouched.
        breakAfter();
        const rest = inputOps.slice(index + 1);
        if (otherOp.path === path) return rest.map(protectOp); // identical move — frames already agree
        return move.transform(state, { op: 'move', from: otherOp.path, path }, rest).map(protectOp);
      }
      if (mirrorKiller?.op === otherOp) {
        if (mirrorKiller.kind === 'move') {
          // Concurrent moves of the same source: the mirror drops THIS (queue) move — the value
          // had already moved away when the committed change landed — so the committed move must
          // survive this direction too. In this frame the value lives at the queue move's
          // destination, so redirect the committed move to pull from there; its own destination
          // (array insertion included) is preserved, keeping later queue entries in the frame
          // the mirror actually committed. Identical destinations mean the frames already agree
          // for this value: drop the move and keep the committed tail untouched.
          if (otherOp.path === path) {
            breakAfter();
            return inputOps.slice(index + 1).map(protectOp);
          }
          return protectOp({ ...otherOp, from: path });
        }
        // A committed hard set at our source (or an ancestor of it): the set wins — this move
        // consumed a value the set had already overwritten, so the mirrored direction drops this
        // move (see updateRemovedOps). The set's residual in our frame must then also kill the
        // ghost our move left at the destination, or ops depending on it survive incorrectly.
        // The set itself stays AT its own path — a literal `replace` clobbers the source and must
        // not be redirected to the destination, while at an ARRAY INDEX an add/copy/move-in
        // INSERTS rather than overwrites (it never clobbers the moved value), so those are
        // excluded from killer detection and fall through to the index shifting below.
        return [protectOp({ op: 'remove', path }), otherOp];
      }
      const original = otherOp;
      otherOp = updateMovePath(state, otherOp, 'path', from, path, original);
      otherOp = updateMovePath(state, otherOp, 'from', from, path, original);
      return otherOp;
    });

    // Remove/adjust items that were affected by this item moving (those that actually moved because of it will not
    // be affected because they have a temporary $ marker prefix that will keep them from doing so)
    if (isSameArray) {
      // need special logic when a move is within one array
      otherOps = updateArrayIndexesForMove(state, fromPrefix, fromIndex, pathIndex, otherOps);
    } else {
      // if a move is not within one array, treat it as a remove then add
      if (isArrayPath(from, state)) {
        otherOps = updateArrayIndexes(state, from, otherOps, -1);
      } else {
        otherOps = updateRemovedOps(state, from, otherOps);
      }

      if (isArrayPath(path, state)) {
        otherOps = updateArrayIndexes(state, path, otherOps, 1);
      } else {
        // A mirror-killed move has no claim on its destination: suppress the otherOpsFirst
        // "this op wins" resolution in updateRemovedOps so committed sets/move-ins at the
        // destination survive (the ghost they would have superseded is already killed above).
        otherOps = updateRemovedOps(
          state,
          path,
          otherOps,
          false,
          undefined,
          undefined,
          mirrorKiller ? undefined : thisOp
        );
      }
    }

    // Remove the move markers added with `updateMovePath`
    return mapAndFilterOps(otherOps, removeMoveMarkers);
  },
};

/**
 * Update paths for a move operation, adding a marker so the path will not be altered by array updates.
 */
function updateMovePath(
  state: State,
  op: JSONPatchOp,
  pathName: 'from' | 'path',
  from: string,
  to: string,
  original: JSONPatchOp
): JSONPatchOp {
  const path = op[pathName];
  if (!path) return op; // No adjustment needed on a property that doesn't exist

  // If a value is being added or copied to the old location it should not be adjusted
  if (isAdd(state, op, pathName) && op.path === from) {
    return op;
  }

  // If this path needs to be changed due to a move operation, change it, but prefix it with a $ temporarily so when we
  // adjust the array indexes to account for this change, we aren't changing this path we JUST set. We will remove the
  // $ prefix right after we adjust arrays affected by this move.
  if (path === from || path.indexOf(from + '/') === 0) {
    if (op === original) op = Object.assign({}, op);
    log('Moving', op, 'from', from, 'to', to);
    // Add a marker "$" so this path will not be double-updated by array index updates
    op[pathName] = '$' + path.replace(from, to);
  }

  return op;
}

/**
 * Update array indexes to account for values being added or removed from an array. If the path is not an array index
 * or if nothing is changed then the original array is returned.
 */
function updateArrayIndexesForMove(
  state: State,
  prefix: string,
  fromIndex: number,
  pathIndex: number,
  otherOps: JSONPatchOp[]
) {
  // Check ops for any that need to be replaced
  log(`Shifting array indexes for a move between ${prefix}/${fromIndex} and ${prefix}/${pathIndex}`);

  return mapAndFilterOps(otherOps, otherOp => {
    // check for items from the same array that will be affected
    const fromUpdate = updateArrayPathForMove(state, otherOp, 'from', prefix, fromIndex, pathIndex);
    const pathUpdate = updateArrayPathForMove(state, otherOp, 'path', prefix, fromIndex, pathIndex);
    if (!fromUpdate || !pathUpdate) return null;
    if (fromUpdate !== otherOp || pathUpdate !== otherOp) {
      otherOp = { ...otherOp, path: pathUpdate.path };
      if (fromUpdate.from) otherOp.from = fromUpdate.from;
    }
    return otherOp;
  });
}

/**
 * Get the adjusted path if it is higher, or undefined if not.
 */
function updateArrayPathForMove(
  state: State,
  otherOp: JSONPatchOp,
  pathName: 'from' | 'path',
  prefix: string,
  from: number,
  to: number
): JSONPatchOp {
  const path = otherOp[pathName];
  if (!path || !path.startsWith(prefix)) return otherOp;

  const min = Math.min(from, to);
  const max = Math.max(from, to);
  const [otherIndex, end] = getIndexAndEnd(state, path, prefix.length);
  if (otherIndex === undefined) return otherOp; // if a prop on an array is being set, for e.g.
  const isFinalProp = end === path.length;
  const opLike = getTypeLike(state, otherOp);

  // If this index is not within the movement boundary, don't touch it
  if (otherIndex < min || otherIndex > max) {
    return otherOp;
  }

  // If the index touches the boundary on an unaffected side, don't touch it
  if (isFinalProp && isAdd(state, otherOp, pathName)) {
    /*
      if the move is from low to high (min is a remove, max is an add) then
      use the remove logic with an add

      if the move is from high to low (min is an add, max is a remove) then
      use the add logic at the bottom
    */
    if (otherIndex === min) {
      if (min === from) {
        // treat like a remove
        return otherOp;
      } else {
        // treat like an add
        return otherOp;
      }
    } else if (otherIndex === max) {
      if (max === from) {
        // treat like a remove
        const fromIndex = getIndexAndEnd(state, otherOp.from, prefix.length)[0];
        if (opLike === 'move' && pathName === 'path' && to <= fromIndex && fromIndex < from) return otherOp;
        // continue
      } else {
        // treat like an add
        return otherOp;
      }
    }
  }

  const modifier = from === min ? -1 : 1;
  const newPath = prefix + (otherIndex + modifier) + path.slice(end);
  return getValue(state, otherOp, pathName, newPath);
}

interface MirrorKiller {
  op: JSONPatchOp;
  kind: 'move' | 'set';
}

/**
 * In `otherOpsFirst` mode, decide whether the MIRROR half of the diamond drops the move being
 * transformed against (a queue move with source `from`).
 *
 * The mirror transforms the queue move against the committed ops in order: a committed
 * same-source move makes it FOLLOW the value to the committed destination (the queue's re-move
 * still wins from there), and it only dies when some committed op clobbers wherever the value
 * currently lives — a hard set at that path or an ancestor of it, or a remove covering it. This
 * scan simulates exactly that walk. When the move dies after being followed through a
 * same-source move, the killer reported is that MOVE (the committed side owns the value, so the
 * advance must keep the committed move, redirected to pull from the queue's destination); when
 * it dies on a set/remove before any follow, the killer is that op (the advance keeps it and
 * kills the ghost the dead queue move left at its destination). No killer means the queue move
 * survives the mirror and genuinely wins as the later writer.
 *
 * Array-index adds/copies/move-ins are INSERTS — they shift, never clobber — so they are not
 * killers (`isHardSet` excludes them); a literal `replace` overwrites even at an array index.
 * Exact-path set detection keeps parity with the pre-DAB-601 rule (array-path sources excluded)
 * so in-place @-ops continue to ride the move. An exact remove of the un-followed source is not
 * a killer here: the plain translation path already follows it to the destination, which kills
 * the ghost naturally.
 */
function findMirrorKiller(state: State, otherOps: JSONPatchOp[], from: string): MirrorKiller | undefined {
  let src = from;
  let followedMove: JSONPatchOp | undefined;
  for (const op of otherOps) {
    const opLike = getTypeLike(state, op);
    if (opLike === 'move' && op.from === src) {
      followedMove = followedMove ?? op;
      src = op.path;
      continue;
    }
    const exactKill =
      op.path === src &&
      !op.soft &&
      (src === from
        ? // Pre-follow: parity with the pre-DAB-601 exact-source rule — array-path sources are
          // excluded wholesale so in-place @-ops and index inserts ride the move.
          (isAdd(state, op, 'path') || op.op === 'replace') && !isArrayPath(src, state)
        : // Post-follow: the mirror's exact-from kill (a set consuming a move's source) applies a
          // literal replace even at an array index — it overwrites the element — while
          // add/copy/move-in at an index insert and never clobber.
          op.op === 'replace' || (isAdd(state, op, 'path') && !isArrayPath(src, state)));
    const kills =
      exactKill ||
      (op.path && src.startsWith(op.path + '/') && isHardSet(state, op, op.path)) ||
      (opLike === 'remove' && (src.startsWith(op.path + '/') || (op.path === src && src !== from)));
    if (kills) {
      return followedMove ? { op: followedMove, kind: 'move' } : { op, kind: 'set' };
    }
  }
  return undefined;
}

/**
 * Clone an op with `$` markers on its paths so the adjustment phases in `move.transform` leave it
 * untouched (the markers are stripped by `removeMoveMarkers` before returning).
 */
function protectOp(op: JSONPatchOp): JSONPatchOp {
  op = { ...op, path: '$' + op.path };
  if (op.from) op.from = '$' + op.from;
  return op;
}

/**
 * Remove any move markers placed during updateMovePath. This occurs in-place since these objects have already been
 * cloned.
 */
function removeMoveMarkers(op: JSONPatchOp) {
  if (op.path[0] === '$') {
    op.path = op.path.slice(1);
  }
  if (op.from && op.from[0] === '$') {
    op.from = op.from.slice(1);
  }
  if (op.from === op.path) return null;
  return op;
}
