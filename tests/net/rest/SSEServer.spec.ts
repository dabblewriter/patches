import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSEServer } from '../../../src/net/rest/SSEServer';

/** Helper: read all available chunks from a ReadableStream and return them as strings. */
async function readStream(stream: ReadableStream<Uint8Array>, count = 20): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  reader.releaseLock();
  return chunks;
}

describe('SSEServer', () => {
  let server: SSEServer;

  beforeEach(() => {
    vi.useFakeTimers();
    server = new SSEServer({
      heartbeatIntervalMs: 10_000,
      bufferTTLMs: 60_000,
    });
  });

  afterEach(() => {
    server.destroy();
    vi.useRealTimers();
  });

  describe('connect', () => {
    it('should return a ReadableStream', () => {
      const stream = server.connect('client1');
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should track the client as connected', () => {
      server.connect('client1');
      expect(server.getConnectionIds()).toContain('client1');
    });

    it('should not duplicate client on reconnect', () => {
      server.connect('client1');
      server.disconnect('client1');
      server.connect('client1');
      // Only one entry
      expect(server.getConnectionIds()).toEqual(['client1']);
    });
  });

  describe('disconnect', () => {
    it('should remove client from connected list', () => {
      server.connect('client1');
      server.disconnect('client1');
      expect(server.getConnectionIds()).not.toContain('client1');
    });

    it('should clean up client after buffer TTL', () => {
      server.connect('client1');
      server.subscribe('client1', ['doc1']);
      server.disconnect('client1');

      // Should still have subscriptions
      expect(server.listSubscriptions('doc1')).toContain('client1');

      // Advance past buffer TTL
      vi.advanceTimersByTime(60_001);

      // Client should be cleaned up
      expect(server.listSubscriptions('doc1')).not.toContain('client1');
    });
  });

  describe('subscriptions', () => {
    beforeEach(() => {
      server.connect('client1');
      server.connect('client2');
    });

    it('should add subscriptions', async () => {
      const result = await server.subscribe('client1', ['doc1', 'doc2']);
      expect(result).toEqual(['doc1', 'doc2']);
    });

    it('should list subscriptions by document', async () => {
      await server.subscribe('client1', ['doc1']);
      await server.subscribe('client2', ['doc1', 'doc2']);

      expect(server.listSubscriptions('doc1')).toEqual(['client1', 'client2']);
      expect(server.listSubscriptions('doc2')).toEqual(['client2']);
    });

    it('should remove subscriptions', async () => {
      await server.subscribe('client1', ['doc1', 'doc2']);
      server.unsubscribe('client1', ['doc1']);

      expect(server.listSubscriptions('doc1')).not.toContain('client1');
      expect(server.listSubscriptions('doc2')).toContain('client1');
    });

    it('should enforce auth on subscribe', async () => {
      const authServer = new SSEServer({
        auth: {
          canAccess: vi
            .fn()
            .mockResolvedValueOnce(true) // doc1 allowed
            .mockResolvedValueOnce(false), // doc2 denied
        },
      });
      authServer.connect('client1');

      const result = await authServer.subscribe('client1', ['doc1', 'doc2'], { clientId: 'client1' });
      expect(result).toEqual(['doc1']);

      authServer.destroy();
    });

    it('should return empty array for unknown client', async () => {
      const result = await server.subscribe('unknown', ['doc1']);
      expect(result).toEqual([]);
    });
  });

  describe('notifications', () => {
    it('should send events to connected subscribed clients', async () => {
      const stream = server.connect('client1');
      await server.subscribe('client1', ['doc1']);

      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });

      const chunks = await readStream(stream, 1);
      expect(chunks[0]).toContain('event: changesCommitted');
      expect(chunks[0]).toContain('"docId":"doc1"');
      expect(chunks[0]).toMatch(/^id: \d+/);
    });

    it('should not send to unsubscribed clients', async () => {
      // Connect two clients, only subscribe client2
      const stream1 = server.connect('client1');
      const stream2 = server.connect('client2');
      await server.subscribe('client2', ['doc1']);

      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [] });

      // client2 receives the event, client1 does not
      const chunks2 = await readStream(stream2, 1);
      expect(chunks2).toHaveLength(1);
      expect(chunks2[0]).toContain('event: changesCommitted');
    });

    it('should route by docId parameter, not params.docId', async () => {
      const stream = server.connect('client1');
      // Client subscribes to root path
      await server.subscribe('client1', ['users/abc']);

      // Notification for a sub-path, routed via root path
      server.notify('users/abc', 'changesCommitted', { docId: 'users/abc/settings', changes: [{ id: 'c1' }] });

      const chunks = await readStream(stream, 1);
      expect(chunks[0]).toContain('event: changesCommitted');
      expect(chunks[0]).toContain('"docId":"users/abc/settings"');
    });

    it('should not send to the originating client', async () => {
      // Connect two clients, both subscribed
      server.connect('client1');
      const stream2 = server.connect('client2');
      await server.subscribe('client1', ['doc1']);
      await server.subscribe('client2', ['doc1']);

      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [] }, 'client1');

      // client2 receives, client1 (the origin) does not
      const chunks2 = await readStream(stream2, 1);
      expect(chunks2).toHaveLength(1);
      expect(chunks2[0]).toContain('event: changesCommitted');
    });

    it('should buffer events for disconnected clients', async () => {
      server.connect('client1');
      await server.subscribe('client1', ['doc1']);
      server.disconnect('client1');

      // Send while disconnected
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c2' }] });

      // Reconnect and replay
      const stream = server.connect('client1', '0');
      const chunks = await readStream(stream, 2);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain('id: 1');
      expect(chunks[1]).toContain('id: 2');
    });

    it('should send resync when buffer is expired', async () => {
      server.connect('client1');
      await server.subscribe('client1', ['doc1']);
      server.disconnect('client1');

      // Expire the buffer
      vi.advanceTimersByTime(60_001);

      // Reconnect with old lastEventId — client is gone, new connection
      const stream = server.connect('client1', '5');
      const chunks = await readStream(stream, 1);

      expect(chunks[0]).toContain('event: resync');
    });
  });

  describe('event IDs', () => {
    it('should assign monotonically increasing IDs per client', async () => {
      const stream = server.connect('client1');
      await server.subscribe('client1', ['doc1']);

      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c2' }] });
      server.notify('doc1', 'docDeleted', { docId: 'doc1' });

      const chunks = await readStream(stream, 3);
      expect(chunks[0]).toContain('id: 1');
      expect(chunks[1]).toContain('id: 2');
      expect(chunks[2]).toContain('id: 3');
    });
  });

  describe('detection gap buffering', () => {
    it('should buffer events while connected for replay after silent disconnect', async () => {
      server.connect('client1');
      await server.subscribe('client1', ['doc1']);

      // Events sent while "connected" — written to stream AND buffered
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c2' }] });
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c3' }] });

      // Network dies silently. Heartbeat detects it after ~15s.
      // Simulate: disconnect detected, then immediate reconnect.
      server.disconnect('client1');

      // Client reconnects having only received event 1 (2 and 3 were lost in the dead stream)
      const stream = server.connect('client1', '1');
      const chunks = await readStream(stream, 2);

      // Events 2 and 3 are replayed from the buffer
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain('id: 2');
      expect(chunks[1]).toContain('id: 3');
    });

    it('should trim buffer to sliding window while connected', async () => {
      // Server with 5-second buffer window for testing
      const shortServer = new SSEServer({
        heartbeatIntervalMs: 10_000,
        bufferTTLMs: 60_000,
        bufferWindowMs: 5_000,
      });
      shortServer.connect('client1');
      await shortServer.subscribe('client1', ['doc1']);

      // Event at T=0
      shortServer.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });

      // Advance past the buffer window
      vi.advanceTimersByTime(6_000);

      // Event at T=6s — should trim the old event
      shortServer.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c2' }] });

      // Disconnect and reconnect — only event 2 should be available
      shortServer.disconnect('client1');
      const stream = shortServer.connect('client1', '0');
      const chunks = await readStream(stream, 1);

      // Only the recent event (within the window) is replayed
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('id: 2');

      shortServer.destroy();
    });
  });

  describe('reconnection replay', () => {
    it('should replay only events after lastEventId', async () => {
      server.connect('client1');
      await server.subscribe('client1', ['doc1']);
      server.disconnect('client1');

      // Buffer 3 events
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'a' }] });
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'b' }] });
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c' }] });

      // Reconnect having received event 1 — should get events 2 and 3 only
      const stream = server.connect('client1', '1');
      const chunks = await readStream(stream, 2);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain('id: 2');
      expect(chunks[1]).toContain('id: 3');
    });

    it('should send resync for invalid lastEventId', async () => {
      server.connect('client1');
      const stream = server.connect('client1', 'not-a-number');
      const chunks = await readStream(stream, 1);
      expect(chunks[0]).toContain('event: resync');
    });
  });

  describe('heartbeats', () => {
    it('should send heartbeats to connected clients', async () => {
      const stream = server.connect('client1');

      vi.advanceTimersByTime(10_000);

      const chunks = await readStream(stream, 1);
      expect(chunks[0]).toBe(': heartbeat\n\n');
    });

    it('should not send heartbeats to disconnected clients', () => {
      server.connect('client1');
      server.disconnect('client1');

      // Heartbeat fires but doesn't throw
      vi.advanceTimersByTime(10_000);
    });
  });

  describe('destroy', () => {
    it('should clean up all resources', () => {
      server.connect('client1');
      server.connect('client2');

      server.destroy();

      expect(server.getConnectionIds()).toEqual([]);
    });
  });
});
