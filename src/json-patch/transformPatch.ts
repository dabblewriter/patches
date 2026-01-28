/*!
 * Based on work from
 * https://github.com/Palindrom/JSONPatchOT
 * (c) 2017 Tomek Wytrebowicz
 *
 * MIT license
 * (c) 2022 Jacob Wright
 *
 *
 * NOTE ON ARRAY APPEND SYNTAX: The /array/- path syntax (append to end) has limitations with
 * Operational Transformations. It's safe when:
 * - The appended value won't be modified by subsequent operations, OR
 * - The append commits to the server before any operations reference the item by index
 *
 * It causes problems when you append with /items/- then reference by index (e.g., /items/3/name)
 * in uncommitted operations — the index can be transformed but the - cannot, causing them to
 * target different items after concurrent changes. See docs/json-patch.md for details.
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
