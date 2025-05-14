import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JSONRPCServer } from '../../../src/net/protocol/JSONRPCServer.js';
import type { ServerTransport } from '../../../src/net/protocol/types.js';

// -----------------------------------------------------------------------------
// Mock transport
// -----------------------------------------------------------------------------
class MockServerTransport implements ServerTransport {
  public sent: { to: string; raw: string }[] = [];
  private handler: ((from: string, raw: string) => void) | null = null;

  getConnectionIds(): string[] {
    return ['client-1'];
  }

  send(to: string, raw: string): void {
    this.sent.push({ to, raw });
  }

  onMessage(cb: (from: string, raw: string) => void): () => void {
    this.handler = cb;
    return () => {
      this.handler = null;
    };
  }

  emitIncoming(from: string, raw: string): void {
    this.handler?.(from, raw);
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('JSONRPCServer (generic dispatch)', () => {
  let transport: MockServerTransport;
  let server: JSONRPCServer;

  beforeEach(() => {
    transport = new MockServerTransport();
    server = new JSONRPCServer(transport);
  });

  it('routes requests to registered handler and returns response', async () => {
    const sumHandler = vi.fn((_conn: string, params: { a: number; b: number }) => params.a + params.b);
    server.registerMethod('sum', sumHandler);

    const request = {
      jsonrpc: '2.0',
      id: 42,
      method: 'sum',
      params: { a: 2, b: 3 },
    };

    transport.emitIncoming('client-1', JSON.stringify(request));

    // wait for async handling
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(sumHandler).toHaveBeenCalledWith('client-1', { a: 2, b: 3 });

    expect(transport.sent.length).toBe(1);
    const response = JSON.parse(transport.sent[0].raw);
    expect(response).toEqual({ jsonrpc: '2.0', id: 42, result: 5 });
  });

  it('emits notification events via .on()', async () => {
    const spy = vi.fn();
    server.on('ping', spy);

    const notification = { jsonrpc: '2.0', method: 'ping', params: { foo: 'bar' } };
    transport.emitIncoming('client-1', JSON.stringify(notification));

    // allow async signal
    await new Promise(r => setTimeout(r, 0));

    expect(spy).toHaveBeenCalledWith('client-1', { foo: 'bar' });
  });
});
