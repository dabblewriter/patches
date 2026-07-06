import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from 'easy-signal';
import { WebRTCTransport } from '../../../src/net/webrtc/WebRTCTransport';
import type { ConnectionState, JsonRpcNotification, SignalingTransport } from '../../../src/net/protocol/types';

// Store the mock peer constructor for use in tests
let mockPeerFactory: (() => any) | undefined;

// Mock simple-peer with a proper constructor function
vi.mock('simple-peer', () => {
  return {
    default: vi.fn(function () {
      return mockPeerFactory ? mockPeerFactory() : {};
    }),
  };
});

type FakeSignalingTransport = SignalingTransport & {
  send: ReturnType<typeof vi.fn> & ((raw: string) => void);
  emitMessage(raw: string): void;
  setState(state: ConnectionState): void;
};

function createFakeTransport(): FakeSignalingTransport {
  const onMessage = signal<(raw: string) => void>();
  const onStateChange = signal<(state: ConnectionState) => void>();
  let state: ConnectionState = 'disconnected';

  const transport = {
    send: vi.fn(),
    onMessage,
    onStateChange,
    connect: vi.fn().mockResolvedValue(undefined),
    get state() {
      return state;
    },
    emitMessage(raw: string) {
      onMessage.emit(raw);
    },
    setState(next: ConnectionState) {
      state = next;
      onStateChange.emit(next);
    },
  };

  return transport as unknown as FakeSignalingTransport;
}

function notification(method: string, params: any): string {
  const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
  return JSON.stringify(msg);
}

function sentMessages(transport: FakeSignalingTransport): any[] {
  return transport.send.mock.calls.map(call => JSON.parse(call[0]));
}

