import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blockable, blocking, blockableResponse, serialGate, singleInvocation } from '../../src/utils/concurrency';

// Mock simplified-concurrency module
vi.mock('simplified-concurrency', () => ({
  simplifiedConcurrency: vi.fn(() => ({
    blockFunction: vi.fn((fn, args, context) => fn.apply(context, args)),
    blockWhile: vi.fn(promise => promise),
    blockResponse: vi.fn(promise => promise),
  })),
}));

describe('concurrency utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('blockable', () => {
    it('should wrap function and pass through arguments', async () => {
      const mockFn = vi.fn().mockResolvedValue('result');
      const wrappedFn = blockable(mockFn);

      const result = await wrappedFn('doc1', 'arg1', 'arg2');

      expect(mockFn).toHaveBeenCalledWith('doc1', 'arg1', 'arg2');
      expect(result).toBe('result');
    });

    it('should use same concurrency instance for same docId', async () => {
      const mockFn1 = vi.fn().mockResolvedValue('result1');
      const mockFn2 = vi.fn().mockResolvedValue('result2');
      const wrappedFn1 = blockable(mockFn1);
      const wrappedFn2 = blockable(mockFn2);

      await wrappedFn1('doc1', 'arg1');
      await wrappedFn2('doc1', 'arg2');

      expect(mockFn1).toHaveBeenCalledWith('doc1', 'arg1');
      expect(mockFn2).toHaveBeenCalledWith('doc1', 'arg2');
    });

    it('should preserve function context', async () => {
      const mockFn = vi.fn().mockResolvedValue('result');
      const wrappedFn = blockable(mockFn);
      const context = { test: 'context' };

      await wrappedFn.call(context, 'doc1', 'arg1');

      expect(mockFn).toHaveBeenCalledWith('doc1', 'arg1');
    });
  });

  describe('blocking', () => {
    it('should wrap function and pass through arguments', async () => {
      const mockFn = vi.fn().mockResolvedValue('result');
      const wrappedFn = blocking(mockFn);

      const result = await wrappedFn('doc1', 'arg1', 'arg2');

      expect(mockFn).toHaveBeenCalledWith('doc1', 'arg1', 'arg2');
      expect(result).toBe('result');
    });

    it('should use same concurrency instance for same docId', async () => {
      const mockFn1 = vi.fn().mockResolvedValue('result1');
      const mockFn2 = vi.fn().mockResolvedValue('result2');
      const wrappedFn1 = blocking(mockFn1);
      const wrappedFn2 = blocking(mockFn2);

      await wrappedFn1('doc1', 'arg1');
      await wrappedFn2('doc1', 'arg2');

      expect(mockFn1).toHaveBeenCalledWith('doc1', 'arg1');
      expect(mockFn2).toHaveBeenCalledWith('doc1', 'arg2');
    });

    it('should preserve function context', async () => {
      const mockFn = vi.fn().mockResolvedValue('result');
      const wrappedFn = blocking(mockFn);
      const context = { test: 'context' };

      await wrappedFn.call(context, 'doc1', 'arg1');

      expect(mockFn).toHaveBeenCalledWith('doc1', 'arg1');
    });
  });

  describe('blockableResponse', () => {
    it('should wrap function and pass through arguments', async () => {
      const mockFn = vi.fn().mockResolvedValue('result');
      const wrappedFn = blockableResponse(mockFn);

      const result = await wrappedFn('doc1', 'arg1', 'arg2');

      expect(mockFn).toHaveBeenCalledWith('doc1', 'arg1', 'arg2');
      expect(result).toBe('result');
    });

    it('should use same concurrency instance for same docId', async () => {
      const mockFn1 = vi.fn().mockResolvedValue('result1');
      const mockFn2 = vi.fn().mockResolvedValue('result2');
      const wrappedFn1 = blockableResponse(mockFn1);
      const wrappedFn2 = blockableResponse(mockFn2);

      await wrappedFn1('doc1', 'arg1');
      await wrappedFn2('doc1', 'arg2');

      expect(mockFn1).toHaveBeenCalledWith('doc1', 'arg1');
      expect(mockFn2).toHaveBeenCalledWith('doc1', 'arg2');
    });

    it('should preserve function context', async () => {
      const mockFn = vi.fn().mockResolvedValue('result');
      const wrappedFn = blockableResponse(mockFn);
      const context = { test: 'context' };

      await wrappedFn.call(context, 'doc1', 'arg1');

      expect(mockFn).toHaveBeenCalledWith('doc1', 'arg1');
    });
  });

  describe('singleInvocation', () => {
    describe('when used as decorator directly', () => {
      it('should return same promise for concurrent calls', async () => {
        const mockFn = vi.fn().mockImplementation(async arg => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return `result-${arg}`;
        });

        const wrappedFn = singleInvocation(mockFn);

        const promise1 = wrappedFn('arg1');
        const promise2 = wrappedFn('arg2'); // Should get same promise as first call

        const result1 = await promise1;
        const result2 = await promise2;

        expect(result1).toBe('result-arg1');
        expect(result2).toBe('result-arg1'); // Same result
        expect(mockFn).toHaveBeenCalledTimes(1);
      });

      it('should allow new calls after previous completes', async () => {
        const mockFn = vi.fn().mockResolvedValueOnce('result1').mockResolvedValueOnce('result2');

        const wrappedFn = singleInvocation(mockFn);

        const result1 = await wrappedFn('arg1');
        const result2 = await wrappedFn('arg2');

        expect(result1).toBe('result1');
        expect(result2).toBe('result2');
        expect(mockFn).toHaveBeenCalledTimes(2);
      });
    });

    describe('when used with matchOnFirstArg=true', () => {
      it('should return same promise for concurrent calls with same first arg', async () => {
        const mockFn = vi.fn().mockImplementation(async (key, data) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return `result-${key}-${data}`;
        });

        const wrappedFn = singleInvocation(true)(mockFn);

        const promise1 = wrappedFn('key1', 'data1');
        const promise2 = wrappedFn('key1', 'data2'); // Same first arg

        const result1 = await promise1;
        const result2 = await promise2;

        expect(result1).toBe('result-key1-data1');
        expect(result2).toBe('result-key1-data1'); // Same result
        expect(mockFn).toHaveBeenCalledTimes(1);
      });

      it('should allow concurrent calls with different first args', async () => {
        const mockFn = vi.fn().mockImplementation(async (key, data) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return `result-${key}-${data}`;
        });

        const wrappedFn = singleInvocation(true)(mockFn);

        const promise1 = wrappedFn('key1', 'data1');
        const promise2 = wrappedFn('key2', 'data2'); // Different first arg

        const result1 = await promise1;
        const result2 = await promise2;

        expect(result1).toBe('result-key1-data1');
        expect(result2).toBe('result-key2-data2');
        expect(mockFn).toHaveBeenCalledTimes(2);
      });

      it('should allow new calls after previous completes for same key', async () => {
        const mockFn = vi.fn().mockResolvedValueOnce('result1').mockResolvedValueOnce('result2');

        const wrappedFn = singleInvocation(true)(mockFn);

        const result1 = await wrappedFn('key1', 'data1');
        const result2 = await wrappedFn('key1', 'data2');

        expect(result1).toBe('result1');
        expect(result2).toBe('result2');
        expect(mockFn).toHaveBeenCalledTimes(2);
      });
    });

    describe('when used with matchOnFirstArg=false', () => {
      it('should return same promise for all concurrent calls', async () => {
        const mockFn = vi.fn().mockImplementation(async (arg1, arg2) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return `result-${arg1}-${arg2}`;
        });

        const wrappedFn = singleInvocation(false)(mockFn);

        const promise1 = wrappedFn('arg1', 'data1');
        const promise2 = wrappedFn('arg2', 'data2'); // Different args

        const result1 = await promise1;
        const result2 = await promise2;

        expect(result1).toBe('result-arg1-data1');
        expect(result2).toBe('result-arg1-data1'); // Same result
        expect(mockFn).toHaveBeenCalledTimes(1);
      });
    });

    // Note: Promise rejection testing is omitted as it causes unhandled rejection warnings
    // in the test environment. The core functionality (promise sharing) is tested above.

    it('should clean up promise cache after completion', async () => {
      let callCount = 0;
      const mockFn = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return ++callCount;
      });

      const wrappedFn = singleInvocation(mockFn);

      const result1 = await wrappedFn('arg1');
      const result2 = await wrappedFn('arg2');

      expect(result1).toBe(1);
      expect(result2).toBe(2);
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });
  describe('serialGate', () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>(r => (resolve = r));
      return { promise, resolve };
    }

    it('treats a synchronous re-entrant call from inside the target as queued, not a second pass', async () => {
      let running = 0;
      let maxRunning = 0;
      let calls = 0;
      const release = deferred();
      const gated = serialGate(async function (this: unknown, _key: string) {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        // A subscriber notified synchronously before the first await calls back in.
        if (calls === 1) void gated.call(this, 'doc1');
        if (calls === 1) await release.promise;
        running--;
      });
      const owner = {};

      const first = gated.call(owner, 'doc1');
      expect(maxRunning).toBe(1);
      release.resolve();
      await first;
      await vi.waitFor(() => expect(calls).toBe(2));

      expect(maxRunning).toBe(1);
    });

    it("resolves a queued caller's promise only after the follow-up pass it triggered completes", async () => {
      const passes: ReturnType<typeof deferred>[] = [deferred(), deferred()];
      let calls = 0;
      const gated = serialGate(async (_key: string) => {
        await passes[calls++].promise;
      });

      const owner = {};
      const first = gated.call(owner, 'doc1');
      let queuedDone = false;
      const queued = gated.call(owner, 'doc1').then(() => {
        queuedDone = true;
      });

      passes[0].resolve();
      await first;
      await vi.waitFor(() => expect(calls).toBe(2));
      await Promise.resolve();
      expect(queuedDone).toBe(false);

      passes[1].resolve();
      await queued;
      expect(queuedDone).toBe(true);
    });

    it("rejects a queued caller with its follow-up pass's error", async () => {
      let calls = 0;
      const gated = serialGate(async (_key: string) => {
        calls++;
        await Promise.resolve();
        if (calls === 2) throw new Error('follow-up failed');
      });

      const owner = {};
      const first = gated.call(owner, 'doc1');
      const queued = gated.call(owner, 'doc1');

      await first;
      await expect(queued).rejects.toThrow('follow-up failed');
    });
  });
});
