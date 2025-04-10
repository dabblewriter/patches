/*!
 * Based on work from
 * https://github.com/Palindrom/JSONPatchOT
 * (c) 2017 Tomek Wytrebowicz
 *
 * MIT license
 * (c) 2022 Jacob Wright
 *
 *
 * WARNING: using /array/- syntax to indicate the end of the array makes it impossible to transform arrays correctly in
 * all situaions. Please avoid using this syntax when using Operational Transformations.
 */

import { Compact } from '../json-patch/compactPatch.js';
import { getTypes } from '../json-patch/ops/index.js';
import { runWithObject } from '../json-patch/state.js';
import type { CompactPatchOp, JSONPatchOpHandlerMap } from '../types.js';
import { getType } from '../utils/getType.js';
import { log } from '../utils/log.js';

/**
 * Transform an array of JSON Patch operations against another array of JSON Patch operations. Returns a new array with
 * transformed operations. Operations that change are cloned, making the results of this function immutable.
 * `otherOps` are transformed over `thisOps` with thisOps considered to have happened first.
 */
export function transformPatch(
  obj: any,
  thisOps: CompactPatchOp[],
  otherOps: CompactPatchOp[],
  custom?: JSONPatchOpHandlerMap
): CompactPatchOp[] {
  const types = getTypes(custom);
  if (!Compact.validate(thisOps)) {
    throw new Error('Invalid argument "thisOps" provided to transformPatch');
  }
  if (!Compact.validate(otherOps)) {
    throw new Error('Invalid argument "otherOps" provided to transformPatch');
  }

  return runWithObject(obj, types, false, state => {
    return thisOps.reduce((otherOps: CompactPatchOp[], thisOp: CompactPatchOp) => {
      // transform ops with patch operation
      const opName = Compact.getOp(thisOp);
      const handler = getType(state, opName)?.transform;
      if (typeof handler === 'function') {
        otherOps = handler(state, thisOp, otherOps);
        if (!Compact.validate(otherOps)) {
          throw new Error('Invalid result from transform function for op ' + opName);
        }
      } else {
        log('No function to transform against for', opName);
      }

      return otherOps;
    }, otherOps);
  });
}
