import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Change, PatchesSnapshot } from '../../src/types';

vi.mock('easy-signal', async () => {
  const actual = await vi.importActual<typeof import('easy-signal')>('easy-signal');
  return {
    ...actual,
    signal: vi.fn().mockImplementation(() => {
      const subscribers = new Set();
      const mockSignal = vi.fn().mockImplementation((callback: any) => {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      }) as any;
      mockSignal.emit = vi.fn().mockImplementation(async (...args: any[]) => {
        for (const callback of subscribers) {
          await (callback as any)(...args);
        }
      });
      mockSignal.emitError = vi.fn();
      mockSignal.clear = vi.fn().mockImplementation(() => subscribers.clear());
      return mockSignal;
    }),
  };
});

const { OTDoc } = await import('../../src/client/OTDoc');

interface TestDoc {
  title?: string;
  count?: number;
}

const makeChange = (id: string, baseRev: number, rev: number, ops: any[], committed: boolean): Change => ({
  id,
  baseRev,
  rev,
  ops,
  createdAt: Date.now(),
  committedAt: committed ? Date.now() : 0,
});

const makeSnapshot = (state: TestDoc, rev: number, changes: Change[] = []): PatchesSnapshot<TestDoc> => ({
  state,
  rev,
  changes,
});

describe('OTDoc — applyChanges echo-skip', () => {
  let doc: InstanceType<typeof OTDoc<TestDoc>>;
  let stateUpdates: number;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
    doc = new OTDoc<TestDoc>('doc-1', makeSnapshot({ title: 'hello', count: 0 }, 5));
    stateUpdates = 0;
    // Subscribe with `false` to skip the immediate initial call so we count only post-init updates.
    doc.subscribe(() => {
      stateUpdates++;
    }, false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT emit a state update when a single server change is a pure echo of the lone pending change', () => {
    // Local change applied optimistically via change()
    doc.change((patch, path) => {
      patch.replace(path.title, 'world');
    });
    expect(stateUpdates).toBe(1);
    const localOps = (doc.onChange.emit as any).mock.calls[0][0];

    // Confirm the local change (committedAt === 0) — shifts optimistic queue, no state update.
    const localChange = makeChange('c1', 5, 6, localOps, false);
    doc.applyChanges([localChange]);
    expect(stateUpdates).toBe(1);
    expect(doc.hasPending).toBe(true);

    // Server commits it back as a pure echo (same id). No new state should be emitted.
    const echoed = makeChange('c1', 5, 6, localOps, true);
    const stateBefore = doc.state;
    doc.applyChanges([echoed]);

    expect(stateUpdates).toBe(1);
    expect(doc.state).toBe(stateBefore);
    expect(doc.committedRev).toBe(6);
    expect(doc.hasPending).toBe(false);
    expect(doc.state).toEqual({ title: 'world', count: 0 });
  });

  it('emits a state update when server changes contain a foreign concurrent op (not a pure echo)', () => {
    doc.change((patch, path) => {
      patch.replace(path.title, 'mine');
    });
    expect(stateUpdates).toBe(1);
    const localOps = (doc.onChange.emit as any).mock.calls[0][0];
    const localChange = makeChange('c-local', 5, 6, localOps, false);
    doc.applyChanges([localChange]);

    // Foreign client committed first at rev 6; our change rebases to rev 7.
    const foreign = makeChange('c-foreign', 5, 6, [{ op: 'replace', path: '/count', value: 99 }], true);
    const rebasedLocal = makeChange('c-local', 6, 7, localOps, false);
    doc.applyChanges([foreign, rebasedLocal]);

    expect(stateUpdates).toBe(2);
    expect(doc.committedRev).toBe(6);
    expect(doc.state.count).toBe(99);
    expect(doc.state.title).toBe('mine');
  });

  it('emits a state update when a server change has no matching pending (cold incoming change)', () => {
    const foreign = makeChange('c-foreign', 5, 6, [{ op: 'replace', path: '/count', value: 7 }], true);
    doc.applyChanges([foreign]);

    expect(stateUpdates).toBe(1);
    expect(doc.state.count).toBe(7);
  });

  it('skips emit for a multi-change pure-echo batch but does emit when the batch is mixed', () => {
    // Two local changes
    doc.change((patch, path) => patch.replace(path.title, 'a'));
    const aOps = (doc.onChange.emit as any).mock.calls[0][0];
    doc.applyChanges([makeChange('a', 5, 6, aOps, false)]);

    doc.change((patch, path) => patch.replace(path.count, 1));
    const bOps = (doc.onChange.emit as any).mock.calls[1][0];
    doc.applyChanges([makeChange('b', 6, 7, bOps, false)]);

    expect(stateUpdates).toBe(2);

    // Pure-echo batch of both
    doc.applyChanges([makeChange('a', 5, 6, aOps, true), makeChange('b', 6, 7, bOps, true)]);
    expect(stateUpdates).toBe(2);
    expect(doc.committedRev).toBe(7);
    expect(doc.hasPending).toBe(false);
  });
});

describe('OTDoc — import preserves optimistic ops', () => {
  let doc: InstanceType<typeof OTDoc<TestDoc>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
    doc = new OTDoc<TestDoc>('doc-1', makeSnapshot({ title: 'hello', count: 0 }, 5));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves outstanding optimistic ops when importing a fresher snapshot (no text-jump)', () => {
    // Mid-typing: change() pushes ops onto _optimisticOps, no local-confirmation yet.
    doc.change((patch, path) => patch.replace(path.title, 'world'));
    doc.change((patch, path) => patch.replace(path.count, 42));
    expect(doc.state).toEqual({ title: 'world', count: 42 });

    // Fresher snapshot for an unrelated field — must NOT regress in-flight typing.
    doc.import(makeSnapshot({ title: 'hello', count: 0 }, 10));

    expect(doc.committedRev).toBe(10);
    expect(doc.state).toEqual({ title: 'world', count: 42 });
  });

  it('drops optimistic ops that no longer apply cleanly to the imported state', () => {
    // Seed an optimistic op that removes `title`. The op is recorded in _optimisticOps.
    doc.change((patch, path) => patch.remove(path.title));
    expect(doc.state).toEqual({ count: 0 });

    // Imported snapshot has no `title` either — replaying the remove against a
    // missing path throws under strict mode, so the op is dropped.
    doc.import(makeSnapshot({ count: 99 } as TestDoc, 10));

    expect(doc.committedRev).toBe(10);
    expect(doc.state).toEqual({ count: 99 });
  });

  it('ignores stale snapshots whose rev is older than current committedRev', () => {
    // doc starts at rev 5
    doc.import(makeSnapshot({ title: 'stale' }, 3));

    expect(doc.committedRev).toBe(5);
    expect(doc.state).toEqual({ title: 'hello', count: 0 });
  });
});
