import type { JSONPatchOpHandler } from '../types.js';
import { get } from '../utils/get.js';
import { updateRemovedOps } from '../utils/ops.js';
import { replace } from './replace.js';

/**
 * Increment or decrement a number (using `+` or `-`).
 */
export const increment: JSONPatchOpHandler = {
  like: 'replace',

  apply(state, path, value) {
    return replace.apply(state, path, (get(state, path) || 0) + value);
  },
  transform(state, thisOp, otherOps) {
    return updateRemovedOps(state, thisOp.path, otherOps, false, true);
  },
  invert(state, op, value, changedObj, isIndex) {
    return replace.invert(state, op, value, changedObj, isIndex);
  },
  compose(_state, value1, value2) {
    return value1 + value2;
  },
};
