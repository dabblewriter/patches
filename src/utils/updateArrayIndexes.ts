import { Compact } from '../json-patch/compactPatch.js';
import type { CompactPatchOp, State } from '../types.js';
import { getTypeLike } from './getType.js';
import { log } from './log.js';
import { isAdd, mapAndFilterOps, transformRemove } from './ops.js';
import { getPrefixAndProp } from './paths.js';
import { updateArrayPath } from './updateArrayPath.js';

/**
 * Update array indexes to account for values being added or removed from an array.
 */
export function updateArrayIndexes(
  state: State,
  thisPath: string,
  otherOps: CompactPatchOp[],
  modifier: 1 | -1,
  isRemove?: boolean
): CompactPatchOp[] {
  const [arrayPrefix, indexStr] = getPrefixAndProp(thisPath);
  const index = parseInt(indexStr);

  log('Shifting array indexes against', thisPath, modifier);

  // Check ops for any that need to be replaced
  return mapAndFilterOps(otherOps, (op, i, breakAfter) => {
    const opName = Compact.getOp(op);
    const path = Compact.getPath(op);
    const from = Compact.getFrom(op);
    const soft = Compact.getSoft(op);

    if (isRemove && thisPath === from) {
      const opLike = getTypeLike(state, opName);
      if (opLike === 'move') {
        // We need the rest of the otherOps to be adjusted against this "move"
        breakAfter();
        return transformRemove(state, path, otherOps.slice(i + 1));
      } else if (opLike === 'copy') {
        // We need future ops on the copied object to be removed
        breakAfter();
        let rest = transformRemove(state, thisPath, otherOps.slice(i + 1));
        rest = transformRemove(state, path, rest);
        return rest;
      }
    }
    if (soft && isAdd(state, op, 'path') && path === thisPath) {
      breakAfter(true);
      return null;
    }
    // check for items from the same array that will be affected
    op = updateArrayPath(state, op, 'from', arrayPrefix, index, modifier) as CompactPatchOp;
    return op && (updateArrayPath(state, op, 'path', arrayPrefix, index, modifier) as CompactPatchOp);
  });
}
