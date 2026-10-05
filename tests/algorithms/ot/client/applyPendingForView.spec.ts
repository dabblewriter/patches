import { describe, expect, it } from 'vitest';
import { applyPendingForView, salvagePendingForView } from '../../../../src/algorithms/ot/client/applyPendingForView';
import { ApplyChangesError } from '../../../../src/algorithms/ot/shared/applyChanges';
import { createChange } from '../../../../src/data/change';
import type { JSONPatchOp } from '../../../../src/json-patch/types';

const REV = 10;
let nextRev = REV;
/** A pending change on the committed frame. */
const change = (...ops: JSONPatchOp[]) => createChange(REV, ++nextRev, ops);
/** A pending change left on an older frame (frame debt). */
const stale = (...ops: JSONPatchOp[]) => createChange(REV - 3, ++nextRev, ops);

/** Fails strict apply wherever it runs: a text op on something that is not a Delta. */
const FAILS: JSONPatchOp = { op: '@txt', path: '/id', value: 'not a delta' };

const committed = () => ({
  id: 'root',
  docs: { group: { id: 'group', children: ['a', 'b'] } } as Record<string, any>,
  items: [{ id: 'a' }] as any[],
});

/** Creates `/docs/timeline` and lists it, and fails. */
const failingCreate = () =>
  change(
    { op: 'add', path: '/docs/timeline', value: { id: 'timeline', children: ['track'] } },
    { op: 'add', path: '/docs/group/children/2', value: 'timeline' },
    FAILS
  );

