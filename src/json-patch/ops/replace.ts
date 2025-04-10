import { JSONPatchOpHandler } from '../../types.js';
import { deepEqual } from '../../utils/deepEqual.js';
import { getOpData } from '../../utils/getOpData.js';
import { log, updateRemovedOps } from '../../utils/index.js';
import { pluckWithShallowCopy } from '../../utils/pluck.js';
import { toArrayIndex } from '../../utils/toArrayIndex.js';
import { Compact } from '../compactPatch.js';

export const replace: JSONPatchOpHandler = {
  like: 'replace',

  apply(state, path, value) {
    if (typeof value === 'undefined') {
      return '[op:replace] require value, but got undefined';
    }
    const [keys, lastKey, target] = getOpData(state, path, true);

    if (target === null) {
      return `[op:replace] path not found: ${path}`;
    }

    if (Array.isArray(target)) {
      const index = toArrayIndex(target, lastKey);
      if (target.length <= index) {
        return `[op:replace] invalid array index: ${path}`;
      }
      if (!deepEqual(target[index], value)) {
        pluckWithShallowCopy(state, keys).splice(index, 1, value);
      }
    } else {
      if (!deepEqual(target[lastKey], value)) {
        pluckWithShallowCopy(state, keys)[lastKey] = value;
      }
    }
  },

  invert(_state, op, value, changedObj) {
    let path = Compact.getPath(op);
    if (path.endsWith('/-')) path = path.replace('-', changedObj.length);
    return value === undefined ? Compact.create('remove', path) : Compact.create('replace', path, value);
  },

  transform(state, thisOp, otherOps) {
    log('Transforming ', otherOps, ' against "replace"', thisOp);
    return updateRemovedOps(state, Compact.getPath(thisOp), otherOps);
  },

  compose(_state, _value1, value2) {
    return value2;
  },
};
