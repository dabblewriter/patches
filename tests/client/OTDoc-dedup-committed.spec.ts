import { describe, expect, it, vi } from 'vitest';
import type { Change } from '../../src/types';

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

interface ListDoc {
  items: string[];
  other?: string;
}

const makeChange = (id: string, baseRev: number, rev: number, ops: any[], committed: boolean): Change => ({
  id,
  baseRev,
  rev,
  ops,
  createdAt: Date.now(),
  committedAt: committed ? Date.now() : 0,
});

/**
 * DAB-1366: the OT client counts its own in-flight insert twice under a slow store, so the next
 * index it mints is one past committed head. Four support tickets (DAB-1064-A, DAB-1235,
 * DAB-1338, DAB-1355) are this one defect in four containers; in arrays it is destructive,
 * because the server commits the out-of-range `add` unchecked and every client then fails strict
 * replay at that rev forever.
 *
 * Two paths in OTDoc can produce the double-count, and both are exercised here against the
 * exact state a lagging `[docs]` transaction hands the doc:
 *
 *  1. A pending row the committed tier already contains is handed back in `rebasedPending`
 *     (the store has not yet marked it committed). `applyPendingForView` strict-applies it a
 *     second time — a re-applied `add` never throws — on the next rebuild.
 *  2. An own change's committed echo arrives before its local mint confirmation and carries no
 *     outbox mark, so it is treated as foreign: `_rebaseOptimisticOps` transforms the optimistic
 *     op against its own committed copy and the doc applies it twice.
 *
 * Either way `items.length` reads one higher than committed head, and the next mint overshoots.
 */
describe('OTDoc — a pending row the committed tier already holds must not apply twice (DAB-1366)', () => {
  it('drops a just-committed row that the lagging store still hands back as pending', () => {
    // Hydrated with one pending append: view is committed + pending.
    const pendingX = makeChange('x', 10, 11, [{ op: 'add', path: '/items/-', value: 'c' }], false);
    const doc = new OTDoc<ListDoc>('doc-1', { state: { items: ['a', 'b'] }, rev: 10, changes: [pendingX] });
    expect(doc.state.items).toEqual(['a', 'b', 'c']);

    // The server echoes X as rev 11. The store's `[docs]` transaction that retires X from the
    // pending tier has not settled, so the algorithm hands X straight back as rebased pending.
    const committedX = makeChange('x', 10, 11, [{ op: 'add', path: '/items/-', value: 'c' }], true);
    doc.applyChanges([committedX, pendingX]);
    expect(doc.committedRev).toBe(11);
    expect(doc.state.items).toEqual(['a', 'b', 'c']); // pure echo: view untouched

    // A foreign change lands while the store is STILL lagging, so the algorithm hands X back
    // yet again as rebased pending. The rebuild this triggers must not re-apply X on top of
    // the committed copy it already holds.
    const foreignY = makeChange('y', 11, 12, [{ op: 'add', path: '/other', value: 'z' }], true);
    doc.applyChanges([foreignY, pendingX]);

    expect(doc.state.items).toEqual(['a', 'b', 'c']); // not ['a','b','c','c']
    expect(doc.state.items.length).toBe(3); // the length the next mint will read
    expect((doc as any)._pendingChanges.map((c: Change) => c.id)).not.toContain('x'); // and it's gone
  });

  it('keeps an indexed structural append at the committed index (the children/N shape)', () => {
    // Heather / Wayne / Rose: `add /docs/<parent>/children/<n>` where n is minted from
    // `children.length`. A doubled row makes the view one longer than committed head, so the
    // NEXT append is minted at head+1 and the server commits it out of range.
    const pendingX = makeChange('x', 10, 11, [{ op: 'add', path: '/items/2', value: 'c' }], false);
    const doc = new OTDoc<ListDoc>('doc-2', { state: { items: ['a', 'b'] }, rev: 10, changes: [pendingX] });

    doc.applyChanges([makeChange('x', 10, 11, [{ op: 'add', path: '/items/2', value: 'c' }], true), pendingX]);
    doc.applyChanges([makeChange('y', 11, 12, [{ op: 'add', path: '/other', value: 'z' }], true), pendingX]);

    expect(doc.state.items).toEqual(['a', 'b', 'c']);
    // Committed head has 3 entries, so the next append must be minted at index 3, never 4.
    expect(doc.state.items.length).toBe(3);
  });

  it('does not let a stale row survive into a later hydration either (import path)', () => {
    const pendingX = makeChange('x', 10, 11, [{ op: 'add', path: '/items/-', value: 'c' }], false);
    const doc = new OTDoc<ListDoc>('doc-3', { state: { items: ['a', 'b'] }, rev: 10, changes: [pendingX] });
    doc.applyChanges([makeChange('x', 10, 11, [{ op: 'add', path: '/items/-', value: 'c' }], true), pendingX]);

    // A recovery snapshot arrives whose state already contains X (rev 11) but whose pending list,
    // read from the same lagging store, still carries X.
    doc.import({ state: { items: ['a', 'b', 'c'] }, rev: 11, changes: [pendingX] });

    expect(doc.state.items).toEqual(['a', 'b', 'c']);
  });
});

