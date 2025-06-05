import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketTransport } from '../../../src/net/websocket/WebSocketTransport';

// Mock Event classes
class MockEvent {
  type: string;
  constructor(type: string) {
    this.type = type;
  }
}

class MockCloseEvent extends MockEvent {
  code?: number;
  reason?: string;
  constructor(type: string, options?: { code?: number; reason?: string }) {
    super(type);
    this.code = options?.code;
    this.reason = options?.reason;
  }
}

class MockMessageEvent extends MockEvent {
  data: any;
  constructor(type: string, options?: { data?: any }) {
    super(type);
    this.data = options?.data;
  }
}

// Mock WebSocket
function MockWebSocket(this: any, url: string, protocol?: string | string[]) {
  if (!(this instanceof MockWebSocket)) {
    return new (MockWebSocket as any)(url, protocol);
  }
  
  this.url = url;
  this.protocol = protocol;
  this.readyState = MockWebSocket.CONNECTING;
  this.onopen = null;
  this.onclose = null;
  this.onerror = null;
  this.onmessage = null;
  
  // Add methods
  this.send = vi.fn((data: string) => {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
  });

  this.close = vi.fn((code?: number, reason?: string) => {
    this.readyState = MockWebSocket.CLOSING;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new MockCloseEvent('close', { code, reason }));
  });
  
  // Helper methods for testing
  this.simulateOpen = () => {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new MockEvent('open'));
  };

  this.simulateMessage = (data: string) => {
    this.onmessage?.(new MockMessageEvent('message', { data }));
  };

  this.simulateError = () => {
    this.onerror?.(new MockEvent('error'));
  };

  this.simulateClose = (code = 1000, reason = '') => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new MockCloseEvent('close', { code, reason }));
  };
}

MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;

// Mock the online state module
vi.mock('../../../src/net/websocket/onlineState', () => ({
  onlineState: {
    isOffline: false,
    onOnlineChange: vi.fn().mockReturnValue(() => {}),
  },
}));

describe('WebSocketTransport', () => {
  let transport: WebSocketTransport;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock global WebSocket
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as any;
    
    transport = new WebSocketTransport('ws://localhost:8080');
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
    transport.disconnect();
  });

  describe('constructor', () => {
    it('should create transport with URL', () => {
      expect(transport.state).toBe('disconnected');
    });

    it('should create transport with URL and options', () => {
      const transport = new WebSocketTransport('ws://localhost:8080', { protocol: 'patches-v1' });
      expect(transport.state).toBe('disconnected');
    });
  });

  describe('state management', () => {
    it('should start in disconnected state', () => {
      expect(transport.state).toBe('disconnected');
    });

    it('should emit state change events', () => {
      const stateListener = vi.fn();
      transport.onStateChange(stateListener);

      transport.connect();

      expect(stateListener).toHaveBeenCalledWith('connecting');
    });
  });

  describe('connect method', () => {
    it('should transition to connecting state', () => {
      transport.connect();
      expect(transport.state).toBe('connecting');
    });

    it('should create WebSocket with correct URL', () => {
      const spy = vi.spyOn(global, 'WebSocket');
      
      transport.connect();
      
      expect(spy).toHaveBeenCalledWith('ws://localhost:8080', undefined);
    });

    it('should create WebSocket with protocol option', () => {
      const transportWithProtocol = new WebSocketTransport('ws://localhost:8080', { protocol: 'patches-v1' });
      const spy = vi.spyOn(global, 'WebSocket');
      
      transportWithProtocol.connect();
      
      expect(spy).toHaveBeenCalledWith('ws://localhost:8080', 'patches-v1');
    });

    it('should resolve when WebSocket opens', async () => {
      const connectPromise = transport.connect();
      
      // Get the WebSocket instance and simulate opening
      const ws = (transport as any).ws as MockWebSocket;
      ws.simulateOpen();

      await connectPromise;
      expect(transport.state).toBe('connected');
    });

    it('should reject when WebSocket errors during connection', async () => {
      const connectPromise = transport.connect();
      
      const ws = (transport as any).ws as MockWebSocket;
      ws.simulateError();

      try {
        await connectPromise;
        expect.fail('Expected promise to reject');
      } catch (error) {
        // Expected to throw
        expect(transport.state).toBe('error');
      }
    });

    it('should reject when WebSocket closes during connection', async () => {
      const connectPromise = transport.connect();
      
      const ws = (transport as any).ws as MockWebSocket;
      ws.simulateClose();

      try {
        await connectPromise;
        expect.fail('Expected promise to reject');
      } catch (error) {
        expect((error as Error).message).toBe('Connection closed');
        expect(transport.state).toBe('disconnected');
      }
    });
  });

  describe('disconnect method', () => {
    it('should set state to disconnected', () => {
      transport.connect();
      transport.disconnect();

      expect(transport.state).toBe('disconnected');
    });

    it('should call WebSocket close if connected', () => {
      transport.connect();
      const ws = (transport as any).ws as MockWebSocket;
      
      transport.disconnect();

      expect(ws.close).toHaveBeenCalled();
    });
  });

  describe('send method', () => {
    it('should throw error when not connected', () => {
      expect(() => transport.send('test')).toThrow('WebSocket is not connected');
    });

    it('should send data when connected', () => {
      transport.connect();
      const ws = (transport as any).ws as MockWebSocket;
      ws.readyState = MockWebSocket.OPEN;

      transport.send('test message');

      expect(ws.send).toHaveBeenCalledWith('test message');
    });
  });

  describe('message handling', () => {
    it('should emit received messages', () => {
      const messageListener = vi.fn();
      transport.onMessage(messageListener);

      transport.connect();
      const ws = (transport as any).ws as MockWebSocket;
      ws.simulateMessage('test message');

      expect(messageListener).toHaveBeenCalledWith('test message');
    });
  });

  describe('online/offline handling', () => {
    it('should set up online/offline listeners when connecting', async () => {
      const { onlineState } = await import('../../../src/net/websocket/onlineState');
      
      transport.connect();

      expect(onlineState.onOnlineChange).toHaveBeenCalled();
    });

    it('should handle offline state during connect', async () => {
      const { onlineState } = await import('../../../src/net/websocket/onlineState');
      onlineState.isOffline = true;

      const connectPromise = transport.connect();

      // Should create deferred promise but not actually connect
      expect((transport as any).connectionDeferred).toBeTruthy();
      expect(transport.state).toBe('disconnected');
      
      // Clean up
      onlineState.isOffline = false;
    });
  });

  describe('error handling', () => {
    it('should handle WebSocket constructor errors', async () => {
      global.WebSocket = class {
        constructor() {
          throw new Error('WebSocket constructor failed');
        }
      } as any;

      const transport = new WebSocketTransport('ws://localhost:8080');
      const connectPromise = transport.connect();

      await expect(connectPromise).rejects.toThrow('WebSocket constructor failed');
      expect(transport.state).toBe('error');
    });

    it('should log errors', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const connectPromise = transport.connect();
      const ws = (transport as any).ws as MockWebSocket;
      ws.simulateError();

      // Properly handle the promise to prevent unhandled rejection
      try {
        await connectPromise;
      } catch {
        // Expected to fail
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith('WebSocket error:', expect.any(MockEvent));
      
      consoleErrorSpy.mockRestore();
    });
  });
});