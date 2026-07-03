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
 *
 * `otherOpsFirst` inverts that temporal assumption: `otherOps` are known to precede `thisOps` in the
 * authoritative order (e.g. rebasing an already-committed change across a local queue that commits
 * after it — the "advance the committed ops through the queue" half of the OT diamond walk in
 * `transformIncomingChanges`/`rebaseChanges`). Conflicting intents at the same path then resolve in
 * favor of `thisOps` (the later writer): a committed set is dropped when the queue re-set the same
 * path, a committed same-source move yields to the queue's move, and a committed set that clobbers
 * the source of a queue move carries a ghost-kill for the move's destination. Without this, the two
 * halves of the diamond disagree about the winner and later queue entries are transformed against a
 * committed op whose effect the queue already superseded — committing ops that can never apply.
 */
export function transformPatch(
  obj: any,
  thisOps: JSONPatchOp[],
  otherOps: JSONPatchOp[],
  custom?: JSONPatchOpHandlerMap,
  otherOpsFirst = false
): JSONPatchOp[] {
  const types = getTypes(custom);
  return runWithObject(obj, types, false, state => {
    if (otherOpsFirst) state.otherOpsFirst = true;
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
