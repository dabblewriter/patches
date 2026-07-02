import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSONRPCError, StatusError } from '../../../src/net/error';
import { FetchTransport } from '../../../src/net/http/FetchTransport';
import { JSONRPCClient } from '../../../src/net/protocol/JSONRPCClient';

function mockResponse(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

describe('FetchTransport', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should emit the response body for ok responses', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(200, body)) as any;

    const transport = new FetchTransport('https://example.com/rpc', 'Bearer token');
    const received: string[] = [];
    transport.onMessage(raw => received.push(raw));

    await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));

    expect(received).toEqual([body]);
  });

  it('should emit a scoped rpcError for non-ok responses instead of the raw body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(401, '{"error":"unauthorized"}')) as any;

    const transport = new FetchTransport('https://example.com/rpc', '');
    const received: string[] = [];
    transport.onMessage(raw => received.push(raw));

    await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'subscribe', params: ['doc1'] }));

    expect(received).toHaveLength(1);
    const message = JSON.parse(received[0]);
    expect(message.id).toBe(7);
    expect(message.error.code).toBe(401);
    expect(message.error.message).toContain('HTTP 401');
  });

  it('should reject the originating call with StatusError for non-JSON-RPC error bodies', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(401, '{"error":"unauthorized"}')) as any;

    const client = new JSONRPCClient(new FetchTransport('https://example.com/rpc', ''));

    // Without the status check this promise never settled (orphaned pending entry).
    const err = await client.call('subscribe', 'doc1').catch(e => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.code).toBe(401);
  });

  it('should not reject unrelated in-flight calls when one response is a non-JSON error page', async () => {
    const validResponse = JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'ok' });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(502, '<html><body>502 Bad Gateway</body></html>'))
      .mockResolvedValueOnce(mockResponse(200, validResponse)) as any;

    const client = new JSONRPCClient(new FetchTransport('https://example.com/rpc', ''));

    const p1 = client.call('a');
    const p2 = client.call('b');

    const err = await p1.catch(e => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.code).toBe(502);
    await expect(p2).resolves.toBe('ok');
  });

  it('should scope network errors to the request that was sent', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any;

    const client = new JSONRPCClient(new FetchTransport('https://example.com/rpc', ''));

    const err = await client.call('ping').catch(e => e);
    expect(err).toBeInstanceOf(JSONRPCError);
    expect(err.code).toBe(-32000);
    expect(err.message).toBe('network down');
  });
});
