import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSEServer } from '../../../src/net/rest/SSEServer';
import { SSESignalingService } from '../../../src/net/rest/SSESignalingService';

/** Helper: read `count` chunks from a stream, skipping the initial `retry:` line. */
async function readChunks(stream: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const out: string[] = [];
  await reader.read(); // skip retry: 5000\n\n
  for (let i = 0; i < count; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(decoder.decode(value));
  }
  reader.releaseLock();
  return out;
}

describe('SSESignalingService', () => {
  let sse: SSEServer;
  let signaling: SSESignalingService;

  beforeEach(() => {
    vi.useFakeTimers();
    sse = new SSEServer({ heartbeatIntervalMs: 10_000, bufferTTLMs: 60_000 });
    signaling = new SSESignalingService(sse);
  });

  afterEach(() => {
    sse.destroy();
    vi.useRealTimers();
  });

  it('should deliver peer-welcome over the signal SSE event on client connect', async () => {
    const stream = sse.connect('client-A');

    await signaling.onClientConnected('client-A');

    const chunks = await readChunks(stream, 1);
    expect(chunks[0]).toContain('event: signal');
    expect(chunks[0]).toContain('"method":"peer-welcome"');
    expect(chunks[0]).toContain('"id":"client-A"');
  });

  it('should relay a peer-signal between two connected clients', async () => {
    const streamA = sse.connect('client-A');
    const streamB = sse.connect('client-B');
    await signaling.onClientConnected('client-A');
    await signaling.onClientConnected('client-B');

    const handled = await signaling.handleClientMessage(
      'client-A',
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'peer-signal',
        params: ['client-B', { sdp: 'fake-offer' }],
      })
    );

    expect(handled).toBe(true);

    // streamA: welcome (1)
    const aChunks = await readChunks(streamA, 1);
    expect(aChunks[0]).toContain('"method":"peer-welcome"');

    // streamB: welcome (1) + relayed signal (2)
    const bChunks = await readChunks(streamB, 2);
    expect(bChunks[0]).toContain('"method":"peer-welcome"');
    expect(bChunks[1]).toContain('event: signal');
    expect(bChunks[1]).toContain('"method":"signal"');
    expect(bChunks[1]).toContain('"from":"client-A"');
    expect(bChunks[1]).toContain('"sdp":"fake-offer"');
  });

  it('should notify remaining peers on disconnect', async () => {
    const streamA = sse.connect('client-A');
    const streamB = sse.connect('client-B');
    await signaling.onClientConnected('client-A');
    await signaling.onClientConnected('client-B');

    await signaling.onClientDisconnected('client-A');

    // streamA welcome only — A is gone before any other event addresses it.
    const aChunks = await readChunks(streamA, 1);
    expect(aChunks[0]).toContain('"method":"peer-welcome"');

    // streamB: welcome (1) + peer-disconnected (2)
    const bChunks = await readChunks(streamB, 2);
    expect(bChunks[0]).toContain('"method":"peer-welcome"');
    expect(bChunks[1]).toContain('event: signal');
    expect(bChunks[1]).toContain('"method":"peer-disconnected"');
    expect(bChunks[1]).toContain('"id":"client-A"');
  });

  it('should drop signals sent to a disconnected client (no buffering)', () => {
    sse.connect('client-A');
    sse.disconnect('client-A');

    // sendToClient must return false rather than buffering — stale signaling
    // is harmful (peers gone, ICE candidates moot).
    const sendSpy = vi.spyOn(sse, 'sendToClient');
    signaling.send('client-A', { jsonrpc: '2.0', method: 'noop' } as any);

    expect(sendSpy).toHaveBeenCalledWith('client-A', 'signal', expect.any(String));
    expect(sendSpy.mock.results[0].value).toBe(false);
  });
});
