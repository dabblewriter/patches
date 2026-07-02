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

describe('BaseDoc — flush()', () => {
  let doc: InstanceType<typeof OTDoc<TestDoc>>;

  beforeEach(() => {
    vi.clearAllMocks();
    doc = new OTDoc<TestDoc>('doc-1', makeSnapshot({ title: 'hello', count: 0 }, 5));
  });

  it('resolves immediately when standalone (no awaiter wired, no optimistic ops)', async () => {
    await expect(doc.flush()).resolves.toBeUndefined();
  });

  it('awaits the wired tail promise before resolving', async () => {
    let resolveTail!: () => void;
    const tail = new Promise<void>(r => {
      resolveTail = r;
    });
    doc._setFlushAwaiter(() => tail);

    let flushed = false;
    const flushPromise = doc.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    resolveTail();
    await flushPromise;
    expect(flushed).toBe(true);
  });

  it('drains a fresh tail that appears during the await', async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstTail = new Promise<void>(r => {
      resolveFirst = r;
    });
    const secondTail = new Promise<void>(r => {
      resolveSecond = r;
    });

    let current = firstTail;
    doc._setFlushAwaiter(() => current);

    let flushed = false;
    const flushPromise = doc.flush().then(() => {
      flushed = true;
    });

    // Swap in a new tail (simulating a new change() being queued mid-flush)
    current = secondTail;
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);

    resolveSecond();
    await flushPromise;
    expect(flushed).toBe(true);
  });

  it('resolves once optimistic ops drain via applyChanges (local-confirm path)', async () => {
    doc._setFlushAwaiter(() => undefined);

    // Push an optimistic op without going through the queue
    doc.change((patch, path) => patch.replace(path.title, 'world'));
    const localOps = (doc.onChange.emit as any).mock.calls[0][0];
    expect((doc as any)._optimisticOps.length).toBe(1);

    // Without confirmation flush would spin; confirm the change, draining the op.
    doc.applyChanges([makeChange('c1', 5, 6, localOps, false)]);
    expect((doc as any)._optimisticOps.length).toBe(0);

    await expect(doc.flush()).resolves.toBeUndefined();
  });

  it('resolves after rollbackOptimistic clears outstanding ops', async () => {
    doc._setFlushAwaiter(() => undefined);

    doc.change((patch, path) => patch.replace(path.title, 'world'));
    expect((doc as any)._optimisticOps.length).toBe(1);

    doc.rollbackOptimistic();
    expect((doc as any)._optimisticOps.length).toBe(0);

    await expect(doc.flush()).resolves.toBeUndefined();
  });
});

interface ListDoc {
  items: string[];
}

