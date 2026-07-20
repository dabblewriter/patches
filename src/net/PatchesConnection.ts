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

  /**
   * Establish the connection to the server. `lastEventId`, when supplied, asks the
   * server to resume the event stream after that id (SSE replay) instead of a cold
   * start — the successor of a closed leader tab passes the predecessor's last id so
   * the gap is replayed rather than re-synced. Transports without a resumable stream
   * (WebSocket) ignore it.
   */
  connect(lastEventId?: string): Promise<void>;

  /**
   * The id of the last event received on the current stream, or undefined before the
   * first event. Persisted cross-tab so a successor can resume from it (see `connect`).
   */
  readonly lastEventId?: string;

  /** Tear down the connection. */
  disconnect(): void;

  /** Signal emitted when the connection state changes. */
  readonly onStateChange: Signal<(state: ConnectionState) => void>;

  /** Signal emitted when the server pushes committed changes for a subscribed document. */
  readonly onChangesCommitted: Signal<(docId: string, changes: Change[], options?: CommitChangesOptions) => void>;

  /** Signal emitted when a subscribed document is deleted remotely. */
  readonly onDocDeleted: Signal<(docId: string) => void>;

  /**
   * Optional signal emitted for transport-level errors that don't reject a specific
   * request — e.g. a malformed server-pushed event the transport had to drop.
   * PatchesSync forwards these to its own onError so they reach app telemetry.
   */
  readonly onError?: Signal<(error: Error) => void>;
}
