import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySSEEventStore } from '../../../src/net/rest/SSEEventStore';

describe('InMemorySSEEventStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should assign numeric-string ids from a per-client counter', async () => {
    const store = new InMemorySSEEventStore();
    expect(await store.append('c1', 'e', 'd')).toBe('1');
    expect(await store.append('c1', 'e', 'd')).toBe('2');
    expect(await store.append('c2', 'e', 'd')).toBe('1');
  });

  it('currentId returns "0" for a fresh client and the last id after appends, both replay-current', async () => {
    const store = new InMemorySSEEventStore();
    // Fresh: one below the first real id (1) — replay accepts it as a verified-current cursor.
    expect(await store.currentId('c1')).toBe('0');
    expect(await store.replay('c1', '0')).toEqual({ type: 'events', events: [] });

    await store.append('c1', 'e', 'a');
    await store.append('c1', 'e', 'b');
    expect(await store.currentId('c1')).toBe('2');
    // Resuming from the current id is an empty continuation, never a resync.
    expect(await store.replay('c1', '2')).toEqual({ type: 'events', events: [] });
  });

  it('should replay only events after the cursor', async () => {
    const store = new InMemorySSEEventStore();
    await store.append('c1', 'e', 'a');
    await store.append('c1', 'e', 'b');
    await store.append('c1', 'e', 'c');

    const result = await store.replay('c1', '1');
    expect(result).toEqual({
      type: 'events',
      events: [
        { id: '2', event: 'e', data: 'b' },
        { id: '3', event: 'e', data: 'c' },
      ],
    });
  });

  it('should resync a cursor at or past the counter (an id this epoch never assigned)', async () => {
    const store = new InMemorySSEEventStore();
    await store.append('c1', 'e', 'a');
    // '9' can only come from a previous epoch (pre-restart). Claiming a
    // verified empty continuation would strand buffered events forever —
    // resync instead, re-anchoring the cursor with a fresh id.
    expect(await store.replay('c1', '9')).toEqual({ type: 'resync', id: '2' });
    // The re-anchored cursor verifies from here on.
    expect(await store.replay('c1', '2')).toEqual({ type: 'events', events: [] });
  });

  it('should resync on a non-numeric cursor', async () => {
    const store = new InMemorySSEEventStore();
    await store.append('c1', 'e', 'a');
    expect(await store.replay('c1', 'not-a-number')).toEqual({ type: 'resync', id: '2' });
    // The buffer was cleared alongside the resync.
    expect(await store.replay('c1', '0')).toEqual({ type: 'events', events: [] });
  });

  it('should resync on a non-zero cursor with no history', async () => {
    const store = new InMemorySSEEventStore();
    expect(await store.replay('c1', '5')).toEqual({ type: 'resync', id: '1' });
    expect(await store.replay('c1', '0')).toEqual({ type: 'events', events: [] });
  });

  it('should trim the buffer window on append while connected', async () => {
    const store = new InMemorySSEEventStore({ bufferWindowMs: 5_000, isClientConnected: () => true });
    await store.append('c1', 'e', 'a');
    vi.advanceTimersByTime(6_000);
    await store.append('c1', 'e', 'b');

    const result = await store.replay('c1', '0');
    expect(result).toEqual({ type: 'events', events: [{ id: '2', event: 'e', data: 'b' }] });
  });

  it('should not trim while the client is disconnected', async () => {
    let connected = true;
    const store = new InMemorySSEEventStore({ bufferWindowMs: 5_000, isClientConnected: () => connected });
    await store.append('c1', 'e', 'a');
    connected = false;
    vi.advanceTimersByTime(6_000);
    await store.append('c1', 'e', 'b');

    const result = await store.replay('c1', '0');
    expect(result).toEqual({
      type: 'events',
      events: [
        { id: '1', event: 'e', data: 'a' },
        { id: '2', event: 'e', data: 'b' },
      ],
    });
  });

  it('should round-trip subscriptions', async () => {
    const store = new InMemorySSEEventStore();
    await store.addSubscriptions('c1', ['doc1', 'doc2']);
    expect(await store.loadSubscriptions('c1')).toEqual(['doc1', 'doc2']);

    await store.removeSubscriptions('c1', ['doc1']);
    expect(await store.loadSubscriptions('c1')).toEqual(['doc2']);
    expect(await store.loadSubscriptions('unknown')).toEqual([]);
  });

  it('should drop all client state', async () => {
    const store = new InMemorySSEEventStore();
    await store.addSubscriptions('c1', ['doc1']);
    await store.append('c1', 'e', 'a');

    await store.dropClient('c1');

    expect(await store.loadSubscriptions('c1')).toEqual([]);
    // The counter reset means a stale cursor can no longer be verified.
    expect(await store.replay('c1', '1')).toEqual({ type: 'resync', id: '1' });
  });
});
