import type { Unsubscriber } from 'easy-signal';
import type { ConnectionState, SignalingTransport } from '../protocol/types.js';
import type { PatchesREST } from './PatchesREST.js';

/**
 * Adapter that exposes a {@link PatchesREST} connection as a {@link SignalingTransport}
 * for `WebRTCTransport`. Multiplexes signaling over the existing SSE stream:
 *
 * - **send** → `PatchesREST.sendSignal()` → `POST /signal/:clientId`.
 * - **receive** → subscribes to `PatchesREST.onSignal` (the `signal` SSE event).
 *
 * Does not own the connection. The application calls `patches.connect()`
 * directly; `connect()` here just delegates so callers can still `await` it.
 */
export class PatchesRESTSignalingTransport implements SignalingTransport {
  /**
   * @param patches - The shared `PatchesREST` instance handling document sync.
   *   The same `clientId` is used for both, so signaling addressing matches.
   */
  constructor(private patches: PatchesREST) {}

  get state(): ConnectionState {
    return this.patches.state;
  }

  get onStateChange() {
    return this.patches.onStateChange;
  }

  /**
   * Delegates to {@link PatchesREST.connect}. Safe to call multiple times — if
   * the SSE stream is already open, the underlying call is a no-op.
   */
  async connect(): Promise<void> {
    await this.patches.connect();
  }

  /** Sends a raw JSON-RPC frame upstream over the signaling REST endpoint. */
  send(raw: string): Promise<void> {
    return this.patches.sendSignal(raw);
  }

  /** Subscribes to inbound JSON-RPC frames received via the `signal` SSE event. */
  onMessage(cb: (raw: string) => void): Unsubscriber {
    return this.patches.onSignal(cb);
  }
}
