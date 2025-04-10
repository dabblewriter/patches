import type { ApplyJSONPatchOptions, CompactPatchOp, State } from '../types.js';

export function exit(state: State, object: any, patch: CompactPatchOp, opts: ApplyJSONPatchOptions) {
  opts.error = patch;
  return opts.partial && state.root ? state.root[''] : object;
}
