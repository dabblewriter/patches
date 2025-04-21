// Core client and sync mechanism
export { Patches } from './Patches.js';
export { PatchesSync } from './PatchesSync.js';

// Underlying protocol and transport
export { JSONRPCClient } from './protocol/JSONRPCClient.js';
export { PatchesWebSocket } from './websocket/PatchesWebSocket.js';
export { WebSocketTransport } from './websocket/WebSocketTransport.js';

// Re-export types
export type { PatchesOptions } from './Patches.js';
export type { PatchesSyncOptions, PatchesSyncState } from './PatchesSync.js';
export type {
  ConnectionState,
  ListOptions,
  PatchesAPI,
  PatchesNotificationParams,
  SignalNotificationParams,
} from './protocol/types.js';
export type { WebSocketOptions } from './websocket/WebSocketTransport.js';

// Optional WebRTC Awareness (if kept)
export * from './webrtc/WebRTCAwareness.js';
export * from './webrtc/WebRTCTransport.js';
