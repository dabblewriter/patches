import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JSONRPCServer } from '../../../src/net/protocol/JSONRPCServer.js';

describe('JSONRPCServer (generic dispatch)', () => {
  let server: JSONRPCServer;

  beforeEach(() => {
    server = new JSONRPCServer();
  });

  it('routes requests to registered handler and returns response', async () => {
    const sumHandler = vi.fn((params: { a: number; b: number }) => params.a + params.b);
    server.registerMethod('sum', sumHandler);

    const request = {
      jsonrpc: '2.0',
      id: 42,
      method: 'sum',
      params: { a: 2, b: 3 },
    };

    const rawResponse = await server.processMessage(JSON.stringify(request), { clientId: 'client-1' });
    expect(sumHandler).toHaveBeenCalledWith({ a: 2, b: 3 }, { clientId: 'client-1' });

    expect(rawResponse).toBeDefined();
    const response = JSON.parse(rawResponse!);
    expect(response).toEqual({ jsonrpc: '2.0', id: 42, result: 5 });
  });

  it('emits notification events via .on()', async () => {
    const spy = vi.fn();
    server.on('ping', spy);

    const notification = { jsonrpc: '2.0', method: 'ping', params: { foo: 'bar' } };
    const res = await server.processMessage(JSON.stringify(notification), { clientId: 'client-1' });

    expect(res).toBeUndefined();

    // allow async signal flush
    await new Promise(r => setTimeout(r, 0));

    expect(spy).toHaveBeenCalledWith({ foo: 'bar' }, 'client-1');
  });
});
