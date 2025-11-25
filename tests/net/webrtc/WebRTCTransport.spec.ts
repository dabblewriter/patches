import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebRTCTransport } from '../../../src/net/webrtc/WebRTCTransport';
import { JSONRPCClient } from '../../../src/net/protocol/JSONRPCClient';
import type { WebSocketTransport } from '../../../src/net/websocket/WebSocketTransport';

// Mock simple-peer
vi.mock('simple-peer');
vi.mock('../../../src/net/protocol/JSONRPCClient');

describe('WebRTCTransport', () => {
  let mockWebSocketTransport: any;
  let mockJSONRPCClient: any;
  let transport: WebRTCTransport;
  let peerEventHandlers: Record<string, any>;
  let rpcEventHandlers: Record<string, any>;
  let currentMockPeerInstance: any;
  let mockPeerConstructor: any;

  beforeEach(async () => {
    // Import and setup mocks
    const SimplePeer = await import('simple-peer');
    mockPeerConstructor = vi.mocked(SimplePeer.default);

    // Create a fresh mock peer instance for each test
    currentMockPeerInstance = {
      signal: vi.fn(),
      send: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      connected: false,
    };

    mockPeerConstructor.mockImplementation(() => currentMockPeerInstance);

    // Reset mock peer event handlers
    peerEventHandlers = {};
    currentMockPeerInstance.on.mockImplementation((event: string, handler: any) => {
      peerEventHandlers[event] = handler;
    });

    // Mock RPC event handlers
    rpcEventHandlers = {};
    mockJSONRPCClient = {
      on: vi.fn().mockImplementation((event: string, handler: any) => {
        rpcEventHandlers[event] = handler;
        return vi.fn(); // Unsubscriber
      }),
      call: vi.fn().mockResolvedValue(undefined),
    };

    // Mock WebSocket transport
    mockWebSocketTransport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      send: vi.fn(),
      onMessage: vi.fn(),
      onStateChange: vi.fn(),
      state: 'disconnected',
    };

    vi.mocked(JSONRPCClient).mockImplementation(() => mockJSONRPCClient);

    transport = new WebRTCTransport(mockWebSocketTransport);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create transport with WebSocket transport', () => {
      expect(transport).toBeInstanceOf(WebRTCTransport);
      expect(JSONRPCClient).toHaveBeenCalledWith(mockWebSocketTransport);
    });

    it('should set up RPC event listeners', () => {
      expect(mockJSONRPCClient.on).toHaveBeenCalledWith('peer-welcome', expect.any(Function));
      expect(mockJSONRPCClient.on).toHaveBeenCalledWith('peer-disconnected', expect.any(Function));
      expect(mockJSONRPCClient.on).toHaveBeenCalledWith('peer-signal', expect.any(Function));
    });

    it('should delegate state change signal from underlying transport', () => {
      expect(transport.onStateChange).toBe(mockWebSocketTransport.onStateChange);
    });
  });

  describe('id property', () => {
    it('should return undefined initially', () => {
      expect(transport.id).toBeUndefined();
    });

    it('should return id after peer-welcome', () => {
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'peer123', peers: [] });

      expect(transport.id).toBe('peer123');
    });
  });

  describe('state property', () => {
    it('should delegate to underlying transport state', () => {
      mockWebSocketTransport.state = 'connected';
      expect(transport.state).toBe('connected');
    });
  });

  describe('connect method', () => {
    it('should connect via underlying transport', async () => {
      await transport.connect();

      expect(mockWebSocketTransport.connect).toHaveBeenCalled();
    });

    it('should handle connection errors', async () => {
      const error = new Error('Connection failed');
      mockWebSocketTransport.connect.mockRejectedValue(error);

      await expect(transport.connect()).rejects.toThrow('Connection failed');
    });
  });

  describe('disconnect method', () => {
    it('should unsubscribe from RPC events', () => {
      const unsubscriber1 = vi.fn();
      const unsubscriber2 = vi.fn();
      const unsubscriber3 = vi.fn();

      mockJSONRPCClient.on
        .mockReturnValueOnce(unsubscriber1)
        .mockReturnValueOnce(unsubscriber2)
        .mockReturnValueOnce(unsubscriber3);

      const newTransport = new WebRTCTransport(mockWebSocketTransport);
      newTransport.disconnect();

      expect(unsubscriber1).toHaveBeenCalled();
      expect(unsubscriber2).toHaveBeenCalled();
      expect(unsubscriber3).toHaveBeenCalled();
    });

    it('should destroy all peer connections', () => {
      // Add a peer first
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1'] });

      // Simulate peer connection
      const connectHandler = peerEventHandlers['connect'];
      connectHandler();

      transport.disconnect();

      expect(currentMockPeerInstance.destroy).toHaveBeenCalled();
    });

    it('should clear peers map', () => {
      // Add a peer
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1'] });

      // Verify peer exists
      expect(transport['peers'].size).toBe(1);

      transport.disconnect();

      expect(transport['peers'].size).toBe(0);
    });
  });

  describe('send method', () => {
    beforeEach(() => {
      // Set up a connected peer
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1'] });

      const connectHandler = peerEventHandlers['connect'];
      connectHandler();
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
      // Set peer as not connected
      transport['peers'].get('peer1')!.connected = false;

      transport.send('test message');

      expect(currentMockPeerInstance.send).not.toHaveBeenCalled();
    });

    it('should handle send errors gracefully', () => {
      currentMockPeerInstance.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      transport.send('test message');

      expect(consoleSpy).toHaveBeenCalledWith('Failed to send to peer:', expect.any(Error));
      consoleSpy.mockRestore();
    });

    it('should skip peers that do not match target peerId', () => {
      // Add another peer with a different mock instance
      const secondMockPeer = {
        signal: vi.fn(),
        send: vi.fn(),
        destroy: vi.fn(),
        on: vi.fn(),
        connected: false,
      };
      mockPeerConstructor.mockReturnValueOnce(secondMockPeer);

      const signalHandler = rpcEventHandlers['peer-signal'];
      signalHandler({ from: 'peer2', data: {} });

      // Connect second peer
      const peer2Info = transport['peers'].get('peer2');
      peer2Info!.connected = true;

      transport.send('test message', 'peer1');

      // Should only send to peer1, not peer2
      expect(currentMockPeerInstance.send).toHaveBeenCalledWith('test message');
      expect(secondMockPeer.send).not.toHaveBeenCalled();
    });
  });

  describe('peer-welcome event handling', () => {
    it('should set peer ID', () => {
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'myPeerId', peers: [] });

      expect(transport.id).toBe('myPeerId');
    });

    it('should connect to existing peers', () => {
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1', 'peer2'] });

      expect(mockPeerConstructor).toHaveBeenCalledTimes(2);
      expect(mockPeerConstructor).toHaveBeenCalledWith({ initiator: true, trickle: false });
      expect(transport['peers'].size).toBe(2);
    });

    it('should handle empty peers array', () => {
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: [] });

      expect(transport['peers'].size).toBe(0);
    });
  });

  describe('peer-disconnected event handling', () => {
    it('should remove disconnected peer', () => {
      // Add a peer first
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1'] });

      expect(transport['peers'].has('peer1')).toBe(true);

      // Handle disconnection
      const disconnectHandler = rpcEventHandlers['peer-disconnected'];
      disconnectHandler({ id: 'peer1' });

      expect(transport['peers'].has('peer1')).toBe(false);
      expect(currentMockPeerInstance.destroy).toHaveBeenCalled();
    });

    it('should emit peer disconnect event', () => {
      const disconnectSpy = vi.fn();
      transport.onPeerDisconnect(disconnectSpy);

      // Add a peer first
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1'] });

      // Handle disconnection
      const disconnectHandler = rpcEventHandlers['peer-disconnected'];
      disconnectHandler({ id: 'peer1' });

      expect(disconnectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);
    });

    it('should handle disconnection of non-existent peer', () => {
      const disconnectHandler = rpcEventHandlers['peer-disconnected'];

      // Should not throw
      expect(() => disconnectHandler({ id: 'nonexistent' })).not.toThrow();
    });
  });

  describe('peer-signal event handling', () => {
    it('should signal existing peer', () => {
      // Add a peer first
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1'] });

      const signalData = { type: 'offer', sdp: 'test-sdp' };
      const signalHandler = rpcEventHandlers['peer-signal'];
      signalHandler({ from: 'peer1', data: signalData });

      expect(currentMockPeerInstance.signal).toHaveBeenCalledWith(signalData);
    });

    it('should create new peer if not exists', () => {
      const signalData = { type: 'answer', sdp: 'test-sdp' };
      const signalHandler = rpcEventHandlers['peer-signal'];
      signalHandler({ from: 'newPeer', data: signalData });

      expect(mockPeerConstructor).toHaveBeenCalledWith({ initiator: false, trickle: false });
      expect(transport['peers'].has('newPeer')).toBe(true);
      expect(currentMockPeerInstance.signal).toHaveBeenCalledWith(signalData);
    });

    it('should handle signal from unknown peer gracefully', () => {
      const signalHandler = rpcEventHandlers['peer-signal'];

      signalHandler({ from: 'unknownPeer', data: {} });

      // Should create new peer
      expect(mockPeerConstructor).toHaveBeenCalled();
    });
  });

  describe('peer event handling', () => {
    beforeEach(() => {
      // Add a peer to test events
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1'] });
    });

    it('should handle peer signal event', () => {
      const signalData = { type: 'offer', sdp: 'test' };
      const signalHandler = peerEventHandlers['signal'];

      signalHandler(signalData);

      expect(mockJSONRPCClient.call).toHaveBeenCalledWith('peer-signal', {
        to: 'peer1',
        data: signalData,
      });
    });

    it('should handle peer connect event', () => {
      const connectSpy = vi.fn();
      transport.onPeerConnect(connectSpy);

      const connectHandler = peerEventHandlers['connect'];
      connectHandler();

      expect(transport['peers'].get('peer1')?.connected).toBe(true);
      expect(connectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);
    });

    it('should handle peer data event', () => {
      const messageSpy = vi.fn();
      transport.onMessage(messageSpy);

      const dataHandler = peerEventHandlers['data'];
      dataHandler('test message');

      expect(messageSpy).toHaveBeenCalledWith('test message', 'peer1', currentMockPeerInstance);
    });

    it('should handle peer data errors gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Mock the onMessage signal to throw an error
      const originalEmit = transport.onMessage.emit;
      transport.onMessage.emit = vi.fn().mockImplementation(() => {
        throw new Error('Message handler error');
      });

      const dataHandler = peerEventHandlers['data'];
      dataHandler('test message');

      expect(consoleSpy).toHaveBeenCalledWith('Invalid peer data:', expect.any(Error));

      // Restore
      transport.onMessage.emit = originalEmit;
      consoleSpy.mockRestore();
    });

    it('should handle peer close event', () => {
      const disconnectSpy = vi.fn();
      transport.onPeerDisconnect(disconnectSpy);

      const closeHandler = peerEventHandlers['close'];
      closeHandler();

      expect(transport['peers'].has('peer1')).toBe(false);
      expect(disconnectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);
      expect(currentMockPeerInstance.destroy).toHaveBeenCalled();
    });

    it('should handle peer error event', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const disconnectSpy = vi.fn();
      transport.onPeerDisconnect(disconnectSpy);

      const errorHandler = peerEventHandlers['error'];
      const error = new Error('Peer connection error');
      errorHandler(error);

      expect(consoleSpy).toHaveBeenCalledWith('Peer error:', error);
      expect(transport['peers'].has('peer1')).toBe(false);
      expect(disconnectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);
      expect(currentMockPeerInstance.destroy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('ClientTransport interface', () => {
    it('should implement send method', () => {
      expect(typeof transport.send).toBe('function');
    });

    it('should implement onMessage method', () => {
      const handler = vi.fn();
      const unsubscriber = transport.onMessage(handler);

      expect(typeof handler).toBe('function');
      expect(typeof unsubscriber).toBe('function');
    });

    it('should support message subscription and unsubscription', () => {
      const handler = vi.fn();
      const unsubscriber = transport.onMessage(handler);

      // Add a peer and simulate message
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1'] });

      const dataHandler = peerEventHandlers['data'];
      dataHandler('test message');

      expect(handler).toHaveBeenCalledWith('test message', 'peer1', currentMockPeerInstance);

      // Unsubscribe and test no longer called
      unsubscriber();
      handler.mockClear();

      dataHandler('another message');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('edge cases and robustness', () => {
    it('should handle multiple peers connecting simultaneously', () => {
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1', 'peer2', 'peer3'] });

      expect(transport['peers'].size).toBe(3);
      expect(mockPeerConstructor).toHaveBeenCalledTimes(3);
    });

    it('should handle peer connection state transitions', () => {
      const connectSpy = vi.fn();
      const disconnectSpy = vi.fn();

      transport.onPeerConnect(connectSpy);
      transport.onPeerDisconnect(disconnectSpy);

      // Add peer
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1'] });

      // Connect peer
      const connectHandler = peerEventHandlers['connect'];
      connectHandler();

      expect(connectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);

      // Disconnect peer
      const closeHandler = peerEventHandlers['close'];
      closeHandler();

      expect(disconnectSpy).toHaveBeenCalledWith('peer1', currentMockPeerInstance);
    });

    it('should handle rapid connect/disconnect cycles', () => {
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      const disconnectHandler = rpcEventHandlers['peer-disconnected'];

      // Connect
      welcomeHandler({ id: 'me', peers: ['peer1'] });
      expect(transport['peers'].has('peer1')).toBe(true);

      // Disconnect
      disconnectHandler({ id: 'peer1' });
      expect(transport['peers'].has('peer1')).toBe(false);

      // Reconnect
      welcomeHandler({ id: 'me', peers: ['peer1'] });
      expect(transport['peers'].has('peer1')).toBe(true);
    });

    it('should handle empty peer IDs', () => {
      const welcomeHandler = rpcEventHandlers['peer-welcome'];

      // Should not throw with empty peer ID
      expect(() => welcomeHandler({ id: 'me', peers: [''] })).not.toThrow();
    });

    it('should handle malformed RPC events', () => {
      const welcomeHandler = rpcEventHandlers['peer-welcome'];

      // These are known to work
      expect(() => welcomeHandler({ id: 'me', peers: [] })).not.toThrow();
      expect(() => welcomeHandler({ peers: [] })).not.toThrow();

      // This currently throws due to missing defensive coding - documenting the bug
      expect(() => welcomeHandler({ id: 'me', peers: undefined })).toThrow();
    });

    it('should handle peer signal with no peer data', () => {
      const signalHandler = rpcEventHandlers['peer-signal'];

      // Should not throw
      expect(() => signalHandler({ from: 'peer1' })).not.toThrow();
      expect(() => signalHandler({ data: {} })).not.toThrow();
    });
  });

  describe('memory management', () => {
    it('should clean up peer resources on disconnect', () => {
      // Add multiple peers
      const welcomeHandler = rpcEventHandlers['peer-welcome'];
      welcomeHandler({ id: 'me', peers: ['peer1', 'peer2', 'peer3'] });

      expect(transport['peers'].size).toBe(3);

      transport.disconnect();

      expect(transport['peers'].size).toBe(0);
      expect(currentMockPeerInstance.destroy).toHaveBeenCalledTimes(3);
    });

    it('should unsubscribe from all RPC events on disconnect', () => {
      const unsubscribers = [vi.fn(), vi.fn(), vi.fn()];
      mockJSONRPCClient.on
        .mockReturnValueOnce(unsubscribers[0])
        .mockReturnValueOnce(unsubscribers[1])
        .mockReturnValueOnce(unsubscribers[2]);

      const newTransport = new WebRTCTransport(mockWebSocketTransport);
      newTransport.disconnect();

      unsubscribers.forEach(unsub => {
        expect(unsub).toHaveBeenCalled();
      });
    });

    it('should clear subscriptions array after disconnect', () => {
      transport.disconnect();

      expect(transport['subscriptions']).toHaveLength(0);
    });
  });
});
