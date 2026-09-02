import type { JSONPatchOpHandler } from '../types.js';
import { getOpData } from '../utils/getOpData.js';
import { log } from '../utils/log.js';
import { shallowCopy } from '../utils/shallowCopy.js';
import { transformRemove, updateRemovedOps } from '../utils/ops.js';
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
    // drops the copy when a committed op removed or clobbered its source first, so the copy
    // never happened on the server — but this frame still holds the ghost the queue wrote at
    // the destination. Kill it, or later queue entries built on the copy are transformed
    // against a frame the server never had and commit ops that fail strict apply (DAB-1236).
    // Unlike the residue for a dropped COMMITTED move-in, an array-index ghost must go too: the
    // queue's insert is real and nothing on the server undoes it, so later queue indexes would
    // stay shifted by one. A soft copy is left alone — whether it wrote anything depends on
    // state the transform does not have, and killing a live value is worse than a stale ghost
    // — as is a `/-` append, which has no addressable index to remove.
    const ghost = !thisOp.soft && !thisOp.path.endsWith('/-');
    const killed = ghost && !!state.otherOpsFirst && !!findMirrorKiller(state, otherOps, thisOp.from!, true);
    if (killed) {
      const kill = { op: 'remove', path: thisOp.path };
      // The committed ops were written in the server's frame, where the ghost never existed: an
      // array destination keeps them unshifted behind the kill; for an object key, anything that
      // reads the killed path is re-transformed through the removal so the frame stays
      // applicable (a killed copy has no claim on its destination, so committed sets there survive).
      if (isArrayPath(thisOp.path, state)) return [kill, ...otherOps];
      return [kill, ...transformRemove(state, thisOp.path, otherOps)];
    }

    if (isArrayPath(thisOp.path, state)) {
      // Adjust any operations on the same array by 1 to account for this new entry
      return updateArrayIndexes(state, thisOp.path, otherOps, 1);
    } else {
      // Remove anything that was done at this path since it is being overwritten
      return updateRemovedOps(state, thisOp.path, otherOps, false, undefined, undefined, thisOp);
    }
  },
};
