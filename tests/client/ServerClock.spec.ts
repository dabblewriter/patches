import { describe, expect, it, vi } from 'vitest';
import { ServerClock, type ServerClockStorage } from '../../src/client/ServerClock.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function memoryStorage(initial: Record<string, string> = {}): ServerClockStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: key => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function clockAt(local: { t: number }, options: ConstructorParameters<typeof ServerClock>[0] = {}) {
  return new ServerClock({ storage: null, now: () => local.t, ...options });
}

describe('ServerClock', () => {
  it('stamps the local clock when nothing has been observed', () => {
    const local = { t: 1_000_000 };
    const clock = clockAt(local);
    expect(clock.offset).toBe(0);
    expect(clock.now()).toBe(1_000_000);
  });

  it('treats a server time inside the round trip as latency, not drift', () => {
    const local = { t: 1_000_000 };
    const clock = clockAt(local, { threshold: 0 });
    // 400ms call; server read 200ms "behind" the receive — inside the window, honest offset is 0
    clock.observe(1_000_000, 1_000_400, 1_000_200);
    expect(clock.offset).toBe(0);
  });

  it('corrects a device clock running BEHIND the server (the case the clamp cannot fix)', () => {
    const local = { t: 1_000_000 };
    const clock = clockAt(local);
    clock.observe(1_000_000, 1_000_500, 1_000_500 + 3 * DAY);
    expect(clock.offset).toBe(3 * DAY);
    expect(clock.now()).toBe(1_000_000 + 3 * DAY);
  });

  it('corrects a device clock running AHEAD of the server', () => {
    const local = { t: 5_000_000 };
    const clock = clockAt(local);
    clock.observe(5_000_000, 5_000_300, 5_000_000 - 10 * MIN);
    expect(clock.offset).toBe(-10 * MIN);
  });

  it('measures only the drift outside the round-trip window', () => {
    const clock = clockAt({ t: 0 });
    clock.observe(10_000, 12_000, 12_000 + MIN); // ahead of receive by exactly 1 min
    expect(clock.offset).toBe(MIN);
  });

  it('ignores drift under the threshold so jitter never reorders concurrent edits', () => {
    const clock = clockAt({ t: 0 });
    clock.observe(10_000, 10_100, 10_100 + 29_000);
    expect(clock.offset).toBe(0);
  });

  it('takes the median of recent samples rather than trusting the newest', () => {
    const clock = clockAt({ t: 0 }, { maxSamples: 3 });
    clock.observe(0, 100, 100 + 5 * MIN);
    clock.observe(0, 100, 100 + 5 * MIN);
    clock.observe(0, 100, 100 + 500 * DAY); // one wild sample
    expect(clock.offset).toBe(5 * MIN);
  });

  it('returns to zero once the device clock is fixed', () => {
    const clock = clockAt({ t: 0 }, { maxSamples: 3 });
    clock.observe(0, 100, 100 + 5 * MIN);
    for (let i = 0; i < 2; i++) clock.observe(0, 100, 50);
    expect(clock.offset).toBe(0);
  });

  it('skips samples it cannot trust', () => {
    const clock = clockAt({ t: 0 });
    clock.observe(1000, 500, 1000 + DAY); // local clock stepped backwards mid-request
    clock.observe(0, 100, 0); // no committedAt
    clock.observe(0, 100, NaN);
    expect(clock.offset).toBe(0);
  });

  describe('monotonic stamps', () => {
    it('never stamps behind an earlier stamp when the offset shifts down a little', () => {
      const local = { t: 1_000_000 };
      const clock = clockAt(local, { threshold: 1000, maxSamples: 1 });
      clock.observe(1_000_000, 1_000_000, 1_000_000 + 5000);
      const first = clock.now();
      clock.observe(1_000_000, 1_000_000, 1_000_000 + 4500); // offset drops by 500ms
      expect(clock.now()).toBe(first);
      local.t += 1000;
      expect(clock.now()).toBe(1_001_000 + 4500);
    });

    it('holds through a large backwards correction until the corrected clock catches up', () => {
      const local = { t: 10 * DAY };
      const clock = clockAt(local, { maxSamples: 1 });
      const fast = clock.now();
      clock.observe(10 * DAY, 10 * DAY, 10 * DAY - 2 * MIN);
      expect(clock.offset).toBe(-2 * MIN);
      expect(clock.now()).toBe(fast); // held, never behind a stamp already issued
      local.t += MIN;
      expect(clock.now()).toBe(fast);
      local.t += 2 * MIN;
      expect(clock.now()).toBe(10 * DAY + MIN); // caught up, now corrected
    });
  });

  it('takes the middle sample nearer zero for an even count instead of averaging', () => {
    const clock = clockAt({ t: 0 }, { maxSamples: 4 });
    clock.observe(0, 100, 100 + 4 * MIN);
    expect(clock.offset).toBe(4 * MIN);
    clock.observe(0, 100, 50); // honest 0 — median of [0, 4min] must not become 2min
    expect(clock.offset).toBe(0);
  });

  describe('persistence', () => {
    it('restores samples so the first offline edit after a reload is already corrected', () => {
      const storage = memoryStorage();
      const first = new ServerClock({ storage, now: () => 0 });
      first.observe(0, 100, 100 + 2 * DAY);

      const reloaded = new ServerClock({ storage, now: () => 0 });
      expect(reloaded.offset).toBe(2 * DAY);
      expect(reloaded.now()).toBe(2 * DAY);
    });

    it('drops restored samples when the first live sample says the clock was fixed', () => {
      const storage = memoryStorage();
      const first = new ServerClock({ storage, now: () => 0 });
      for (let i = 0; i < 5; i++) first.observe(0, 100, 100 + 10 * MIN);

      const reloaded = new ServerClock({ storage, now: () => 0 });
      expect(reloaded.offset).toBe(10 * MIN); // offline edits still corrected before any commit
      reloaded.observe(0, 100, 50); // the clock is right now — one sample is enough
      expect(reloaded.offset).toBe(0);
      expect(JSON.parse(storage.data['patches.serverClock']).samples).toEqual([0]);
    });

    it('keeps restored samples when the first live sample agrees with them', () => {
      const storage = memoryStorage();
      const first = new ServerClock({ storage, now: () => 0 });
      for (let i = 0; i < 3; i++) first.observe(0, 100, 100 + 10 * MIN);

      const reloaded = new ServerClock({ storage, now: () => 0 });
      reloaded.observe(0, 100, 100 + 10 * MIN + 5000);
      expect(JSON.parse(storage.data['patches.serverClock']).samples).toHaveLength(4);
    });

    it('stamps strictly after a given stamp, and continues from it', () => {
      const clock = new ServerClock({ storage: null, now: () => 1000 });
      expect(clock.now(5000)).toBe(5001);
      expect(clock.now()).toBe(5001);
      expect(clock.now(10)).toBe(5001);
    });

    it('starts uncorrected from unreadable or corrupt storage', () => {
      expect(new ServerClock({ storage: memoryStorage({ 'patches.serverClock': '{nope' }) }).offset).toBe(0);
      const throwing: ServerClockStorage = {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      };
      const clock = new ServerClock({ storage: throwing, now: () => 0 });
      expect(() => clock.observe(0, 100, 100 + DAY)).not.toThrow();
      expect(clock.offset).toBe(DAY);
    });
  });

  describe('onDrift', () => {
    it('reports crossing the threshold and recovering, not every sample', () => {
      const clock = clockAt({ t: 0 }, { maxSamples: 1 });
      const listener = vi.fn();
      clock.onDrift(listener);

      clock.observe(0, 200, 200 + 3 * DAY);
      clock.observe(0, 200, 200 + 3 * DAY + 1000); // moved by under the threshold — not reported
      clock.observe(0, 200, 150); // fixed

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[0][0]).toEqual({ offset: 3 * DAY, previousOffset: 0, sample: 3 * DAY, rtt: 200 });
      expect(listener.mock.calls[1][0]).toMatchObject({ offset: 0, previousOffset: 3 * DAY + 1000 });
    });
  });
});
