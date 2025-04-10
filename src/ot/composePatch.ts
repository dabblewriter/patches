import { Compact } from '../json-patch/compactPatch.js';
import { getTypes } from '../json-patch/ops/index.js';
import { runWithObject } from '../json-patch/state.js';
import { type CompactPatchOp, type JSONPatchOpHandlerMap } from '../types.js';
import { getType, getValue, mapAndFilterOps } from '../utils/index.js';

export function composePatch(patch: CompactPatchOp[], custom: JSONPatchOpHandlerMap = {}): CompactPatchOp[] {
  const types = getTypes(custom);
  const opsByPath = new Map<string, CompactPatchOp>();

  // Only composing ops next to each other on the same path. It becomes too complex to do more because of moves and arrays
  return runWithObject(null, types, patch.length > 1, state => {
    return mapAndFilterOps(patch, op => {
      const type = getType(state, Compact.getOp(op));
      const handler = type?.compose;
      if (handler) {
        const lastOp = opsByPath.get(Compact.getPath(op));
        if (lastOp && match(lastOp, op)) {
          Compact.update(lastOp, { value: handler(state, Compact.getValue(lastOp), Compact.getValue(op)) });
          return null;
        } else {
          const prefix = `${Compact.getPath(op)}/`;
          for (const path of opsByPath.keys()) {
            if (path.startsWith(prefix)) opsByPath.delete(path);
          }
          opsByPath.set(Compact.getPath(op), (op = getValue(state, op)));
        }
      } else {
        opsByPath.clear();
      }
      return op;
    });
  });
}

function match(op1: CompactPatchOp, op2?: CompactPatchOp) {
  return op1 && op2 && op1[0] === op2[0];
}