describe('WebRTCTransport', () => {
  let mockTransport: FakeSignalingTransport;
  let transport: WebRTCTransport;
  let peerEventHandlers: Record<string, any>;
  let currentMockPeerInstance: any;
  let mockPeerConstructor: any;

  beforeEach(async () => {
    const SimplePeer = await import('simple-peer');
    mockPeerConstructor = vi.mocked(SimplePeer.default);

    currentMockPeerInstance = {
      signal: vi.fn(),
      send: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      connected: false,
    };

    mockPeerFactory = () => currentMockPeerInstance;

    peerEventHandlers = {};
    currentMockPeerInstance.on.mockImplementation(function (event: string, handler: any) {
      peerEventHandlers[event] = handler;
    });

    mockTransport = createFakeTransport();
    transport = new WebRTCTransport(mockTransport);
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockPeerConstructor.mockClear();
  });

  describe('constructor', () => {
    it('should create transport with the signaling transport', () => {
      expect(transport).toBeInstanceOf(WebRTCTransport);
    });

    it('should delegate state change signal from underlying transport', () => {
      expect(transport.onStateChange).toBe(mockTransport.onStateChange);
    });

    it('should accept any SignalingTransport (e.g. non-WebSocket REST adapter)', () => {
      const restLikeTransport = createFakeTransport();
      const t = new WebRTCTransport(restLikeTransport);

      expect(t).toBeInstanceOf(WebRTCTransport);
      expect(t.onStateChange).toBe(restLikeTransport.onStateChange);
    });
  });

  describe('options', () => {
    it('should pass ICE config (STUN/TURN servers) to simple-peer', () => {
      const config = { iceServers: [{ urls: 'turn:turn.example.com', username: 'u', credential: 'c' }] };
      const other = createFakeTransport();
      new WebRTCTransport(other, { config });

      other.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));

      expect(mockPeerConstructor).toHaveBeenCalledWith({ initiator: true, trickle: false, config });
    });

    it('should pass trickle through to simple-peer', () => {
      const other = createFakeTransport();
      new WebRTCTransport(other, { trickle: true });

      other.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));

      expect(mockPeerConstructor).toHaveBeenCalledWith({ initiator: true, trickle: true, config: undefined });
    });
  });

  describe('id property', () => {
    it('should return undefined initially', () => {
      expect(transport.id).toBeUndefined();
    });

    it('should return id after peer-welcome', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'peer123', peers: [] }));

      expect(transport.id).toBe('peer123');
    });
  });

  describe('state property', () => {
    it('should delegate to underlying transport state', () => {
      mockTransport.setState('connected');
      expect(transport.state).toBe('connected');
    });
  });

  describe('connect method', () => {
    it('should connect via underlying transport', async () => {
      await transport.connect();

      expect(mockTransport.connect).toHaveBeenCalled();
    });

    it('should handle connection errors', async () => {
      const error = new Error('Connection failed');
      (mockTransport.connect as any).mockRejectedValue(error);

      await expect(transport.connect()).rejects.toThrow('Connection failed');
    });
  });

  describe('disconnect method', () => {
    it('should destroy all peer connections', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));
      peerEventHandlers['connect']();

      transport.disconnect();

      expect(currentMockPeerInstance.destroy).toHaveBeenCalled();
    });

    it('should clear peers map', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));

      expect(transport['peers'].size).toBe(1);

      transport.disconnect();

      expect(transport['peers'].size).toBe(0);
    });

    it('should stop reacting to inbound signaling messages', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: [] }));
      transport.disconnect();

      mockTransport.emitMessage(notification('signal', { from: 'peer1', data: { type: 'offer' } }));

      // No new peer should be created because subscriptions have been torn down
      expect(transport['peers'].size).toBe(0);
    });
  });

  describe('send method', () => {
    beforeEach(() => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));
      peerEventHandlers['connect']();
    });

    it('should send to all connected peers', () => {
      transport.send('test message');

      expect(currentMockPeerInstance.send).toHaveBeenCalledWith('test message');
    });

    it('should send to specific peer', () => {
      transport.send('test message', 'peer1');

      expect(currentMockPeerInstance.send).toHaveBeenCalledWith('test message');
    });

    it('should not send to unconnected peers', () => {
      transport['peers'].get('peer1')!.connected = false;

      transport.send('test message');

      expect(currentMockPeerInstance.send).not.toHaveBeenCalled();
    });

    it('should handle send errors gracefully', () => {
      currentMockPeerInstance.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      const messageSpy = vi.fn();
      transport.onMessage(messageSpy);

      transport.send('test message');

      expect(messageSpy).toHaveBeenCalledWith(expect.stringContaining('"error"'), undefined, currentMockPeerInstance);
    });
  });

  describe('peer-welcome handling (inbound notification)', () => {
    it('should set peer ID', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'myPeerId', peers: [] }));

      expect(transport.id).toBe('myPeerId');
    });

    it('should connect to existing peers', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1', 'peer2'] }));

      expect(mockPeerConstructor).toHaveBeenCalledTimes(2);
      expect(mockPeerConstructor).toHaveBeenCalledWith({ initiator: true, trickle: false });
      expect(transport['peers'].size).toBe(2);
    });
  });

  describe('peer-disconnected handling (inbound notification)', () => {
    it('should remove disconnected peer', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));
      expect(transport['peers'].has('peer1')).toBe(true);

      mockTransport.emitMessage(notification('peer-disconnected', { id: 'peer1' }));

      expect(transport['peers'].has('peer1')).toBe(false);
      expect(currentMockPeerInstance.destroy).toHaveBeenCalled();
    });

    it('should emit peer disconnect event', () => {
      const disconnectSpy = vi.fn();
      transport.onPeerDisconnect(disconnectSpy);

      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));
      mockTransport.emitMessage(notification('peer-disconnected', { id: 'peer1' }));

      expect(disconnectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);
    });

    it('should handle disconnection of non-existent peer', () => {
      expect(() => mockTransport.emitMessage(notification('peer-disconnected', { id: 'nonexistent' }))).not.toThrow();
    });
  });

  describe('inbound signal notification (server → client)', () => {
    it('should subscribe to the "signal" method (server emits method:"signal", not "peer-signal")', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));

      const signalData = { type: 'offer', sdp: 'test-sdp' };
      mockTransport.emitMessage(notification('signal', { from: 'peer1', data: signalData }));

      expect(currentMockPeerInstance.signal).toHaveBeenCalledWith(signalData);
    });

    it('should NOT react to legacy "peer-signal" inbound notifications', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));

      mockTransport.emitMessage(notification('peer-signal', { from: 'peer1', data: { type: 'offer' } }));

      expect(currentMockPeerInstance.signal).not.toHaveBeenCalled();
    });

    it('should create new peer if not exists', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: [] }));

      const signalData = { type: 'answer', sdp: 'test-sdp' };
      mockTransport.emitMessage(notification('signal', { from: 'newPeer', data: signalData }));

      expect(mockPeerConstructor).toHaveBeenCalledWith({ initiator: false, trickle: false });
      expect(transport['peers'].has('newPeer')).toBe(true);
      expect(currentMockPeerInstance.signal).toHaveBeenCalledWith(signalData);
    });
  });

  describe('outbound peer-signal (client → server)', () => {
    it('should send a JSON-RPC notification with positional params [to, data]', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));

      // Drop the peer-welcome inbound; we're interested in the outbound that
      // comes from simple-peer firing its 'signal' event.
      mockTransport.send.mockClear();

      const signalData = { type: 'offer', sdp: 'test' };
      peerEventHandlers['signal'](signalData);

      const sent = sentMessages(mockTransport);
      expect(sent).toHaveLength(1);

      // Protocol contract: notification (no id), positional params [peerId, data],
      // method 'peer-signal'. If any of these regress, the SignalingService
      // will silently drop the message.
      expect(sent[0]).toMatchObject({
        jsonrpc: '2.0',
        method: 'peer-signal',
        params: ['peer1', signalData],
      });
      expect(sent[0].id).toBeUndefined();
    });
  });

  describe('peer event handling', () => {
    beforeEach(() => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));
    });

    it('should handle peer connect event', () => {
      const connectSpy = vi.fn();
      transport.onPeerConnect(connectSpy);

      peerEventHandlers['connect']();

      expect(transport['peers'].get('peer1')?.connected).toBe(true);
      expect(connectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);
    });

    it('should handle peer data event', () => {
      const messageSpy = vi.fn();
      transport.onMessage(messageSpy);

      peerEventHandlers['data']('test message');

      expect(messageSpy).toHaveBeenCalledWith('test message', 'peer1', currentMockPeerInstance);
    });

    it('should handle peer close event', () => {
      const disconnectSpy = vi.fn();
      transport.onPeerDisconnect(disconnectSpy);

      peerEventHandlers['close']();

      expect(transport['peers'].has('peer1')).toBe(false);
      expect(disconnectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);
      expect(currentMockPeerInstance.destroy).toHaveBeenCalled();
    });

    it('should handle peer error event', () => {
      const messageSpy = vi.fn();
      transport.onMessage(messageSpy);

      const disconnectSpy = vi.fn();
      transport.onPeerDisconnect(disconnectSpy);

      const error = new Error('Peer connection error');
      peerEventHandlers['error'](error);

      expect(messageSpy).toHaveBeenCalledWith(expect.stringContaining('"error"'), 'peer1', currentMockPeerInstance);
      expect(transport['peers'].has('peer1')).toBe(false);
      expect(disconnectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);
      expect(currentMockPeerInstance.destroy).toHaveBeenCalled();
    });
  });

  describe('ClientTransport interface', () => {
    it('should implement send method', () => {
      expect(typeof transport.send).toBe('function');
    });

    it('should support message subscription and unsubscription', () => {
      const handler = vi.fn();
      const unsubscriber = transport.onMessage(handler);

      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));
      peerEventHandlers['data']('test message');

      expect(handler).toHaveBeenCalledWith('test message', 'peer1', currentMockPeerInstance);

      unsubscriber();
      handler.mockClear();

      peerEventHandlers['data']('another message');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('edge cases and robustness', () => {
    it('should handle multiple peers connecting simultaneously', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1', 'peer2', 'peer3'] }));

      expect(transport['peers'].size).toBe(3);
      expect(mockPeerConstructor).toHaveBeenCalledTimes(3);
    });

    it('should handle rapid connect/disconnect cycles', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));
      expect(transport['peers'].has('peer1')).toBe(true);

      mockTransport.emitMessage(notification('peer-disconnected', { id: 'peer1' }));
      expect(transport['peers'].has('peer1')).toBe(false);

      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1'] }));
      expect(transport['peers'].has('peer1')).toBe(true);
    });
  });

  describe('memory management', () => {
    it('should clean up peer resources on disconnect', () => {
      mockTransport.emitMessage(notification('peer-welcome', { id: 'me', peers: ['peer1', 'peer2', 'peer3'] }));

      expect(transport['peers'].size).toBe(3);

      transport.disconnect();

      expect(transport['peers'].size).toBe(0);
      expect(currentMockPeerInstance.destroy).toHaveBeenCalledTimes(3);
    });

    it('should clear subscriptions array after disconnect', () => {
      transport.disconnect();

      expect(transport['subscriptions']).toHaveLength(0);
    });
  });
});
