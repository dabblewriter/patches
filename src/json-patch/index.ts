export { applyPatch } from './applyPatch.js';
export { composePatch } from './composePatch.js';
export { invertPatch } from './invertPatch.js';
export { applyBitmask, bitmask, combineBitmasks } from './ops/bitmask.js';
export * as defaultOps from './ops/index.js';
export * from './pathProxy.js';
export { transformPatch } from './transformPatch.js';

export * from './JSONPatch.js';
export type { ApplyJSONPatchOptions, JSONPatchOpHandlerMap, JSONPatchOp } from './types.js';
