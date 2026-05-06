import { signal } from 'easy-signal';
import { describe, expect, it, vi } from 'vitest';
import { PatchesRESTSignalingTransport } from '../../../src/net/rest/PatchesRESTSignalingTransport';
import type { PatchesREST } from '../../../src/net/rest/PatchesREST';

function makeFakePatches() {
  const onSignal = signal<(raw: string) => void>();
  const onStateChange = signal<(state: any) => void>();
  return {
    state: 'connected' as const,
    onStateChange,
    onSignal,
    connect: vi.fn().mockResolvedValue(undefined),
    sendSignal: vi.fn().mockResolvedValue(undefined),
  } as unknown as PatchesREST & {
    onSignal: ReturnType<typeof signal>;
    onStateChange: ReturnType<typeof signal>;
  };
}

describe('PatchesRESTSignalingTransport', () => {
  it('exposes the underlying PatchesREST state and onStateChange', () => {
    const fake = makeFakePatches();
    const t = new PatchesRESTSignalingTransport(fake);

    expect(t.state).toBe('connected');
    expect(t.onStateChange).toBe(fake.onStateChange);
  });

  it('delegates connect to PatchesREST', async () => {
    const fake = makeFakePatches();
    const t = new PatchesRESTSignalingTransport(fake);

    await t.connect();
    expect(fake.connect).toHaveBeenCalled();
  });

  it('routes send through PatchesREST.sendSignal verbatim', async () => {
    const fake = makeFakePatches();
    const t = new PatchesRESTSignalingTransport(fake);

    await t.send('{"jsonrpc":"2.0","method":"peer-signal"}');
    expect(fake.sendSignal).toHaveBeenCalledWith('{"jsonrpc":"2.0","method":"peer-signal"}');
  });

  it('forwards onSignal events to onMessage subscribers', () => {
    const fake = makeFakePatches();
    const t = new PatchesRESTSignalingTransport(fake);

    const received: string[] = [];
    const off = t.onMessage(raw => received.push(raw));

    (fake.onSignal as any).emit('frame-1');
    (fake.onSignal as any).emit('frame-2');

    expect(received).toEqual(['frame-1', 'frame-2']);

    off();
    (fake.onSignal as any).emit('frame-3');
    expect(received).toEqual(['frame-1', 'frame-2']);
  });
});
