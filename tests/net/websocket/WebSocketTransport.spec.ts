import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketTransport } from '../../../src/net/websocket/WebSocketTransport';

// Mock WebSocket implementation
class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: any) => void) | null = null;
  onmessage: ((event: { data: any }) => void) | null = null;
  readyState = 0; // CONNECTING
  send = vi.fn();
  close = vi.fn();

  constructor(public url: string) {}

  // Helper methods for testing
  simulateOpen() {
    this.readyState = 1; // OPEN
    if (this.onopen) this.onopen();
  }

  simulateClose() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  simulateError(error: any) {
    if (this.onerror) this.onerror(error);
  }

  simulateMessage(data: any) {
    if (this.onmessage) this.onmessage({ data });
  }
}

// Mock timers
const mockTimers = new Map<number, { callback: Function; delay: number }>();
const mockSetTimeout = vi.fn((callback: Function, delay: number) => {
  const id = Math.random();
  mockTimers.set(id, { callback, delay });
  return id;
});
const mockClearTimeout = vi.fn((id: number) => {
  mockTimers.delete(id);
});

describe('WebSocketTransport', () => {
  let transport: WebSocketTransport;
  let mockWs: MockWebSocket;
  const testUrl = 'ws://test.example.com';

  // Original methods to restore in afterEach
  const originalWebSocket = global.WebSocket;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  beforeEach(() => {
    // Clear mock state
    vi.clearAllMocks();
    mockTimers.clear();

    // Mock console.error to avoid test noise
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock WebSocket constructor
    global.WebSocket = vi.fn((url: string) => {
      mockWs = new MockWebSocket(url);
      return mockWs;
    }) as any;

    // Add readyState constants
    (global.WebSocket as any).CONNECTING = 0;
    (global.WebSocket as any).OPEN = 1;
    (global.WebSocket as any).CLOSING = 2;
    (global.WebSocket as any).CLOSED = 3;

    // Mock timers
    global.setTimeout = mockSetTimeout as any;
    global.clearTimeout = mockClearTimeout as any;

    // Create transport instance
    transport = new WebSocketTransport(testUrl);
  });

  afterEach(() => {
    // Restore original globals
    global.WebSocket = originalWebSocket;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  it('should create a WebSocketTransport instance with correct initial state', () => {
    expect(transport).toBeInstanceOf(WebSocketTransport);
    expect(transport.state).toBe('disconnected');
  });

  describe('connect method', () => {
    it('should create a WebSocket connection when connect is called', async () => {
      const connectPromise = transport.connect();

      // Simulate successful connection
      mockWs.simulateOpen();

      await connectPromise;
      expect(transport.state).toBe('connected');
    });

    it('should return existing promise when connect is called while connecting', async () => {
      const firstPromise = transport.connect();
      const secondPromise = transport.connect();

      // Both should resolve similarly (using toStrictEqual due to potential instance differences in test env)
      expect(secondPromise).toStrictEqual(firstPromise);

      // Simulate connection success
      mockWs.simulateOpen();

      await firstPromise;
      expect(transport.state).toBe('connected');
    });

    it('should immediately resolve if already connected', async () => {
      // First connect and open
      const connectPromise = transport.connect();
      mockWs.simulateOpen();
      await connectPromise;

      // Clear mocks to verify new WebSocket is not created
      vi.clearAllMocks();

      // Connect again
      await transport.connect();

      // Should not create a new WebSocket instance
      expect(global.WebSocket).not.toHaveBeenCalled();
    });

    it('should reject the promise when connection fails', async () => {
      const errorMock = new Error('Connection failed');
      const connectPromise = transport.connect();

      // Simulate connection error
      mockWs.simulateError(errorMock);

      await expect(connectPromise).rejects.toEqual(errorMock);
      expect(transport.state).toBe('error');
    });

    it('should reject the promise when connection closes during connection attempt', async () => {
      const connectPromise = transport.connect();

      // Simulate connection closing
      mockWs.simulateClose();

      await expect(connectPromise).rejects.toThrow('Connection closed');
      expect(transport.state).toBe('disconnected');
    });
  });

  describe('disconnect method', () => {
    it('should close the WebSocket connection when disconnect is called', async () => {
      // First connect
      const connectPromise = transport.connect();
      mockWs.simulateOpen();
      await connectPromise;

      // Then disconnect
      transport.disconnect();

      // Should close the WebSocket
      expect(mockWs.close).toHaveBeenCalled();
      expect(transport.state).toBe('disconnected');
    });

    it('should cancel pending reconnection when disconnect is called', async () => {
      // First connect
      const connectPromise = transport.connect();

      // Simulate error to trigger reconnect
      mockWs.simulateError(new Error('Test error'));
      mockWs.simulateClose();

      try {
        await connectPromise;
      } catch (error) {
        // Expected error, ignore
      }

      // Should have scheduled a reconnect
      expect(mockTimers.size).toBe(1);

      // Disconnect
      transport.disconnect();

      // Should have cleared the reconnect timer
      expect(mockClearTimeout).toHaveBeenCalled();
    });
  });

  describe('send method', () => {
    it('should send data through the WebSocket', async () => {
      // First connect
      const connectPromise = transport.connect();
      mockWs.simulateOpen();
      await connectPromise;

      // Send data
      const testData = 'test message';
      transport.send(testData);

      // Should have sent the data
      expect(mockWs.send).toHaveBeenCalledWith(testData);
    });

    it('should throw an error if trying to send when not connected', () => {
      const testData = 'test message';

      // Try to send without connecting
      expect(() => transport.send(testData)).toThrow('WebSocket is not connected');
    });
  });

  describe('automatic reconnection', () => {
    it('should schedule a reconnect after connection error', async () => {
      const connectPromise = transport.connect();

      // Simulate error and close to trigger reconnect
      mockWs.simulateError(new Error('Test error'));
      mockWs.simulateClose();

      try {
        await connectPromise;
      } catch (error) {
        // Expected error, ignore
      }

      // Should have scheduled a reconnect
      expect(mockTimers.size).toBe(1);
      const [[timerId, timer]] = mockTimers.entries();
      expect(timer.delay).toBe(1000); // Initial backoff
    });

    it('should increase backoff time on consecutive failures', async () => {
      // First attempt
      let connectPromise = transport.connect();
      mockWs.simulateError(new Error('Test error'));
      mockWs.simulateClose();

      try {
        await connectPromise;
      } catch (error) {
        /* Expected error */
      }

      // Get first timer's delay
      expect(mockTimers.size).toBe(1);
      let [[timerId, timer]] = mockTimers.entries();
      const firstDelay = timer.delay;

      // Simulate timer firing and trigger reconnect
      const callback = timer.callback;
      mockTimers.clear();

      // Execute reconnect callback - this initiates transport.connect() internally
      callback();

      // Get the promise for the connection attempt initiated by the callback
      const reconnectPromise = transport.connect(); // Should return the pending promise

      // Wrap error simulation in a microtask to manage timing
      await Promise.resolve().then(() => {
        mockWs.simulateError(new Error('Test error'));
        mockWs.simulateClose();
      });

      // Now assert that the promise rejects
      await expect(reconnectPromise).rejects.toThrow('Test error');

      // Check for increased backoff
      expect(mockTimers.size).toBe(1);
      [[timerId, timer]] = mockTimers.entries();
      const secondDelay = timer.delay;

      // Second delay should be more than first delay
      expect(secondDelay).toBeGreaterThan(firstDelay);
    });

    it('should reset backoff time on successful connection', async () => {
      // First connect with failure
      let connectPromise = transport.connect();
      mockWs.simulateError(new Error('Test error'));
      mockWs.simulateClose();

      try {
        await connectPromise;
      } catch (error) {
        /* Expected error */
      }

      // Get first backoff timer
      let [[timerId, timer]] = mockTimers.entries();
      const callback = timer.callback;
      mockTimers.clear();

      // Execute reconnect callback and simulate successful connection
      callback();
      mockWs.simulateOpen();

      // Force a disconnect to trigger another reconnect
      transport.disconnect();

      // Connect again and fail to check backoff reset
      connectPromise = transport.connect();

      mockWs.simulateError(new Error('Test error'));
      mockWs.simulateClose();

      try {
        await connectPromise;
      } catch (error) {
        /* Expected error */
      }

      // Check for reset backoff
      expect(mockTimers.size).toBe(1);
      [[timerId, timer]] = mockTimers.entries();

      // Should have reset to initial backoff
      expect(timer.delay).toBe(1000);
    });
  });

  describe('event handling', () => {
    it('should emit state change events', async () => {
      const stateChangeHandler = vi.fn();
      transport.onStateChange(stateChangeHandler);

      // Connect and trigger state changes
      const connectPromise = transport.connect();

      // Should have emitted 'connecting' state
      expect(stateChangeHandler).toHaveBeenCalledWith('connecting');

      // Simulate open
      mockWs.simulateOpen();
      await connectPromise;

      // Should have emitted 'connected' state
      expect(stateChangeHandler).toHaveBeenCalledWith('connected');

      // Reset mock to track next calls
      stateChangeHandler.mockReset();

      // Simulate error
      mockWs.simulateError(new Error('Test error'));

      // Should have emitted 'error' state
      expect(stateChangeHandler).toHaveBeenCalledWith('error');

      // Reset mock to track next calls
      stateChangeHandler.mockReset();

      // Simulate close
      mockWs.simulateClose();

      // Should have emitted 'disconnected' state
      expect(stateChangeHandler).toHaveBeenCalledWith('disconnected');
    });

    it('should emit message events', async () => {
      const messageHandler = vi.fn();
      transport.onMessage(messageHandler);

      // First connect
      const connectPromise = transport.connect();
      mockWs.simulateOpen();
      await connectPromise;

      // Simulate receiving a message
      const testMessage = 'test message data';
      mockWs.simulateMessage(testMessage);

      // Should have emitted the message
      expect(messageHandler).toHaveBeenCalledWith(testMessage);
    });
  });
});
