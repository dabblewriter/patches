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
   * the gap is replayed rather than re-synced. The cursor is only honored for the
   * clientId that earned it: the server keys its replay log and restored subscriptions
   * by clientId, so the successor must also connect with the predecessor's clientId. A
   * fresh clientId with an old cursor degrades safely to a full sync (`resync`), but
   * the resume never fires. Transports without a resumable stream (WebSocket) ignore it.
   */
  connect(lastEventId?: string): Promise<void>;

  /**
   * The id of the last event received on the current stream, or undefined before the
   * first event. Persisted cross-tab so a successor can resume from it (see `connect`).
   */
  readonly lastEventId?: string;

  /**
   * Whether the currently open stream was opened as a resume (with a `lastEventId`
   * cursor) rather than a cold start — i.e. the server is replaying the missed gap.
   * This is the authority PatchesSync consults on the `connected` transition to decide
   * whether to run a resume-mode sync: it reflects what the transport *actually did*,
   * so a cursor that never opened a resumed stream (offline defer, already-connected
   * no-op, a `resync` re-anchor after the buffer expired, or a plain cold reconnect)
   * correctly reads `false`. Transports with no resumable stream (WebSocket) leave it
   * undefined, which reads as `false`.
   */
  readonly resumedStream?: boolean;

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
