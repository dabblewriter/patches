import { applyPatch } from './applyPatch.js';
import { getTypes } from './ops/index.js';
import { runWithObject } from './state.js';
import type { JSONPatchOp, JSONPatchOpHandlerMap } from './types.js';
import { getType } from './utils/getType.js';
import { toKeys } from './utils/toKeys.js';

export function invertPatch(object: any, ops: JSONPatchOp[], custom: JSONPatchOpHandlerMap = {}): JSONPatchOp[] {
  const types = getTypes(custom);
  return runWithObject({}, types, false, state => {
    // Each op's prior value must come from the state produced by the ops before it, not from
    // the original object — a later op can read paths an earlier op shifted or rewrote
    let workingState = object;
    return ops
      .map((op): JSONPatchOp => {
        let changedObj: any;
        let prop: string;
        let value, isIndex;

        try {
          if (op.path === '') {
            // A root op's prior value is the whole document
            changedObj = { '': workingState };
            prop = '';
          } else {
            const keys = toKeys(op.path).slice(1);
            prop = keys.pop() as string;
            changedObj = workingState;
            for (let i = 0; i < keys.length; i++) {
              changedObj = changedObj[keys[i]];
            }
          }
          value = changedObj[prop];
          isIndex = Array.isArray(changedObj) && (prop as any) >= 0;
        } catch (err: any) {
          throw new Error(
            `Patch mismatch. This patch was not applied to the provided object and cannot be inverted. ${err.message || err}`,
            { cause: err }
          );
        }

        const handler = getType(state, op)?.invert;
        if (!handler) throw new Error('Unknown patch operation, cannot invert');

        const inverted = handler(state, op, value, changedObj, isIndex);
        // Advance the working state so the next op inverts against the right prior values
        workingState = applyPatch(workingState, [op], { silent: true }, custom);
        return inverted;
      })
      .filter(op => !!op)
      .reverse();
  });
}
