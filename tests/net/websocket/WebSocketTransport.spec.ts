import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketTransport } from '../../../src/net/websocket/WebSocketTransport.js';
import { onlineState } from '../../../src/net/websocket/onlineState.js';

// Mock the global WebSocket
let mockWsInstance: any;
const MockWebSocketGlobal = vi.fn().mockImplementation(url => {
  mockWsInstance = {
    url,
    readyState: WebSocket.CONNECTING,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    addEventListener: vi.fn((event, cb) => {
      mockWsInstance[`on${event}`] = cb;
    }),
    removeEventListener: vi.fn(),
    simulateOpen: () => {
      mockWsInstance.readyState = WebSocket.OPEN;
      if (mockWsInstance.onopen) mockWsInstance.onopen({ type: 'open' });
    },
    simulateMessage: (data: any) => {
      if (mockWsInstance.onmessage) mockWsInstance.onmessage({ data, type: 'message' });
    },
    simulateError: (error?: Error) => {
      if (mockWsInstance.onerror) mockWsInstance.onerror(error || new Error('Mock WebSocket Error'));
    },
    simulateClose: (code?: number, reason?: string) => {
      mockWsInstance.readyState = WebSocket.CLOSED;
      if (mockWsInstance.onclose) mockWsInstance.onclose({ code, reason, type: 'close' });
    },
  };
  return mockWsInstance;
});

// Mock onlineState
vi.mock('../../../src/net/websocket/onlineState.js', () => ({
  onlineState: {
    isOnline: true,
    onOnlineChange: vi.fn(() => () => {}),
  },
}));

// Mock Deferred utility
const mockDeferredResolve = vi.fn();
const mockDeferredReject = vi.fn();
const mockDeferredPromise = Promise.resolve(); // Always-resolved promise for tests

vi.mock('../../../src/utils/deferred.ts', () => ({
  deferred: vi.fn(() => ({
    promise: mockDeferredPromise,
    resolve: mockDeferredResolve,
    reject: mockDeferredReject,
    status: 'pending',
  })),
}));

describe('WebSocketTransport', () => {
  let transport: WebSocketTransport;
  const MOCK_URL = 'ws://localhost:1234';
  let originalWebSocket: any;

  beforeAll(() => {
    originalWebSocket = (global as any).WebSocket;
    (global as any).WebSocket = MockWebSocketGlobal;
  });

  afterAll(() => {
    (global as any).WebSocket = originalWebSocket;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocketGlobal.mockClear();
    mockWsInstance = undefined;
    vi.mocked(onlineState.onOnlineChange).mockClear();
    vi.mocked(require('../../../src/utils/deferred.ts').deferred).mockClear();
    mockDeferredResolve.mockClear();
    mockDeferredReject.mockClear();

    transport = new WebSocketTransport(MOCK_URL, {
      // No specific WebSocketOptions needed here as PatchesWebSocket takes WebSocketOptions,
      // not WebSocketTransport directly in its constructor for these low-level options.
      // Reconnect options are internal to WebSocketTransport.
    });
  });

  afterEach(() => {
    if (transport) transport.disconnect();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('connect method', () => {
    it('should create a WebSocket connection when connect is called', async () => {
      const connectPromise = transport.connect();
      expect(MockWebSocketGlobal).toHaveBeenCalledWith(MOCK_URL, undefined);
      expect(mockWsInstance).toBeDefined();
      expect(transport.state).toBe('connecting');
      if (mockWsInstance) mockWsInstance.simulateOpen();
      await connectPromise;
      expect(transport.state).toBe('connected');
    });

    it('should defer connection when offline', async () => {
      vi.mocked(onlineState).isOnline = false; // Control via mocked onlineState
      const connectPromise = transport.connect();
      expect(MockWebSocketGlobal).not.toHaveBeenCalled();
      expect(transport.state).toBe('disconnected');

      vi.mocked(onlineState).isOnline = true;
      const onlineChangeListener = vi.mocked(onlineState.onOnlineChange).mock.calls[0][0];
      onlineChangeListener(true);
      await new Promise(process.nextTick);

      expect(mockWsInstance).toBeDefined();
      if (mockWsInstance) mockWsInstance.simulateOpen();
      await connectPromise;
      expect(transport.state).toBe('connected');
      vi.mocked(onlineState).isOnline = true; // Reset for other tests
    });
  });
});