// Finding #29: a server change landing between change() and its queued mint must rebase
// the still-unminted optimistic ops — IN PLACE, since the queued mint holds the same array
// change() emitted. Otherwise _recomputeState re-applies raw ops position-shifted and the
// mint stamps them at the post-server committedRev, committing misplaced ops verbatim.
describe('OTDoc — optimistic ops rebase over interleaved server changes', () => {
  let doc: InstanceType<typeof OTDoc<ListDoc>>;

  beforeEach(() => {
    vi.clearAllMocks();
    doc = new OTDoc<ListDoc>('doc-1', { state: { items: ['a', 'b', 'c'] }, rev: 1, changes: [] });
  });

  it('rebases unminted optimistic ops (and the emitted array) when a foreign change arrives first', () => {
    doc.change(patch => patch.add('/items/1', 'X'));
    const emittedOps = (doc.onChange.emit as any).mock.calls[0][0];

    doc.applyChanges([makeChange('c-foreign', 1, 2, [{ op: 'add', path: '/items/0', value: 'Z' }], true)]);

    expect(doc.state.items).toEqual(['Z', 'a', 'X', 'b', 'c']);
    // The queued mint shares this array; it must now mint the rebased op.
    expect(emittedOps).toEqual([{ op: 'add', path: '/items/2', value: 'X' }]);
  });

  it('threads the foreign op past the pending queue before rebasing optimistic ops', () => {
    doc = new OTDoc<ListDoc>('doc-1', {
      state: { items: ['a', 'b', 'c'] },
      rev: 1,
      changes: [makeChange('c-p', 1, 2, [{ op: 'add', path: '/items/1', value: 'P' }], false)],
    });
    doc.change(patch => patch.add('/items/3', 'X'));
    const emittedOps = (doc.onChange.emit as any).mock.calls[0][0];

    // Server committed a foreign change at rev 2; our pending change rebased to rev 3.
    doc.applyChanges([
      makeChange('c-foreign', 1, 2, [{ op: 'add', path: '/items/0', value: 'Z' }], true),
      makeChange('c-p', 2, 3, [{ op: 'add', path: '/items/2', value: 'P' }], false),
    ]);

    expect(doc.state.items).toEqual(['Z', 'a', 'P', 'b', 'X', 'c']);
    expect(emittedOps).toEqual([{ op: 'add', path: '/items/4', value: 'X' }]);
  });

  it('drops (and empties in place) optimistic ops a server change invalidates, without throwing', () => {
    doc.change(patch => patch.add('/items/1', 'X'));
    const emittedOps = (doc.onChange.emit as any).mock.calls[0][0];

    doc.applyChanges([makeChange('c-foreign', 1, 2, [{ op: 'replace', path: '/items', value: ['q'] }], true)]);

    expect(doc.committedRev).toBe(2);
    expect(doc.state.items).toEqual(['q']);
    // Emptied in place so the queued mint sees no ops and skips.
    expect(emittedOps).toEqual([]);
    expect((doc as any)._optimisticOps).toEqual([]);
  });

  it('leaves optimistic ops untouched on a pure echo of pending changes', () => {
    doc.change(patch => patch.add('/items/-', 'M'));
    const mintedOps = (doc.onChange.emit as any).mock.calls[0][0];
    doc.applyChanges([makeChange('c-mine', 1, 2, mintedOps, false)]);

    doc.change(patch => patch.add('/items/-', 'N'));
    const optimisticOps = (doc.onChange.emit as any).mock.calls[1][0];

    doc.applyChanges([makeChange('c-mine', 1, 2, mintedOps, true)]);

    expect(optimisticOps).toEqual([{ op: 'add', path: '/items/-', value: 'N' }]);
    expect(doc.state.items).toEqual(['a', 'b', 'c', 'M', 'N']);
  });
});

// Regression repro for SNAPIMP-1 (sync data-loss audit, 2026-06-24; live report DABBLE-WRITER-3-42
// "manuscript changes revert and then duplicate / add other characters").
//
// In the DW3 spoke, the `'changes'` listener's rev-mismatch recovery (src/stores/patches.ts) does
// `recoveringDocs.add(docId)` then `loadDoc(docId).then(doc.import)`, and while that RPC is in
// flight it DROPS the doc's own local-change broadcasts. The local broadcast is what would normally
// shift a typed op out of `_optimisticOps` (via applyChanges). Because it is dropped, the op stays
// in `_optimisticOps`. Meanwhile the hub already persisted that op (savePendingChanges runs BEFORE
// the broadcast), so `loadDoc` returns it inside `snapshot.changes`. `import()` then applies the op
// TWICE — once via createStateFromSnapshot (snapshot.changes -> _pendingChanges) and again from the
// surviving `_optimisticOps` — with no de-dup by change id. The result is duplicated content.
//
// An array append is used here because it is non-idempotent and dependency-free; the editor's
// real `@dabble/delta` `@txt` text ops duplicate identically, and the same path duplicates plot/
// structure cards (cf. the 34-vs-45 plot-card loss class).
describe('OTDoc — import() must not double-apply a stranded optimistic op the snapshot already holds (SNAPIMP-1)', () => {
  it('does not duplicate a typed op that the recovery snapshot already contains as pending', () => {
    const doc = new OTDoc<ListDoc>('doc-snapimp', { state: { items: ['a'] }, rev: 5, changes: [] });

    // User types: additive op applied optimistically and parked in _optimisticOps. Its echo
    // broadcast (which would shift it out) is dropped by the recovery guard, so it stays parked.
    doc.change(patch => patch.add('/items/-', 'b'));
    expect(doc.state.items).toEqual(['a', 'b']);
    expect((doc as any)._optimisticOps.length).toBe(1);

    // What loadDoc() returns from the hub mid-recovery: the hub had already persisted the typed op,
    // so it comes back as a pending change on the same committedRev (committedAt 0 = not yet server-committed).
    const recoverySnapshot: PatchesSnapshot<ListDoc> = {
      state: { items: ['a'] },
      rev: 5,
      changes: [makeChange('c1', 5, 6, [{ op: 'add', path: '/items/-', value: 'b' }], false)],
    };

    doc.import(recoverySnapshot);

    // Current (buggy) behaviour produces ['a', 'b', 'b'] — the typed 'b' is duplicated.
    expect(doc.state.items).toEqual(['a', 'b']);
  });
});
