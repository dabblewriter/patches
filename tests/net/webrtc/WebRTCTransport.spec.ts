import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../../../src/net/protocol/types';
import { WebRTCTransport } from '../../../src/net/webrtc/WebRTCTransport';
import type { WebSocketTransport } from '../../../src/net/websocket/WebSocketTransport';
// Import the actual class for type checking/instanceof

// Mock dependencies
vi.mock('simple-peer', () => {
  // Create a mock Peer implementation
  const MockPeer = vi.fn().mockImplementation(() => {
    const events: Record<string, Array<(...args: any[]) => void>> = {};

    const peer = {
      on: vi.fn((event, handler) => {
        events[event] = events[event] || [];
        events[event].push(handler);
      }),
      signal: vi.fn(_data => {
        // Simulate signal processing
      }),
      send: vi.fn(_data => {
        // Simulate data sending
      }),
      destroy: vi.fn(() => {
        // Simulate peer cleanup
        if (events.close) {
          events.close.forEach(handler => handler());
        }
      }),
      // Helper methods for testing
      _emit: (event: string, ...args: any[]) => {
        if (events[event]) {
          events[event].forEach(handler => handler(...args));
        }
      },
      _triggerConnect: () => {
        if (events.connect) {
          events.connect.forEach(handler => handler());
        }
      },
      _triggerData: (data: string) => {
        if (events.data) {
          events.data.forEach(handler => handler(data));
        }
      },
      _triggerError: (error: Error) => {
        if (events.error) {
          events.error.forEach(handler => handler(error));
        }
      },
      _triggerClose: () => {
        if (events.close) {
          events.close.forEach(handler => handler());
        }
      },
    };

    return peer;
  });

  return { default: MockPeer };
});

// Mock WebSocketTransport
class MockWebSocketTransport {
  onStateChange = vi.fn();
  onMessage = vi.fn();
  state: ConnectionState = 'disconnected';
  connect = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn();
  send = vi.fn();
}

// Mock JSONRPCClient
class MockJSONRPCClient {
  private eventHandlers: Record<string, (data: any) => void> = {};

  constructor(private transport: any) {}

  on = vi.fn((event: string, handler: (data: any) => void) => {
    this.eventHandlers[event] = handler;
    return () => {
      delete this.eventHandlers[event];
    };
  });

  request = vi.fn().mockResolvedValue(undefined);

  // Helper to trigger events for testing
  _triggerEvent(event: string, data: any) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event](data);
    }
  }
}

// Mock the JSONRPCClient module
vi.mock('../../../src/net/protocol/JSONRPCClient.js', () => ({
  JSONRPCClient: vi.fn().mockImplementation(transport => {
    return new MockJSONRPCClient(transport);
  }),
}));

