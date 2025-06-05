import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebRTCAwareness } from '../../../src/net/webrtc/WebRTCAwareness';
import type { WebRTCTransport } from '../../../src/net/webrtc/WebRTCTransport';

describe('WebRTCAwareness', () => {
  let mockTransport: any;
  let awareness: WebRTCAwareness;
  let transportEventHandlers: Record<string, any>;

  beforeEach(() => {
    transportEventHandlers = {};

    mockTransport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      send: vi.fn(),
      onPeerConnect: vi.fn().mockImplementation((handler: any) => {
        transportEventHandlers['peerConnect'] = handler;
        return vi.fn(); // Unsubscriber
      }),
      onPeerDisconnect: vi.fn().mockImplementation((handler: any) => {
        transportEventHandlers['peerDisconnect'] = handler;
        return vi.fn(); // Unsubscriber
      }),
      onMessage: vi.fn().mockImplementation((handler: any) => {
        transportEventHandlers['message'] = handler;
        return vi.fn(); // Unsubscriber
      }),
      id: undefined,
    };

    awareness = new WebRTCAwareness(mockTransport);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create awareness instance with transport', () => {
      expect(awareness).toBeInstanceOf(WebRTCAwareness);
    });

    it('should set up transport event listeners', () => {
      expect(mockTransport.onPeerConnect).toHaveBeenCalledWith(expect.any(Function));
      expect(mockTransport.onPeerDisconnect).toHaveBeenCalledWith(expect.any(Function));
      expect(mockTransport.onMessage).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should initialize with empty states', () => {
      expect(awareness.states).toEqual([]);
    });

    it('should initialize with empty local state', () => {
      expect(awareness.localState).toEqual({});
    });
  });

  describe('connect method', () => {
    it('should delegate to transport connect', async () => {
      await awareness.connect();

      expect(mockTransport.connect).toHaveBeenCalled();
    });

    it('should set myId from transport after connection', async () => {
      mockTransport.id = 'test-peer-id';

      await awareness.connect();

      expect(awareness['myId']).toBe('test-peer-id');
    });

    it('should handle connection errors', async () => {
      const error = new Error('Connection failed');
      mockTransport.connect.mockRejectedValue(error);

      await expect(awareness.connect()).rejects.toThrow('Connection failed');
    });
  });

  describe('disconnect method', () => {
    it('should delegate to transport disconnect', () => {
      awareness.disconnect();

      expect(mockTransport.disconnect).toHaveBeenCalled();
    });
  });

  describe('states property', () => {
    it('should return current states', () => {
      const testStates = [{ id: 'peer1', data: 'test' }];
      awareness['_states'] = testStates;

      expect(awareness.states).toBe(testStates);
    });

    it('should emit onUpdate signal when states are set', () => {
      const updateSpy = vi.fn();
      awareness.onUpdate(updateSpy);

      const newStates = [{ id: 'peer1', data: 'test' }];
      awareness['states'] = newStates;

      expect(updateSpy).toHaveBeenCalledWith(newStates);
    });

    it('should update internal states when set', () => {
      const newStates = [{ id: 'peer1', data: 'test' }];
      awareness['states'] = newStates;

      expect(awareness['_states']).toBe(newStates);
    });
  });

  describe('localState property', () => {
    beforeEach(() => {
      awareness['myId'] = 'my-peer-id';
    });

    it('should return current local state', () => {
      const testState = { data: 'test' };
      awareness['_localState'] = testState;

      expect(awareness.localState).toBe(testState);
    });

    it('should set local state and add peer ID', () => {
      const newState = { data: 'test' };
      awareness.localState = newState;

      expect(awareness['_localState']).toEqual({ data: 'test', id: 'my-peer-id' });
    });

    it('should broadcast local state when set', () => {
      const newState = { data: 'test' };
      awareness.localState = newState;

      expect(mockTransport.send).toHaveBeenCalledWith(JSON.stringify({ data: 'test', id: 'my-peer-id' }));
    });

    it('should handle setting state before peer ID is available', () => {
      awareness['myId'] = undefined;
      const newState = { data: 'test' };

      expect(() => {
        awareness.localState = newState;
      }).not.toThrow();
    });
  });

  describe('_addPeer method', () => {
    beforeEach(() => {
      awareness['myId'] = 'my-peer-id';
    });

    it('should send local state to new peer if local state exists', () => {
      awareness['_localState'] = { id: 'my-peer-id', data: 'test' };

      const addPeerHandler = transportEventHandlers['peerConnect'];
      addPeerHandler('new-peer-id');

      expect(mockTransport.send).toHaveBeenCalledWith(
        JSON.stringify({ id: 'my-peer-id', data: 'test' }),
        'new-peer-id'
      );
    });

    it('should not send local state if local state has no id', () => {
      awareness['_localState'] = { data: 'test' }; // No id

      const addPeerHandler = transportEventHandlers['peerConnect'];
      addPeerHandler('new-peer-id');

      expect(mockTransport.send).not.toHaveBeenCalled();
    });

    it('should not send local state if local state is empty', () => {
      awareness['_localState'] = {};

      const addPeerHandler = transportEventHandlers['peerConnect'];
      addPeerHandler('new-peer-id');

      expect(mockTransport.send).not.toHaveBeenCalled();
    });
  });

  describe('_removePeer method', () => {
    it('should remove peer state from states array', () => {
      const states = [
        { id: 'peer1', data: 'test1' },
        { id: 'peer2', data: 'test2' },
        { id: 'peer3', data: 'test3' },
      ];
      awareness['_states'] = states;

      const removePeerHandler = transportEventHandlers['peerDisconnect'];
      removePeerHandler('peer2');

      expect(awareness.states).toEqual([
        { id: 'peer1', data: 'test1' },
        { id: 'peer3', data: 'test3' },
      ]);
    });

    it('should emit onUpdate when peer is removed', () => {
      const updateSpy = vi.fn();
      awareness.onUpdate(updateSpy);

      const states = [{ id: 'peer1', data: 'test1' }];
      awareness['_states'] = states;

      const removePeerHandler = transportEventHandlers['peerDisconnect'];
      removePeerHandler('peer1');

      expect(updateSpy).toHaveBeenCalledWith([]);
    });

    it('should handle removing non-existent peer', () => {
      const states = [{ id: 'peer1', data: 'test1' }];
      awareness['_states'] = states;

      const removePeerHandler = transportEventHandlers['peerDisconnect'];
      removePeerHandler('non-existent-peer');

      expect(awareness.states).toEqual(states);
    });

    it('should handle removing from empty states', () => {
      awareness['_states'] = [];

      const removePeerHandler = transportEventHandlers['peerDisconnect'];

      expect(() => removePeerHandler('peer1')).not.toThrow();
      expect(awareness.states).toEqual([]);
    });
  });

  describe('_receiveData method', () => {
    it('should parse and add new peer state', () => {
      const peerState = { id: 'peer1', data: 'test' };

      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler(JSON.stringify(peerState));

      expect(awareness.states).toEqual([peerState]);
    });

    it('should update existing peer state', () => {
      const initialStates = [{ id: 'peer1', data: 'old', other: 'keep' }];
      awareness['_states'] = initialStates;

      const updatedState = { id: 'peer1', data: 'new' };

      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler(JSON.stringify(updatedState));

      expect(awareness.states).toEqual([{ id: 'peer1', data: 'new', other: 'keep' }]);
    });

    it('should emit onUpdate when state is received', () => {
      const updateSpy = vi.fn();
      awareness.onUpdate(updateSpy);

      const peerState = { id: 'peer1', data: 'test' };

      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler(JSON.stringify(peerState));

      expect(updateSpy).toHaveBeenCalledWith([peerState]);
    });

    it('should handle invalid JSON gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler('invalid json');

      expect(consoleSpy).toHaveBeenCalledWith('Invalid peer data:', expect.any(Error));
      expect(awareness.states).toEqual([]);

      consoleSpy.mockRestore();
    });

    it('should ignore data without peer ID', () => {
      const peerState = { data: 'test' }; // No id

      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler(JSON.stringify(peerState));

      expect(awareness.states).toEqual([]);
    });

    it('should ignore null data', () => {
      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler(JSON.stringify(null));

      expect(awareness.states).toEqual([]);
    });

    it('should ignore undefined data', () => {
      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler(JSON.stringify(undefined));

      expect(awareness.states).toEqual([]);
    });

    it('should handle empty string data', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler('');

      expect(consoleSpy).toHaveBeenCalledWith('Invalid peer data:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  describe('onUpdate signal', () => {
    it('should allow subscribing to state updates', () => {
      const updateSpy = vi.fn();
      const unsubscriber = awareness.onUpdate(updateSpy);

      expect(typeof unsubscriber).toBe('function');
    });

    it('should emit updates when states change', () => {
      const updateSpy = vi.fn();
      awareness.onUpdate(updateSpy);

      const newStates = [{ id: 'peer1', data: 'test' }];
      awareness['states'] = newStates;

      expect(updateSpy).toHaveBeenCalledWith(newStates);
    });

    it('should allow unsubscribing from updates', () => {
      const updateSpy = vi.fn();
      const unsubscriber = awareness.onUpdate(updateSpy);

      // First update should trigger
      awareness['states'] = [{ id: 'peer1', data: 'test' }];
      expect(updateSpy).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscriber();
      updateSpy.mockClear();

      // Second update should not trigger
      awareness['states'] = [{ id: 'peer2', data: 'test2' }];
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe('edge cases and integration', () => {
    it('should handle multiple peer states correctly', () => {
      const receiveDataHandler = transportEventHandlers['message'];

      receiveDataHandler(JSON.stringify({ id: 'peer1', data: 'test1' }));
      receiveDataHandler(JSON.stringify({ id: 'peer2', data: 'test2' }));
      receiveDataHandler(JSON.stringify({ id: 'peer3', data: 'test3' }));

      expect(awareness.states).toHaveLength(3);
      expect(awareness.states.map(s => s.id)).toEqual(['peer1', 'peer2', 'peer3']);
    });

    it('should handle peer reconnection correctly', () => {
      const receiveDataHandler = transportEventHandlers['message'];
      const removePeerHandler = transportEventHandlers['peerDisconnect'];

      // Add peer
      receiveDataHandler(JSON.stringify({ id: 'peer1', data: 'initial' }));
      expect(awareness.states).toHaveLength(1);

      // Remove peer
      removePeerHandler('peer1');
      expect(awareness.states).toHaveLength(0);

      // Re-add peer
      receiveDataHandler(JSON.stringify({ id: 'peer1', data: 'reconnected' }));
      expect(awareness.states).toEqual([{ id: 'peer1', data: 'reconnected' }]);
    });

    it('should maintain state consistency during rapid updates', () => {
      const receiveDataHandler = transportEventHandlers['message'];

      // Rapid updates from same peer
      receiveDataHandler(JSON.stringify({ id: 'peer1', data: 'v1' }));
      receiveDataHandler(JSON.stringify({ id: 'peer1', data: 'v2' }));
      receiveDataHandler(JSON.stringify({ id: 'peer1', data: 'v3' }));

      expect(awareness.states).toHaveLength(1);
      expect(awareness.states[0].data).toBe('v3');
    });

    it('should handle complex state objects', () => {
      const complexState = {
        id: 'peer1',
        cursor: { line: 5, column: 10 },
        selection: { start: { line: 1, column: 0 }, end: { line: 3, column: 5 } },
        user: { name: 'John Doe', color: '#ff0000' },
        metadata: { timestamp: Date.now(), version: '1.0.0' },
      };

      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler(JSON.stringify(complexState));

      expect(awareness.states[0]).toEqual(complexState);
    });

    it('should preserve existing properties when updating peer state', () => {
      const receiveDataHandler = transportEventHandlers['message'];

      // Initial state
      receiveDataHandler(
        JSON.stringify({
          id: 'peer1',
          cursor: { line: 1, column: 1 },
          user: { name: 'John' },
        })
      );

      // Partial update (should preserve user info)
      receiveDataHandler(
        JSON.stringify({
          id: 'peer1',
          cursor: { line: 5, column: 10 },
        })
      );

      expect(awareness.states[0]).toEqual({
        id: 'peer1',
        cursor: { line: 5, column: 10 },
        user: { name: 'John' },
      });
    });
  });

  describe('memory management', () => {
    it('should clean up resources when transport disconnects', () => {
      const updateSpy = vi.fn();
      awareness.onUpdate(updateSpy);

      // Add some state
      const receiveDataHandler = transportEventHandlers['message'];
      receiveDataHandler(JSON.stringify({ id: 'peer1', data: 'test' }));

      expect(awareness.states).toHaveLength(1);

      // Disconnect should be handled by transport
      awareness.disconnect();

      expect(mockTransport.disconnect).toHaveBeenCalled();
    });

    it('should handle transport event handler cleanup', () => {
      // The transport should handle unsubscribing when disconnect is called
      awareness.disconnect();

      expect(mockTransport.disconnect).toHaveBeenCalled();
    });
  });

  describe('TypeScript typing', () => {
    it('should work with typed awareness states', () => {
      interface TestAwarenessState {
        id: string;
        cursor: { line: number; column: number };
        user: { name: string; color: string };
      }

      const typedAwareness = new WebRTCAwareness<TestAwarenessState>(mockTransport);

      expect(typedAwareness).toBeInstanceOf(WebRTCAwareness);
      expect(typedAwareness.states).toEqual([]);
    });
  });
});
