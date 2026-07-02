import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';
import { composePatch } from '../../src/json-patch/composePatch.js';
import { invertPatch } from '../../src/json-patch/invertPatch.js';
import type { JSONPatchOp } from '../../src/json-patch/types.js';

// Undo fidelity: applyPatch(applyPatch(doc, patch), invertPatch(doc, patch)) === doc
const roundTrip = (doc: any, patch: JSONPatchOp[]) => {
  const applied = applyPatch(doc, patch);
  const inverse = invertPatch(doc, patch);
  return applyPatch(applied, inverse);
};

describe('invertPatch fidelity', () => {
  it('inverts multi-op patches against the evolving state, not the original', () => {
    const doc = { list: ['a', 'b', 'c'] };
    const patch: JSONPatchOp[] = [
      { op: 'remove', path: '/list/0' },
      { op: 'remove', path: '/list/0' },
    ];
    expect(roundTrip(doc, patch)).toEqual(doc);
  });

  it('unescapes ~0/~1 path components when reading prior values', () => {
    const doc = { 'a/b': 5, 'c~d': 6 };
    const patch: JSONPatchOp[] = [
      { op: 'replace', path: '/a~1b', value: 60 },
      { op: 'replace', path: '/c~0d', value: 70 },
    ];
    const inverse = invertPatch(doc, patch);
    expect(inverse).toEqual([
      { op: 'replace', path: '/c~0d', value: 6 },
      { op: 'replace', path: '/a~1b', value: 5 },
    ]);
    expect(roundTrip(doc, patch)).toEqual(doc);
  });

  it('inverts an append without corrupting hyphenated keys', () => {
    const doc = { 'my-list': ['a'] };
    const patch: JSONPatchOp[] = [{ op: 'add', path: '/my-list/-', value: 'b' }];
    const inverse = invertPatch(doc, patch);
    expect(inverse).toEqual([{ op: 'remove', path: '/my-list/1' }]);
    expect(roundTrip(doc, patch)).toEqual(doc);
  });

  it('inverts an add onto a numeric object key as a replace, not a remove', () => {
    const doc = { versions: { '0': 'v0' } };
    const patch: JSONPatchOp[] = [{ op: 'add', path: '/versions/0', value: 'new' }];
    const inverse = invertPatch(doc, patch);
    expect(inverse).toEqual([{ op: 'replace', path: '/versions/0', value: 'v0' }]);
    expect(roundTrip(doc, patch)).toEqual(doc);
  });

  it('inverts a root replace back to the original document', () => {
    const doc = { a: 1 };
    const patch: JSONPatchOp[] = [{ op: 'replace', path: '', value: { b: 2 } }];
    const inverse = invertPatch(doc, patch);
    expect(inverse).toEqual([{ op: 'replace', path: '', value: { a: 1 } }]);
    expect(roundTrip(doc, patch)).toEqual(doc);
  });
});

describe('applyPatch aliasing and scoping', () => {
  it('does not alias a copy destination to its modified source', () => {
    const doc = { a: { b: 1 } };
    const result = applyPatch(doc, [
      { op: 'replace', path: '/a/b', value: 2 },
      { op: 'copy', from: '/a', path: '/c' },
      { op: 'replace', path: '/c/x', value: 5 },
    ]);
    expect(result).toEqual({ a: { b: 2 }, c: { b: 2, x: 5 } });
  });

  it('does not alias when the source is edited after the copy', () => {
    const doc = { a: { b: 1 } };
    const result = applyPatch(doc, [
      { op: 'replace', path: '/a/b', value: 2 },
      { op: 'copy', from: '/a', path: '/c' },
      { op: 'replace', path: '/a/x', value: 5 },
    ]);
    expect(result).toEqual({ a: { b: 2, x: 5 }, c: { b: 2 } });
  });

  it('scopes move/copy from paths with atPath', () => {
    const doc = { x: 'rootX', sub: { x: 'subX' } };
    const result = applyPatch(doc, [{ op: 'move', from: '/x', path: '/y' }], { atPath: '/sub' });
    expect(result).toEqual({ x: 'rootX', sub: { y: 'subX' } });
  });

  it('writes through an intermediate - segment on a non-empty array', () => {
    const doc = { list: [{ a: 1 }] };
    const result = applyPatch(doc, [{ op: 'add', path: '/list/-/name', value: 'x' }]);
    expect(result).toEqual({ list: [{ a: 1, name: 'x' }] });
  });
});

describe('composePatch sequential equivalence', () => {
  it('does not merge parent writes across an intervening child write', () => {
    const patch: JSONPatchOp[] = [
      { op: 'replace', path: '/x', value: { y: 0 } },
      { op: '@inc', path: '/x/y', value: 1 },
      { op: 'replace', path: '/x', value: { y: 5 } },
    ];
    const composed = composePatch(patch);
    expect(applyPatch({}, composed)).toEqual(applyPatch({}, patch));
  });
});
