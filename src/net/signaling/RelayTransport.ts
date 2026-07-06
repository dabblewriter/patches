import { signal, type Unsubscriber } from 'easy-signal';
import { JSONRPCClient } from '../protocol/JSONRPCClient.js';
import type { AwarenessTransport, ConnectionState, SignalingTransport } from '../protocol/types.js';

/**
 * Server-relayed peer transport: satisfies {@link AwarenessTransport} using nothing but the
 * {@link SignalingService} wire protocol, so awareness state flows through the signaling server
 * instead of WebRTC data channels. No P2P, no NAT/ICE failure class, no simple-peer — the
 * signaling channel (e.g. `PatchesRESTSignalingTransport` over the doc-sync SSE stream) is the
 * whole transport.
 *
 * Protocol mapping (server messages → peer events):
 * - `peer-welcome {id, peers}` — adopts `id`, treats `peers` as the authoritative roster:
 *   every listed peer is (re-)announced via `onPeerConnect` (consumers re-push their full
 *   state, which makes signaling reconnects self-healing), and known peers missing from the
 *   roster are retired via `onPeerDisconnect`.
 * - `signal {from, data}` — delivers `data` via `onMessage`. A `from` we have not seen yet is
 *   announced via `onPeerConnect` first: peers that join after our welcome introduce themselves
 *   with their first frame, and the announcement prompts consumers to push our state back —
 *   completing the two-way exchange the WebRTC handshake would otherwise provide.
 * - `peer-disconnected {id}` — retires the peer via `onPeerDisconnect`.
 *
 * Sending fans out as directed `peer-signal [to, data]` notifications — one per known peer when
 * `peerId` is omitted (the protocol has no broadcast).
 *
 * **Rooms.** Servers that host multiple peer groups on one connection can tag the three
 * messages above with a `room` param (and read the third `peer-signal` param, which stock
 * {@link SignalingService} ignores). Construct with that `roomId` to make this transport filter
 * inbound frames to its room and stamp outbound frames with it — several `RelayTransport`s can
 * then share a single signaling connection. Without a `roomId`, all frames are processed and
 * none are stamped (stock single-room behavior).
 *
 * The underlying signaling channel is shared (doc sync may ride the same stream), so
 * {@link disconnect} only tears down local peer bookkeeping — it never closes the channel.
 */
export class RelayTransport implements AwarenessTransport {
  private rpc: JSONRPCClient;
  private peers = new Set<string>();
  private _id: string | undefined;
  private subscriptions: Unsubscriber[] = [];

  /** Emits when a peer becomes reachable in this room. */
  readonly onPeerConnect = signal<(peerId: string) => void>();

  /** Emits when a peer leaves this room (or vanishes from a welcome roster). */
  readonly onPeerDisconnect = signal<(peerId: string) => void>();

  /** Emits the raw payload of each relayed `signal` frame addressed to us. */
  readonly onMessage = signal<(data: string) => void>();

  /**
   * @param transport - The signaling channel to relay over (e.g.
   *   `PatchesRESTSignalingTransport` or `WebSocketTransport`).
   * @param roomId - Optional room tag; see the class docs. Omit for servers that host a single
   *   peer group per connection.
   */
  constructor(
    private transport: SignalingTransport,
    private roomId?: string
  ) {
    this.rpc = new JSONRPCClient(transport);
    this._subscribe();
  }

  /** The peer id assigned by the server's `peer-welcome`, or undefined until it arrives. */
  get id(): string | undefined {
    return this._id;
  }

  /** Connection state of the underlying signaling channel. */
  get state(): ConnectionState {
    return this.transport.state;
  }

  /** Emits whenever the underlying signaling channel's state changes. */
  get onStateChange() {
    return this.transport.onStateChange;
  }

  /**
   * Opens the underlying signaling channel (a no-op if it is already open) and restores the
   * message subscriptions if a previous {@link disconnect} tore them down.
   */
  async connect(): Promise<void> {
    this._subscribe();
    await this.transport.connect();
  }

  /**
   * Retires every known peer (emitting `onPeerDisconnect` for each) and stops processing
   * signaling messages. The underlying channel stays open — it is shared with other consumers.
   */
  disconnect(): void {
    this.subscriptions.forEach(u => u());
    this.subscriptions.length = 0;
    this._id = undefined;
    const peerIds = Array.from(this.peers);
    this.peers.clear();
    peerIds.forEach(peerId => this.onPeerDisconnect.emit(peerId));
  }

  /**
   * Sends `data` to one peer, or to every known peer when `peerId` is omitted, as directed
   * `peer-signal` notifications through the server.
   */
  send(data: string, peerId?: string): void {
    const targets = peerId ? [peerId] : Array.from(this.peers);
    for (const to of targets) {
      // notify() drops a trailing undefined room, keeping stock frames two-element
      this.rpc.notify('peer-signal', to, data, this.roomId);
    }
  }

  private _subscribe() {
    if (this.subscriptions.length > 0) return;

    this.subscriptions = [
      this.rpc.on('peer-welcome', (params: { id: string; peers: string[]; room?: string }) => {
        if (!this._inRoom(params)) return;
        this._id = params.id;
        const roster = new Set(params.peers);
        // The roster is authoritative: peers we know that the server no longer lists are gone
        // (their disconnect broadcast may have been lost while our stream was down)
        for (const peerId of Array.from(this.peers)) {
          if (!roster.has(peerId)) {
            this.peers.delete(peerId);
            this.onPeerDisconnect.emit(peerId);
          }
        }
        // (Re-)announce every listed peer — even already-known ones, so consumers re-push
        // state to peers that dropped us while our stream was down
        for (const peerId of roster) {
          this.peers.add(peerId);
          this.onPeerConnect.emit(peerId);
        }
      }),

      this.rpc.on('peer-disconnected', (params: { id: string; room?: string }) => {
        if (!this._inRoom(params)) return;
        if (this.peers.delete(params.id)) {
          this.onPeerDisconnect.emit(params.id);
        }
      }),

      this.rpc.on('signal', (params: { from: string; data: unknown; room?: string }) => {
        if (!this._inRoom(params)) return;
        const { from, data } = params;
        if (!from || from === this._id) return;
        if (!this.peers.has(from)) {
          this.peers.add(from);
          this.onPeerConnect.emit(from);
        }
        this.onMessage.emit(typeof data === 'string' ? data : JSON.stringify(data));
      }),
    ];
  }

  private _inRoom(params: { room?: string } | undefined): boolean {
    return this.roomId === undefined || params?.room === this.roomId;
  }
}
