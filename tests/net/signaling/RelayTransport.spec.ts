import { signal } from 'easy-signal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayTransport } from '../../../src/net/signaling/RelayTransport';
import { SignalingService, type JsonRpcMessage } from '../../../src/net/signaling/SignalingService';
import { WebRTCAwareness } from '../../../src/net/webrtc/WebRTCAwareness';
import type { ConnectionState, JsonRpcRequest, SignalingTransport } from '../../../src/net/protocol/types';

interface MockSignaling extends SignalingTransport {
  /** Parsed frames the transport was asked to send. */
  sent: any[];
  /** Deliver a server frame to every onMessage subscriber. */
  receive(frame: object): void;
  /** Live onMessage subscriber count — leak probe. */
  readonly handlerCount: number;
}

function createMockSignaling(onSend?: (raw: string) => void): MockSignaling {
  const handlers: ((raw: string) => void)[] = [];
  const sent: any[] = [];
  return {
    get handlerCount() {
      return handlers.length;
    },
    state: 'connected' as ConnectionState,
    onStateChange: signal<(state: ConnectionState) => void>(),
    connect: vi.fn(async () => {}),
    send(raw: string) {
      sent.push(JSON.parse(raw));
      onSend?.(raw);
    },
    onMessage(cb: (raw: string) => void) {
      handlers.push(cb);
      return () => {
        const index = handlers.indexOf(cb);
        if (index !== -1) handlers.splice(index, 1);
      };
    },
    sent,
    receive(frame: object) {
      for (const handler of [...handlers]) handler(JSON.stringify(frame));
    },
  };
}

const welcome = (id: string, peers: string[], room?: string) => ({
  jsonrpc: '2.0',
  method: 'peer-welcome',
  params: { id, peers, ...(room !== undefined && { room }) },
});

const signalFrame = (from: string, data: unknown, room?: string) => ({
  jsonrpc: '2.0',
  method: 'signal',
  params: { from, data, ...(room !== undefined && { room }) },
});

const disconnected = (id: string, room?: string) => ({
  jsonrpc: '2.0',
  method: 'peer-disconnected',
  params: { id, ...(room !== undefined && { room }) },
});

/** Collect every peer event and message in arrival order for order-sensitive assertions. */
function recordEvents(relay: RelayTransport) {
  const events: string[] = [];
  relay.onPeerConnect(peerId => events.push(`connect:${peerId}`));
  relay.onPeerDisconnect(peerId => events.push(`disconnect:${peerId}`));
  relay.onMessage(data => events.push(`message:${data}`));
  return events;
}

