export { PatchesOfflineFirst } from './PatchesOfflineFirst';
export { PatchesRealtime } from './PatchesRealtime';
export { JSONRPCClient } from './protocol/JSONRPCClient';
export { PatchesWebSocket } from './websocket/PatchesWebSocket';
export { WebSocketTransport } from './websocket/WebSocketTransport';

// Re-export types
export type {
  ConnectionState,
  ListOptions,
  PatchesAPI,
  PatchesNotificationParams,
  SignalNotificationParams,
} from './protocol/types';

export * from './protocol/types.js';
export * from './webrtc/WebRTCAwareness.js';
export * from './webrtc/WebRTCTransport.js';
