import type { ApplyJSONPatchOptions, CompactPatch, JSONPatchOpHandlerMap } from '../types.js';
import { exit } from '../utils/exit.js';
import { getType } from '../utils/getType.js';
import { Compact } from './compactPatch.js';
import { getTypes } from './ops/index.js';
import { runWithObject } from './state.js';

export function applyPatch(
  object: any,
  patch: CompactPatch,
  opts: ApplyJSONPatchOptions = {},
  custom?: JSONPatchOpHandlerMap
) {
  if (patch.length === 0) {
    return object;
  }
  if (opts.atPath) {
    patch = patch.map(op => [op[0][0] + opts.atPath + op[0].slice(1), ...op.slice(1)]) as CompactPatch;
  }

  const types = getTypes(custom);
  return runWithObject(object, types, patch.length > 1, state => {
    for (let i = 0, imax = patch.length; i < imax; i++) {
      const op = Compact.getOp(patch[i]);
      const path = Compact.getPath(patch[i]);
      const value = Compact.getValue(patch[i]);
      const from = Compact.getFrom(patch[i]);
      const handler = getType(state, op[0][0])?.apply;
      const error = handler ? handler(state, path, from || value) : `[op:${op}] unknown`;
      if (error) {
        if ((!opts.silent && !opts.strict) || opts.silent === false) console.error(error, op);
        if (opts.strict) throw new TypeError(error);
        if (opts.rigid) return exit(state, object, patch[i], opts);
      }
    }
  });
}
