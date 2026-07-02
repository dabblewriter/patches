import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';
import { transformPatch } from '../../src/json-patch/transformPatch.js';
import type { JSONPatchOp } from '../../src/json-patch/types.js';

// Transforming a sequential multi-op patch must thread coordinates through the sequence: op[i] is written in the
// space after op[0..i-1], so the op being transformed against must be advanced as the list is walked. Each test
// asserts convergence to the intended result: apply(thisOps) then apply(transform(otherOps)) preserves both intents.
const converge = (obj: any, thisOps: JSONPatchOp[], otherOps: JSONPatchOp[]) => {
  const transformed = transformPatch(obj, thisOps, otherOps);
  return applyPatch(applyPatch(obj, thisOps), transformed);
};

describe('transformPatch sequential multi-op patches', () => {
  describe('array index threading', () => {
    it('does not corrupt append (/arr/-) paths into /arr/NaN against a concurrent index op', () => {
      const transformed = transformPatch(
        { arr: ['a', 'b'] },
        [{ op: 'add', path: '/arr/0', value: 'S' }],
        [{ op: 'add', path: '/arr/-', value: 'x' }]
      );
      expect(transformed).toEqual([{ op: 'add', path: '/arr/-', value: 'x' }]);
      expect(
        converge(
          { arr: ['a', 'b'] },
          [{ op: 'add', path: '/arr/0', value: 'S' }],
          [{ op: 'add', path: '/arr/-', value: 'x' }]
        )
      ).toEqual({ arr: ['S', 'a', 'b', 'x'] });
    });

    it('does not corrupt append from paths against a concurrent remove', () => {
      const transformed = transformPatch(
        { arr: ['a', 'b'] },
        [{ op: 'remove', path: '/arr/0' }],
        [{ op: 'copy', from: '/arr/-', path: '/other' }]
      );
      expect(transformed).toEqual([{ op: 'copy', from: '/arr/-', path: '/other' }]);
    });

    it('adjusts later ops after an earlier remove below the transformed index', () => {
      // other removes index 0 then edits what is now index 0 ('b'); this concurrently inserts at 1
      expect(
        converge(
          ['a', 'b', 'c'],
          [{ op: 'add', path: '/1', value: 'S' }],
          [
            { op: 'remove', path: '/0' },
            { op: 'replace', path: '/0', value: 'V' },
          ]
        )
      ).toEqual(['S', 'V', 'c']);
    });

    it('adjusts later ops after an earlier insert below the transformed index', () => {
      // other inserts at 0 then edits index 2 (originally 'b'); this concurrently inserts at 1
      expect(
        converge(
          ['a', 'b', 'c'],
          [{ op: 'add', path: '/1', value: 'S' }],
          [
            { op: 'add', path: '/0', value: 'X' },
            { op: 'replace', path: '/2', value: 'V' },
          ]
        )
      ).toEqual(['X', 'a', 'S', 'V', 'c']);
    });

    it('stops shifting once the other patch removes the same element this patch removed', () => {
      // both remove index 1; other then edits index 1 (originally 'c'), which must not be shifted down
      expect(
        converge(
          ['a', 'b', 'c'],
          [{ op: 'remove', path: '/1' }],
          [
            { op: 'remove', path: '/1' },
            { op: 'replace', path: '/1', value: 'V' },
          ]
        )
      ).toEqual(['a', 'V']);
    });

    it('stops shifting once the other patch replaces the removed element', () => {
      // other replaces index 1 (kept as an add into the hole) then edits index 2, which must not be shifted down
      expect(
        converge(
          ['a', 'b', 'c'],
          [{ op: 'remove', path: '/1' }],
          [
            { op: 'replace', path: '/1', value: 'B2' },
            { op: 'replace', path: '/2', value: 'C2' },
          ]
        )
      ).toEqual(['a', 'B2', 'C2']);
    });
  });

  describe('text delta threading', () => {
    it('transforms sequential @txt ops against an advancing delta', () => {
      const doc = { text: [{ insert: 'xy\n' }] };
      const thisOps: JSONPatchOp[] = [{ op: '@txt', path: '/text', value: [{ retain: 2 }, { insert: 'S' }] }];
      const otherOps: JSONPatchOp[] = [
        { op: '@txt', path: '/text', value: [{ retain: 1 }, { insert: 'AAA' }] },
        { op: '@txt', path: '/text', value: [{ retain: 2 }, { insert: 'B' }] },
      ];
      const result = converge(doc, thisOps, otherOps) as { text: any };
      expect(new Delta(result.text).ops).toEqual([{ insert: 'xABAAyS\n' }]);
    });
  });

  describe('move with a later remove of the moved element', () => {
    it('leaves ops after the remove untouched in a same-array move', () => {
      const arr = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
      const transformed = transformPatch(
        arr,
        [{ op: 'move', from: '/5', path: '/1' }],
        [
          { op: 'remove', path: '/5' },
          { op: 'replace', path: '/3', value: 'V' },
        ]
      );
      expect(transformed).toEqual([
        { op: 'remove', path: '/1' },
        { op: 'replace', path: '/3', value: 'V' },
      ]);
      expect(
        converge(
          arr,
          [{ op: 'move', from: '/5', path: '/1' }],
          [
            { op: 'remove', path: '/5' },
            { op: 'replace', path: '/3', value: 'V' },
          ]
        )
      ).toEqual(['a0', 'a1', 'a2', 'V', 'a4', 'a6']);
    });

    it('keeps a follow-up insert at the right position', () => {
      const arr = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
      expect(
        converge(
          arr,
          [{ op: 'move', from: '/5', path: '/1' }],
          [
            { op: 'remove', path: '/5' },
            { op: 'add', path: '/5', value: 'x' },
          ]
        )
      ).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'x', 'a6']);
    });
  });

  describe('dropped move keeps no orphaned follow-ups', () => {
    it('drops ops targeting the destination of a move whose source was overwritten', () => {
      const doc = { x: { a: 1 }, y: { foo: 1 } };
      const transformed = transformPatch(
        doc,
        [{ op: 'replace', path: '/x', value: 5 }],
        [
          { op: 'move', from: '/x', path: '/y' },
          { op: 'replace', path: '/y/foo', value: 99 },
        ]
      );
      expect(transformed).toEqual([]);
      expect(
        converge(
          doc,
          [{ op: 'replace', path: '/x', value: 5 }],
          [
            { op: 'move', from: '/x', path: '/y' },
            { op: 'replace', path: '/y/foo', value: 99 },
          ]
        )
      ).toEqual({ x: 5, y: { foo: 1 } });
    });
  });
});
