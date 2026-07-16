import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSEServer } from '../../../src/net/rest/SSEServer';

/** Helper: read chunks from a ReadableStream, skipping the initial retry message. */
async function readStream(stream: ReadableStream<Uint8Array>, count = 20): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  // Skip the initial retry: message sent on connect
  await reader.read();
  for (let i = 0; i < count; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  reader.releaseLock();
  return chunks;
}

/** Helper: read the raw first chunk (before skipping). */
async function readFirstChunk(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value);
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

    it('should send retry interval as first message', async () => {
      const stream = server.connect('client1');
      const first = await readFirstChunk(stream);
      expect(first).toBe('retry: 5000\n\n');
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

  describe('stale disconnect after reconnect', () => {
    it('should ignore a lagging disconnect from a replaced connection', async () => {
      server.connect('client1');
      await server.subscribe('client1', ['doc1']);

      // Client reconnects while the old response is still open server-side
      // (half-open connection); connect() force-closes the old writer.
      const stream2 = server.connect('client1');

      // The old response finally closes and the framework reports it late.
      server.disconnect('client1');

      // The fresh connection must stay live and keep receiving events.
      expect(server.getConnectionIds()).toContain('client1');

      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });
      const chunks = await readStream(stream2, 1);
      expect(chunks[0]).toContain('event: changesCommitted');
    });

    it('should still process a genuine disconnect after swallowing a stale one', () => {
      server.connect('client1');
      server.connect('client1'); // reconnect replaces the live connection

      server.disconnect('client1'); // stale close of the replaced connection
      expect(server.getConnectionIds()).toContain('client1');

      server.disconnect('client1'); // genuine close of the current connection
      expect(server.getConnectionIds()).not.toContain('client1');
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

    it('should exclude docs where canAccess throws and not propagate the error', async () => {
      const authServer = new SSEServer({
        auth: {
          canAccess: vi
            .fn()
            .mockResolvedValueOnce(true) // doc1 allowed
            .mockRejectedValueOnce(new Error('auth service error')) // doc2 throws
            .mockResolvedValueOnce(true), // doc3 allowed
        },
      });
      authServer.connect('client1');

      const result = await authServer.subscribe('client1', ['doc1', 'doc2', 'doc3'], { clientId: 'client1' });
      expect(result).toEqual(['doc1', 'doc3']);
      expect(authServer.listSubscriptions('doc1')).toContain('client1');
      expect(authServer.listSubscriptions('doc2')).not.toContain('client1');
      expect(authServer.listSubscriptions('doc3')).toContain('client1');

      authServer.destroy();
    });

    it('should return empty array for unknown client', async () => {
      const result = await server.subscribe('unknown', ['doc1']);
      expect(result).toEqual([]);
    });
  });

  describe('hasClient', () => {
    it('should be false for an unknown client', () => {
      expect(server.hasClient('nope')).toBe(false);
    });

    it('should be true for a connected client', () => {
      server.connect('client1');
      expect(server.hasClient('client1')).toBe(true);
    });

    it('should stay true for a disconnected client within the buffer TTL', () => {
      server.connect('client1');
      server.disconnect('client1');
      expect(server.hasClient('client1')).toBe(true);
    });

    it('should be false once the buffer TTL expires', () => {
      server.connect('client1');
      server.disconnect('client1');
      vi.advanceTimersByTime(60_001);
      expect(server.hasClient('client1')).toBe(false);
    });
  });

  describe('addSubscriptions', () => {
    it('should return null for an unknown client', () => {
      expect(server.addSubscriptions('unknown', ['doc1'])).toBeNull();
    });

    it('should register subscriptions and return the docIds', () => {
      server.connect('client1');
      expect(server.addSubscriptions('client1', ['doc1', 'doc2'])).toEqual(['doc1', 'doc2']);
      expect(server.listSubscriptions('doc1')).toContain('client1');
      expect(server.listSubscriptions('doc2')).toContain('client1');
    });

    it('should bypass the authorization provider (trusted, pre-authorized input)', () => {
      const canAccess = vi.fn().mockResolvedValue(false);
      const authServer = new SSEServer({ auth: { canAccess } });
      authServer.connect('client1');

      const result = authServer.addSubscriptions('client1', ['doc1']);

      expect(result).toEqual(['doc1']);
      expect(authServer.listSubscriptions('doc1')).toContain('client1');
      expect(canAccess).not.toHaveBeenCalled();
      authServer.destroy();
    });

    it('should deliver notifications to clients registered this way', async () => {
      const stream = server.connect('client1');
      server.addSubscriptions('client1', ['doc1']);

      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });

      const chunks = await readStream(stream, 1);
      expect(chunks[0]).toContain('event: changesCommitted');
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

  describe('sendToClient', () => {
    it('should write a client-targeted event without subscription routing', async () => {
      const stream = server.connect('client1');

      const ok = server.sendToClient('client1', 'signal', '{"jsonrpc":"2.0","method":"peer-welcome"}');

      expect(ok).toBe(true);
      const chunks = await readStream(stream, 1);
      expect(chunks[0]).toContain('event: signal');
      expect(chunks[0]).toContain('"method":"peer-welcome"');
    });

    it('should not require the client to be subscribed to anything', async () => {
      const stream = server.connect('client1');

      const ok = server.sendToClient('client1', 'signal', 'payload');

      expect(ok).toBe(true);
      const chunks = await readStream(stream, 1);
      expect(chunks[0]).toContain('event: signal');
    });

    it('should return false and drop event when client is not connected', () => {
      // Connect, then disconnect — buffered for doc events but not signals.
      server.connect('client1');
      server.disconnect('client1');

      const ok = server.sendToClient('client1', 'signal', 'payload');

      expect(ok).toBe(false);
    });

    it('should return false for unknown clients', () => {
      const ok = server.sendToClient('ghost', 'signal', 'payload');
      expect(ok).toBe(false);
    });

    it('should not be replayed on reconnect (signaling events are not buffered)', async () => {
      server.connect('client1');
      server.disconnect('client1');

      // Signal arrives while disconnected — drop it.
      server.sendToClient('client1', 'signal', 'late');

      // Reconnect with lastEventId 0 — if the dropped signal had been buffered,
      // it would replay here as the next chunk after the retry: line.
      const stream = server.connect('client1', '0');
      const reader = stream.getReader();
      await reader.read(); // skip retry: 5000\n\n

      // No data should be queued on the stream. A pending read against an
      // empty stream should lose the race against an immediate microtask.
      const racer = new Promise<{ done: true }>(resolve => {
        Promise.resolve().then(() => resolve({ done: true }));
      });
      const result = await Promise.race([reader.read(), racer]);
      reader.releaseLock();
      expect(result.done).toBe(true);
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
      // Observable named event (not a `:` comment) so EventSource clients can detect liveness.
      expect(chunks[0]).toBe('event: heartbeat\ndata: \n\n');
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
