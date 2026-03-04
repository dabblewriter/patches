import type { Signal } from 'easy-signal';
import type { Change, CommitChangesOptions } from '../types.js';
import type { ConnectionState, PatchesAPI } from './protocol/types.js';

/**
 * Common interface for transport connections that PatchesSync can use.
 * Implemented by PatchesWebSocket (WebSocket transport) and PatchesREST (SSE + fetch transport).
 */
export interface PatchesConnection extends PatchesAPI {
  /** The server URL. Readable and writable — setting while connected triggers reconnection. */
  url: string;

  /** Establish the connection to the server. */
  connect(): Promise<void>;

  /** Tear down the connection. */
  disconnect(): void;

  /** Signal emitted when the connection state changes. */
  readonly onStateChange: Signal<(state: ConnectionState) => void>;

  /** Signal emitted when the server pushes committed changes for a subscribed document. */
  readonly onChangesCommitted: Signal<(docId: string, changes: Change[], options?: CommitChangesOptions) => void>;

  /** Signal emitted when a subscribed document is deleted remotely. */
  readonly onDocDeleted: Signal<(docId: string) => void>;
}
