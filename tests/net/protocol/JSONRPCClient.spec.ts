import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSONRPCParseError } from '../../../src/net/error';
import { JSONRPCClient } from '../../../src/net/protocol/JSONRPCClient';
import type { ClientTransport } from '../../../src/net/protocol/types';

describe('JSONRPCClient', () => {
  let mockTransport: ClientTransport;
  let client: JSONRPCClient;
  let mockUnsubscriber: ReturnType<typeof vi.fn>;
  let onMessageHandler: (raw: string) => void;

  beforeEach(() => {
    mockUnsubscriber = vi.fn();
    onMessageHandler = vi.fn();

    mockTransport = {
      send: vi.fn(),
      onMessage: vi.fn().mockImplementation(handler => {
        onMessageHandler = handler;
        return mockUnsubscriber;
      }),
    };

    client = new JSONRPCClient(mockTransport);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create client with transport and register message handler', () => {
      expect(mockTransport.onMessage).toHaveBeenCalledTimes(1);
      expect(mockTransport.onMessage).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should initialize with empty pending requests and notifications', () => {
      // Test that client starts clean
      expect(client).toBeInstanceOf(JSONRPCClient);
    });
  });

  describe('request method', () => {
    it('should send JSON-RPC request with auto-incrementing id', async () => {
      const responsePromise = client.call('testMethod', 'arg1', 'arg2');

      expect(mockTransport.send).toHaveBeenCalledTimes(1);
      const sentMessage = JSON.parse(vi.mocked(mockTransport.send).mock.calls[0][0]);

      expect(sentMessage).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'testMethod',
        params: ['arg1', 'arg2'],
      });

      // Send response to resolve promise
      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: 'success',
        })
      );

      const result = await responsePromise;
      expect(result).toBe('success');
    });

    it('should handle request without params', async () => {
      const responsePromise = client.call('ping');

      const sentMessage = JSON.parse(vi.mocked(mockTransport.send).mock.calls[0][0]);
      expect(sentMessage).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: undefined,
      });

      // Resolve the promise
      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: null,
        })
      );

      await responsePromise;
    });

    it('should auto-increment request ids', async () => {
      const promise1 = client.call('method1');
      const promise2 = client.call('method2');

      expect(mockTransport.send).toHaveBeenCalledTimes(2);

      const message1 = JSON.parse(vi.mocked(mockTransport.send).mock.calls[0][0]);
      const message2 = JSON.parse(vi.mocked(mockTransport.send).mock.calls[1][0]);

      expect(message1.id).toBe(1);
      expect(message2.id).toBe(2);

      // Resolve both promises
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'result1' }));
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'result2' }));

      expect(await promise1).toBe('result1');
      expect(await promise2).toBe('result2');
    });

    it('should handle error responses', async () => {
      const responsePromise = client.call('errorMethod');

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32601,
            message: 'Method not found',
            data: { method: 'errorMethod' },
          },
        })
      );

      await expect(responsePromise).rejects.toEqual({
        code: -32601,
        message: 'Method not found',
        data: { method: 'errorMethod' },
      });
    });

    it('should handle complex data types in params and results', async () => {
      const complexParams = {
        nested: { array: [1, 2, 3], bool: true },
        nullValue: null,
        number: 42.5,
      };

      const responsePromise = client.call('complexMethod', complexParams);

      const sentMessage = JSON.parse(vi.mocked(mockTransport.send).mock.calls[0][0]);
      expect(sentMessage.params).toEqual([complexParams]);

      const complexResult = {
        data: { items: ['a', 'b', 'c'] },
        meta: { count: 3, hasMore: false },
      };

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: complexResult,
        })
      );

      const result = await responsePromise;
      expect(result).toEqual(complexResult);
    });

    it('should support typed responses', async () => {
      interface TestResult {
        value: string;
        count: number;
      }

      const responsePromise = client.call<TestResult>('typedMethod');

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { value: 'test', count: 5 },
        })
      );

      const result = await responsePromise;
      expect(result.value).toBe('test');
      expect(result.count).toBe(5);
    });
  });

  describe('notify method', () => {
    it('should send notification without id', () => {
      client.notify('notifyMethod', 'arg1', 'arg2');

      expect(mockTransport.send).toHaveBeenCalledTimes(1);
      const sentMessage = JSON.parse(vi.mocked(mockTransport.send).mock.calls[0][0]);

      expect(sentMessage).toEqual({
        jsonrpc: '2.0',
        method: 'notifyMethod',
        params: ['arg1', 'arg2'],
      });
      expect('id' in sentMessage).toBe(false);
    });

    it('should send notification without params', () => {
      client.notify('ping');

      const sentMessage = JSON.parse(vi.mocked(mockTransport.send).mock.calls[0][0]);
      expect(sentMessage).toEqual({
        jsonrpc: '2.0',
        method: 'ping',
        params: undefined,
      });
    });

    it('should handle multiple notifications', () => {
      client.notify('notify1', 'value1');
      client.notify('notify2', 'value2');

      expect(mockTransport.send).toHaveBeenCalledTimes(2);

      const message1 = JSON.parse(vi.mocked(mockTransport.send).mock.calls[0][0]);
      const message2 = JSON.parse(vi.mocked(mockTransport.send).mock.calls[1][0]);

      expect(message1.method).toBe('notify1');
      expect(message2.method).toBe('notify2');
    });
  });

  describe('on method (notification subscription)', () => {
    it('should subscribe to server notifications', () => {
      const handler = vi.fn();
      const unsubscribe = client.on('serverNotification', handler);

      expect(typeof unsubscribe).toBe('function');

      // Simulate server notification
      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'serverNotification',
          params: { message: 'Hello from server' },
        })
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ message: 'Hello from server' });
    });

    it('should support multiple subscribers for same notification', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      client.on('sharedNotification', handler1);
      client.on('sharedNotification', handler2);

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'sharedNotification',
          params: { data: 'shared' },
        })
      );

      expect(handler1).toHaveBeenCalledWith({ data: 'shared' });
      expect(handler2).toHaveBeenCalledWith({ data: 'shared' });
    });

    it('should support unsubscribing from notifications', () => {
      const handler = vi.fn();
      const unsubscribe = client.on('testNotification', handler);

      // Send notification - should be received
      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'testNotification',
          params: { test: 1 },
        })
      );

      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      // Send another notification - should not be received
      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'testNotification',
          params: { test: 2 },
        })
      );

      expect(handler).toHaveBeenCalledTimes(1); // Still only called once
    });

    it('should handle notifications without params', () => {
      const handler = vi.fn();
      client.on('emptyNotification', handler);

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'emptyNotification',
        })
      );

      expect(handler).toHaveBeenCalledWith(undefined);
    });

    it('should handle different notification types', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      client.on('type1', handler1);
      client.on('type2', handler2);

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'type1',
          params: { data: 'for type1' },
        })
      );

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'type2',
          params: { data: 'for type2' },
        })
      );

      expect(handler1).toHaveBeenCalledWith({ data: 'for type1' });
      expect(handler2).toHaveBeenCalledWith({ data: 'for type2' });
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('message handling', () => {
    it('should handle valid JSON-RPC responses', async () => {
      const responsePromise = client.call('test');

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: 'test result',
        })
      );

      const result = await responsePromise;
      expect(result).toBe('test result');
    });

    it('should handle responses with null result', async () => {
      const responsePromise = client.call('nullTest');

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: null,
        })
      );

      const result = await responsePromise;
      expect(result).toBeNull();
    });

    it('should ignore responses for unknown request ids', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 999,
          result: 'unknown',
        })
      );

      expect(consoleSpy).toHaveBeenCalledWith('Received response for unknown id: 999');
      consoleSpy.mockRestore();
    });

    it('should handle malformed JSON gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      onMessageHandler('{ invalid json }');

      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to parse incoming message:',
        '{ invalid json }',
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });

    it('should handle unexpected message formats', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Message without method or id
      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          someOtherField: 'value',
        })
      );

      expect(consoleSpy).toHaveBeenCalledWith('Received unexpected message format:', {
        jsonrpc: '2.0',
        someOtherField: 'value',
      });
      consoleSpy.mockRestore();
    });

    it('should handle null and non-object messages', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      onMessageHandler('null');
      onMessageHandler('"string message"');
      onMessageHandler('42');

      expect(consoleSpy).toHaveBeenCalledTimes(3);
      consoleSpy.mockRestore();
    });

    it('should handle notifications for non-subscribed methods', () => {
      // This should not throw or cause issues
      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'unsubscribedMethod',
          params: { data: 'test' },
        })
      );

      // No assertion needed - just ensuring no errors occur
    });
  });

  describe('error handling edge cases', () => {
    it('should handle error responses with complex error objects', async () => {
      const responsePromise = client.call('complexError');

      const complexError = {
        code: -32603,
        message: 'Internal error',
        data: {
          exception: 'DatabaseConnectionError',
          details: { host: 'db.example.com', port: 5432 },
          stack: ['at line 1', 'at line 2'],
        },
      };

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: complexError,
        })
      );

      await expect(responsePromise).rejects.toEqual(complexError);
    });

    it('should handle responses that have both result and error', async () => {
      const responsePromise = client.call('invalidResponse');

      // This is technically invalid JSON-RPC, but we test how we handle it
      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: 'success',
          error: { code: -1, message: 'error' },
        })
      );

      // Our implementation prioritizes error over result
      await expect(responsePromise).rejects.toEqual({
        code: -1,
        message: 'error',
      });
    });

    it('should handle concurrent requests and responses', async () => {
      const promise1 = client.call('concurrent1');
      const promise2 = client.call('concurrent2');
      const promise3 = client.call('concurrent3');

      // Send responses out of order
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'result2' }));
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 3, result: 'result3' }));
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'result1' }));

      const results = await Promise.all([promise1, promise2, promise3]);
      expect(results).toEqual(['result1', 'result2', 'result3']);
    });

    it('should clean up pending requests when responses are received', async () => {
      const promise1 = client.call('cleanup1');
      const promise2 = client.call('cleanup2');

      // Resolve first request
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'done1' }));
      await promise1;

      // Try to send response for already resolved request - should warn
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'duplicate' }));
      expect(consoleSpy).toHaveBeenCalledWith('Received response for unknown id: 1');

      // Second request should still work
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'done2' }));
      const result2 = await promise2;
      expect(result2).toBe('done2');

      consoleSpy.mockRestore();
    });
  });

  describe('transport integration', () => {
    it('should handle async transport send', async () => {
      const asyncTransport: ClientTransport = {
        send: vi.fn().mockResolvedValue(undefined),
        onMessage: vi.fn().mockReturnValue(vi.fn()),
      };

      const asyncClient = new JSONRPCClient(asyncTransport);
      asyncClient.notify('asyncTest', { data: 'async' });

      expect(asyncTransport.send).toHaveBeenCalledWith(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'asyncTest',
          params: [{ data: 'async' }],
        })
      );
    });

    it('should work with different transport implementations', () => {
      const customTransport: ClientTransport = {
        send: vi.fn(),
        onMessage: vi.fn().mockReturnValue(() => {}),
      };

      const customClient = new JSONRPCClient(customTransport);
      customClient.call('customMethod');

      expect(customTransport.send).toHaveBeenCalled();
      expect(customTransport.onMessage).toHaveBeenCalled();
    });
  });

  describe('type safety and TypeScript integration', () => {
    it('should support strongly typed request parameters and results', async () => {
      interface UserCreateParams {
        name: string;
        email: string;
      }

      interface UserCreateResult {
        id: string;
        created: boolean;
      }

      const responsePromise = client.call<UserCreateResult>('createUser', {
        name: 'John Doe',
        email: 'john@example.com',
      } as UserCreateParams);

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { id: 'user123', created: true },
        })
      );

      const result = await responsePromise;
      expect(result.id).toBe('user123');
      expect(result.created).toBe(true);
    });

    it('should support notification parameter types', () => {
      interface NotificationParams {
        event: string;
        timestamp: number;
      }

      const handler = vi.fn();
      client.on('typedNotification', handler);

      onMessageHandler(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'typedNotification',
          params: { event: 'user.login', timestamp: Date.now() },
        })
      );

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'user.login',
          timestamp: expect.any(Number),
        })
      );
    });
  });

  describe('parse error handling', () => {
    it('should reject all pending requests when receiving unparseable response', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const promise1 = client.call('method1');
      const promise2 = client.call('method2');

      // Simulate server returning plain text error
      onMessageHandler('Internal Server Error');

      // Both promises should be rejected with JSONRPCParseError
      await expect(promise1).rejects.toBeInstanceOf(JSONRPCParseError);
      await expect(promise2).rejects.toBeInstanceOf(JSONRPCParseError);
      consoleSpy.mockRestore();
    });

    it('should include raw message in JSONRPCParseError', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const responsePromise = client.call('testMethod');

      onMessageHandler('502 Bad Gateway');

      try {
        await responsePromise;
        expect.fail('Should have rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(JSONRPCParseError);
        expect((error as JSONRPCParseError).rawMessage).toBe('502 Bad Gateway');
        expect((error as JSONRPCParseError).message).toContain('502 Bad Gateway');
      }
      consoleSpy.mockRestore();
    });

    it('should truncate long error messages in JSONRPCParseError', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const responsePromise = client.call('testMethod');
      const longMessage = 'x'.repeat(500);

      onMessageHandler(longMessage);

      try {
        await responsePromise;
        expect.fail('Should have rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(JSONRPCParseError);
        expect((error as JSONRPCParseError).rawMessage).toBe(longMessage);
        expect((error as JSONRPCParseError).message.length).toBeLessThan(300);
        expect((error as JSONRPCParseError).message).toContain('...');
      }
      consoleSpy.mockRestore();
    });

    it('should preserve the underlying parse error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const responsePromise = client.call('testMethod');

      onMessageHandler('{ invalid json }');

      try {
        await responsePromise;
        expect.fail('Should have rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(JSONRPCParseError);
        expect((error as JSONRPCParseError).parseError).toBeInstanceOf(SyntaxError);
      }
      consoleSpy.mockRestore();
    });

    it('should clear pending map after rejecting all requests', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const promise1 = client.call('method1');
      const promise2 = client.call('method2');

      onMessageHandler('Server Error');

      // Wait for rejections
      await Promise.allSettled([promise1, promise2]);

      // Subsequent valid response for old ID should warn (not crash)
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'late' }));
      expect(warnSpy).toHaveBeenCalledWith('Received response for unknown id: 1');

      consoleSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should handle parse error with no pending requests gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // No pending requests, just receive bad data
      onMessageHandler('Unexpected error from server');

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
      // Should not throw or crash
    });

    it('should allow new requests after parse error recovery', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const promise1 = client.call('method1');

      // Trigger parse error
      onMessageHandler('Server Error');
      await expect(promise1).rejects.toBeInstanceOf(JSONRPCParseError);

      // New request should work fine
      const promise2 = client.call('method2');
      onMessageHandler(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'success' }));
      const result = await promise2;
      expect(result).toBe('success');
      consoleSpy.mockRestore();
    });

    it('should handle HTML error pages', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const responsePromise = client.call('testMethod');

      const htmlError = '<html><body><h1>503 Service Unavailable</h1></body></html>';
      onMessageHandler(htmlError);

      await expect(responsePromise).rejects.toBeInstanceOf(JSONRPCParseError);
      consoleSpy.mockRestore();
    });
  });
});
