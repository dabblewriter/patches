import Peer from 'simple-peer';
import { signal, type Unsubscriber } from '../../event-signal.js';
import { JSONRPCClient } from '../../net/protocol/JSONRPCClient.js';
import type { ClientTransport } from '../protocol/types.js';
import { rpcError } from '../protocol/utils.js';
import type { WebSocketTransport } from '../websocket/WebSocketTransport.js';

/**
 * Represents information about a connected WebRTC peer.
 */
interface PeerInfo {
  /** Unique identifier for the peer */
  id: string;
  /** The simple-peer instance handling the WebRTC connection */
  peer: Peer.Instance;
  /** Whether the peer is fully connected and ready for data exchange */
  connected: boolean;
}

/**
 * WebRTC-based transport implementation that enables direct peer-to-peer communication.
 * Uses a WebSocket transport as a signaling channel to establish WebRTC connections.
 * Once connections are established, data flows directly between peers without going through a server.
 */
export class WebRTCTransport implements ClientTransport {
  private rpc: JSONRPCClient;
  private peers = new Map<string, PeerInfo>();
  private _id: string | undefined;
  private subscriptions: Unsubscriber[];

  /**
   * Signal that emits when a message is received from a peer.
   * Provides the message data, peer ID, and peer instance.
   */
  public readonly onMessage = signal<(data: string, peerId: string, peer: Peer.Instance) => void>();

  /**
   * Signal that emits when a new peer connection is established.
   * Provides the peer ID and peer instance.
   */
  public readonly onPeerConnect = signal<(peerId: string, peer: Peer.Instance) => void>();

  /**
   * Signal that emits when a peer disconnects.
   * Provides the peer ID and peer instance.
   */
  public readonly onPeerDisconnect = signal<(peerId: string, peer: Peer.Instance) => void>();

  /**
   * Signal that emits when the underlying signaling transport's state changes.
   * This is delegated directly from the WebSocketTransport.
   */
  public get onStateChange() {
    return this.transport.onStateChange;
  }

  /**
   * Creates a new WebRTC transport instance.
   * @param transport - The WebSocket transport to use for signaling
   */
  constructor(private transport: WebSocketTransport) {
    this.rpc = new JSONRPCClient(transport);

    this.subscriptions = [
      this.rpc.on('peer-welcome', ({ id, peers }) => {
        this._id = id;
        peers.forEach((peerId: string) => this._connectToPeer(peerId, true));
      }),

      this.rpc.on('peer-disconnected', ({ id }) => {
        this._removePeer(id);
      }),

      this.rpc.on('peer-signal', ({ from, data }) => {
        if (!this.peers.has(from)) {
          this._connectToPeer(from, false);
        }
        this.peers.get(from)?.peer.signal(data);
      }),
    ];
  }

  /**
   * Gets the unique ID assigned to this peer by the signaling server.
   * @returns The peer ID, or undefined if not yet connected
   */
  get id() {
    return this._id;
  }

  /**
   * Gets the current connection state of the underlying signaling transport.
   * @returns The current connection state
   */
  get state() {
    return this.transport.state;
  }

  /**
   * Establishes the connection by connecting to the signaling server.
   * Peer connections will be established automatically after this.
   * @returns A promise that resolves when connected to the signaling server
   */
  async connect() {
    await this.transport.connect();
  }

  /**
   * Terminates the connection for this transport.
   * Must be implemented by concrete subclasses.
   */
  disconnect(): void {
    this.subscriptions.forEach(u => u());
    this.subscriptions.length = 0;

    // Call _removePeer for each peer, which handles destroy()
    const peerIds = Array.from(this.peers.keys());
    peerIds.forEach(peerId => this._removePeer(peerId));

    // Ensure the map is clear after removal
    this.peers.clear();

    // Disconnect the underlying transport if needed (optional, depends on desired behavior)
    // this.transport.disconnect();
  }

  /**
   * Sends data to one or all connected peers.
   * @param data - The string data to send
   * @param peerId - Optional ID of specific peer to send to; if omitted, sends to all peers
   */
  send(data: string, peerId?: string) {
    for (const info of this.peers.values()) {
      if (peerId && info.id !== peerId) continue;
      if (info.connected) {
        try {
          info.peer.send(data);
        } catch (e) {
          this.onMessage.emit(JSON.stringify(rpcError(-32000, (e as Error).message)), peerId!, info.peer);
        }
      }
    }
  }

  /**
   * Establishes a WebRTC connection to a peer.
   * @private
   * @param peerId - ID of the peer to connect to
   * @param initiator - Whether this peer is initiating the connection
   */
  private _connectToPeer(peerId: string, initiator: boolean) {
    const peer = new Peer({ initiator, trickle: false });

    peer.on('signal', data => {
      this.rpc.call('peer-signal', peerId, data);
    });

    peer.on('connect', () => {
      this.peers.set(peerId, { id: peerId, peer, connected: true });
      this.onPeerConnect.emit(peerId, peer);
    });

    peer.on('data', raw => {
      try {
        this.onMessage.emit(raw, peerId, peer);
      } catch (e) {
        this.onMessage.emit(JSON.stringify(rpcError(-32700, 'Parse error', e)), peerId, peer);
      }
    });

    peer.on('close', () => {
      this._removePeer(peerId);
    });

    peer.on('error', err => {
      this.onMessage.emit(JSON.stringify(rpcError(-32000, (err as Error).message)), peerId, peer);
      this._removePeer(peerId);
    });

    this.peers.set(peerId, { id: peerId, peer, connected: false });
  }

  /**
   * Removes a peer from the connection pool and cleans up resources.
   * @private
   * @param peerId - ID of the peer to remove
   */
  private _removePeer(peerId: string) {
    const info = this.peers.get(peerId);
    if (info) {
      this.peers.delete(peerId);
      this.onPeerDisconnect.emit(peerId, info.peer);
      info.peer.destroy();
    }
  }
}
