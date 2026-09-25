import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../../../src/algorithms/ot/shared/applyChanges.js';
import { hasIndexedOps, normalizeArrayIndices } from '../../../../src/algorithms/ot/server/normalizeArrayIndices.js';
import type { JSONPatchOp } from '../../../../src/json-patch/types.js';
import type { Change } from '../../../../src/types.js';

const change = (id: string, rev: number, ops: JSONPatchOp[]): Change => ({
  id,
  rev,
  baseRev: rev - 1,
  ops,
  createdAt: 1,
  committedAt: 1,
});

// The shape of DAB-1581: a book holding four chapters, and a chapter appended at index 5.
const book = () => ({ docs: { CaKt: { children: ['c0', 'c1', 'c2', 'c3'] } } });

describe('normalizeArrayIndices', () => {
  it('clamps an add past the end to an append, and the result replays strictly', () => {
    const state = book();
    const { changes, normalizations } = normalizeArrayIndices(state, [
      change('a', 11, [{ op: 'add', path: '/docs/CaKt/children/5', value: 'c4' }]),
    ]);

    expect(changes[0].ops).toEqual([{ op: 'add', path: '/docs/CaKt/children/4', value: 'c4' }]);
    expect(normalizations).toEqual([
      {
        change: expect.objectContaining({ id: 'a', rev: 11 }),
        op: { op: 'add', path: '/docs/CaKt/children/5', value: 'c4' },
        action: 'clamped',
        index: 5,
        length: 4,
      },
    ]);
    expect(applyChanges(state, changes).docs.CaKt.children).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('drops a remove or replace naming an element that does not exist', () => {
    const state = book();
    const { changes, normalizations } = normalizeArrayIndices(state, [
      change('r', 11, [
        { op: 'remove', path: '/docs/CaKt/children/4' },
        { op: 'replace', path: '/docs/CaKt/children/9', value: 'x' },
        { op: 'replace', path: '/docs/CaKt/children/0', value: 'kept' },
      ]),
    ]);

    expect(changes[0].ops).toEqual([{ op: 'replace', path: '/docs/CaKt/children/0', value: 'kept' }]);
    expect(normalizations.map(n => [n.op.op, n.action, n.index, n.length])).toEqual([
      ['remove', 'dropped', 4, 4],
      ['replace', 'dropped', 9, 4],
    ]);
    expect(applyChanges(state, changes).docs.CaKt.children).toEqual(['kept', 'c1', 'c2', 'c3']);
  });

  it('keeps a change whose every op was dropped, with empty ops, so its sender can confirm it by id', () => {
    const { changes } = normalizeArrayIndices(book(), [
      change('r', 11, [{ op: 'remove', path: '/docs/CaKt/children/7' }]),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: 'r', rev: 11, ops: [] });
  });

  it('drops a move whose source does not exist', () => {
    const { changes, normalizations } = normalizeArrayIndices(book(), [
      change('m', 11, [{ op: 'move', from: '/docs/CaKt/children/6', path: '/docs/CaKt/children/0' }]),
    ]);
    expect(changes[0].ops).toEqual([]);
    expect(normalizations[0]).toMatchObject({ action: 'dropped', index: 6, length: 4 });
  });

  it("clamps a move's destination against the array after its source is taken out", () => {
    const state = book();
    const { changes, normalizations } = normalizeArrayIndices(state, [
      change('m', 11, [{ op: 'move', from: '/docs/CaKt/children/0', path: '/docs/CaKt/children/9' }]),
    ]);
    // Same array: after removing c0 it holds three, so the last valid position is 3.
    expect(changes[0].ops).toEqual([{ op: 'move', from: '/docs/CaKt/children/0', path: '/docs/CaKt/children/3' }]);
    expect(normalizations[0]).toMatchObject({ action: 'clamped', index: 9, length: 3 });
    expect(applyChanges(state, changes).docs.CaKt.children).toEqual(['c1', 'c2', 'c3', 'c0']);
  });

  it('resolves a nested move destination in the document AFTER the source is taken out', () => {
    // Moving a[0] out shifts a[1] down: the destination `/a/1/c/9` then names the ORIGINAL a[2].c.
    const state = { a: [{ c: ['x'] }, { c: ['p', 'q', 'r', 's'] }, { c: ['m'] }] };
    const { changes, normalizations } = normalizeArrayIndices(state, [
      change('m', 3, [{ op: 'move', from: '/a/0', path: '/a/1/c/9' }]),
    ]);
    expect(changes[0].ops).toEqual([{ op: 'move', from: '/a/0', path: '/a/1/c/1' }]);
    expect(normalizations[0]).toMatchObject({ action: 'clamped', index: 9, length: 1 });
    expect(applyChanges(state, changes).a[1].c).toEqual(['m', { c: ['x'] }]);
  });

  it('clamps a copy whose destination is past the end', () => {
    const state = book();
    const { changes, normalizations } = normalizeArrayIndices(state, [
      change('c', 11, [{ op: 'copy', from: '/docs/CaKt/children/0', path: '/docs/CaKt/children/7' }]),
    ]);
    expect(changes[0].ops).toEqual([{ op: 'copy', from: '/docs/CaKt/children/0', path: '/docs/CaKt/children/4' }]);
    expect(normalizations[0]).toMatchObject({ action: 'clamped', index: 7, length: 4 });
    expect(applyChanges(state, changes).docs.CaKt.children).toEqual(['c0', 'c1', 'c2', 'c3', 'c0']);
  });

  it('drops a copy whose source names a missing element', () => {
    const state = { a: ['x', 'y'], b: 'keep' };
    const { changes, normalizations } = normalizeArrayIndices(state, [
      change('c', 3, [
        { op: 'copy', from: '/a/5', path: '/b' },
        { op: 'add', path: '/a/2', value: 'z' },
      ]),
    ]);
    expect(changes[0].ops).toEqual([{ op: 'add', path: '/a/2', value: 'z' }]);
    expect(normalizations[0]).toMatchObject({ op: { op: 'copy' }, action: 'dropped', index: 5, length: 2 });
    expect(applyChanges(state, changes)).toEqual({ a: ['x', 'y', 'z'], b: 'keep' });
  });

  it('checks each change in the frame the earlier changes of the batch produce', () => {
    const state = book();
    const { changes } = normalizeArrayIndices(state, [
      change('a', 11, [{ op: 'add', path: '/docs/CaKt/children/9', value: 'c4' }]),
      // Valid only because the first change (once clamped) made the array five long.
      change('b', 12, [{ op: 'add', path: '/docs/CaKt/children/5', value: 'c5' }]),
      change('c', 13, [{ op: 'add', path: '/docs/CaKt/children/9', value: 'c6' }]),
    ]);
    expect(changes.map(c => c.ops[0].path)).toEqual([
      '/docs/CaKt/children/4',
      '/docs/CaKt/children/5',
      '/docs/CaKt/children/6',
    ]);
    expect(applyChanges(state, changes).docs.CaKt.children).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  });

  it('handles a two-dimensional plot-grid path (DAB-1428 shape)', () => {
    const state = { docs: { s3aF: { grid: [['a'], ['b', 'c']] } } };
    const { changes } = normalizeArrayIndices(state, [
      change('g', 5, [
        { op: 'replace', path: '/docs/s3aF/grid/1/9', value: 'x' },
        { op: 'add', path: '/docs/s3aF/grid/0/4', value: 'y' },
      ]),
    ]);
    expect(changes[0].ops).toEqual([{ op: 'add', path: '/docs/s3aF/grid/0/1', value: 'y' }]);
  });

  it('leaves a change that fails for another reason exactly as sent, and does not advance the frame with it', () => {
    const state = book();
    const broken = change('x', 11, [
      { op: 'add', path: '/docs/CaKt/children/8', value: 'c4' },
      { op: 'test', path: '/docs/CaKt/children/0', value: 'not-c0' },
    ]);
    const { changes, normalizations } = normalizeArrayIndices(state, [
      broken,
      // In the frame without `x`, the array is still four long.
      change('y', 12, [{ op: 'add', path: '/docs/CaKt/children/5', value: 'c4' }]),
    ]);
    expect(changes[0]).toBe(broken);
    expect(changes[1].ops[0].path).toBe('/docs/CaKt/children/4');
    expect(normalizations.map(n => n.change.id)).toEqual(['y']);
  });

  it('returns the same array when nothing needed correcting', () => {
    const input = [change('a', 11, [{ op: 'add', path: '/docs/CaKt/children/4', value: 'c4' }])];
    const { changes, normalizations } = normalizeArrayIndices(book(), input);
    expect(changes).toBe(input);
    expect(normalizations).toEqual([]);
  });
});

describe('hasIndexedOps', () => {
  it('is true only for ops on a numeric trailing path segment', () => {
    expect(hasIndexedOps([change('a', 1, [{ op: 'replace', path: '/docs/CaKt/title', value: 't' }])])).toBe(false);
    expect(hasIndexedOps([change('a', 1, [{ op: 'add', path: '/docs/CaKt/children/-', value: 'x' }])])).toBe(false);
    expect(hasIndexedOps([change('a', 1, [{ op: 'add', path: '/docs/CaKt/children/3', value: 'x' }])])).toBe(true);
    expect(hasIndexedOps([change('a', 1, [{ op: 'move', from: '/a/2', path: '/b/x' }])])).toBe(true);
    expect(hasIndexedOps([change('a', 1, [{ op: 'copy', from: '/a/5', path: '/b' }])])).toBe(true);
  });
});
