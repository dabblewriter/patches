import type { JSONPatchOpHandler } from '../types.js';
import { getOpData } from '../utils/getOpData.js';
import { log } from '../utils/log.js';
import { transformRemove } from '../utils/ops.js';
import { pluckWithShallowCopy } from '../utils/pluck.js';
import { toArrayIndex } from '../utils/toArrayIndex.js';

export const remove: JSONPatchOpHandler = {
  like: 'remove',

  apply(state, path: string) {
    const [keys, lastKey, target] = getOpData(state, path);

    if (target === null) {
      return;
    }

    if (Array.isArray(target)) {
      const index = toArrayIndex(target, lastKey);
      if (index < 0 || target.length <= index) {
        return '[op:remove] invalid array index: ' + path;
      }
      pluckWithShallowCopy(state, keys).splice(index, 1);
    } else {
      delete pluckWithShallowCopy(state, keys)[lastKey];
    }
  },

  invert(_state, { path }, value) {
    return { op: 'add', path, value };
  },

  transform(state, thisOp, otherOps) {
    log('Transforming', otherOps, 'against "remove"', thisOp);
    return transformRemove(state, thisOp.path, otherOps, true);
  },
};
