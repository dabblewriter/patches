import type { JSONPatchOpHandler } from '../types.js';
import { getOpData } from '../utils/getOpData.js';
import { log } from '../utils/log.js';
import { updateRemovedOps } from '../utils/ops.js';
import { isArrayPath } from '../utils/paths.js';
import { updateArrayIndexes } from '../utils/updateArrayIndexes.js';
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

  invert(_state, { path }, value, changedObj, isIndex) {
    if (path.endsWith('/-')) return { op: 'remove', path: path.replace('-', changedObj.length) };
    else if (isIndex) return { op: 'remove', path };
    return value === undefined ? { op: 'remove', path } : { op: 'replace', path, value };
  },

  transform(state, thisOp, otherOps) {
    log('Transforming', otherOps, 'against "add"', thisOp);

    if (isArrayPath(thisOp.path, state)) {
      // Adjust any operations on the same array by 1 to account for this new entry
      return updateArrayIndexes(state, thisOp.path, otherOps, 1);
    } else {
      // Remove anything that was done at this path since it is being overwritten
      return updateRemovedOps(state, thisOp.path, otherOps);
    }
  },
};
