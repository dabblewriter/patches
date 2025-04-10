import { Compact } from '../json-patch/compactPatch.js';
import type { CompactPatchOp, State } from '../types.js';
import { getTypeLike } from './getType.js';
import { isAdd } from './ops.js';
import { getIndexAndEnd } from './paths.js';
import { getValue } from './pluck.js';

/**
 * Adjust ops within an array
 */
export function updateArrayPath(
  state: State,
  otherOp: CompactPatchOp,
  pathName: 'from' | 'path',
  thisPrefix: string,
  thisIndex: number,
  modifier: 1 | -1
): CompactPatchOp | [CompactPatchOp, CompactPatchOp] | null {
  const path = pathName === 'from' ? Compact.getFrom(otherOp) : Compact.getPath(otherOp);
  if (!path || !path.startsWith(thisPrefix)) return otherOp;

  const otherOpName = Compact.getOp(otherOp);
  const otherFrom = Compact.getFrom(otherOp);
  const otherPath = Compact.getPath(otherOp);
  const otherSoft = Compact.getSoft(otherOp);

  const [otherIndex, end] = getIndexAndEnd(state, path, thisPrefix.length);
  const opLike = getTypeLike(state, otherOpName);

  // A bit of complex logic to handle moves upwards in an array. Since an item is removed earier in the array and added later, the other index is like it was one less (or this index was one more), so we correct it
  if (
    opLike === 'move' &&
    pathName === 'path' &&
    otherFrom?.startsWith(thisPrefix) &&
    getIndexAndEnd(state, otherFrom, thisPrefix.length)[0] < otherIndex
  ) {
    thisIndex -= 1;
  }

  if (otherIndex < thisIndex) return otherOp;

  // When this is a removed item and the op is a subpath or a non-add, remove it.
  if (otherIndex === thisIndex && modifier === -1) {
    if (end === path.length) {
      // If we are adding to the location something got removed, continue adding it.
      if (isAdd(state, otherOp, pathName)) return otherOp;
      if (otherOpName === '=') {
        otherOp = getValue(state, otherOp);
        return Compact.update(otherOp, { op: 'add' });
      }
      // If we are replacing an item which was removed, add it (don't replace something else in the array)
      if (opLike === 'replace') return [Compact.create('add', otherPath, null), otherOp];
    }
    return null;
  } else if (isAdd(state, otherOp, pathName) && otherIndex === thisIndex && end === path.length) {
    if (otherSoft) return null;
    return otherOp;
  }

  const newPath = thisPrefix + (otherIndex + modifier) + path.slice(end);
  otherOp = getValue(state, otherOp);
  Compact.update(otherOp, { [pathName]: newPath });

  return otherOp;
}
