import type { JSONPatchOp, State } from '../types.js';
import { getTypeLike } from './getType.js';
import { log } from './log.js';
import { isAdd, mapAndFilterOps, transformRemove } from './ops.js';
import { getIndexAndEnd, getPrefixAndProp } from './paths.js';
import { updateArrayPath } from './updateArrayPath.js';

/**
 * Update array indexes to account for values being added or removed from an array.
 */
export function updateArrayIndexes(
  state: State,
  thisPath: string,
  otherOps: JSONPatchOp[],
  modifier: 1 | -1,
  isRemove?: boolean
): JSONPatchOp[] {
  const [arrayPrefix, indexStr] = getPrefixAndProp(thisPath);
  // The index this op applies at, tracked in the coordinate space of the other ops as they evolve. Each other op that
  // changes the array's length at or before this index shifts where this op lands for the ops that follow it.
  let index = parseInt(indexStr);

  log('Shifting array indexes', thisPath, modifier);

  // Check ops for any that need to be replaced
  return mapAndFilterOps(otherOps, (op, i, breakAfter) => {
    const original = op;
    const currentPath = arrayPrefix + index;
    if (isRemove && currentPath === op.from) {
      const opLike = getTypeLike(state, op);
      if (opLike === 'move') {
        // We need the rest of the otherOps to be adjusted against this "move"
        breakAfter();
        return transformRemove(state, op.path, otherOps.slice(i + 1));
      } else if (opLike === 'copy') {
        // We need future ops on the copied object to be removed
        breakAfter();
        let rest = transformRemove(state, currentPath, otherOps.slice(i + 1));
        rest = transformRemove(state, op.path, rest);
        return rest;
      }
    }
    if (op.soft && isAdd(state, op, 'path') && op.path === currentPath) {
      breakAfter(true);
      return null;
    }
    // check for items from the same array that will be affected
    op = updateArrayPath(state, op, 'from', arrayPrefix, index, modifier) as JSONPatchOp;
    op = op && (updateArrayPath(state, op, 'path', arrayPrefix, index, modifier) as JSONPatchOp);

    index = advanceIndexPast(state, arrayPrefix, index, modifier, original, breakAfter);

    return op;
  });
}

/**
 * Advance this op's array index into the coordinate space that follows `otherOp`, so the next op in the sequential
 * patch is compared against the right position.
 */
function advanceIndexPast(
  state: State,
  arrayPrefix: string,
  index: number,
  modifier: 1 | -1,
  otherOp: JSONPatchOp,
  breakAfter: (keepRest?: boolean) => void
): number {
  const opLike = getTypeLike(state, otherOp);

  // The remove half of a move happens before its add half
  if (opLike === 'move' && otherOp.from?.startsWith(arrayPrefix)) {
    const [fromIndex, end] = getIndexAndEnd(state, otherOp.from, arrayPrefix.length);
    if (fromIndex !== undefined && end === otherOp.from.length && fromIndex < index) index -= 1;
  }

  if (!otherOp.path.startsWith(arrayPrefix)) return index;
  const [otherIndex, end] = getIndexAndEnd(state, otherOp.path, arrayPrefix.length);
  if (otherIndex === undefined || end !== otherOp.path.length) return index;

  if (isAdd(state, otherOp, 'path')) {
    // An insert at or before this index shifts this op up for the ops that follow
    if (otherIndex <= index) index += 1;
  } else if (opLike === 'remove') {
    if (otherIndex < index) index -= 1;
    else if (otherIndex === index && modifier === -1) {
      // Both patches removed the same element; the remaining ops already operate in the space where it is gone
      breakAfter(true);
    }
  } else if (modifier === -1 && otherIndex === index && opLike === 'replace') {
    // The other patch wrote back into the removed slot, so the remaining ops target that new value and their indexes
    // already account for the element this op removed
    breakAfter(true);
  }

  return index;
}
