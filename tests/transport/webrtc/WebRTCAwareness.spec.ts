import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebRTCAwareness } from '../../../src/transport/webrtc/WebRTCAwareness';
import type { WebRTCTransport } from '../../../src/transport/webrtc/WebRTCTransport';

// Define test types
interface TestAwarenessState {
  id?: string;
  cursor?: { x: number; y: number };
  selection?: { start: number; end: number };
  user?: { name: string; color: string };
}

describe('WebRTCAwareness', () => {
  // Mock WebRTCTransport
  let mockTransport: {
    onPeerConnect: any;
    onPeerDisconnect: any;
    onMessage: any;
    connect: any;
    disconnect: any;
    send: any;
    id: string;
  };

  let awareness: WebRTCAwareness<TestAwarenessState>;
  let connectHandler: (peerId: string) => void;
  let disconnectHandler: (peerId: string) => void;
  let messageHandler: (data: string) => void;

  beforeEach(() => {
    // Create mock transport with fake event handlers
    const onPeerConnectHandlers: ((peerId: string, peer: any) => void)[] = [];
    const onPeerDisconnectHandlers: ((peerId: string, peer: any) => void)[] = [];
    const onMessageHandlers: ((data: string, peerId: string, peer: any) => void)[] = [];

    mockTransport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      send: vi.fn(),
      id: 'local-peer-id',

      // Mock event registration methods
      onPeerConnect: vi.fn(handler => {
        onPeerConnectHandlers.push(handler);
        connectHandler = (peerId: string) => {
          onPeerConnectHandlers.forEach(h => h(peerId, {}));
        };
        return () => {};
      }),

      onPeerDisconnect: vi.fn(handler => {
        onPeerDisconnectHandlers.push(handler);
        disconnectHandler = (peerId: string) => {
          onPeerDisconnectHandlers.forEach(h => h(peerId, {}));
        };
        return () => {};
      }),

      onMessage: vi.fn(handler => {
        onMessageHandlers.push(handler);
        messageHandler = (data: string) => {
          onMessageHandlers.forEach(h => h(data, '', {}));
        };
        return () => {};
      }),
    };

    // Create awareness instance with mock transport
    awareness = new WebRTCAwareness<TestAwarenessState>(mockTransport as unknown as WebRTCTransport);
  });

  it('should create an awareness instance', () => {
    expect(awareness).toBeInstanceOf(WebRTCAwareness);
    expect(awareness.states).toEqual([]);
  });

  it('should subscribe to transport events on creation', () => {
    expect(mockTransport.onPeerConnect).toHaveBeenCalled();
    expect(mockTransport.onPeerDisconnect).toHaveBeenCalled();
    expect(mockTransport.onMessage).toHaveBeenCalled();
  });

  it('should connect to the transport when connect is called', async () => {
    await awareness.connect();
    expect(mockTransport.connect).toHaveBeenCalled();
  });

  it('should disconnect from the transport when disconnect is called', () => {
    awareness.disconnect();
    expect(mockTransport.disconnect).toHaveBeenCalled();
  });

  it('should allow setting local state and broadcast it', async () => {
    // Connect first to ensure myId is set
    await awareness.connect();

    const testState: TestAwarenessState = {
      cursor: { x: 100, y: 200 },
      selection: { start: 10, end: 20 },
      user: { name: 'Test User', color: '#ff0000' },
    };

    awareness.localState = testState;

    // Should add id to the state
    expect(awareness.localState).toEqual({
      ...testState,
      id: 'local-peer-id',
    });

    // Should broadcast the state
    expect(mockTransport.send).toHaveBeenCalledWith(JSON.stringify({ ...testState, id: 'local-peer-id' }));
  });

  it('should send local state to newly connected peers', async () => {
    // Connect first to ensure myId is set
    await awareness.connect();

    // Set local state first
    const testState: TestAwarenessState = {
      cursor: { x: 100, y: 200 },
    };
    awareness.localState = testState;

    // Clear previous calls
    mockTransport.send.mockClear();

    // Simulate new peer connection
    connectHandler('new-peer-id');

    // Should send local state to the new peer
    expect(mockTransport.send).toHaveBeenCalledWith(
      JSON.stringify({ ...testState, id: 'local-peer-id' }),
      'new-peer-id'
    );
  });

  it('should remove peer state when a peer disconnects', () => {
    // Setup initial state with multiple peers
    const peerState1: TestAwarenessState = {
      id: 'peer1',
      user: { name: 'Peer 1', color: '#00ff00' },
    };

    const peerState2: TestAwarenessState = {
      id: 'peer2',
      user: { name: 'Peer 2', color: '#0000ff' },
    };

    // Add peers to awareness state
    messageHandler(JSON.stringify(peerState1));
    messageHandler(JSON.stringify(peerState2));

    // Verify both peers are in the state
    expect(awareness.states).toHaveLength(2);

    // Simulate peer disconnection
    disconnectHandler('peer1');

    // Verify peer1 was removed
    expect(awareness.states).toHaveLength(1);
    expect(awareness.states[0].id).toBe('peer2');
  });

  it('should process incoming awareness data', () => {
    // Simulate receiving data from a peer
    const peerState: TestAwarenessState = {
      id: 'peer1',
      cursor: { x: 50, y: 75 },
      user: { name: 'Remote User', color: '#00ff00' },
    };

    messageHandler(JSON.stringify(peerState));

    // Should add to the awareness state
    expect(awareness.states).toHaveLength(1);
    expect(awareness.states[0]).toEqual(peerState);
  });

  it('should update existing peer data when receiving updates', () => {
    // Initial peer state
    const initialState: TestAwarenessState = {
      id: 'peer1',
      cursor: { x: 50, y: 75 },
      selection: { start: 5, end: 10 },
      user: { name: 'Remote User', color: '#00ff00' },
    };

    // Updated peer state with partial changes
    const updatedState: TestAwarenessState = {
      id: 'peer1',
      cursor: { x: 60, y: 80 },
    };

    // Add initial state
    messageHandler(JSON.stringify(initialState));
    expect(awareness.states[0]).toEqual(initialState);

    // Process update
    messageHandler(JSON.stringify(updatedState));

    // Should update only the changed fields
    expect(awareness.states).toHaveLength(1);
    expect(awareness.states[0]).toEqual({
      id: 'peer1',
      cursor: { x: 60, y: 80 }, // Updated
      selection: { start: 5, end: 10 }, // Preserved
      user: { name: 'Remote User', color: '#00ff00' }, // Preserved
    });
  });

  it('should emit update events when the state changes', () => {
    const updateHandler = vi.fn();
    awareness.onUpdate(updateHandler);

    // Simulate peer data
    const peerState: TestAwarenessState = {
      id: 'peer1',
      cursor: { x: 100, y: 100 },
    };

    // Process data
    messageHandler(JSON.stringify(peerState));

    // Should emit update
    expect(updateHandler).toHaveBeenCalledWith([peerState]);
  });

  it('should ignore invalid awareness data', () => {
    const invalidData = 'not json';

    // Initial valid state to verify no changes occur
    const validState: TestAwarenessState = {
      id: 'peer1',
      user: { name: 'Remote User', color: '#00ff00' },
    };

    // Add valid state first
    messageHandler(JSON.stringify(validState));
    expect(awareness.states).toHaveLength(1);

    // Try to process invalid data
    messageHandler(invalidData);

    // State should remain unchanged
    expect(awareness.states).toHaveLength(1);
    expect(awareness.states[0]).toEqual(validState);
  });

  it('should ignore data without an ID', () => {
    const dataWithoutId = JSON.stringify({
      cursor: { x: 100, y: 100 },
    });

    // Process data without ID
    messageHandler(dataWithoutId);

    // Should ignore the data
    expect(awareness.states).toHaveLength(0);
  });

  it('should handle multiple peers correctly', () => {
    // Add multiple peers
    const peer1State: TestAwarenessState = {
      id: 'peer1',
      user: { name: 'Peer 1', color: '#ff0000' },
    };

    const peer2State: TestAwarenessState = {
      id: 'peer2',
      user: { name: 'Peer 2', color: '#00ff00' },
    };

    const peer3State: TestAwarenessState = {
      id: 'peer3',
      user: { name: 'Peer 3', color: '#0000ff' },
    };

    // Add all peers
    messageHandler(JSON.stringify(peer1State));
    messageHandler(JSON.stringify(peer2State));
    messageHandler(JSON.stringify(peer3State));

    // Verify all peers are in the state
    expect(awareness.states).toHaveLength(3);

    // Check ordering by insertion
    expect(awareness.states[0].id).toBe('peer1');
    expect(awareness.states[1].id).toBe('peer2');
    expect(awareness.states[2].id).toBe('peer3');
  });
});
