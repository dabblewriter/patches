import type { JSONPatchOpHandler } from '../../types.js';
import { getOpData } from '../../utils/getOpData.js';
import { isArrayPath, log, updateArrayIndexes, updateRemovedOps } from '../../utils/index.js';
import { Compact } from '../compactPatch.js';
import { add } from './add.js';

export const copy: JSONPatchOpHandler = {
  like: 'copy',

  apply(state, path, from: string) {
    const [, lastKey, target] = getOpData(state, from);

    if (target === null) {
      return `[op:copy] path not found: ${from}`;
    }

    return add.apply(state, path, target[lastKey]);
  },

  invert(_state, op, value, changedObj, isIndex) {
    const path = Compact.getPath(op);
    if (path.endsWith('/-')) return Compact.create('remove', path.replace('-', changedObj.length));
    else if (isIndex) return Compact.create('remove', path);
    return value === undefined ? Compact.create('remove', path) : Compact.create('replace', path, value);
  },

  transform(state, thisOp, otherOps) {
    log('Transforming', otherOps, 'against "add"', thisOp);
    const path = Compact.getPath(thisOp);

    if (isArrayPath(path, state)) {
      // Adjust any operations on the same array by 1 to account for this new entry
      return updateArrayIndexes(state, path, otherOps, 1);
    } else {
      // Remove anything that was done at this path since it is being overwritten
      return updateRemovedOps(state, path, otherOps);
    }
  },
};
