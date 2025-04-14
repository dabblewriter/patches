import type { ApplyJSONPatchOptions, JSONPatchOp, JSONPatchOpHandlerMap } from '../types.js';
import { getTypes } from './ops/index.js';
import { runWithObject } from './state.js';
import { exit } from './utils/exit.js';
import { getType } from './utils/getType.js';

export function applyPatch(
  object: any,
  patches: JSONPatchOp[],
  opts: ApplyJSONPatchOptions = {},
  custom?: JSONPatchOpHandlerMap
) {
  if (patches.length === 0) {
    return object;
  }
  if (opts.atPath) {
    patches = patches.map(op => ({ ...op, path: opts.atPath + op.path }));
  }

  const types = getTypes(custom);
  return runWithObject(object, types, patches.length > 1, state => {
    for (let i = 0, imax = patches.length; i < imax; i++) {
      const patch = patches[i];
      const handler = getType(state, patch)?.apply;
      const error = handler ? handler(state, '' + patch.path, patch.from || patch.value) : `[op:${patch.op}] unknown`;
      if (error) {
        if ((!opts.silent && !opts.strict) || opts.silent === false) console.error(error, patch);
        if (opts.strict) throw new TypeError(error);
        if (opts.rigid) return exit(state, object, patch, opts);
      }
    }
  });
}
