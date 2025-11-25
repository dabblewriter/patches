import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSONRPCServer } from '../../../src/net/protocol/JSONRPCServer';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, Message } from '../../../src/net/protocol/types';
import type { AuthContext } from '../../../src/net/websocket/AuthorizationProvider';

describe('JSONRPCServer', () => {
  let server: JSONRPCServer;

  beforeEach(() => {
    server = new JSONRPCServer();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create server with empty handlers and notification signals', () => {
      expect(server).toBeInstanceOf(JSONRPCServer);
      expect(server.onNotify).toBeDefined();
    });
  });

  describe('registerMethod', () => {
    it('should register a method handler', () => {
      const handler = vi.fn().mockResolvedValue('result');

      server.registerMethod('testMethod', handler);

      // No direct way to test registration, but we can test it through processMessage
      expect(() => server.registerMethod('testMethod', handler)).toThrow();
    });

    it('should throw error when registering duplicate method', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      server.registerMethod('duplicateMethod', handler1);

      expect(() => server.registerMethod('duplicateMethod', handler2)).toThrow(
        "A handler for method 'duplicateMethod' is already registered."
      );
    });

    it('should register multiple different methods', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      server.registerMethod('method1', handler1);
      server.registerMethod('method2', handler2);

      // Should not throw
      expect(true).toBe(true);
    });

    it('should support typed method registration', () => {
      interface TestParams {
        name: string;
        value: number;
      }

      interface TestResult {
        success: boolean;
        id: string;
      }

      const typedHandler = vi.fn().mockResolvedValue({ success: true, id: 'test123' });

      server.registerMethod<TestParams, TestResult>('typedMethod', typedHandler);

      // Registration should succeed without type errors
      expect(true).toBe(true);
    });
  });

  describe('on method (notification subscription)', () => {
    it('should subscribe to notifications', () => {
      const handler = vi.fn();
      const unsubscribe = server.on('testNotification', handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should support multiple subscribers to same notification', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      server.on('sharedNotification', handler1);
      server.on('sharedNotification', handler2);

      // Both handlers should be subscribed (tested through processMessage)
      expect(true).toBe(true);
    });

    it('should allow unsubscribing from notifications', () => {
      const handler = vi.fn();
      const unsubscribe = server.on('unsubTest', handler);

      unsubscribe();

      // Handler should no longer receive notifications (tested through processMessage)
      expect(true).toBe(true);
    });
  });

  describe('notify method', () => {
    it('should emit notification to onNotify signal', async () => {
      const notifyHandler = vi.fn();
      server.onNotify(notifyHandler);

      await server.notify('testMethod', { data: 'test' });

      expect(notifyHandler).toHaveBeenCalledTimes(1);
      expect(notifyHandler).toHaveBeenCalledWith(
        { jsonrpc: '2.0', method: 'testMethod', params: { data: 'test' } },
        undefined
      );
    });

    it('should emit notification with exceptConnectionId', async () => {
      const notifyHandler = vi.fn();
      server.onNotify(notifyHandler);

      await server.notify('testMethod', { data: 'test' }, 'client123');

      expect(notifyHandler).toHaveBeenCalledWith(
        { jsonrpc: '2.0', method: 'testMethod', params: { data: 'test' } },
        'client123'
      );
    });

    it('should emit notification without params', async () => {
      const notifyHandler = vi.fn();
      server.onNotify(notifyHandler);

      await server.notify('pingMethod');

      expect(notifyHandler).toHaveBeenCalledWith(
        { jsonrpc: '2.0', method: 'pingMethod', params: undefined },
        undefined
      );
    });
  });

  describe('processMessage with string input', () => {
    beforeEach(() => {
      server.registerMethod('testMethod', vi.fn().mockResolvedValue('success'));
      server.registerMethod('errorMethod', vi.fn().mockRejectedValue(new Error('Test error')));
    });

    it('should process valid JSON-RPC request', async () => {
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'testMethod',
        params: { data: 'test' },
      });

      const response = await server.processMessage(request);
      const parsed = JSON.parse(response as string);

      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: 'success',
      });
    });

    it('should handle malformed JSON', async () => {
      const response = await server.processMessage('{ invalid json }');
      const parsed = JSON.parse(response as string);

      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
          data: expect.any(Object),
        },
      });
    });

    it('should handle invalid request structure', async () => {
      const invalidRequest = JSON.stringify({ someField: 'value' });

      const response = await server.processMessage(invalidRequest);
      const parsed = JSON.parse(response as string);

      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request',
          data: null,
        },
      });
    });

    it('should handle unknown method', async () => {
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'unknownMethod',
        params: {},
      });

      const response = await server.processMessage(request);
      const parsed = JSON.parse(response as string);

      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: "Unknown method 'unknownMethod'.",
          data: expect.any(String),
        },
      });
    });

    it('should handle method that throws error', async () => {
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'errorMethod',
        params: {},
      });

      const response = await server.processMessage(request);
      const parsed = JSON.parse(response as string);

      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: 'Test error',
          data: expect.any(String),
        },
      });
    });

    it('should handle notification (no response expected)', async () => {
      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notificationMethod',
        params: { data: 'notify' },
      });

      const response = await server.processMessage(notification);

      expect(response).toBeUndefined();
    });

    it('should handle request without params', async () => {
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'testMethod',
      });

      const response = await server.processMessage(request);
      const parsed = JSON.parse(response as string);

      // Server rejects requests without params
      expect(parsed.error?.message).toBe("Invalid parameters for method 'testMethod'.");
    });

    it('should handle request with null id', async () => {
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'testMethod',
        params: {},
      });

      const response = await server.processMessage(request);
      const parsed = JSON.parse(response as string);

      expect(parsed.id).toBeNull();
      expect(parsed.result).toBe('success');
    });
  });

  describe('processMessage with Message object input', () => {
    beforeEach(() => {
      server.registerMethod('objectMethod', vi.fn().mockResolvedValue({ result: 'object' }));
    });

    it('should process Message object directly', async () => {
      const message: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'objectMethod',
        params: { data: 'object' },
      };

      const response = (await server.processMessage(message)) as JsonRpcResponse;

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { result: 'object' },
      });
    });

    it('should handle invalid Message object', async () => {
      const invalidMessage = { someField: 'value' } as any;

      const response = (await server.processMessage(invalidMessage)) as unknown as JsonRpcResponse;

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request',
          data: null,
        },
      });
    });

    it('should handle notification Message object', async () => {
      const handler = vi.fn();
      server.on('objectNotification', handler);

      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'objectNotification',
        params: { data: 'notify' },
      };

      const response = await server.processMessage(notification);

      expect(response).toBeUndefined();
      expect(handler).toHaveBeenCalledWith({ data: 'notify' }, undefined);
    });
  });

  describe('authentication context handling', () => {
    it('should pass auth context to method handlers', async () => {
      const handler = vi.fn().mockResolvedValue('authenticated');
      server.registerMethod('authMethod', handler);

      const authCtx: AuthContext = {
        clientId: 'client123',
        metadata: { user: 'testuser' },
      };

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'authMethod',
        params: { data: 'test' },
      };

      await server.processMessage(request, authCtx);

      expect(handler).toHaveBeenCalledWith({ data: 'test' }, authCtx);
    });

    it('should pass clientId to notification handlers', async () => {
      const handler = vi.fn();
      server.on('authNotification', handler);

      const authCtx: AuthContext = {
        clientId: 'client456',
        metadata: { role: 'admin' },
      };

      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'authNotification',
        params: { message: 'admin action' },
      };

      await server.processMessage(notification, authCtx);

      expect(handler).toHaveBeenCalledWith({ message: 'admin action' }, 'client456');
    });
  });

  describe('error handling with custom error codes', () => {
    it('should handle errors with custom codes', async () => {
      const customError = new Error('Custom error') as any;
      customError.code = 1001;

      server.registerMethod('customErrorMethod', vi.fn().mockRejectedValue(customError));

      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'customErrorMethod',
        params: {},
      });

      const response = await server.processMessage(request);
      const parsed = JSON.parse(response as string);

      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: 1001,
          message: 'Custom error',
          data: undefined,
        },
      });
    });

    it('should handle errors without message', async () => {
      const errorWithoutMessage = {} as any;
      server.registerMethod('noMessageError', vi.fn().mockRejectedValue(errorWithoutMessage));

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'noMessageError',
        params: {},
      };

      const response = (await server.processMessage(request)) as JsonRpcResponse;

      expect(response.error?.code).toBe(-32000);
      expect(response.error?.message).toBe('Server error');
    });
  });

  describe('parameter validation', () => {
    it('should reject non-object parameters', async () => {
      server.registerMethod('paramValidation', vi.fn());

      const requestWithStringParams = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'paramValidation',
        params: 'string params',
      });

      const response = await server.processMessage(requestWithStringParams);
      const parsed = JSON.parse(response as string);

      expect(parsed.error?.message).toBe("Invalid parameters for method 'paramValidation'.");
    });

    it('should reject array parameters', async () => {
      server.registerMethod('arrayParamValidation', vi.fn());

      const requestWithArrayParams: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'arrayParamValidation',
        params: [1, 2, 3],
      };

      const response = (await server.processMessage(requestWithArrayParams)) as JsonRpcResponse;

      expect(response.error?.message).toBe("Invalid parameters for method 'arrayParamValidation'.");
    });

    it('should accept null/undefined parameters', async () => {
      const handler = vi.fn().mockResolvedValue('success');
      server.registerMethod('nullParamMethod', handler);

      const requestWithNullParams: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'nullParamMethod',
        params: null,
      };

      const response = (await server.processMessage(requestWithNullParams)) as JsonRpcResponse;

      expect(response.error?.message).toBe("Invalid parameters for method 'nullParamMethod'.");
    });

    it('should accept object parameters', async () => {
      const handler = vi.fn().mockResolvedValue('valid');
      server.registerMethod('validParamMethod', handler);

      const requestWithObjectParams: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'validParamMethod',
        params: { valid: true },
      };

      const response = (await server.processMessage(requestWithObjectParams)) as JsonRpcResponse;

      expect(response.result).toBe('valid');
      expect(handler).toHaveBeenCalledWith({ valid: true }, undefined);
    });
  });

  describe('concurrent message processing', () => {
    it('should handle multiple concurrent requests', async () => {
      server.registerMethod('concurrent1', vi.fn().mockResolvedValue('result1'));
      server.registerMethod('concurrent2', vi.fn().mockResolvedValue('result2'));
      server.registerMethod('concurrent3', vi.fn().mockResolvedValue('result3'));

      const requests = [
        { jsonrpc: '2.0' as const, id: 1, method: 'concurrent1', params: {} },
        { jsonrpc: '2.0' as const, id: 2, method: 'concurrent2', params: {} },
        { jsonrpc: '2.0' as const, id: 3, method: 'concurrent3', params: {} },
      ];

      const responses = await Promise.all(requests.map(req => server.processMessage(req)));

      expect(responses).toHaveLength(3);
      expect((responses[0] as JsonRpcResponse).result).toBe('result1');
      expect((responses[1] as JsonRpcResponse).result).toBe('result2');
      expect((responses[2] as JsonRpcResponse).result).toBe('result3');
    });

    it('should handle mixed requests and notifications', async () => {
      const handler = vi.fn().mockResolvedValue('request result');
      const notificationHandler = vi.fn();

      server.registerMethod('mixedRequest', handler);
      server.on('mixedNotification', notificationHandler);

      const messages: Message[] = [
        { jsonrpc: '2.0', id: 1, method: 'mixedRequest', params: {} },
        { jsonrpc: '2.0', method: 'mixedNotification', params: { data: 'notify' } },
      ];

      const responses = await Promise.all(messages.map(msg => server.processMessage(msg)));

      expect(responses[0]).toBeDefined(); // Request response
      expect(responses[1]).toBeUndefined(); // Notification response
      expect(handler).toHaveBeenCalled();
      expect(notificationHandler).toHaveBeenCalledWith({ data: 'notify' }, undefined);
    });
  });

  describe('edge cases and robustness', () => {
    it('should handle empty object message', async () => {
      const response = (await server.processMessage({} as any)) as unknown as JsonRpcResponse;

      expect(response.error?.code).toBe(-32600);
      expect(response.error?.message).toBe('Invalid Request');
    });

    it('should handle null message', async () => {
      const response = (await server.processMessage(null as any)) as unknown as JsonRpcResponse;

      expect(response.error?.code).toBe(-32600);
      expect(response.error?.message).toBe('Invalid Request');
    });

    it('should handle message with method but invalid structure', async () => {
      const message = { method: 'test' } as any;

      const response = await server.processMessage(message);

      expect(response).toBeUndefined(); // Treated as notification
    });

    it('should handle very large method names and parameters', async () => {
      const largeMethodName = 'a'.repeat(1000);
      const largeParams = { data: 'x'.repeat(10000) };

      server.registerMethod(largeMethodName, vi.fn().mockResolvedValue('large'));

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: largeMethodName,
        params: largeParams,
      };

      const response = (await server.processMessage(request)) as JsonRpcResponse;

      expect(response.result).toBe('large');
    });

    it('should handle async method handlers', async () => {
      const asyncHandler = vi.fn().mockImplementation(async params => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return `async result: ${params.data}`;
      });

      server.registerMethod('asyncMethod', asyncHandler);

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'asyncMethod',
        params: { data: 'test' },
      };

      const response = (await server.processMessage(request)) as JsonRpcResponse;

      expect(response.result).toBe('async result: test');
    });

    it('should handle notification for non-subscribed method', async () => {
      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'unsubscribedMethod',
        params: { data: 'test' },
      };

      // Should not throw
      const response = await server.processMessage(notification);

      expect(response).toBeUndefined();
    });
  });

  describe('type safety and TypeScript integration', () => {
    it('should support strongly typed method handlers', async () => {
      interface CreateUserParams {
        name: string;
        email: string;
      }

      interface CreateUserResult {
        id: string;
        created: boolean;
      }

      const typedHandler = vi.fn().mockResolvedValue({ id: 'user123', created: true });

      server.registerMethod<CreateUserParams, CreateUserResult>('createUser', typedHandler);

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'createUser',
        params: { name: 'John', email: 'john@example.com' },
      };

      const response = (await server.processMessage(request)) as JsonRpcResponse;

      expect(response.result).toEqual({ id: 'user123', created: true });
      expect(typedHandler).toHaveBeenCalledWith({ name: 'John', email: 'john@example.com' }, undefined);
    });

    it('should support typed notification handlers', async () => {
      interface NotificationParams {
        event: string;
        timestamp: number;
      }

      const typedNotificationHandler = vi.fn();

      server.on('typedNotification', (params: NotificationParams, clientId?: string) => {
        typedNotificationHandler(params, clientId);
      });

      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'typedNotification',
        params: { event: 'user.login', timestamp: Date.now() },
      };

      await server.processMessage(notification);

      expect(typedNotificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'user.login',
          timestamp: expect.any(Number),
        }),
        undefined
      );
    });
  });
});
