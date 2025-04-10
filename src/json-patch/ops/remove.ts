import { type JSONPatchOpHandler } from '../../types.js';
import { getOpData } from '../../utils/getOpData.js';
import { log, transformRemove } from '../../utils/index.js';
import { pluckWithShallowCopy } from '../../utils/pluck.js';
import { toArrayIndex } from '../../utils/toArrayIndex.js';
import { Compact } from '../compactPatch.js';

export const remove: JSONPatchOpHandler = {
  like: 'remove',

  apply(state, path: string) {
    const [keys, lastKey, target] = getOpData(state, path);

    if (target === null) {
      return;
    }

    if (Array.isArray(target)) {
      const index = toArrayIndex(target, lastKey);
      if (target.length <= index) {
        return '[op:remove] invalid array index: ' + path;
      }
      pluckWithShallowCopy(state, keys).splice(index, 1);
    } else {
      delete pluckWithShallowCopy(state, keys)[lastKey];
    }
  },

  invert(_state, op, value) {
    const path = Compact.getPath(op);
    return Compact.create('add', path, value);
  },

  transform(state, thisOp, otherOps) {
    log('Transforming', otherOps, 'against "remove"', thisOp);
    return transformRemove(state, Compact.getPath(thisOp), otherOps, true);
  },
};
