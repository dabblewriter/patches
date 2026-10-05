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
 * DAB-1409: an own echo is recognised by the change id it was minted under, never by its bytes.
 *
 * DAB-1366 (patches #175) matched an echo that beats its mint confirmation byte-for-byte against
 * the parked optimistic op. That is wrong in both directions:
 *  - a server-TRANSFORMED own echo, or a change `breakChanges` split into pieces, no longer
 *    matches, reads as foreign, and the parked op is transformed against its own committed copy —
 *    the view applies it twice (Jacob's scratch docs: ['W','a','X','X','b'], ['a','A','B','A','B']);
 *  - a FOREIGN change with byte-identical ops is adopted as ours, the parked entry is emptied,
 *    and the local edit never reaches the server.
 *
 * The algorithm mints the change ids before it awaits the store, so it tells the doc which ids
 * belong to which parked entry (`_noteMinted`) before any echo can exist.
 */
describe('OTDoc — own echoes are matched by minted id, not by bytes (DAB-1409)', () => {
  it('a server-transformed own echo is recognised immediately — no double-apply window', () => {
    const doc = new OTDoc<ListDoc>('doc-1', { state: { items: ['a', 'b'] }, rev: 1, changes: [] });
    doc.change(patch => patch.add('/items/1', 'X'));
    const ops = (doc as any)._optimisticOps[0];
    doc._noteMinted([makeChange('u1', 1, 2, ops, false)], ops);

    // A foreign add at 0 committed first, so the server transformed ours to /items/2.
    doc.applyChanges([
      makeChange('f', 1, 2, [{ op: 'add', path: '/items/0', value: 'W' }], true),
      makeChange('u1', 1, 3, [{ op: 'add', path: '/items/2', value: 'X' }], true),
    ]);

    expect(doc.state.items).toEqual(['W', 'a', 'X', 'b']);
    expect((doc as any)._optimisticOps).toEqual([]);
    expect(doc.optimisticBatchCount).toBe(0);
  });

  it('a split change is confirmed piece by piece, and the view never doubles', () => {
    const doc = new OTDoc<ListDoc>('doc-2', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => {
      patch.add('/items/-', 'A');
      patch.add('/items/-', 'B');
    });
    const ops = (doc as any)._optimisticOps[0];
    expect(doc.state.items).toEqual(['a', 'A', 'B']);
    // breakChanges split it into two sequential pieces under fresh ids.
    doc._noteMinted(
      [
        makeChange('p0', 1, 2, [{ op: 'add', path: '/items/-', value: 'A' }], false),
        makeChange('p1', 1, 3, [{ op: 'add', path: '/items/-', value: 'B' }], false),
      ],
      ops
    );

    doc.applyChanges([makeChange('p0', 1, 2, [{ op: 'add', path: '/items/-', value: 'A' }], true)]);
    expect(doc.state.items).toEqual(['a', 'A', 'B']);
    // Only the un-echoed piece is still parked — in the SAME array, so a queued mint follows it.
    expect((doc as any)._optimisticOps).toEqual([ops]);
    expect(ops).toEqual([{ op: 'add', path: '/items/-', value: 'B' }]);

    doc.applyChanges([makeChange('p1', 2, 3, [{ op: 'add', path: '/items/-', value: 'B' }], true)]);
    expect(doc.state.items).toEqual(['a', 'A', 'B']);
    expect((doc as any)._optimisticOps).toEqual([]);
  });

  it('a split change whose first piece echoes behind a foreign change keeps the tail in frame', () => {
    const doc = new OTDoc<ListDoc>('doc-3', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => {
      patch.add('/items/1', 'A');
      patch.add('/items/2', 'B');
    });
    const ops = (doc as any)._optimisticOps[0];
    doc._noteMinted(
      [
        makeChange('p0', 1, 2, [{ op: 'add', path: '/items/1', value: 'A' }], false),
        makeChange('p1', 1, 3, [{ op: 'add', path: '/items/2', value: 'B' }], false),
      ],
      ops
    );

    doc.applyChanges([
      makeChange('f', 1, 2, [{ op: 'add', path: '/items/0', value: 'W' }], true),
      makeChange('p0', 1, 3, [{ op: 'add', path: '/items/2', value: 'A' }], true),
    ]);

    expect(doc.state.items).toEqual(['W', 'a', 'A', 'B']);
    expect(ops).toEqual([{ op: 'add', path: '/items/3', value: 'B' }]);
  });

  it('a split entry with another edit queued behind it: the later edit keeps its frame across piece echoes', () => {
    const doc = new OTDoc<ListDoc>('doc-8', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => {
      patch.add('/items/1', 'A');
      patch.add('/items/2', 'B');
    });
    const ops = (doc as any)._optimisticOps[0];
    doc._noteMinted(
      [
        makeChange('p0', 1, 2, [{ op: 'add', path: '/items/1', value: 'A' }], false),
        makeChange('p1', 1, 3, [{ op: 'add', path: '/items/2', value: 'B' }], false),
      ],
      ops
    );
    doc.change(patch => patch.add('/items/3', 'C')); // typed on top of A and B
    const later = (doc as any)._optimisticOps[1];

    doc.applyChanges([makeChange('p0', 1, 2, [{ op: 'add', path: '/items/1', value: 'A' }], true)]);
    doc.applyChanges([
      makeChange('f', 2, 3, [{ op: 'add', path: '/items/0', value: 'W' }], true),
      makeChange('p1', 2, 4, [{ op: 'add', path: '/items/3', value: 'B' }], true),
    ]);

    expect(doc.state.items).toEqual(['W', 'a', 'A', 'B', 'C']);
    expect((doc as any)._optimisticOps).toEqual([later]);
    expect(later).toEqual([{ op: 'add', path: '/items/4', value: 'C' }]);
  });

  it('import drops the minted pieces a snapshot already carries — a split entry is not re-applied on top', () => {
    const doc = new OTDoc<ListDoc>('doc-9', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => {
      patch.add('/items/-', 'A');
      patch.add('/items/-', 'B');
    });
    const ops = (doc as any)._optimisticOps[0];
    const p0 = makeChange('p0', 1, 2, [{ op: 'add', path: '/items/-', value: 'A' }], false);
    const p1 = makeChange('p1', 1, 3, [{ op: 'add', path: '/items/-', value: 'B' }], false);
    doc._noteMinted([p0, p1], ops);

    // A recovery snapshot whose pending list already holds both pieces.
    doc.import({ state: { items: ['a'] }, rev: 1, changes: [p0, p1] });

    expect(doc.state.items).toEqual(['a', 'A', 'B']); // not ['a','A','B','A','B']
    expect((doc as any)._optimisticOps).toEqual([]);
  });

  it('a foreign change with byte-identical ops is NOT adopted — the local edit survives', () => {
    const doc = new OTDoc<ListDoc>('doc-4', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => patch.add('/items/-', 'X'));
    const ops = (doc as any)._optimisticOps[0];
    doc._noteMinted([makeChange('u1', 1, 2, ops, false)], ops);

    // Someone else appended the same value.
    doc.applyChanges([makeChange('f1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);

    expect(ops).toEqual([{ op: 'add', path: '/items/-', value: 'X' }]); // not emptied
    expect((doc as any)._optimisticOps).toEqual([ops]); // still in flight
    expect(doc.state.items).toEqual(['a', 'X', 'X']);
  });

  it('flags a foreign change that byte-matches a parked op, without adopting it', () => {
    const doc = new OTDoc<ListDoc>('doc-5', { state: { items: ['a'] }, rev: 1, changes: [] });
    const seen: string[] = [];
    doc.onSuspectedOwnEcho(ids => seen.push(...ids));
    doc.change(patch => patch.add('/items/-', 'X'));

    doc.applyChanges([makeChange('f1', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);

    expect(seen).toEqual(['f1']);
    expect(doc.state.items).toEqual(['a', 'X', 'X']);
  });

  it('an outbox entry keeps its outbox identity — a re-drive does not record pieces beside it', () => {
    const doc = new OTDoc<ListDoc>('doc-7', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => patch.add('/items/-', 'X'));
    const ops = (doc as any)._optimisticOps[0];
    doc._markUnstored('stable', ops);
    doc._noteMinted([makeChange('p0', 1, 2, ops, false), makeChange('p1', 1, 3, ops, false)], ops);

    expect((doc as any)._minted.size).toBe(0);
    doc.applyChanges([makeChange('stable', 1, 2, [{ op: 'add', path: '/items/-', value: 'X' }], true)]);
    expect(doc.state.items).toEqual(['a', 'X']);
    expect((doc as any)._optimisticOps).toEqual([]);
  });

  it('the noted ids are forgotten once the local mint confirmation retires the entry', () => {
    const doc = new OTDoc<ListDoc>('doc-6', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => patch.add('/items/-', 'X'));
    const ops = (doc as any)._optimisticOps[0];
    const minted = makeChange('u1', 1, 2, ops, false);
    doc._noteMinted([minted], ops);
    doc.applyChanges([minted]);

    expect((doc as any)._minted.size).toBe(0);
  });
});
