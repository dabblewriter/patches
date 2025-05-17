import { describe, expect, it, vi } from 'vitest';
import { JSONRPCClient } from '../../../src/net/protocol/JSONRPCClient.js';
import type { ClientTransport, ConnectionState } from '../../../src/net/protocol/types.js';

// Mock Transport implementation
class MockTransport implements ClientTransport {
  messageHandler: ((data: string) => void) | null = null;
  stateHandler: ((state: ConnectionState) => void) | null = null;
  sentData: string[] = [];

  connect = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn();
  send = vi.fn((data: string) => {
    this.sentData.push(data);
  });

  onMessage(handler: (data: string) => void) {
    this.messageHandler = handler;
    return () => {};
  }
  onStateChange(handler: (state: ConnectionState) => void): void {
    this.stateHandler = handler;
  }

  // Method to simulate receiving data
  receive(data: any): void {
    if (this.messageHandler) {
      this.messageHandler(JSON.stringify(data));
    }
  }
}

describe('JSONRPCClient', () => {
  it('should send a request and resolve on valid response', async () => {
    const transport = new MockTransport();
    const client = new JSONRPCClient(transport);

    const requestPromise = client.request('testMethod', { param1: 'value1' });

    // Check if request was sent correctly
    expect(transport.send).toHaveBeenCalledTimes(1);
    const sentMessage = JSON.parse(transport.sentData[0]);
    expect(sentMessage).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'testMethod',
      params: { param1: 'value1' },
    });

    // Simulate receiving the response
    transport.receive({
      jsonrpc: '2.0',
      id: 1,
      result: { success: true },
    });

    // Check if the promise resolved correctly
    await expect(requestPromise).resolves.toEqual({ success: true });
  });

  it('should send a request and reject on error response', async () => {
    const transport = new MockTransport();
    const client = new JSONRPCClient(transport);

    const requestPromise = client.request('errorMethod');

    // Simulate receiving an error response
    transport.receive({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'Test Error' },
    });

    // Check if the promise rejected correctly
    await expect(requestPromise).rejects.toEqual({ code: -32000, message: 'Test Error' });
  });

  it('should send a notification', () => {
    const transport = new MockTransport();
    const client = new JSONRPCClient(transport);

    client.notify('notifyMethod', { info: 'data' });

    expect(transport.send).toHaveBeenCalledTimes(1);
    const sentMessage = JSON.parse(transport.sentData[0]);
    expect(sentMessage).toEqual({
      jsonrpc: '2.0',
      method: 'notifyMethod',
      params: { info: 'data' },
      // No 'id' for notifications
    });
  });

  it('should emit onNotification signal when a notification is received', async () => {
    const transport = new MockTransport();
    const client = new JSONRPCClient(transport);
    const notificationHandler = vi.fn();

    client.on('serverUpdate', notificationHandler);

    // Simulate receiving a notification
    const notificationParams = { update: 'value' };
    transport.receive({
      jsonrpc: '2.0',
      method: 'serverUpdate',
      params: notificationParams,
    });

    // Allow async signal emission to complete
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(notificationHandler).toHaveBeenCalledTimes(1);
    expect(notificationHandler).toHaveBeenCalledWith(notificationParams);
  });

  it('should ignore responses with unknown IDs', async () => {
    const transport = new MockTransport();
    new JSONRPCClient(transport);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    transport.receive({ jsonrpc: '2.0', id: 999, result: 'ignored' });

    // Allow potential async operations
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(warnSpy).toHaveBeenCalledWith('Received response for unknown id: 999');
    warnSpy.mockRestore();
  });
});