describe('OTDoc — an own echo that beats its mint is recognised, not transformed against itself (DAB-1366)', () => {
  it('drops the optimistic op when its committed echo arrives before the local mint confirmation', () => {
    const doc = new OTDoc<ListDoc>('doc-4', { state: { items: ['a', 'b', 'c'] }, rev: 1, changes: [] });

    // change() applies optimistically and parks the ops. The store's mint write is slow, so the
    // doc has not yet been told this is pending (no `applyChanges([local])` yet) and it never
    // went through the outbox, so there is no `_markUnstored` either.
    doc.change(patch => patch.add('/items/-', 'X'));
    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X']);
    expect((doc as any)._optimisticOps.length).toBe(1);

    // Its committed echo lands first.
    doc.applyChanges([makeChange('u1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);

    expect(doc.state.items).toEqual(['a', 'b', 'c', 'X']); // once — this is the line-571 hazard, fixed
    expect((doc as any)._optimisticOps).toEqual([]);
    expect(doc.committedRev).toBe(2);
  });

  it('keeps an indexed optimistic insert at its committed index instead of shifting it by itself', () => {
    const doc = new OTDoc<ListDoc>('doc-5', { state: { items: ['a', 'b', 'c'] }, rev: 1, changes: [] });

    doc.change(patch => patch.add('/items/1', 'X'));
    expect(doc.state.items).toEqual(['a', 'X', 'b', 'c']);

    // Treated as foreign, `_rebaseOptimisticOps` would transform `add /items/1` against the
    // identical committed `add /items/1` and land the optimistic copy at /items/2.
    doc.applyChanges([makeChange('u1', 1, 2, [{ op: 'add', path: '/items/1', value: 'X' }], true)]);

    expect(doc.state.items).toEqual(['a', 'X', 'b', 'c']);
    expect((doc as any)._optimisticOps).toEqual([]);
  });

  it('still rebases a genuinely foreign change that merely resembles nothing we typed', () => {
    // Guard against over-matching: a foreign op on a different path must still be treated as
    // foreign and the optimistic op must be rebased past it.
    const doc = new OTDoc<ListDoc>('doc-6', { state: { items: ['a', 'b', 'c'] }, rev: 1, changes: [] });

    doc.change(patch => patch.add('/items/-', 'X'));
    doc.applyChanges([makeChange('f1', 1, 2, [{ op: 'add', path: '/items/0', value: 'W' }], true)]);

    expect(doc.state.items).toEqual(['W', 'a', 'b', 'c', 'X']);
    expect((doc as any)._optimisticOps.length).toBe(1); // ours is still in flight, rebased
  });

  it('a later, structurally identical local edit is NOT swallowed by an unrelated echo of the same ops', () => {
    // Two genuinely distinct appends of the same value: the echo of the first must confirm only
    // one of them. Mirrors the "consume each match at most once" rule import() already applies.
    const doc = new OTDoc<ListDoc>('doc-7', { state: { items: ['a'] }, rev: 1, changes: [] });

    doc.change(patch => patch.add('/items/-', 'X'));
    doc.change(patch => patch.add('/items/-', 'X'));
    expect(doc.state.items).toEqual(['a', 'X', 'X']);
    expect((doc as any)._optimisticOps.length).toBe(2);

    doc.applyChanges([makeChange('u1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);

    expect(doc.state.items).toEqual(['a', 'X', 'X']); // second X is still ours and still shown
    expect((doc as any)._optimisticOps.length).toBe(1);
  });
});

describe('OTDoc — review regressions on the DAB-1366 fix', () => {
  it('the echo of a MINTED change must not adopt a parked op that merely looks identical', () => {
    // First X is minted (pending row u1); second X is still optimistic. u1's echo confirms u1 by
    // id. It must NOT be matched structurally against the parked second X — that would empty the
    // second edit in place (its mint then skips it) and it would be silently lost.
    const doc = new OTDoc<ListDoc>('doc-8', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => patch.add('/items/-', 'X'));
    const first = (doc as any)._optimisticOps[0];
    doc.applyChanges([makeChange('u1', 1, 2, first, false)]); // local mint confirmation → pending
    doc.change(patch => patch.add('/items/-', 'X'));
    const second = (doc as any)._optimisticOps[0];
    expect(doc.state.items).toEqual(['a', 'X', 'X']);

    doc.applyChanges([makeChange('u1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);

    expect(second).toEqual([{ op: 'add', path: '/items/-', value: 'X' }]); // NOT emptied
    expect((doc as any)._optimisticOps).toContain(second); // still in flight
    expect(doc.state.items).toEqual(['a', 'X', 'X']);
    // and a later rebuild still shows both
    doc.applyChanges([makeChange('y', 2, 3, [{ op: 'add', path: '/other', value: 'z' }], true)]);
    expect(doc.state.items).toEqual(['a', 'X', 'X']);
  });

  it('a late mint confirmation for a server-transformed echo retires the parked op instead of stranding it', () => {
    // Optimistic add at 1; a foreign add at 0 commits first, so the server transforms ours to
    // /items/2 and the echo no longer matches the parked ops structurally. The parked op is
    // treated as foreign-rebased and stays in the queue (double-applying). When the local mint
    // confirmation finally arrives for the already-committed id it must retire THAT entry by
    // reference and rebuild — not return early and leave `optimisticBatchCount` stuck.
    const doc = new OTDoc<ListDoc>('doc-9', { state: { items: ['a', 'b'] }, rev: 1, changes: [] });
    doc.change(patch => patch.add('/items/1', 'X'));
    const ops = (doc as any)._optimisticOps[0];

    doc.applyChanges([
      makeChange('f', 1, 2, [{ op: 'add', path: '/items/0', value: 'W' }], true),
      makeChange('u1', 1, 3, [{ op: 'add', path: '/items/2', value: 'X' }], true),
    ]);
    expect((doc as any)._optimisticOps.length).toBe(1); // known gap: transformed echo not adopted

    doc.applyChanges([makeChange('u1', 1, 3, ops, false)]); // late local mint confirmation

    expect((doc as any)._optimisticOps).toEqual([]); // drained — flush() can resolve
    expect(doc.optimisticBatchCount).toBe(0);
    expect((doc as any)._pendingChanges).toEqual([]); // not re-queued
    expect(doc.state.items).toEqual(['W', 'a', 'X', 'b']); // doubled copy gone on the rebuild
  });

  it('a late mint confirmation does not shift a DIFFERENT still-in-flight edit', () => {
    // The adopted echo already retired op A. A's late confirmation must not take op B by a blind
    // shift.
    const doc = new OTDoc<ListDoc>('doc-10', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => patch.add('/items/-', 'A'));
    const opsA = (doc as any)._optimisticOps[0];
    doc.change(patch => patch.add('/items/-', 'B'));
    const opsB = (doc as any)._optimisticOps[1];

    doc.applyChanges([makeChange('u1', 1, 2, [{ op: 'add', path: '/items/-', value: 'A' }], true)]); // adopts A
    expect((doc as any)._optimisticOps).toEqual([opsB]);

    doc.applyChanges([makeChange('u1', 1, 2, opsA, false)]); // late confirmation for A (ops now [])

    expect((doc as any)._optimisticOps).toEqual([opsB]); // B untouched
    expect(doc.state.items).toEqual(['a', 'A', 'B']);
  });

  it('a batch that fails strict apply mutates nothing — no phantom outbox mark, op still parked intact', () => {
    const doc = new OTDoc<ListDoc>('doc-11', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => patch.add('/items/-', 'X'));
    const ops = (doc as any)._optimisticOps[0];

    // Poison batch: an echo that would structurally adopt our op, plus an out-of-range index.
    expect(() =>
      doc.applyChanges([
        makeChange('u1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true),
        makeChange('p', 2, 3, [{ op: 'add', path: '/items/9', value: 'Q' }], true),
      ])
    ).toThrow();

    expect(doc.committedRev).toBe(1);
    expect(doc.unstoredChangeIds).toEqual([]); // no mark left behind
    expect((doc as any)._optimisticOps).toEqual([ops]);
    expect(ops).toEqual([{ op: 'add', path: '/items/-', value: 'X' }]); // not emptied
    expect(doc.state.items).toEqual(['a', 'X']);
  });
});
