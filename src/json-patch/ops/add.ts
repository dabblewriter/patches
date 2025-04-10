import type { JSONPatchOpHandler } from '../../types.js';
import { deepEqual } from '../../utils/deepEqual.js';
import { getOpData } from '../../utils/getOpData.js';
import {
  isArrayPath,
  isEmptyObject,
  log,
  updateArrayIndexes,
  updateRemovedOps,
  updateSoftWrites,
} from '../../utils/index.js';
import { pluckWithShallowCopy } from '../../utils/pluck.js';
import { toArrayIndex } from '../../utils/toArrayIndex.js';
import { Compact } from '../compactPatch.js';

export const add: JSONPatchOpHandler = {
  like: 'add',

  apply(state, path, value) {
    if (typeof value === 'undefined') {
      return '[op:add] require value, but got undefined';
    }
    const [keys, lastKey, target] = getOpData(state, path, true);

    if (target === null) {
      return `[op:add] path not found: ${path}`;
    }

    if (Array.isArray(target)) {
      const index = toArrayIndex(target, lastKey);
      if (target.length < index) {
        return `[op:add] invalid array index: ${path}`;
      }
      pluckWithShallowCopy(state, keys).splice(index, 0, value);
    } else {
      if (!deepEqual(target[lastKey], value)) {
        pluckWithShallowCopy(state, keys)[lastKey] = value;
      }
    }
  },

  invert(_state, op, value, changedObj, isIndex) {
    const path = Compact.getPath(op);
    if (path.endsWith('/-')) return Compact.create('remove', path.replace('-', changedObj.length));
    else if (isIndex) return Compact.create('remove', path);
    return value === undefined ? Compact.create('remove', path) : Compact.create('replace', path, value);
  },

  transform(state, thisOp, otherOps) {
    log('Transforming', otherOps, 'against "add"', thisOp);
    const thisPath = Compact.getPath(thisOp);
    const thisValue = Compact.getValue(thisOp);

    if (isArrayPath(thisPath, state)) {
      // Adjust any operations on the same array by 1 to account for this new entry
      return updateArrayIndexes(state, thisPath, otherOps, 1);
    } else if (isEmptyObject(thisValue)) {
      // Treat empty objects special. If two empty objects are added to the same location, don't overwrite the existing
      // one, allowing for the merging of maps together which did not exist before
      return updateSoftWrites(thisPath, otherOps);
    } else {
      // Remove anything that was done at this path since it is being overwritten by the add
      return updateRemovedOps(state, thisPath, otherOps);
    }
  },
};