describe('salvagePendingForView', () => {
  const salvage = (...pending: ReturnType<typeof change>[]) => salvagePendingForView(committed(), REV, pending);

  it('applies a queue that has no failures and drops nothing', () => {
    const create = change({ op: 'add', path: '/docs/timeline', value: { id: 'timeline', children: [] } });
    const addChild = change({ op: 'add', path: '/docs/timeline/children/0', value: 'event' });

    const result = salvage(create, addChild);

    expect(result.kept).toEqual([create, addChild]);
    expect(result.dropped).toEqual([]);
    expect(result.dependents).toBe(0);
    expect(result.state.docs.timeline).toEqual({ id: 'timeline', children: ['event'] });
  });

  it('drops a change that writes beneath a path the dropped change would have created', () => {
    const create = failingCreate();
    const addChild = change({ op: 'add', path: '/docs/timeline/children/1', value: 'event' });

    const result = salvage(create, addChild);

    expect(result.dropped).toEqual([create, addChild]);
    expect(result.dependents).toBe(1);
    expect(result.kept).toEqual([]);
    expect(result.state).toEqual(committed());
  });

  it('drops it whichever op the dropped change used to create the path', () => {
    const create = change({ op: 'replace', path: '/docs/timeline', value: { id: 'timeline' } }, FAILS);
    const retitle = change({ op: 'replace', path: '/docs/timeline/title', value: 'Timeline' });

    const result = salvage(create, retitle);

    // `replace` creates a missing parent too: this was `{ title: 'Timeline' }`.
    expect(result.dropped).toEqual([create, retitle]);
    expect(result.state).toEqual(committed());
  });

  it('drops a change that removes what the dropped change would have created', () => {
    const create = change(
      { op: 'add', path: '/docs/timeline', value: { id: 'timeline' } },
      { op: 'add', path: '/docs/group/children/1', value: 'timeline' },
      FAILS
    );
    // Made when the list read ['a', 'timeline', 'b']. Kept, it would unlist 'b' instead.
    const remove = change({ op: 'remove', path: '/docs/group/children/1' }, { op: 'remove', path: '/docs/timeline' });

    const result = salvage(create, remove);

    expect(result.dropped).toEqual([create, remove]);
    expect(result.state.docs.group.children).toEqual(['a', 'b']);
  });

  it('drops a change that moves or copies out of it', () => {
    const create = failingCreate();
    const copy = change({ op: 'copy', from: '/docs/timeline/children', path: '/docs/group/tracks' });

    const result = salvage(create, copy);

    expect(result.dropped).toEqual([create, copy]);
    expect(result.dependents).toBe(1);
  });

  it('carries down a chain: the paths a dropped dependent would have created are missing too', () => {
    const create = failingCreate();
    const addChild = change(
      { op: 'add', path: '/docs/event', value: { id: 'event' } },
      { op: 'add', path: '/docs/timeline/children/1', value: 'event' }
    );
    const addGrandchild = change({ op: 'add', path: '/docs/event/children/0', value: 'note' });

    const result = salvage(create, addChild, addGrandchild);

    expect(result.dropped).toEqual([create, addChild, addGrandchild]);
    expect(result.dependents).toBe(2);
    expect(result.state).toEqual(committed());
  });

  it('keeps a change that touches none of it', () => {
    const create = failingCreate();
    const addChild = change({ op: 'add', path: '/docs/timeline/children/1', value: 'event' });
    const independent = change(
      { op: 'add', path: '/docs/note', value: { id: 'note' } },
      { op: 'add', path: '/docs/group/children/2', value: 'note' }
    );

    const result = salvage(create, addChild, independent);

    expect(result.dropped).toEqual([create, addChild]);
    expect(result.kept).toEqual([independent]);
    expect(result.state.docs).toEqual({
      group: { id: 'group', children: ['a', 'b', 'note'] },
      note: { id: 'note' },
    });
  });

  it('keeps a change that writes the missing path itself, and the changes after it', () => {
    const create = failingCreate();
    const recreate = change(
      { op: 'add', path: '/docs/timeline', value: { id: 'timeline', children: [] } },
      { op: 'add', path: '/docs/timeline/children/0', value: 'track-2' }
    );
    const addChild = change({ op: 'add', path: '/docs/timeline/children/1', value: 'event' });

    const result = salvage(create, recreate, addChild);

    expect(result.dropped).toEqual([create]);
    expect(result.kept).toEqual([recreate, addChild]);
    expect(result.state.docs.timeline).toEqual({ id: 'timeline', children: ['track-2', 'event'] });
  });

  it('keeps an in-place update of a value the dropped change would have started', () => {
    const first = change({ op: '@inc', path: '/count', value: 1 }, FAILS);
    const second = change({ op: '@inc', path: '/count', value: 1 });

    const result = salvage(first, second);

    expect(result.dropped).toEqual([first]);
    expect(result.kept).toEqual([second]);
    expect((result.state as any).count).toBe(1);
  });

  describe('array elements', () => {
    /** Appends an element at index 1, and fails. */
    const failingInsert = () => change({ op: 'add', path: '/items/1', value: { id: 't' } }, FAILS);
    const retitleSecond = () => change({ op: 'replace', path: '/items/1/title', value: 'x' });

    it('drops a change that writes into an element the dropped change would have added', () => {
      const insert = failingInsert();
      const retitle = retitleSecond();

      const result = salvage(insert, retitle);

      // Was `[{ id: 'a' }, { title: 'x' }]`.
      expect(result.dropped).toEqual([insert, retitle]);
      expect(result.state.items).toEqual([{ id: 'a' }]);
    });

    it('keeps it once a surviving change has put an element at that index', () => {
      const insert = failingInsert();
      const append = change({ op: 'add', path: '/items/-', value: { id: 'u' } });
      const retitle = retitleSecond();

      const result = salvage(insert, append, retitle);

      expect(result.dropped).toEqual([insert]);
      expect(result.kept).toEqual([append, retitle]);
      expect(result.state.items).toEqual([{ id: 'a' }, { id: 'u', title: 'x' }]);
    });

    it('judges an op against the state it runs on, earlier ops of its own change included', () => {
      const insert = failingInsert();
      const insertAndRetitle = change(
        { op: 'add', path: '/items/1', value: { id: 'u' } },
        { op: 'replace', path: '/items/1/title', value: 'x' }
      );

      const result = salvage(insert, insertAndRetitle);

      expect(result.dropped).toEqual([insert]);
      expect(result.kept).toEqual([insertAndRetitle]);
      expect(result.state.items).toEqual([{ id: 'a' }, { id: 'u', title: 'x' }]);
    });
  });

  describe('frame debt', () => {
    const staleCreate = () =>
      stale(
        { op: 'add', path: '/docs/timeline', value: { id: 'timeline', children: ['track'] } },
        { op: 'add', path: '/docs/group/children/5', value: 'timeline' }
      );

    it('keeps a row on an older frame queued and out of the view, with the rows built on it', () => {
      const create = staleCreate();
      const addChild = change({ op: 'add', path: '/docs/timeline/children/1', value: 'event' });
      const independent = change({ op: 'add', path: '/docs/note', value: { id: 'note' } });

      const result = salvage(create, addChild, independent);

      expect(result.dropped).toEqual([]);
      expect(result.kept).toEqual([create, addChild, independent]);
      expect(result.state.docs).toEqual({ ...committed().docs, note: { id: 'note' } });
    });

    it('holds out a row built on a row that is itself held out', () => {
      const create = staleCreate();
      const addChild = change(
        { op: 'add', path: '/docs/event', value: { id: 'event' } },
        { op: 'add', path: '/docs/timeline/children/1', value: 'event' }
      );
      const addGrandchild = change({ op: 'add', path: '/docs/event/children/0', value: 'note' });

      const result = salvage(create, addChild, addGrandchild);

      expect(result.dropped).toEqual([]);
      expect(result.kept).toEqual([create, addChild, addGrandchild]);
      expect(result.state).toEqual(committed());
    });

    it('drops a row that is built on a dropped change as well as on a deferred one', () => {
      const deferred = staleCreate();
      const dropped = change({ op: 'add', path: '/docs/plot', value: { id: 'plot' } }, FAILS);
      const both = change(
        { op: 'add', path: '/docs/timeline/children/1', value: 'event' },
        { op: 'add', path: '/docs/plot/title', value: 'Plot' }
      );

      const result = salvage(deferred, dropped, both);

      expect(result.dropped).toEqual([dropped, both]);
      expect(result.kept).toEqual([deferred]);
    });

    it('never drops the older-frame row itself, whatever it reaches', () => {
      const create = failingCreate();
      const straggler = stale({ op: 'add', path: '/docs/timeline/children/1', value: 'event' });

      const result = salvage(create, straggler);

      expect(result.dropped).toEqual([create]);
      expect(result.kept).toEqual([straggler]);
      expect(result.state).toEqual(committed());
    });
  });
});

