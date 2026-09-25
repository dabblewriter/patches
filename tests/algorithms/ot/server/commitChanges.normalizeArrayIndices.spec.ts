import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitChanges } from '../../../../src/algorithms/ot/server/commitChanges.js';
import { applyChanges } from '../../../../src/algorithms/ot/shared/applyChanges.js';
import type { JSONPatchOp } from '../../../../src/json-patch/types.js';
import type { ArrayIndexNormalization, ChangeInput } from '../../../../src/types.js';
import { OTFuzzBackend } from '../../../fuzz/otFuzzBackend.js';

const DOC = 'projects/p1/content';
const SESSION = 30 * 60 * 1000;

let seq = 0;
const input = (baseRev: number, ops: JSONPatchOp[], id = `c${++seq}`): ChangeInput => ({
  id,
  baseRev,
  ops,
  createdAt: Date.now(),
});

describe('commitChanges — array-index normalization (DAB-1557)', () => {
  let store: OTFuzzBackend;
  let reported: ArrayIndexNormalization[];
  const options = () => ({
    onArrayIndicesNormalized: (_: string, n: ArrayIndexNormalization[]) => reported.push(...n),
  });

  beforeEach(async () => {
    store = new OTFuzzBackend();
    reported = [];
    // rev 1: a book holding four chapters.
    await commitChanges(
      store,
      DOC,
      [input(0, [{ op: 'add', path: '/docs', value: { CaKt: { children: ['c0', 'c1', 'c2', 'c3'] } } }])],
      SESSION
    );
  });

  const replay = () => applyChanges(null as any, store.log(DOC));

  it('commits an append past the end as an append, so the log replays strictly', async () => {
    const { newChanges } = await commitChanges(
      store,
      DOC,
      [input(1, [{ op: 'add', path: '/docs/CaKt/children/5', value: 'c4' }], 'poison')],
      SESSION,
      options()
    );

    expect(newChanges[0].ops).toEqual([{ op: 'add', path: '/docs/CaKt/children/4', value: 'c4' }]);
    expect(store.log(DOC).at(-1)!.ops[0].path).toBe('/docs/CaKt/children/4');
    expect(replay().docs.CaKt.children).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(reported).toMatchObject([{ change: { id: 'poison' }, action: 'clamped', index: 5, length: 4 }]);
  });

  it('normalizes AFTER the transform, against the tip the change is re-expressed on', async () => {
    // Another client appends first, on the same base.
    await commitChanges(
      store,
      DOC,
      [input(1, [{ op: 'add', path: '/docs/CaKt/children/4', value: 'other' }])],
      SESSION
    );

    // Minted on rev 1 against a view one ahead (the DAB-1366 double-count): index 5 of a 4-long array.
    const { newChanges } = await commitChanges(
      store,
      DOC,
      [input(1, [{ op: 'add', path: '/docs/CaKt/children/5', value: 'mine' }], 'late')],
      SESSION,
      options()
    );

    expect(newChanges[0].rev).toBe(3);
    expect(replay().docs.CaKt.children).toEqual(['c0', 'c1', 'c2', 'c3', 'other', 'mine']);
    expect(reported).toMatchObject([{ change: { id: 'late' }, action: 'clamped', length: 5 }]);
  });

  it('commits a remove of a missing element as an empty change, echoed back under its id', async () => {
    const { newChanges } = await commitChanges(
      store,
      DOC,
      [input(1, [{ op: 'remove', path: '/docs/CaKt/children/4' }], 'gone')],
      SESSION,
      options()
    );

    expect(newChanges).toMatchObject([{ id: 'gone', rev: 2, ops: [] }]);
    expect(replay().docs.CaKt.children).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(reported).toMatchObject([{ change: { id: 'gone' }, action: 'dropped' }]);
  });

  it('does not read state for a batch with no op on a numeric path segment', async () => {
    const listVersions = vi.spyOn(store, 'listVersions');
    await commitChanges(store, DOC, [input(1, [{ op: 'replace', path: '/docs/CaKt/title', value: 'T' }])], SESSION);
    expect(listVersions).not.toHaveBeenCalled();
  });

  it('commits the batch as sent when the state cannot be read', async () => {
    vi.spyOn(store, 'listVersions').mockRejectedValue(new Error('store down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { newChanges } = await commitChanges(
      store,
      DOC,
      [input(1, [{ op: 'add', path: '/docs/CaKt/children/5', value: 'c4' }])],
      SESSION,
      options()
    );

    expect(newChanges[0].ops[0].path).toBe('/docs/CaKt/children/5');
    expect(reported).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports once, from the attempt that saved, when a conflict forces a retry', async () => {
    // A foreign append lands between this commit's read and its save (a second instance).
    const save = store.saveChanges.bind(store);
    let raced = false;
    vi.spyOn(store, 'saveChanges').mockImplementation(async (docId, changes) => {
      if (!raced) {
        raced = true;
        const now = Date.now();
        const foreign = { id: 'foreign', rev: 2, baseRev: 1, createdAt: now, committedAt: now };
        await save(docId, [{ ...foreign, ops: [{ op: 'add', path: '/docs/CaKt/children/4', value: 'f' }] }]);
      }
      return save(docId, changes);
    });

    await commitChanges(
      store,
      DOC,
      [input(1, [{ op: 'add', path: '/docs/CaKt/children/9', value: 'mine' }], 'late')],
      SESSION,
      options()
    );

    expect(replay().docs.CaKt.children).toEqual(['c0', 'c1', 'c2', 'c3', 'f', 'mine']);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ change: { id: 'late', rev: 3 }, length: 5 });
  });

  it('reports nothing when the save fails', async () => {
    vi.spyOn(store, 'saveChanges').mockRejectedValue(new Error('store down'));
    const commit = commitChanges(
      store,
      DOC,
      [input(1, [{ op: 'add', path: '/docs/CaKt/children/9', value: 'x' }])],
      SESSION,
      options()
    );

    await expect(commit).rejects.toThrow('store down');
    expect(reported).toEqual([]);
  });

  it('is off when normalizeArrayIndices is false', async () => {
    const off = await commitChanges(
      store,
      DOC,
      [input(1, [{ op: 'add', path: '/docs/CaKt/children/9', value: 'x' }])],
      SESSION,
      { ...options(), normalizeArrayIndices: false }
    );
    expect(off.newChanges[0].ops[0].path).toBe('/docs/CaKt/children/9');
    expect(reported).toEqual([]);
  });
});