describe('RelayTransport', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('peer-welcome', () => {
    it('adopts the assigned id and announces every listed peer', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      const events = recordEvents(relay);

      transport.receive(welcome('me', ['B', 'C']));

      expect(relay.id).toBe('me');
      expect(events).toEqual(['connect:B', 'connect:C']);
    });

    it('never announces itself, even when a server fails to filter the roster', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      const events = recordEvents(relay);

      transport.receive(welcome('me', ['me', 'B']));
      relay.send('payload');

      expect(events).toEqual(['connect:B']);
      expect(transport.sent.map(frame => frame.params)).toEqual([['B', 'payload']]);
    });

    it('treats a repeat welcome as the authoritative roster', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', ['B', 'C']));

      const events = recordEvents(relay);
      // Reconnect: C left while our stream was down, D joined
      transport.receive(welcome('me', ['B', 'D']));

      // C is retired, and B is re-announced so consumers re-push state to it
      expect(events).toEqual(['disconnect:C', 'connect:B', 'connect:D']);
    });
  });

  describe('signal', () => {
    it('delivers the payload of a known peer', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', ['B']));
      const events = recordEvents(relay);

      transport.receive(signalFrame('B', '{"id":"B"}'));

      expect(events).toEqual(['message:{"id":"B"}']);
    });

    it('announces an unknown sender before delivering its first frame', () => {
      // Peers that join after our welcome introduce themselves with their first frame; the
      // announcement makes the consumer push our state back, completing the exchange
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', []));
      const events = recordEvents(relay);

      transport.receive(signalFrame('B', '{"id":"B"}'));

      expect(events).toEqual(['connect:B', 'message:{"id":"B"}']);
    });

    it('ignores frames echoed back from itself', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', []));
      const events = recordEvents(relay);

      transport.receive(signalFrame('me', '{"id":"me"}'));

      expect(events).toEqual([]);
    });

    it('stringifies non-string payloads', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', ['B']));
      const events = recordEvents(relay);

      transport.receive(signalFrame('B', { id: 'B', cursor: 4 }));

      expect(events).toEqual(['message:{"id":"B","cursor":4}']);
    });
  });

  describe('peer-disconnected', () => {
    it('retires a known peer', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', ['B']));
      const events = recordEvents(relay);

      transport.receive(disconnected('B'));

      expect(events).toEqual(['disconnect:B']);
    });

    it('ignores unknown peers', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', ['B']));
      const events = recordEvents(relay);

      transport.receive(disconnected('Z'));

      expect(events).toEqual([]);
    });
  });

  describe('send', () => {
    it('sends a directed peer-signal notification', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', ['B']));

      relay.send('payload', 'B');

      expect(transport.sent).toEqual([{ jsonrpc: '2.0', method: 'peer-signal', params: ['B', 'payload'] }]);
    });

    it('fans out to every known peer when no target is given', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', ['B', 'C']));

      relay.send('payload');

      expect(transport.sent.map(frame => frame.params)).toEqual([
        ['B', 'payload'],
        ['C', 'payload'],
      ]);
    });

    it('sends nothing when no peers are known', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', []));

      relay.send('payload');

      expect(transport.sent).toEqual([]);
    });
  });

  describe('rooms', () => {
    it('processes only frames tagged with its room', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport, 'r1');
      const events = recordEvents(relay);

      transport.receive(welcome('me', ['X'], 'r2'));
      transport.receive(welcome('me', ['B'])); // untagged — some other consumer's traffic
      expect(relay.id).toBeUndefined();
      expect(events).toEqual([]);

      transport.receive(welcome('me', ['B'], 'r1'));
      transport.receive(signalFrame('B', 'data-r2', 'r2'));
      transport.receive(signalFrame('B', 'data-r1', 'r1'));
      transport.receive(disconnected('B', 'r2'));

      expect(relay.id).toBe('me');
      expect(events).toEqual(['connect:B', 'message:data-r1']);
    });

    it('stamps outbound frames with its room as the third param', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport, 'r1');
      transport.receive(welcome('me', ['B'], 'r1'));

      relay.send('payload', 'B');

      expect(transport.sent).toEqual([{ jsonrpc: '2.0', method: 'peer-signal', params: ['B', 'payload', 'r1'] }]);
    });

    it('lets two rooms share one signaling connection without crosstalk', () => {
      const transport = createMockSignaling();
      const relayA = new RelayTransport(transport, 'room-a');
      const relayB = new RelayTransport(transport, 'room-b');
      const eventsA = recordEvents(relayA);
      const eventsB = recordEvents(relayB);

      transport.receive(welcome('me', ['P1'], 'room-a'));
      transport.receive(welcome('me', ['P2'], 'room-b'));
      transport.receive(signalFrame('P1', 'for-a', 'room-a'));
      transport.receive(signalFrame('P2', 'for-b', 'room-b'));

      expect(eventsA).toEqual(['connect:P1', 'message:for-a']);
      expect(eventsB).toEqual(['connect:P2', 'message:for-b']);
    });
  });

  describe('lifecycle', () => {
    it('connect() delegates to the signaling channel', async () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);

      await relay.connect();

      expect(transport.connect).toHaveBeenCalled();
    });

    it('disconnect() retires all peers, clears the id, and stops processing frames', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', ['B', 'C']));
      const events = recordEvents(relay);

      relay.disconnect();

      expect(events).toEqual(['disconnect:B', 'disconnect:C']);
      expect(relay.id).toBeUndefined();

      transport.receive(welcome('me', ['D']));
      expect(relay.id).toBeUndefined();
      expect(events).toEqual(['disconnect:B', 'disconnect:C']);
    });

    it('connect() after disconnect() resumes processing frames', async () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      transport.receive(welcome('me', ['B']));
      relay.disconnect();

      await relay.connect();
      const events = recordEvents(relay);
      transport.receive(welcome('me', ['B']));

      expect(relay.id).toBe('me');
      expect(events).toEqual(['connect:B']);
    });
  });

  describe('end-to-end with SignalingService and WebRTCAwareness', () => {
    /** In-memory SignalingService that delivers straight into each client's transport. */
    class LoopbackSignalingService extends SignalingService {
      constructor(private clientTransports: Map<string, MockSignaling>) {
        super();
      }
      send(id: string, message: JsonRpcMessage): void {
        this.clientTransports.get(id)?.receive(message as object);
      }
    }

    const flush = async () => {
      // Each relay hop chains a few promises (handleClientMessage → send → receive)
      for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
    };

    it('exchanges awareness states both ways and drops them on disconnect', async () => {
      const clientTransports = new Map<string, MockSignaling>();
      const service = new LoopbackSignalingService(clientTransports);

      const transportA = createMockSignaling(raw => void service.handleClientMessage('A', raw));
      const transportB = createMockSignaling(raw => void service.handleClientMessage('B', raw));
      clientTransports.set('A', transportA);
      clientTransports.set('B', transportB);

      const awarenessA = new WebRTCAwareness(new RelayTransport(transportA));
      const awarenessB = new WebRTCAwareness(new RelayTransport(transportB));

      await service.onClientConnected('A');
      awarenessA.localState = { user: 'alice' };
      await flush();

      // B joins after A already set its state: B is welcomed with A in the roster, pushes its
      // state to A, and A pushes back when B's first frame announces it
      await service.onClientConnected('B');
      awarenessB.localState = { user: 'bob' };
      await flush();

      expect(awarenessA.states).toEqual([{ user: 'bob', id: 'B' }]);
      expect(awarenessB.states).toEqual([{ user: 'alice', id: 'A' }]);

      // Updates replace the peer's full state
      awarenessB.localState = { user: 'bob', cursor: 7 };
      await flush();
      expect(awarenessA.states).toEqual([{ user: 'bob', cursor: 7, id: 'B' }]);

      // A disconnect broadcast retires the peer and its state
      await service.onClientDisconnected('B');
      await flush();
      expect(awarenessA.states).toEqual([]);
    });

    it('round-trips rooms against a room-echoing service (the pup shape)', async () => {
      /**
       * Stock SignalingService drops the third peer-signal param on relay, so room tagging is
       * only live against a server that echoes `room` — this emulates that server: it stamps
       * its room into every outbound frame and records the inbound third param.
       */
      class RoomSignalingService extends SignalingService {
        seenRooms: unknown[] = [];
        constructor(
          private clientTransports: Map<string, MockSignaling>,
          private room: string
        ) {
          super();
        }
        async handleClientMessage(fromId: string, message: string | JsonRpcRequest): Promise<boolean> {
          const parsed = typeof message === 'string' ? JSON.parse(message) : message;
          if (parsed?.method === 'peer-signal' && Array.isArray(parsed.params)) {
            this.seenRooms.push(parsed.params[2]);
          }
          return super.handleClientMessage(fromId, message);
        }
        send(id: string, message: JsonRpcMessage): void {
          const frame = message as any;
          if (['peer-welcome', 'peer-disconnected', 'signal'].includes(frame?.method)) {
            frame.params = { ...frame.params, room: this.room };
          }
          this.clientTransports.get(id)?.receive(frame as object);
        }
      }

      const clientTransports = new Map<string, MockSignaling>();
      const service = new RoomSignalingService(clientTransports, 'fam');
      const transportA = createMockSignaling(raw => void service.handleClientMessage('A', raw));
      const transportB = createMockSignaling(raw => void service.handleClientMessage('B', raw));
      clientTransports.set('A', transportA);
      clientTransports.set('B', transportB);

      const awarenessA = new WebRTCAwareness(new RelayTransport(transportA, 'fam'));
      const awarenessB = new WebRTCAwareness(new RelayTransport(transportB, 'fam'));
      // A transport for another room sharing A's signaling channel must stay silent
      const bystander = new RelayTransport(transportA, 'other-room');
      const bystanderEvents = recordEvents(bystander);

      await service.onClientConnected('A');
      awarenessA.localState = { user: 'alice' };
      await flush();
      await service.onClientConnected('B');
      awarenessB.localState = { user: 'bob' };
      await flush();

      expect(awarenessA.states).toEqual([{ user: 'bob', id: 'B' }]);
      expect(awarenessB.states).toEqual([{ user: 'alice', id: 'A' }]);
      expect(service.seenRooms.every(room => room === 'fam')).toBe(true);
      expect(service.seenRooms.length).toBeGreaterThan(0);
      expect(bystanderEvents).toEqual([]);
    });
  });

  describe('dispose', () => {
    it('releases the transport-level handlers that disconnect (deliberately) keeps', () => {
      const transport = createMockSignaling();
      const baseline = transport.handlerCount;
      const relay = new RelayTransport(transport);
      expect(transport.handlerCount).toBe(baseline + 1);

      // disconnect keeps the transport-level subscription so connect() can reuse the instance
      relay.disconnect();
      expect(transport.handlerCount).toBe(baseline + 1);

      // dispose is the final teardown: nothing left on the shared channel
      relay.dispose();
      expect(transport.handlerCount).toBe(baseline);
    });

    it('creating and disposing many transports leaves the shared channel clean', () => {
      const transport = createMockSignaling();
      const baseline = transport.handlerCount;
      for (let i = 0; i < 5; i++) {
        const relay = new RelayTransport(transport, `room-${i}`);
        relay.dispose();
      }
      expect(transport.handlerCount).toBe(baseline);
    });

    it('a disposed transport ignores subsequent frames', () => {
      const transport = createMockSignaling();
      const relay = new RelayTransport(transport);
      const connects: string[] = [];
      relay.onPeerConnect(peerId => connects.push(peerId));

      relay.dispose();
      transport.receive(welcome('me', ['peer-1']));

      expect(connects).toEqual([]);
      expect(relay.id).toBeUndefined();
    });
  });
});
