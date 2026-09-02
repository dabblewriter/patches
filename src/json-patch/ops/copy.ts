import type { JSONPatchOpHandler } from '../types.js';
import { getOpData } from '../utils/getOpData.js';
import { log } from '../utils/log.js';
import { shallowCopy } from '../utils/shallowCopy.js';
import { updateRemovedOps } from '../utils/ops.js';
import { isArrayPath } from '../utils/paths.js';
import { updateArrayIndexes } from '../utils/updateArrayIndexes.js';
import { add } from './add.js';
import { findMirrorKiller } from './move.js';

export const copy: JSONPatchOpHandler = {
  like: 'copy',

  apply(state, path, from: string) {
    const [, lastKey, target] = getOpData(state, from);

    if (target === null) {
      return `[op:copy] path not found: ${from}`;
    }

    // Insert a copy, not the live reference: the source may be a cached working copy from an
    // earlier op in this patch, and inserting it at a second path would let later writes mutate
    // both locations through the copy-on-write cache
    return add.apply(state, path, shallowCopy(target[lastKey]));
  },

  invert(_state, { path }, value, changedObj, isIndex) {
    if (path.endsWith('/-')) return { op: 'remove', path: path.slice(0, -1) + changedObj.length };
    else if (isIndex) return { op: 'remove', path };
    return value === undefined ? { op: 'remove', path } : { op: 'replace', path, value };
  },

  transform(state, thisOp, otherOps) {
    log('Transforming', otherOps, 'against "copy"', thisOp);

    // otherOpsFirst: otherOps precede this (queue) copy in the authoritative order. The mirror
    // drops the copy when a committed op removed or clobbered its source first, so the copy's
    // destination never existed on the server — but this frame still holds the ghost the queue
    // put there. Kill it, or later queue entries built on the copy are transformed against a
    // frame the server never had and commit ops that fail strict apply (DAB-1236). A killed
    // copy has no claim on its destination either: the committed ops stay untouched behind the
    // ghost kill (for an array destination that also means unshifted — the element is gone).
    const killed = !!state.otherOpsFirst && !!findMirrorKiller(state, otherOps, thisOp.from!, true);
    if (killed) return [{ op: 'remove', path: thisOp.path }, ...otherOps];

    if (isArrayPath(thisOp.path, state)) {
      // Adjust any operations on the same array by 1 to account for this new entry
      return updateArrayIndexes(state, thisOp.path, otherOps, 1);
    } else {
      // Remove anything that was done at this path since it is being overwritten
      return updateRemovedOps(state, thisOp.path, otherOps, false, undefined, undefined, thisOp);
    }
  },
};
