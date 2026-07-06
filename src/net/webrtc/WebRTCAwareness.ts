import { signal } from 'easy-signal';
import type { AwarenessTransport } from '../protocol/types.js';

/**
 * Base type for awareness states, representing arbitrary structured data
 * that will be shared between peers.
 */
type AwarenessState = Record<string, any>;

/**
 * Implements the awareness protocol to synchronize peer states over any
 * {@link AwarenessTransport} — `WebRTCTransport` for direct P2P data channels, or
 * `RelayTransport` for a server-relayed path with the same semantics.
 * Awareness allows peers to share real-time information about their current state,
 * such as cursor position, selection, user info, or any other application-specific data.
 *
 * @template T - The type of awareness state to be shared between peers
 */
export class WebRTCAwareness<T extends AwarenessState = AwarenessState> {
  private _states: T[] = [];
  private _localState: T = {} as T;

  /**
   * Signal that emits when the awareness state is updated.
   * Subscribers receive the complete new awareness state array.
   */
  readonly onUpdate = signal<(states: T[]) => void>();

  /**
   * Whether localState has been set (an empty object is a legal state).
   */
  private hasLocalState = false;

  /**
   * Creates a new awareness instance.
   * @param transport - The peer transport to use for awareness communication
   *   (e.g. `WebRTCTransport` or `RelayTransport`)
   */
  constructor(private transport: AwarenessTransport) {
    this.transport.onPeerConnect(this._addPeer.bind(this));
    this.transport.onPeerDisconnect(this._removePeer.bind(this));
    this.transport.onMessage(this._receiveData.bind(this));
  }

  /**
   * Connects to the WebRTC network to start synchronizing awareness states.
   * @returns A promise that resolves when the connection is established
   */
  async connect(): Promise<void> {
    await this.transport.connect();
  }

  /**
   * Disconnects from the WebRTC network and stops awareness synchronization.
   */
  disconnect(): void {
    this.transport.disconnect();
  }

  /**
   * Gets the current combined awareness state of all peers.
   * @returns An array of awareness states from all connected peers
   */
  get states(): T[] {
    return this._states;
  }

  /**
   * Sets the combined awareness state and emits an update event.
   * This method is protected and typically used internally.
   * @param state - The new combined awareness state array
   */
  protected set states(state: T[]) {
    this._states = state;
    this.onUpdate.emit(this._states);
  }

  /**
   * Gets this peer's local awareness state.
   * @returns The current local awareness state
   */
  get localState(): T {
    return this._localState;
  }

  /**
   * Sets this peer's local awareness state and broadcasts it to all connected peers.
   * @param value - The new local awareness state to set and broadcast
   */
  set localState(value: T) {
    this.hasLocalState = true;
    // The transport's id arrives with peer-welcome, which can land after connect() resolves —
    // read it lazily so the state is never broadcast without an id (receivers drop those)
    this._localState = { ...value, id: this.transport.id } as T;
    if (this._localState.id) {
      this.transport.send(JSON.stringify(this._localState));
    }
  }

  /**
   * Handles a new peer connection by sending the local state to the new peer.
   * @private
   * @param peerId - ID of the newly connected peer
   */
  private _addPeer(peerId: string) {
    if (!this.hasLocalState) return;
    // Peers only connect after the welcome assigned our id, so stamp it now if the state was
    // set before the id arrived
    if (!this._localState.id && this.transport.id) {
      this._localState = { ...this._localState, id: this.transport.id } as T;
    }
    if (this._localState.id) {
      this.transport.send(JSON.stringify(this._localState), peerId);
    }
  }

  /**
   * Handles a peer disconnection by removing their state from the awareness state.
   * @private
   * @param peerId - ID of the disconnected peer
   */
  private _removePeer(peerId: string) {
    this.states = this.states.filter(s => (s as any).id !== peerId);
  }

  /**
   * Processes incoming awareness data from other peers.
   * @private
   * @param data - The serialized awareness state data received from a peer
   */
  private _receiveData(data: string) {
    let peerState: T;
    try {
      peerState = JSON.parse(data);
      if (!peerState?.id) return;
    } catch (err) {
      console.error('Invalid peer data:', err);
      return;
    }
    const update = [...this.states];
    const existingIndex = update.findIndex(s => (s as any).id === peerState.id);
    if (existingIndex !== -1) {
      // Senders always transmit their complete state, so replace — merging would resurrect
      // fields the sender removed and diverge from peers that joined after the removal
      update.splice(existingIndex, 1, peerState);
    } else {
      update.push(peerState as unknown as T);
    }
    this.states = update;
  }
}
