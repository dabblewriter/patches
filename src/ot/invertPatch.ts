import { Compact } from '../json-patch/compactPatch.js';
import { getTypes } from '../json-patch/ops/index.js';
import { runWithObject } from '../json-patch/state.js';
import { type CompactPatchOp, type JSONPatchOpHandlerMap } from '../types.js';
import { getType } from '../utils/getType.js';

export function invertPatch(object: any, ops: CompactPatchOp[], custom: JSONPatchOpHandlerMap = {}): CompactPatchOp[] {
  const types = getTypes(custom);
  return runWithObject({}, types, false, state => {
    return ops
      .map((op): CompactPatchOp => {
        const pathParts = Compact.getPath(op).split('/').slice(1);
        let changedObj = object;
        const prop = pathParts.pop() as string;
        let value, isIndex;

        try {
          for (let i = 0; i < pathParts.length; i++) {
            changedObj = changedObj[pathParts[i]];
          }
          value = changedObj[prop];
          isIndex = (prop as any) >= 0;
        } catch (err: any) {
          throw new Error(
            `Patch mismatch. This patch was not applied to the provided object and cannot be inverted. ${err.message || err}`
          );
        }

        const handler = getType(state, Compact.getOp(op))?.invert;
        if (!handler) throw new Error('Unknown patch operation, cannot invert');

        return handler(state, op, value, changedObj, isIndex);
      })
      .filter(op => !!op)
      .reverse();
  });
}