describe('WebRTCTransport', () => {
  let transport: WebRTCTransport;
  let mockWsTransport: MockWebSocketTransport;
  let mockRpc: MockJSONRPCClient;
  let mockPeers: Record<string, any> = {};

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    mockPeers = {};

    // Create mock dependencies
    mockWsTransport = new MockWebSocketTransport();

    // Create transport under test
    transport = new WebRTCTransport(mockWsTransport as unknown as WebSocketTransport);

    // Get reference to the mock RPC client
    mockRpc = (transport as any).rpc;

    // Helper to register a mock peer for testing
    const registerMockPeer = (peerId: string, initiator: boolean = false) => {
      // Trigger peer-welcome or peer-signal to create the peer
      if (initiator) {
        mockRpc._triggerEvent('peer-welcome', { id: 'local-id', peers: [peerId] });
      } else {
        mockRpc._triggerEvent('peer-signal', { from: peerId, data: { type: 'offer' } });
      }

      // Get peer from the internal peers map
      const peerInfo = (transport as any).peers.get(peerId);

      if (peerInfo) {
        mockPeers[peerId] = peerInfo.peer;
      }
    };

    // Register some mock peers for testing
    registerMockPeer('peer1', true);
    registerMockPeer('peer2', false);
  });

  it('should create a WebRTCTransport instance', () => {
    expect(transport).toBeInstanceOf(WebRTCTransport);
  });

  it('should delegate state to the underlying WebSocket transport', () => {
    expect(transport.state).toBe('disconnected');

    // Change the mock transport state
    mockWsTransport.state = 'connected';

    // Should reflect the updated state
    expect(transport.state).toBe('connected');
  });

  it('should connect to the signaling server when connect is called', async () => {
    await transport.connect();
    expect(mockWsTransport.connect).toHaveBeenCalled();
  });

  it('should handle receiving peer-welcome event', () => {
    // Clear previously created peers
    vi.clearAllMocks();
    (transport as any).peers.clear();

    // Simulate receiving welcome message from server
    mockRpc._triggerEvent('peer-welcome', {
      id: 'my-peer-id',
      peers: ['peer1', 'peer2', 'peer3'],
    });

    // Should set local ID
    expect(transport.id).toBe('my-peer-id');

    // Should create 3 peers
    expect((transport as any).peers.size).toBe(3);
  });

  it('should establish WebRTC connections to peers', () => {
    // Peer connection should be initiated when peer-welcome is received
    expect(mockPeers.peer1).toBeDefined();

    // Simulate successful connection for peer1
    mockPeers.peer1._triggerConnect();

    // Peer should be marked as connected
    const peer1Info = (transport as any).peers.get('peer1');
    expect(peer1Info.connected).toBe(true);
  });

  it('should handle peer disconnections', () => {
    // Setup connected peer
    mockPeers.peer1._triggerConnect();

    const peerDisconnectHandler = vi.fn();
    transport.onPeerDisconnect(peerDisconnectHandler);

    // Simulate peer disconnection
    mockRpc._triggerEvent('peer-disconnected', { id: 'peer1' });

    // Peer should be removed
    expect((transport as any).peers.has('peer1')).toBe(false);

    // Disconnect event should be emitted
    expect(peerDisconnectHandler).toHaveBeenCalledWith('peer1', mockPeers.peer1);
  });

  it('should emit connection events when peers connect', () => {
    const peerConnectHandler = vi.fn();
    transport.onPeerConnect(peerConnectHandler);

    // Simulate peer1 connecting
    mockPeers.peer1._triggerConnect();

    // Event should be emitted
    expect(peerConnectHandler).toHaveBeenCalledWith('peer1', mockPeers.peer1);
  });

  it('should relay signaling data to peers', () => {
    // Simulate receiving signal from peer1
    const signalData = { type: 'candidate', candidate: 'test' };
    mockRpc._triggerEvent('peer-signal', { from: 'peer1', data: signalData });

    // Should forward the signal to the peer
    expect(mockPeers.peer1.signal).toHaveBeenCalledWith(signalData);
  });

  it('should send signals to the signaling server', () => {
    // Simulate peer generating a signal
    const signalData = { type: 'answer', sdp: 'test' };

    // This will retrieve the signal handler and call it with our test data
    const signalHandlers = mockPeers.peer1.on.mock.calls
      .filter((call: any) => call[0] === 'signal')
      .map((call: any) => call[1]);

    signalHandlers[0](signalData);

    // Should send the signal via RPC
    expect(mockRpc.request).toHaveBeenCalledWith('peer-signal', {
      to: 'peer1',
      data: signalData,
    });
  });

  it('should send data to connected peers', () => {
    // Connect peers
    mockPeers.peer1._triggerConnect();
    mockPeers.peer2._triggerConnect();

    // Send data to all peers
    transport.send('test data');

    // Should send to both peers
    expect(mockPeers.peer1.send).toHaveBeenCalledWith('test data');
    expect(mockPeers.peer2.send).toHaveBeenCalledWith('test data');
  });

  it('should send data to a specific peer', () => {
    // Connect peers
    mockPeers.peer1._triggerConnect();
    mockPeers.peer2._triggerConnect();

    // Send data to specific peer
    transport.send('specific data', 'peer2');

    // Should only send to peer2
    expect(mockPeers.peer1.send).not.toHaveBeenCalled();
    expect(mockPeers.peer2.send).toHaveBeenCalledWith('specific data');
  });

  it('should emit message events when data is received from peers', () => {
    const messageHandler = vi.fn();
    transport.onMessage(messageHandler);

    // Simulate receiving data from peer1
    const testData = 'received data';
    mockPeers.peer1._triggerData(testData);

    // Event should be emitted with peer data
    expect(messageHandler).toHaveBeenCalledWith(testData, 'peer1', mockPeers.peer1);
  });

  it('should handle peer errors', () => {
    const peerDisconnectHandler = vi.fn();
    transport.onPeerDisconnect(peerDisconnectHandler);

    // Create a connected peer
    mockPeers.peer1._triggerConnect();

    // Simulate peer error
    const error = new Error('Connection failed');
    mockPeers.peer1._triggerError(error);

    // Peer should be removed
    expect((transport as any).peers.has('peer1')).toBe(false);

    // Disconnect event should be emitted
    expect(peerDisconnectHandler).toHaveBeenCalledWith('peer1', mockPeers.peer1);
  });

  it('should clean up resources when a peer closes', () => {
    // Setup connected peer
    mockPeers.peer1._triggerConnect();

    const peerDisconnectHandler = vi.fn();
    transport.onPeerDisconnect(peerDisconnectHandler);

    // Simulate peer closure
    mockPeers.peer1._triggerClose();

    // Peer should be removed
    expect((transport as any).peers.has('peer1')).toBe(false);

    // Disconnect event should be emitted
    expect(peerDisconnectHandler).toHaveBeenCalledWith('peer1', mockPeers.peer1);
  });

  it('should clean up all peers when disconnecting', () => {
    // Setup connected peers
    mockPeers.peer1._triggerConnect();
    mockPeers.peer2._triggerConnect();

    // Add a spy to track destroyed peers
    const destroySpy = vi.fn();

    // Intercept destroy calls
    Object.values(mockPeers).forEach(peer => {
      const originalDestroy = peer.destroy;
      peer.destroy = vi.fn(() => {
        destroySpy();
        return originalDestroy();
      });
    });

    // Disconnect the transport
    transport.disconnect();

    // All peers should be destroyed
    expect(destroySpy).toHaveBeenCalledTimes(2);

    // All peer handlers should be unsubscribed
    expect((transport as any).peers.size).toBe(0);
  });
});
