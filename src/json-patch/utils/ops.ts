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
 */
export function updateRemovedOps(
  state: State,
  thisPath: string,
  otherOps: JSONPatchOp[],
  isRemove = false,
  updatableObject = false,
  opOp?: string,
  customHandler?: (op: JSONPatchOp) => any
) {
  const softPrefixes = new Set();

  return mapAndFilterOps(otherOps, (op, index, breakAfter) => {
    const opLike = getTypeLike(state, op);
    const canMergeCustom = customHandler && opOp === op.op;

    if (thisPath === op.path && opLike !== 'remove' && !canMergeCustom && !op.soft) {
      // Once an operation sets this value again, we can assume the following ops were working on that and not the
      // old value so they can be kept
      if (op.op !== 'test') {
        breakAfter(true); // stop and keep the remaining ops as-is
      }
      return op;
    }

    const { path, from } = op;
    if (path === thisPath && canMergeCustom) {
      const customOp = customHandler(op);
      if (customOp) return customOp;
    }

    if (isRemove && !updatableObject && from === thisPath) {
      // Because of the check above, moves and copies will only hit here when the "from" field matches
      if (opLike === 'move') {
        // We need the rest of the otherOps to be adjusted against this "move"
        breakAfter();
        return transformRemove(state, op.path, otherOps.slice(index + 1));
      } else if (opLike === 'copy') {
        // We need future ops on the copied object to be removed
        breakAfter();
        let rest = transformRemove(state, thisPath, otherOps.slice(index + 1));
        rest = transformRemove(state, op.path, rest);
        return rest;
      }
    }

    if (op.soft && path === thisPath) {
      softPrefixes.add(path);
      return null;
    }

    const samePath =
      (!updatableObject && path === thisPath) || (!softPrefixes.has(thisPath) && path.startsWith(`${thisPath}/`));
    const sameFrom =
      (!updatableObject && from === thisPath) || (!softPrefixes.has(thisPath) && from?.startsWith(`${thisPath}/`));
    if (samePath || sameFrom) {
      log('Removing', op);
      return null;
    }
    return op;
  });
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
    return updateRemovedOps(state, thisPath, otherOps, isRemove);
  }
}
