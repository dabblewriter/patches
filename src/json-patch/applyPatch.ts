import { getTypes } from './ops/index.js';
import { runWithObject } from './state.js';
import type { ApplyJSONPatchOptions, JSONPatchOp, JSONPatchOpHandlerMap } from './types.js';
import { exit } from './utils/exit.js';
import { getType, getTypeLike } from './utils/getType.js';
import { isSoftOp, shouldSkipSoftWrite } from './utils/softWrites.js';

/**
 * Applies a sequence of JSON patch operations to an object.
 *
 * Failure handling:
 * - default: a failed `test`-like op aborts the patch and returns the original object (RFC 6902);
 *   any other failed op is logged and skipped.
 * - `strict`: throw on the first failed op.
 * - `rigid`: abort on the first failed op and return the original object.
 * - `partial`: aborts return the state applied so far instead of the original object.
 *
 * @param object - The object to apply the patches to
 * @param patches - The JSON patch operations to apply
 * @param opts - Options for applying the patch
 * @param custom - Custom patch operation handlers
 * @returns The object after applying the patches
 */
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
    patches = patches.map(op =>
      op.from != null
        ? { ...op, path: opts.atPath + op.path, from: opts.atPath + op.from }
        : { ...op, path: opts.atPath + op.path }
    );
  }

  const types = getTypes(custom);
  return runWithObject(object, types, patches.length > 1, state => {
    for (let i = 0, imax = patches.length; i < imax; i++) {
      const patch = patches[i];
      // Soft ops (explicit `soft: true`, plus the empty-container `add` convention)
      // must not overwrite existing data. Check the live state — earlier ops in
      // this same patch may have just created the path — and skip when present.
      if (isSoftOp(patch) && shouldSkipSoftWrite(state.root[''], patch)) {
        continue;
      }
      const handler = getType(state, patch)?.apply;
      const error = handler ? handler(state, '' + patch.path, patch.from || patch.value) : `[op:${patch.op}] unknown`;
      if (error) {
        if ((!opts.silent && !opts.strict) || opts.silent === false) console.error(error, patch);
        if (opts.strict) throw new TypeError(error);
        // A failed test aborts the whole patch (RFC 6902); other failed ops are skipped unless rigid.
        if (opts.rigid || getTypeLike(state, patch) === 'test') return exit(state, object, patch, opts);
      }
    }
  });
}
