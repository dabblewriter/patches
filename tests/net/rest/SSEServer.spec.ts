import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSEEventStore, SSEReplayResult } from '../../../src/net/rest/SSEEventStore';
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

/** Helper: a mock SSEEventStore whose methods can be overridden per test. */
function createStore(overrides: Partial<SSEEventStore> = {}): SSEEventStore {
  return {
    append: vi.fn(async () => null),
    replay: vi.fn(async (): Promise<SSEReplayResult> => ({ type: 'events', events: [] })),
    addSubscriptions: vi.fn(async () => {}),
    removeSubscriptions: vi.fn(async () => {}),
    loadSubscriptions: vi.fn(async (): Promise<string[]> => []),
    dropClient: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Helper: a promise resolvable from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

/**
 * Helper: drain pending microtasks. Notify appends ride each client's
 * pipeline, so a test simulating a disconnect/reconnect must let them land
 * first — as any real reconnect (a later network round trip) does.
 */
async function flushAsync(ticks = 25) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
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
    it('should return null for an unknown client', async () => {
      expect(await server.addSubscriptions('unknown', ['doc1'])).toBeNull();
    });

    it('should register subscriptions and return the docIds', async () => {
      server.connect('client1');
      expect(await server.addSubscriptions('client1', ['doc1', 'doc2'])).toEqual(['doc1', 'doc2']);
      expect(server.listSubscriptions('doc1')).toContain('client1');
      expect(server.listSubscriptions('doc2')).toContain('client1');
    });

    it('should bypass the authorization provider (trusted, pre-authorized input)', async () => {
      const canAccess = vi.fn().mockResolvedValue(false);
      const authServer = new SSEServer({ auth: { canAccess } });
      authServer.connect('client1');

      const result = await authServer.addSubscriptions('client1', ['doc1']);

      expect(result).toEqual(['doc1']);
      expect(authServer.listSubscriptions('doc1')).toContain('client1');
      expect(canAccess).not.toHaveBeenCalled();
      authServer.destroy();
    });

    it('should deliver notifications to clients registered this way', async () => {
      const stream = server.connect('client1');
      await server.addSubscriptions('client1', ['doc1']);

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

      // Send while disconnected — and let the appends land BEFORE the
      // reconnect, so the asserted frames come from replay() rather than from
      // the pending notify tasks writing to the new stream.
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c2' }] });
      await flushAsync();

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
      await flushAsync();

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
      await flushAsync();

      // Advance past the buffer window
      vi.advanceTimersByTime(6_000);

      // Event at T=6s — should trim the old event
      shortServer.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c2' }] });
      await flushAsync();

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
      await flushAsync();

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

  describe('resync cursor re-anchoring', () => {
    it('should write a store-assigned id on the resync frame so the cursor re-anchors', async () => {
      // Cursor from a previous store epoch (e.g. from before a server restart).
      const stream1 = server.connect('client1', '137');
      const chunks1 = await readStream(stream1, 1);
      expect(chunks1[0]).toBe('id: 1\nevent: resync\ndata: {}\n\n');

      await server.subscribe('client1', ['doc1']);
      server.disconnect('client1');
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });
      await flushAsync();

      // The re-anchored cursor verifies against the current epoch.
      const stream2 = server.connect('client1', '1');
      const chunks2 = await readStream(stream2, 1);
      expect(chunks2[0]).toContain('id: 2');
      expect(chunks2[0]).toContain('event: changesCommitted');
    });

    it('should resync a cursor from an old epoch instead of claiming an empty continuation', async () => {
      server.connect('client1');
      await server.subscribe('client1', ['doc1']);
      server.disconnect('client1');
      // An append in the current epoch makes the client "known" to the store.
      server.notify('doc1', 'changesCommitted', { docId: 'doc1', changes: [{ id: 'c1' }] });
      await flushAsync();

      // A cursor this epoch never assigned must not silently verify as an
      // empty continuation (that would strand the buffered event forever).
      const stream = server.connect('client1', '137');
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

describe('SSEServer event store seam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should append once per notify and write the store-assigned id on the wire', async () => {
    let n = 40;
    const store = createStore({ append: vi.fn(async () => String(++n)) });
    const server = new SSEServer({ eventStore: store });
    const stream = server.connect('c1');
    await server.subscribe('c1', ['doc1']);

    server.notify('doc1', 'changesCommitted', { docId: 'doc1' });
    server.notify('doc1', 'docDeleted', { docId: 'doc1' });

    const chunks = await readStream(stream, 2);
    expect(chunks[0]).toContain('id: 41');
    expect(chunks[1]).toContain('id: 42');
    expect(vi.mocked(store.append).mock.calls).toEqual([
      ['c1', 'changesCommitted', '{"docId":"doc1"}'],
      ['c1', 'docDeleted', '{"docId":"doc1"}'],
    ]);

    server.destroy();
  });

  it('should preserve per-client write order when appends resolve out of order', async () => {
    const slow = deferred<string | null>();
    const store = createStore({
      append: vi.fn<SSEEventStore['append']>().mockReturnValueOnce(slow.promise).mockResolvedValueOnce('2'),
    });
    const server = new SSEServer({ eventStore: store });
    const stream = server.connect('c1');
    await server.subscribe('c1', ['doc1']);

    server.notify('doc1', 'changesCommitted', { docId: 'doc1', seq: 1 });
    server.notify('doc1', 'changesCommitted', { docId: 'doc1', seq: 2 });
    slow.resolve('1'); // First append finishes AFTER the second

    const chunks = await readStream(stream, 2);
    expect(chunks[0]).toContain('id: 1');
    expect(chunks[0]).toContain('"seq":1');
    expect(chunks[1]).toContain('id: 2');
    expect(chunks[1]).toContain('"seq":2');

    server.destroy();
  });

  it("should not block one client behind another client's pending append", async () => {
    const stuck = deferred<string | null>();
    const store = createStore({
      append: vi.fn(async (clientId: string) => (clientId === 'c1' ? stuck.promise : '7')),
    });
    const server = new SSEServer({ eventStore: store });
    server.connect('c1');
    const stream2 = server.connect('c2');
    await server.subscribe('c1', ['doc1']);
    await server.subscribe('c2', ['doc1']);

    server.notify('doc1', 'changesCommitted', { docId: 'doc1' });

    // c2 receives its event while c1's append is still in flight.
    const chunks = await readStream(stream2, 1);
    expect(chunks[0]).toContain('id: 7');

    stuck.resolve('1');
    server.destroy();
  });

  it('should replay a store continuation with its opaque ids verbatim', async () => {
    const store = createStore({
      replay: vi.fn(
        async (): Promise<SSEReplayResult> => ({
          type: 'events',
          events: [
            { id: 'evt-8', event: 'changesCommitted', data: '{"docId":"doc1"}' },
            { id: 'evt-9', event: 'docDeleted', data: '{"docId":"doc2"}' },
          ],
        })
      ),
    });
    const server = new SSEServer({ eventStore: store });

    const stream = server.connect('c1', 'evt-7');

    // The read is issued inside the pipeline task, not synchronously.
    const chunks = await readStream(stream, 2);
    expect(store.replay).toHaveBeenCalledWith('c1', 'evt-7');
    expect(chunks[0]).toBe('id: evt-8\nevent: changesCommitted\ndata: {"docId":"doc1"}\n\n');
    expect(chunks[1]).toBe('id: evt-9\nevent: docDeleted\ndata: {"docId":"doc2"}\n\n');

    server.destroy();
  });

  it('should emit an id-less resync when the store cannot verify continuity', async () => {
    const store = createStore({ replay: vi.fn(async (): Promise<SSEReplayResult> => ({ type: 'resync' })) });
    const server = new SSEServer({ eventStore: store });

    const stream = server.connect('c1', 'evt-7');

    const chunks = await readStream(stream, 1);
    expect(chunks[0]).toBe('event: resync\ndata: {}\n\n');

    server.destroy();
  });

  it('should write the store re-anchor id on the resync frame when provided', async () => {
    const store = createStore({
      replay: vi.fn(async (): Promise<SSEReplayResult> => ({ type: 'resync', id: 'anchor-3' })),
    });
    const server = new SSEServer({ eventStore: store });

    const stream = server.connect('c1', 'evt-7');

    const chunks = await readStream(stream, 1);
    expect(chunks[0]).toBe('id: anchor-3\nevent: resync\ndata: {}\n\n');

    server.destroy();
  });

  it('should issue the replay read behind an append still in the pipeline', async () => {
    const gate = deferred<string | null>();
    const store = createStore({
      append: vi.fn<SSEEventStore['append']>().mockReturnValueOnce(gate.promise),
      replay: vi.fn(
        async (): Promise<SSEReplayResult> => ({
          type: 'events',
          events: [{ id: '2', event: 'changesCommitted', data: '{"n":2}' }],
        })
      ),
    });
    const server = new SSEServer({ eventStore: store });
    server.connect('c1');
    await server.subscribe('c1', ['doc1']);

    // Event 2's append is in flight when the client reconnects with its
    // cursor at 1. Reading the store before that append lands would omit the
    // event from the replay meant to cover it — committed to the store,
    // written to no wire, and unreachable once the cursor passes it.
    server.notify('doc1', 'changesCommitted', { n: 2 });
    const stream2 = server.connect('c1', '1');
    await flushAsync();
    expect(store.replay).not.toHaveBeenCalled();

    gate.resolve('2');
    await flushAsync();
    expect(store.replay).toHaveBeenCalledWith('c1', '1');
    // Delivered exactly once, by the replay — the pending notify task must
    // not also write it to the replacement stream. The sentinel occupying the
    // second frame proves there was no duplicate.
    server.sendToClient('c1', 'sentinel', 'x');
    const chunks = await readStream(stream2, 2);
    expect(chunks[0]).toBe('id: 2\nevent: changesCommitted\ndata: {"n":2}\n\n');
    expect(chunks[1]).toBe('event: sentinel\ndata: x\n\n');

    server.destroy();
  });

  it('should degrade a hung append to an id-less frame instead of wedging the pipeline', async () => {
    const store = createStore({
      append: vi
        .fn<SSEEventStore['append']>()
        .mockImplementationOnce(() => new Promise(() => {})) // never settles
        .mockResolvedValue('2'),
    });
    const server = new SSEServer({ eventStore: store, storeTimeoutMs: 1_000 });
    const stream = server.connect('c1');
    await server.subscribe('c1', ['doc1']);

    server.notify('doc1', 'changesCommitted', { n: 1 });
    server.notify('doc1', 'changesCommitted', { n: 2 });
    await flushAsync();
    vi.advanceTimersByTime(1_001);

    const chunks = await readStream(stream, 2);
    // The hung append degrades to an id-less frame (cursor must not advance
    // past the unstored event) and the queued second event still flows.
    expect(chunks[0]).toBe('event: changesCommitted\ndata: {"n":1}\n\n');
    expect(chunks[1]).toBe('id: 2\nevent: changesCommitted\ndata: {"n":2}\n\n');

    server.destroy();
  });

  it('should degrade a hung replay to a resync', async () => {
    const store = createStore({ replay: vi.fn(() => new Promise<SSEReplayResult>(() => {})) });
    const server = new SSEServer({ eventStore: store, storeTimeoutMs: 1_000 });

    const stream = server.connect('c1', '5');
    await flushAsync();
    vi.advanceTimersByTime(1_001);

    const chunks = await readStream(stream, 1);
    expect(chunks[0]).toBe('event: resync\ndata: {}\n\n');

    server.destroy();
  });

  it('should land subscription mutations in the store in issue order', async () => {
    const addGate = deferred<void>();
    const calls: string[] = [];
    const store = createStore({
      addSubscriptions: vi.fn(async () => {
        calls.push('add');
        await addGate.promise;
      }),
      removeSubscriptions: vi.fn(async () => {
        calls.push('remove');
      }),
    });
    const server = new SSEServer({ eventStore: store });
    server.connect('c1');

    const subscribed = server.subscribe('c1', ['doc1']);
    const unsubscribed = server.unsubscribe('c1', ['doc1']);
    await flushAsync();
    // The remove must not overtake the still-pending add — landing out of
    // order would leave the doc subscribed in the store.
    expect(store.removeSubscriptions).not.toHaveBeenCalled();

    addGate.resolve();
    await Promise.all([subscribed, unsubscribed]);
    expect(calls).toEqual(['add', 'remove']);

    server.destroy();
  });

  it('should write nothing for an empty continuation', async () => {
    const store = createStore();
    const server = new SSEServer({ eventStore: store });

    const stream = server.connect('c1', 'evt-7');
    // Let the replay task finish, then write a sentinel — the sentinel being
    // the first frame proves replay wrote nothing.
    await flushAsync();
    server.sendToClient('c1', 'sentinel', 'x');

    const chunks = await readStream(stream, 1);
    expect(chunks[0]).toBe('event: sentinel\ndata: x\n\n');

    server.destroy();
  });

  it('should hydrate local subscriptions from the store before replay on cold state', async () => {
    const store = createStore({
      loadSubscriptions: vi.fn(async () => ['doc1']),
      replay: vi.fn(
        async (): Promise<SSEReplayResult> => ({
          type: 'events',
          events: [{ id: 'r1', event: 'caughtUp', data: '{}' }],
        })
      ),
      append: vi.fn(async () => 'n2'),
    });
    const server = new SSEServer({ eventStore: store });

    const stream = server.connect('c1', 'r0');
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // retry: 5000

    expect(decoder.decode((await reader.read()).value)).toBe('id: r1\nevent: caughtUp\ndata: {}\n\n');
    expect(vi.mocked(store.loadSubscriptions).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.replay).mock.invocationCallOrder[0]
    );
    expect(server.listSubscriptions('doc1')).toContain('c1');

    // Post-replay events fan out via the hydrated set.
    server.notify('doc1', 'changesCommitted', { docId: 'doc1' });
    expect(decoder.decode((await reader.read()).value)).toBe(
      'id: n2\nevent: changesCommitted\ndata: {"docId":"doc1"}\n\n'
    );

    reader.releaseLock();
    server.destroy();
  });

  it('should deliver the frame without an id when append is degraded', async () => {
    const store = createStore({ append: vi.fn(async () => null) });
    const server = new SSEServer({ eventStore: store });
    const stream = server.connect('c1');
    await server.subscribe('c1', ['doc1']);

    server.notify('doc1', 'changesCommitted', { docId: 'doc1' });

    // No id line — the client's Last-Event-ID cursor must not advance past an unstored event.
    const chunks = await readStream(stream, 1);
    expect(chunks[0]).toBe('event: changesCommitted\ndata: {"docId":"doc1"}\n\n');
    expect(chunks[0]).not.toContain('id:');

    server.destroy();
  });

  it('should treat a throwing append as degraded', async () => {
    const store = createStore({ append: vi.fn(async () => Promise.reject(new Error('store down'))) });
    const server = new SSEServer({ eventStore: store });
    const stream = server.connect('c1');
    await server.subscribe('c1', ['doc1']);

    server.notify('doc1', 'changesCommitted', { docId: 'doc1' });

    const chunks = await readStream(stream, 1);
    expect(chunks[0]).toBe('event: changesCommitted\ndata: {"docId":"doc1"}\n\n');

    server.destroy();
  });

  it('should mirror subscription mutations and TTL cleanup to the store', async () => {
    const store = createStore();
    const server = new SSEServer({ eventStore: store, bufferTTLMs: 60_000 });
    server.connect('c1');

    await server.subscribe('c1', ['doc1', 'doc2']);
    expect(store.addSubscriptions).toHaveBeenCalledWith('c1', ['doc1', 'doc2']);

    await server.unsubscribe('c1', ['doc1']);
    expect(store.removeSubscriptions).toHaveBeenCalledWith('c1', ['doc1']);

    server.disconnect('c1');
    vi.advanceTimersByTime(60_001);
    expect(store.dropClient).toHaveBeenCalledWith('c1');

    server.destroy();
  });

  it('should not drop store state on destroy', () => {
    const store = createStore();
    const server = new SSEServer({ eventStore: store });
    server.connect('c1');

    server.destroy();

    expect(store.dropClient).not.toHaveBeenCalled();
  });

  it('should deliver and store an event that arrives while hydration is in flight', async () => {
    const load = deferred<string[]>();
    const store = createStore({
      loadSubscriptions: vi.fn(() => load.promise),
      append: vi.fn(async () => 'h1'),
    });
    const server = new SSEServer({ eventStore: store });
    const stream = server.connect('c1');

    // The event arrives before the stored subscriptions have been applied —
    // it must be neither dropped nor left out of the store.
    server.notify('doc1', 'changesCommitted', { docId: 'doc1' });
    load.resolve(['doc1']);

    const chunks = await readStream(stream, 1);
    expect(chunks[0]).toBe('id: h1\nevent: changesCommitted\ndata: {"docId":"doc1"}\n\n');
    expect(store.append).toHaveBeenCalledWith('c1', 'changesCommitted', '{"docId":"doc1"}');

    server.destroy();
  });

  it('should not resurrect a doc unsubscribed while hydration is in flight', async () => {
    const load = deferred<string[]>();
    const store = createStore({ loadSubscriptions: vi.fn(() => load.promise) });
    const server = new SSEServer({ eventStore: store });
    server.connect('c1');

    // Unsubscribe races the (stale) snapshot — the apply must not re-add it.
    server.unsubscribe('c1', ['docY']);
    load.resolve(['docY']);
    await flushAsync();

    expect(server.listSubscriptions('docY')).not.toContain('c1');
    server.notify('docY', 'changesCommitted', { docId: 'docY' });
    await flushAsync();
    expect(store.append).not.toHaveBeenCalled();

    server.destroy();
  });

  it('should refresh stored subscriptions on every reconnect, not only on cold state', async () => {
    const store = createStore();
    const server = new SSEServer({ eventStore: store });

    server.connect('c1');
    expect(store.loadSubscriptions).toHaveBeenCalledTimes(1);

    server.disconnect('c1');
    server.connect('c1'); // warm local state — load again purely as a TTL touch
    expect(store.loadSubscriptions).toHaveBeenCalledTimes(2);

    server.destroy();
  });

  describe('releaseClient', () => {
    it('should drop local state without touching the store when another instance claims the stream', async () => {
      const store = createStore();
      const server = new SSEServer({ eventStore: store, bufferTTLMs: 60_000 });
      server.connect('c1');
      await server.subscribe('c1', ['doc1']);
      server.disconnect('c1');

      server.releaseClient('c1');

      expect(server.hasClient('c1')).toBe(false);
      // The expiry timer was cancelled — it must not fire dropClient against a
      // client that is live on another instance.
      vi.advanceTimersByTime(60_001);
      expect(store.dropClient).not.toHaveBeenCalled();

      // A ghost no longer appends relayed events to the shared store.
      server.notify('doc1', 'changesCommitted', { docId: 'doc1' });
      await flushAsync();
      expect(store.append).not.toHaveBeenCalled();

      server.destroy();
    });

    it('should close a lingering live writer on release', async () => {
      const server = new SSEServer({ eventStore: createStore() });
      const stream = server.connect('c1');

      server.releaseClient('c1');

      const reader = stream.getReader();
      await reader.read(); // retry: 5000
      const { done } = await reader.read();
      expect(done).toBe(true);
      reader.releaseLock();

      server.destroy();
    });

    it('should ignore unknown clients', () => {
      const server = new SSEServer({ eventStore: createStore() });
      expect(() => server.releaseClient('ghost')).not.toThrow();
      server.destroy();
    });

    it('should suppress appends already queued when the client is released', async () => {
      const gate = deferred<string | null>();
      const store = createStore({
        append: vi.fn<SSEEventStore['append']>().mockReturnValueOnce(gate.promise).mockResolvedValue('9'),
      });
      const server = new SSEServer({ eventStore: store });
      server.connect('c1');
      await server.subscribe('c1', ['doc1']);

      server.notify('doc1', 'changesCommitted', { n: 1 }); // append in flight
      server.notify('doc1', 'changesCommitted', { n: 2 }); // queued behind it
      await flushAsync();
      server.releaseClient('c1'); // another instance claimed the stream

      gate.resolve('1');
      await flushAsync();
      // The queued task must not append into the shared store for a client
      // that is live elsewhere — that's the duplicate releaseClient exists to
      // prevent, and the queue is deepest exactly when the store is slow.
      expect(store.append).toHaveBeenCalledTimes(1);

      server.destroy();
    });

    it("should not mark a later reconnection disconnected when the released stream's close arrives late", async () => {
      const server = new SSEServer({ eventStore: createStore() });
      server.connect('c1'); // live stream, half-open network — no close reported yet
      server.releaseClient('c1'); // claim from another instance force-closes the writer
      server.connect('c1'); // client load-balances back before that close lands
      server.disconnect('c1'); // the framework finally reports the released stream's close

      // The fresh stream must still be live (heartbeats, notify writes).
      expect(server.getConnectionIds()).toContain('c1');

      server.disconnect('c1'); // genuine close of the current stream
      expect(server.getConnectionIds()).not.toContain('c1');

      server.destroy();
    });
  });
});
