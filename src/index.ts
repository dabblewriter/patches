export { applyPatch } from './json-patch/applyPatch.js';
export { applyBitmask, bitmask, combineBitmasks } from './json-patch/ops/bitmask.js';
export * as defaultOps from './json-patch/ops/index.js';
export { composePatch } from './ot/composePatch.js';
export { invertPatch } from './ot/invertPatch.js';
export { transformPatch } from './ot/transformPatch.js';

export * from './json-patch/ops/index.js'; // Exports all ops: add, remove, etc.

export * from './json-patch/ops/index.js';
export type { ApplyJSONPatchOptions, JSONPatchOpHandlerMap as JSONPatchCustomTypes, JSONPatchOp } from './types.js';

// OT Core
export * from './json-patch/state.js';
export * from './ot/composePatch.js';
export * from './ot/invertPatch.js';
export * from './ot/transformPatch.js';
export * from './ot/types.js';
export * from './ot/utils.js';

export * from './ot/client/PatchDoc.js';

export * from './ot/server/BranchManager.js';
export * from './ot/server/HistoryManager.js';
export * from './ot/server/PatchServer.js';

// JSON Patch Core
export * from './json-patch/applyPatch.js';
export * from './json-patch/createJSONPatch.js';
export * from './json-patch/JSONPatch.js';
export * from './json-patch/patchProxy.js';

// Transport
export * from './transport/protocol/JSONRPCClient.js';
export * from './transport/protocol/types.js';
export * from './transport/webrtc/WebRTCAwareness.js';
export * from './transport/webrtc/WebRTCTransport.js';
export * from './transport/websocket/PatchesWebSocket.js';
export * from './transport/websocket/WebSocketTransport.js';

// Root Types (if any remain)
export * from './types.js';
