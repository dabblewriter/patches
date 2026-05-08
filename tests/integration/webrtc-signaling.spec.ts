import { signal, type Signal } from 'easy-signal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientTransport, ConnectionState, SignalingTransport } from '../../src/net/protocol/types';
import { SignalingService, type JsonRpcMessage } from '../../src/net/signaling/SignalingService';
import { WebRTCTransport } from '../../src/net/webrtc/WebRTCTransport';

/**
 * End-to-end signaling test: two `WebRTCTransport` instances backed by a shared
 * `SignalingService`. Verifies the JSON-RPC handshake reaches `peer.signal(data)`
 * on the receiving side. Mocks `simple-peer` so we don't actually open WebRTC
 * connections — we only assert the signaling protocol carries the payload.
 *
 * This is the test that should have caught the original peer-signal/signal
 * method-name and positional/named-params mismatches.
 */

interface FakePeer {
  initiator: boolean;
  handlers: Record<string, (arg?: any) => void>;
  signal: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  connected: boolean;
}

const createdPeers: FakePeer[] = [];

vi.mock('simple-peer', () => ({
  default: vi.fn(function (opts: { initiator?: boolean }) {
    const handlers: FakePeer['handlers'] = {};
    const peer: FakePeer = {
      initiator: !!opts.initiator,
      handlers,
      signal: vi.fn(),
      send: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, cb: (arg?: any) => void) => {
        handlers[event] = cb;
      }),
      connected: false,
    };
    createdPeers.push(peer);
    return peer;
  }),
}));

class IntegratedSignalingService extends SignalingService {
  inbound = new Map<string, Signal<(raw: string) => void>>();

  send(id: string, message: JsonRpcMessage): void {
    this.inbound.get(id)?.emit(JSON.stringify(message));
  }
}

function makeTransport(svc: IntegratedSignalingService, id: string): SignalingTransport {
  const onMessage = signal<(raw: string) => void>();
  const onStateChange = signal<(state: ConnectionState) => void>();
  svc.inbound.set(id, onMessage);

  const transport: ClientTransport & {
    onStateChange: typeof onStateChange;
    state: ConnectionState;
    connect: () => Promise<void>;
  } = {
    send(raw: string) {
      // Fire-and-forget; the integration relies on awaiting `flush()` between
      // assertions to drain the chain of awaits inside handleClientMessage.
      void svc.handleClientMessage(id, raw);
    },
    onMessage,
    onStateChange,
    state: 'connected',
    connect: async () => {},
  };

  return transport as SignalingTransport;
}

async function flush() {
  // Drain a few microtask + macrotask ticks so the async chain in
  // SignalingService.handleClientMessage settles before we assert.
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('WebRTC signaling integration (two peers via shared SignalingService)', () => {
  beforeEach(() => {
    createdPeers.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('relays an offer from initiator to responder via the shared SignalingService', async () => {
    const svc = new IntegratedSignalingService();
    const transportA = makeTransport(svc, 'A');
    const transportB = makeTransport(svc, 'B');

    // Wrap both transports in WebRTCTransports so they subscribe to inbound
    // peer-welcome / signal / peer-disconnected before we register them.
    new WebRTCTransport(transportA);
    new WebRTCTransport(transportB);

    // A connects first, sees no peers yet.
    await svc.onClientConnected('A');
    await flush();
    expect(createdPeers).toHaveLength(0);

    // B connects, sees peers: ['A'] in its welcome → constructs a Peer with
    // initiator: true to talk to A.
    await svc.onClientConnected('B');
    await flush();

    expect(createdPeers).toHaveLength(1);
    const bsPeerForA = createdPeers[0];
    expect(bsPeerForA.initiator).toBe(true);

    // simple-peer would normally fire its own 'signal' event with an offer.
    // Trigger it manually; this is the start of the JSON-RPC handshake.
    const offer = { type: 'offer', sdp: 'TEST-OFFER' };
    bsPeerForA.handlers['signal'](offer);
    await flush();

    // A's WebRTCTransport should have received the relayed 'signal' notification,
    // constructed a Peer for B (initiator: false), and called peer.signal(offer).
    expect(createdPeers).toHaveLength(2);
    const asPeerForB = createdPeers[1];
    expect(asPeerForB.initiator).toBe(false);
    expect(asPeerForB.signal).toHaveBeenCalledTimes(1);
    expect(asPeerForB.signal).toHaveBeenCalledWith(offer);
  });

  it('relays the answer back from responder to initiator', async () => {
    const svc = new IntegratedSignalingService();
    const transportA = makeTransport(svc, 'A');
    const transportB = makeTransport(svc, 'B');

    new WebRTCTransport(transportA);
    new WebRTCTransport(transportB);

    await svc.onClientConnected('A');
    await svc.onClientConnected('B');
    await flush();

    const bsPeerForA = createdPeers[0];

    // Send the offer through; A's side creates a peer for B.
    const offer = { type: 'offer', sdp: 'TEST-OFFER' };
    bsPeerForA.handlers['signal'](offer);
    await flush();

    const asPeerForB = createdPeers[1];

    // Now A's peer fires its own 'signal' with an answer. Should round-trip
    // back to B's existing peer and land in peer.signal(answer).
    const answer = { type: 'answer', sdp: 'TEST-ANSWER' };
    asPeerForB.handlers['signal'](answer);
    await flush();

    expect(bsPeerForA.signal).toHaveBeenCalledWith(answer);
    // No extra peers created on either side for the answer.
    expect(createdPeers).toHaveLength(2);
  });

  it('uses notifications (no JSON-RPC id) for signaling so transient relays do not raise unhandled rejections', async () => {
    // Capture the bytes B's transport sends so we can verify the wire shape
    // without depending on internal implementation details of SignalingService.
    const svc = new IntegratedSignalingService();
    const sentByB: string[] = [];

    const transportA = makeTransport(svc, 'A');
    const onMessageB = signal<(raw: string) => void>();
    const onStateChangeB = signal<(state: ConnectionState) => void>();
    svc.inbound.set('B', onMessageB);
    const transportB = {
      send(raw: string) {
        sentByB.push(raw);
        void svc.handleClientMessage('B', raw);
      },
      onMessage: onMessageB,
      onStateChange: onStateChangeB,
      state: 'connected' as ConnectionState,
      connect: async () => {},
    } as unknown as SignalingTransport;

    new WebRTCTransport(transportA);
    new WebRTCTransport(transportB);

    await svc.onClientConnected('A');
    await svc.onClientConnected('B');
    await flush();

    const bsPeerForA = createdPeers[0];
    bsPeerForA.handlers['signal']({ type: 'offer', sdp: 'X' });
    await flush();

    expect(sentByB).toHaveLength(1);
    const wire = JSON.parse(sentByB[0]);
    expect(wire).toMatchObject({
      jsonrpc: '2.0',
      method: 'peer-signal',
      params: ['A', { type: 'offer', sdp: 'X' }],
    });
    expect(wire.id).toBeUndefined();
  });
});
