import type { JSONPatchOpHandler } from '../types.js';
import { get } from '../utils/get.js';
import { updateRemovedOps } from '../utils/ops.js';
import { replace } from './replace.js';

/**
 * Set a value only if it's greater than the current value. Works with numbers or strings
 * (ISO dates compare correctly). Useful for tracking "latest" values like lastModifiedAt.
 */
export const max: JSONPatchOpHandler = {
  like: 'replace',

  apply(state, path, value) {
    const current = get(state, path);
    // Only apply if current is null/undefined, or new value is greater
    if (current == null || value > current) {
      return replace.apply(state, path, value);
    }
    // No-op: return undefined (success) without mutating state
  },

  transform(state, thisOp, otherOps) {
    return updateRemovedOps(state, thisOp.path, otherOps, false, true);
  },

  invert(state, op, value, changedObj, isIndex) {
    return replace.invert(state, op, value, changedObj, isIndex);
  },

  compose(_state, value1, value2) {
    return value1 > value2 ? value1 : value2;
  },
};

/**
 * Set a value only if it's less than the current value. Works with numbers or strings
 * (ISO dates compare correctly). Useful for tracking "earliest" values like createdAt.
 */
export const min: JSONPatchOpHandler = {
  like: 'replace',

  apply(state, path, value) {
    const current = get(state, path);
    // Only apply if current is null/undefined, or new value is smaller
    if (current == null || value < current) {
      return replace.apply(state, path, value);
    }
    // No-op: return undefined (success) without mutating state
  },

  transform(state, thisOp, otherOps) {
    return updateRemovedOps(state, thisOp.path, otherOps, false, true);
  },

  invert(state, op, value, changedObj, isIndex) {
    return replace.invert(state, op, value, changedObj, isIndex);
  },

  compose(_state, value1, value2) {
    return value1 < value2 ? value1 : value2;
  },
};
