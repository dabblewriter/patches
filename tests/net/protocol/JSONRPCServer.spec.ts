import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JSONRPCServer } from '../../../src/net/protocol/JSONRPCServer.js';
import type { Transport } from '../../../src/net/protocol/types.js';

// -----------------------------------------------------------------------------
// Mock transport
// -----------------------------------------------------------------------------
class MockTransport implements Transport {
  public sent: string[] = [];
  private messageHandler: ((data: string) => void) | null = null;
  private stateHandler: ((state: any) => void) | null = null;

  async connect(): Promise<void> {}
  disconnect(): void {}
  send(data: string): void {
    this.sent.push(data);
  }
  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onStateChange(handler: (state: any) => void): void {
    this.stateHandler = handler;
  }

  // Helper to trigger incoming messages
  emitIncoming(data: string): void {
    this.messageHandler?.(data);
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('JSONRPCServer', () => {
  let transport: MockTransport;
  let patches: any;
  let server: JSONRPCServer;

  beforeEach(() => {
    transport = new MockTransport();
    patches = {
      subscribe: vi.fn().mockResolvedValue(['doc1']),
      unsubscribe: vi.fn().mockResolvedValue(['doc1']),
      getDoc: vi.fn().mockResolvedValue({ rev: 0, state: null, changes: [] }),
      getChangesSince: vi.fn().mockResolvedValue([]),
      commitChanges: vi.fn().mockResolvedValue([[], []]),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      createVersion: vi.fn().mockResolvedValue('version-1'),
      listVersions: vi.fn().mockResolvedValue([]),
      getVersionState: vi.fn().mockResolvedValue({ rev: 0, state: null }),
      getVersionChanges: vi.fn().mockResolvedValue([]),
      updateVersion: vi.fn().mockResolvedValue(undefined),
    };

    server = new JSONRPCServer(transport, patches, 'client-1');
  });

  it('should route "subscribe" request to patches server and send response', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'subscribe',
      params: { ids: 'doc1' },
    };

    transport.emitIncoming(JSON.stringify(request));

    // wait for async handling
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(patches.subscribe).toHaveBeenCalledWith('client-1', 'doc1');
    expect(transport.sent.length).toBe(1);
    const response = JSON.parse(transport.sent[0]);
    expect(response).toEqual({ jsonrpc: '2.0', id: 1, result: ['doc1'] });
  });

  it('should return transformed changes from commitChanges', async () => {
    patches.commitChanges.mockResolvedValue([[], [{ id: 'c', ops: [], rev: 1, created: Date.now() }]]);

    const request = {
      jsonrpc: '2.0',
      id: 2,
      method: 'commitChanges',
      params: {
        docId: 'doc1',
        changes: [{ id: 'c', ops: [], rev: 0, created: Date.now() }],
      },
    };

    transport.emitIncoming(JSON.stringify(request));
    await new Promise(r => setTimeout(r, 0));

    expect(patches.commitChanges).toHaveBeenCalled();
    const response = JSON.parse(transport.sent.pop()!);
    expect(response.id).toBe(2);
    expect(response.result).toEqual([{ id: 'c', ops: [], rev: 1, created: expect.any(Number) }]);
  });
});