describe('applyPendingForView', () => {
  const view = (...pending: ReturnType<typeof change>[]) => applyPendingForView(committed(), REV, pending);

  it('applies a frame-consistent queue strictly', () => {
    const create = change({ op: 'add', path: '/docs/timeline', value: { id: 'timeline', children: [] } });
    const addChild = change({ op: 'add', path: '/docs/timeline/children/0', value: 'event' });

    expect(view(create, addChild).docs.timeline).toEqual({ id: 'timeline', children: ['event'] });
  });

  it('throws on a frame-consistent queue that does not apply', () => {
    const create = failingCreate();
    const addChild = change({ op: 'add', path: '/docs/timeline/children/1', value: 'event' });

    expect(() => view(create, addChild)).toThrowError(ApplyChangesError);
  });

  it('keeps an older-frame row in the view while the whole queue still applies', () => {
    const create = stale({ op: 'add', path: '/docs/timeline', value: { id: 'timeline', children: [] } });
    const addChild = change({ op: 'add', path: '/docs/timeline/children/0', value: 'event' });

    expect(view(create, addChild).docs.timeline).toEqual({ id: 'timeline', children: ['event'] });
  });

  it('leaves out an older-frame row that no longer applies, and the rows built on it', () => {
    const create = stale(
      { op: 'add', path: '/docs/timeline', value: { id: 'timeline', children: ['track'] } },
      { op: 'add', path: '/docs/group/children/5', value: 'timeline' }
    );
    const addChild = change(
      { op: 'add', path: '/docs/event', value: { id: 'event' } },
      { op: 'add', path: '/docs/timeline/children/1', value: 'event' }
    );
    const independent = change({ op: 'add', path: '/docs/note', value: { id: 'note' } });

    // Was `{ …, event: { id: 'event' }, timeline: { children: { '1': 'event' } }, note }`.
    expect(view(create, addChild, independent).docs).toEqual({ ...committed().docs, note: { id: 'note' } });
  });

  it('throws when a current-frame row that is not built on it fails', () => {
    const create = stale({ op: 'add', path: '/docs/group/children/5', value: 'timeline' });
    const bad = change(FAILS);

    let thrown: unknown;
    try {
      view(create, bad);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApplyChangesError);
    expect(thrown).toMatchObject({ changeId: bad.id, rev: bad.rev, index: 1 });
  });

  it('holds out a current-frame row that needs what an older-frame row would have done elsewhere', () => {
    // The older row inserts at the head of a list that exists; the later row removes the index
    // that insert would have shifted the last element to. Not beneath any path the older row
    // would have created, but it does not apply without it.
    const early = stale(
      { op: 'add', path: '/docs/group/children/0', value: 'x' },
      { op: 'add', path: '/docs/group/children/9', value: 'y' }
    );
    const later = change({ op: 'remove', path: '/docs/group/children/2' });

    expect(view(early, later).docs.group.children).toEqual(['a', 'b']);
  });
});

describe('a malformed pending row', () => {
  const malformed = [
    { name: 'no ops array', ops: undefined },
    { name: 'a failing row with an op that has no path', ops: [{ op: 'add', value: 1 }, FAILS] },
  ];

  for (const { name, ops } of malformed) {
    it(`is dropped and reported by salvage, not thrown on: ${name}`, () => {
      const bad = { ...change(), ops } as any;
      const good = change({ op: 'add', path: '/docs/note', value: { id: 'note' } });

      const result = salvagePendingForView(committed(), REV, [bad, good]);

      expect(result.dropped).toEqual([bad]);
      expect(result.kept).toEqual([good]);
    });

    it(`is dropped alongside an older-frame row: ${name}`, () => {
      const early = stale({ op: 'add', path: '/docs/group/children/9', value: 'y' }, FAILS);
      const bad = { ...change(), ops } as any;

      const result = salvagePendingForView(committed(), REV, [early, bad]);

      expect(result.dropped).toEqual([bad]);
      expect(result.kept).toEqual([early]);
    });
  }
});
