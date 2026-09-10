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

describe('OTDoc — hydration with corrupt pending', () => {
  it('captures dropped pending changes on droppedPendingChanges instead of silently discarding them', () => {
    // c-bad is a text op against a target that is not a Delta — the realistic corrupt
    // shape (a @txt op pending against a body whose structure changed under it), and one
    // of the few op classes strict apply actually rejects (plain replace/remove on
    // missing paths do NOT throw). c-good applies cleanly. The drop keeps the queue
    // flushable (a change the local state rejects would also be rejected server-side
    // and wedge every commit behind it), but the payload must survive for
    // Patches.openDoc to surface — silent drops are user work destroyed with zero signal.
    const bad = makeChange('c-bad', 5, 6, [{ op: '@txt', path: '/title', value: 'typed words' }], false);
    const good = makeChange('c-good', 5, 7, [{ op: 'replace', path: '/title', value: 'kept' }], false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const doc = new OTDoc<TestDoc>('doc-1', makeSnapshot({ title: 'hello', count: 0 }, 5, [bad, good]));

    expect(doc.getPendingChanges()).toEqual([good]);
    expect(doc.droppedPendingChanges).toEqual([bad]);
    expect(doc.state).toEqual({ title: 'kept', count: 0 });
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it('leaves droppedPendingChanges empty on a clean hydration', () => {
    const good = makeChange('c-good', 5, 6, [{ op: 'replace', path: '/title', value: 'kept' }], false);
    const doc = new OTDoc<TestDoc>('doc-1', makeSnapshot({ title: 'hello' }, 5, [good]));

    expect(doc.droppedPendingChanges).toEqual([]);
    expect(doc.getPendingChanges()).toEqual([good]);
  });
});

describe('BaseDoc — optimisticBatchCount', () => {
  it('counts in-flight optimistic batches that hasPending cannot see', () => {
    const doc = new OTDoc<TestDoc>('doc-1', makeSnapshot({ title: 'hello', count: 0 }, 5));
    expect(doc.optimisticBatchCount).toBe(0);

    doc.change((patch, path) => patch.replace(path.title, 'world'));

    // The exact window that produced DAB-854 false positives: `state` carries the op,
    // the pending queue does not, and hasPending reads false.
    expect(doc.hasPending).toBe(false);
    expect(doc.optimisticBatchCount).toBe(1);

    // Local confirmation moves the change into pending and shifts the optimistic queue.
    const ops = (doc.onChange.emit as any).mock.calls[0][0];
    doc.applyChanges([makeChange('c1', 5, 6, ops, false)]);
    expect(doc.optimisticBatchCount).toBe(0);
    expect(doc.hasPending).toBe(true);
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

  it('keeps optimistic ops a non-conflicting foreign change leaves untransformed', () => {
    // transformPatch returns its input array by IDENTITY when nothing needs
    // transforming, so the rebased entry can alias the live optimistic array.
    // The in-place refill must copy first — clearing the alias destroyed
    // unconflicting in-flight ops entirely: state reverted, the mint sent
    // nothing, and the typed text silently never reached the server (DAB-828).
    doc.change(patch => patch.add('/items/-', 'X'));
    const emittedOps = (doc.onChange.emit as any).mock.calls[0][0];

    doc.applyChanges([makeChange('c-foreign', 1, 2, [{ op: 'add', path: '/other', value: 'Z' }], true)]);

    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X']);
    expect(emittedOps).toEqual([{ op: 'add', path: '/items/-', value: 'X' }]);
    expect((doc as any)._optimisticOps).toEqual([[{ op: 'add', path: '/items/-', value: 'X' }]]);
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

/**
 * Outbox entries (storage hardening A1): an optimistic entry the store refused is sent from
 * memory under a stable id and has NO pending row, so its committed echo is the one thing that
 * can confirm it. The doc must recognise that echo as its own — drop the entry, never transform
 * it against its committed copy — or the change applies twice.
 */
describe('OTDoc — outbox entries confirmed by their committed echo', () => {
  let doc: InstanceType<typeof OTDoc<ListDoc>>;
  let stateUpdates: number;

  beforeEach(() => {
    vi.clearAllMocks();
    doc = new OTDoc<ListDoc>('doc-1', { state: { items: ['a', 'b', 'c'] }, rev: 1, changes: [] });
    stateUpdates = 0;
    doc.subscribe(() => stateUpdates++, false);
  });

  /** Type an append, hand its entry to the outbox, and return the live ops array. */
  function typeUnstored(id: string, value: string): any[] {
    doc.change(patch => patch.add('/items/-', value));
    const calls = (doc.onChange.emit as any).mock.calls;
    const ops = calls[calls.length - 1][0];
    doc._markUnstored(id, ops);
    return ops;
  }

  it('a pure echo drops the entry without emitting or re-applying (state is data-identical)', () => {
    const ops = typeUnstored('u1', 'X');
    expect(doc.unstoredChangeIds).toEqual(['u1']);
    const emitsBefore = stateUpdates;

    doc.applyChanges([makeChange('u1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);

    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X']); // once, not twice
    expect(doc.committedRev).toBe(2);
    expect((doc as any)._optimisticOps).toEqual([]);
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(ops).toEqual([]); // emptied in place so a queued mint skips it
    expect(stateUpdates).toBe(emitsBefore); // pure echo: no spurious update mid-typing
  });

  it('a mixed batch drops the echoed entry and rebases later entries against the foreign change only', () => {
    typeUnstored('u1', 'X');
    doc.change(patch => patch.add('/items/1', 'Y')); // typed after, still memory-only (not queued yet)
    const laterOps = (doc.onChange.emit as any).mock.calls[1][0];
    expect(doc.state.items).toEqual(['a', 'Y', 'b', 'c', 'X']);

    // Foreign insert at 0 committed at rev 2, then our outbox row at rev 3 (transformed by the
    // server against the foreign change — an append is unaffected).
    doc.applyChanges([
      makeChange('c-foreign', 1, 2, [{ op: 'add', path: '/items/0', value: 'Z' }], true),
      makeChange('u1', 1, 3, [{ op: 'add', path: '/items/-', value: 'X' }], true),
    ]);

    expect(doc.committedRev).toBe(3);
    // X exactly once (from the committed copy), Y shifted by Z only — NOT re-expressed over X.
    expect(doc.state.items).toEqual(['Z', 'a', 'Y', 'b', 'c', 'X']);
    expect(laterOps).toEqual([{ op: 'add', path: '/items/2', value: 'Y' }]);
    expect((doc as any)._optimisticOps).toEqual([laterOps]);
    expect(doc.unstoredChangeIds).toEqual([]);
  });

  it('a later entry is NOT transformed against the echoed row (its frame already includes it)', () => {
    typeUnstored('u1', 'X'); // appended: ['a','b','c','X']
    doc.change(patch => patch.add('/items/0', 'W')); // on top of X: ['W','a','b','c','X']
    const laterOps = (doc.onChange.emit as any).mock.calls[1][0];

    // The server committed a foreign insert at 1, then our row (appended, unaffected).
    doc.applyChanges([
      makeChange('c-foreign', 1, 2, [{ op: 'add', path: '/items/1', value: 'Z' }], true),
      makeChange('u1', 1, 3, [{ op: 'add', path: '/items/-', value: 'X' }], true),
    ]);

    // W stays at 0. Had the echo been walked as foreign, W would ALSO have been transformed
    // against an insert it was already expressed on top of.
    expect(doc.state.items).toEqual(['W', 'a', 'Z', 'b', 'c', 'X']);
    expect(laterOps).toEqual([{ op: 'add', path: '/items/0', value: 'W' }]);
  });

  it('a later entry keeps its index when the echoed row is an insert before it', () => {
    typeUnstored('u1', 'X'); // ['a','b','c','X']
    doc.change(patch => patch.add('/items/4', 'Y')); // after X: ['a','b','c','X','Y']
    const laterOps = (doc.onChange.emit as any).mock.calls[1][0];

    doc.applyChanges([makeChange('u1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);
    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X', 'Y']);

    // Now a foreign insert lands AFTER the echo; only it may move Y.
    doc.applyChanges([makeChange('c-foreign', 2, 3, [{ op: 'add', path: '/items/0', value: 'Z' }], true)]);
    expect(doc.state.items).toEqual(['Z', 'a', 'b', 'c', 'X', 'Y']);
    expect(laterOps).toEqual([{ op: 'add', path: '/items/5', value: 'Y' }]);
  });

  it('a mixed batch where the echoed row is an insert must not shift entries typed on top of it', () => {
    doc.change(patch => patch.add('/items/0', 'X')); // ['X','a','b','c']
    const calls = (doc.onChange.emit as any).mock.calls;
    doc._markUnstored('u1', calls[calls.length - 1][0]);
    doc.change(patch => patch.add('/items/2', 'Y')); // ['X','a','Y','b','c']
    const laterOps = calls[calls.length - 1][0];

    doc.applyChanges([
      makeChange('c-foreign', 1, 2, [{ op: 'add', path: '/items/-', value: 'Z' }], true),
      makeChange('u1', 1, 3, [{ op: 'add', path: '/items/0', value: 'X' }], true),
    ]);

    // Y was expressed on top of X; walking X's echo as foreign would push Y to index 3.
    expect(doc.state.items).toEqual(['X', 'a', 'Y', 'b', 'c', 'Z']);
    expect(laterOps).toEqual([{ op: 'add', path: '/items/2', value: 'Y' }]);
  });

  it('without the outbox mark the same echo would be treated as foreign and double-apply (control)', () => {
    doc.change(patch => patch.add('/items/-', 'X'));
    doc.applyChanges([makeChange('u1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);
    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X', 'X']); // the hazard the mark exists to prevent
  });

  it('a foreign change arriving before the echo rebases the entry in place, so the outbox sends the rebased ops', () => {
    const ops = typeUnstored('u1', 'X');
    doc.change(patch => patch.add('/items/0', 'W'));
    doc.applyChanges([makeChange('c-foreign', 1, 2, [{ op: 'add', path: '/items/1', value: 'Z' }], true)]);

    expect(doc.unstoredChangeIds).toEqual(['u1']); // still ours, still queued
    expect(ops).toEqual([{ op: 'add', path: '/items/-', value: 'X' }]);
    expect(doc.state.items).toEqual(['W', 'a', 'Z', 'b', 'c', 'X']);
  });

  it('_forgetUnstored hands the entry back to the normal local-confirm path (store accepted it after all)', () => {
    const ops = typeUnstored('u1', 'X');
    doc._forgetUnstored('u1');
    expect(doc.unstoredChangeIds).toEqual([]);

    doc.applyChanges([makeChange('u1', 1, 2, ops, false)]); // local confirm: shifts the entry
    expect(doc.hasPending).toBe(true);
    doc.applyChanges([makeChange('u1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);
    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X']);
    expect((doc as any)._optimisticOps).toEqual([]);
  });

  it('_dropUnstored removes the entry from the queue without recomputing state', () => {
    const ops = typeUnstored('u1', 'X');
    const emitsBefore = stateUpdates;
    expect(doc._dropUnstored(['u1', 'not-queued'])).toEqual(['u1']);
    expect((doc as any)._optimisticOps).toEqual([]);
    expect(ops).toEqual([]);
    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X']); // untouched until the caller re-syncs
    expect(stateUpdates).toBe(emitsBefore);
  });

  it('_noteUnstoredCommitted at or below committedRev drops the duplicate now', () => {
    typeUnstored('u1', 'X');
    // The doc caught up by import (a follower reloading from the store): the snapshot already
    // holds X, so the surviving entry is re-applied on top — a visible duplicate...
    doc.import({ state: { items: ['a', 'b', 'c', 'X'] }, rev: 2, changes: [] });
    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X', 'X']);
    // ...until the writer's report names the rev the row committed at.
    doc._noteUnstoredCommitted('u1', 2);
    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X']);
    expect(doc.unstoredChangeIds).toEqual([]);
  });

  it('_noteUnstoredCommitted ahead of committedRev makes the import that covers it drop the entry', () => {
    typeUnstored('u1', 'X');
    doc._noteUnstoredCommitted('u1', 2);
    expect(doc.unstoredChangeIds).toEqual(['u1']); // not yet in this doc's state

    doc.import({ state: { items: ['a', 'b', 'c', 'X'] }, rev: 2, changes: [] });
    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X']); // not duplicated
    expect(doc.unstoredChangeIds).toEqual([]);
  });

  it('rollbackOptimistic clears the outbox bookkeeping with the queue', () => {
    typeUnstored('u1', 'X');
    doc.rollbackOptimistic();
    expect(doc.unstoredChangeIds).toEqual([]);
    expect(doc.state.items).toEqual(['a', 'b', 'c']);
  });

  it('_markUnstored ignores an array that is not in the optimistic queue', () => {
    doc._markUnstored('ghost', [{ op: 'add', path: '/items/-', value: 'G' }]);
    expect(doc.unstoredChangeIds).toEqual([]);
  });
});
