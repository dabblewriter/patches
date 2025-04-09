export { applyPatch } from './json-patch/applyPatch.js';
export { applyBitmask, bitmask, combineBitmasks } from './json-patch/ops/bitmask.js';
export * as defaultOps from './json-patch/ops/index.js';
export { composePatch } from './ot/composePatch.js';
export { invertPatch } from './ot/invertPatch.js';
export * from './ot/syncable.js';
export { transformPatch } from './ot/transformPatch.js';

export * from './json-patch/ops/index.js'; // Exports all ops: add, remove, etc.

export * from './json-patch/ops/index.js';
export type { ApplyJSONPatchOptions, JSONPatchOpHandlerMap as JSONPatchCustomTypes, JSONPatchOp } from './types.js';

// OT Core
export * from './json-patch/state.js';
export * from './ot/BranchManager.js';
export * from './ot/composePatch.js';
export * from './ot/fractionalIndex.js';
export * from './ot/HistoryManager.js';
export * from './ot/invertPatch.js';
export * from './ot/PatchDoc.js';
export * from './ot/PatchServer.js';
export * from './ot/syncable.js'; // Keep? Older implementation
export * from './ot/transformPatch.js';
export * from './ot/types.js';
export * from './ot/utils.js';

// JSON Patch Core
export * from './json-patch/applyPatch.js';
export * from './json-patch/createJSONPatch.js';
export * from './json-patch/JSONPatch.js';
export * from './json-patch/patchProxy.js';

// Root Types (if any remain)
export * from './types.js';
