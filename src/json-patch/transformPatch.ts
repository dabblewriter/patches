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

import { getTypes } from './ops/index.js';
import { runWithObject } from './state.js';
import type { JSONPatchOp, JSONPatchOpHandlerMap } from './types.js';
import { getType } from './utils/getType.js';
import { log } from './utils/log.js';

/**
 * Transform an array of JSON Patch operations against another array of JSON Patch operations. Returns a new array with
 * transformed operations. Operations that change are cloned, making the results of this function immutable.
 * `otherOps` are transformed over `thisOps` with thisOps considered to have happened first.
 */
export function transformPatch(
  obj: any,
  thisOps: JSONPatchOp[],
  otherOps: JSONPatchOp[],
  custom?: JSONPatchOpHandlerMap
): JSONPatchOp[] {
  const types = getTypes(custom);
  return runWithObject(obj, types, false, state => {
    return thisOps.reduce((otherOps: JSONPatchOp[], thisOp: JSONPatchOp) => {
      // transform ops with patch operation
      const handler = getType(state, thisOp)?.transform;
      if (typeof handler === 'function') {
        otherOps = handler(state, thisOp, otherOps);
      } else {
        log('No function to transform against for', thisOp.op);
      }

      return otherOps;
    }, otherOps);
  });
}
