export { applyPatch } from './applyPatch.js';
export { composePatch } from './composePatch.js';
export { invertPatch } from './invertPatch.js';
export { applyBitmask, bitmask, combineBitmasks } from './ops/bitmask.js';
export * as defaultOps from './ops/index.js';
export { transformPatch } from './transformPatch.js';

export * from './JSONPatch.js';
export * from './ops/index.js';
export type { ApplyJSONPatchOptions, JSONPatchOpHandlerMap as JSONPatchCustomTypes, JSONPatchOp } from './types.js';
