import type { JSONPatchOpHandler } from '../../types.js';
import { get, updateRemovedOps } from '../../utils/index.js';
import { Compact } from '../compactPatch.js';
import { replace } from './replace.js';

/**
 * Increment or decrement a number (using `+` or `-`).
 */
export const increment: JSONPatchOpHandler = {
  like: 'replace',

  apply(state, path, value) {
    return replace.apply(state, path, (get(state, path) || 0) + value);
  },
  transform(state, op, otherOps) {
    const path = Compact.getPath(op);
    return updateRemovedOps(state, path, otherOps, false, true);
  },
  invert(state, op, value, changedObj, isIndex) {
    return replace.invert(state, op, value, changedObj, isIndex);
  },
  compose(_state, value1, value2) {
    return value1 + value2;
  },
};
