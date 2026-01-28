import { beforeEach, describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';
import { bitmask, combineBitmasks } from '../../src/json-patch/ops/bitmask.js';

describe('applyPatch', () => {
  describe('auto-create missing containers', () => {
    describe('replace creates objects only', () => {
      it('creates objects for missing intermediate paths', () => {
        const result = applyPatch({}, [{ op: 'replace', path: '/obj/sub/foo', value: 'bar' }]);
        expect(result).toEqual({ obj: { sub: { foo: 'bar' } } });
      });

      it('creates objects with numeric keys (not arrays) for 0 index', () => {
        const result = applyPatch({}, [{ op: 'replace', path: '/obj/sub/0/foo', value: 'bar' }]);
        expect(result).toEqual({ obj: { sub: { 0: { foo: 'bar' } } } });
      });

      it('creates objects for all numeric keys', () => {
        const result = applyPatch({}, [{ op: 'replace', path: '/obj/1/foo', value: 'bar' }]);
        expect(result).toEqual({ obj: { 1: { foo: 'bar' } } });
      });
    });

    describe('add creates arrays for 0 index', () => {
      it('creates objects for missing intermediate paths', () => {
        const result = applyPatch({}, [{ op: 'add', path: '/obj/sub/foo', value: 'bar' }]);
        expect(result).toEqual({ obj: { sub: { foo: 'bar' } } });
      });

      it('creates arrays when path contains 0 index', () => {
        const result = applyPatch({}, [{ op: 'add', path: '/obj/sub/0/foo', value: 'bar' }]);
        expect(result).toEqual({ obj: { sub: [{ foo: 'bar' }] } });
      });

      it('creates nested arrays for consecutive 0 indexes', () => {
        const result = applyPatch({}, [{ op: 'add', path: '/obj/0/0/foo', value: 'bar' }]);
        expect(result).toEqual({ obj: [[{ foo: 'bar' }]] });
      });

      it('creates array at end of path when last key is 0', () => {
        const result = applyPatch({}, [{ op: 'add', path: '/obj/sub/0', value: 'bar' }]);
        expect(result).toEqual({ obj: { sub: ['bar'] } });
      });

      it('creates objects for non-0 numeric keys', () => {
        const result = applyPatch({}, [{ op: 'add', path: '/obj/1/foo', value: 'bar' }]);
        expect(result).toEqual({ obj: { 1: { foo: 'bar' } } });
      });

      it('creates deeply nested structure with mixed arrays and objects', () => {
        const result = applyPatch({}, [{ op: 'add', path: '/obj/sub/0/foo/bar', value: 'foobar' }]);
        expect(result).toEqual({ obj: { sub: [{ foo: { bar: 'foobar' } }] } });
      });
    });
  });

  describe('move', () => {
    let a: any;

    beforeEach(() => {
      a = {
        matrix: [
          [0, 1, 2],
          [3, 4, 5],
          [6, 7, 8],
        ],
        vector: [10, 20],
      };
    });

    it('move in arrays', () => {
      expect(applyPatch(a, [{ op: 'move', from: '/matrix/2/0', path: '/matrix/1/-' }])).toEqual({
        matrix: [
          [0, 1, 2],
          [3, 4, 5, 6],
          [7, 8],
        ],
        vector: [10, 20],
      });
    });

    it('move correctly forward in one array', () => {
      expect(applyPatch(a, [{ op: 'move', from: '/matrix/0/0', path: '/matrix/0/2' }])).toEqual({
        matrix: [
          [1, 2, 0],
          [3, 4, 5],
          [6, 7, 8],
        ],
        vector: [10, 20],
      });
    });

    it('move correctly backward in one array', () => {
      expect(applyPatch(a, [{ op: 'move', from: '/matrix/0/2', path: '/matrix/0/0' }])).toEqual({
        matrix: [
          [2, 0, 1],
          [3, 4, 5],
          [6, 7, 8],
        ],
        vector: [10, 20],
      });
    });

    it('move correctly between arrays', () => {
      expect(applyPatch(a, [{ op: 'move', from: '/matrix/0/0', path: '/matrix/1/3' }])).toEqual({
        matrix: [
          [1, 2],
          [3, 4, 5, 0],
          [6, 7, 8],
        ],
        vector: [10, 20],
      });
    });

    it('object', () => {
      expect(applyPatch(a, [{ op: 'move', from: '/vector', path: '/matrix/-' }])).toEqual({
        matrix: [
          [0, 1, 2],
          [3, 4, 5],
          [6, 7, 8],
          [10, 20],
        ],
      });
    });

    it('no changes', () => {
      const prevA = a;
      expect(applyPatch(a, [{ op: 'move', from: '/matrix/-', path: '/matrix/-' }])).toEqual({
        matrix: [
          [0, 1, 2],
          [3, 4, 5],
          [6, 7, 8],
        ],
        vector: [10, 20],
      });

      expect(a).toEqual(prevA);
    });

    describe('increment', () => {
      it('increment in arrays', () => {
        expect(applyPatch(a, [{ op: '@inc', path: '/matrix/0/0', value: 1 }])).toEqual({
          matrix: [
            [1, 1, 2],
            [3, 4, 5],
            [6, 7, 8],
          ],
          vector: [10, 20],
        });
      });

      it('increment in object', () => {
        expect(applyPatch(a, [{ op: '@inc', path: '/vector/0', value: 5 }])).toEqual({
          matrix: [
            [0, 1, 2],
            [3, 4, 5],
            [6, 7, 8],
          ],
          vector: [15, 20],
        });
      });

      it('increment in non-existing path', () => {
        expect(applyPatch(a, [{ op: '@inc', path: '/nonexistent', value: 1 }])).toEqual({ ...a, nonexistent: 1 });
      });

      it('decrement in object', () => {
        expect(applyPatch(a, [{ op: '@inc', path: '/vector/0', value: -5 }])).toEqual({
          matrix: [
            [0, 1, 2],
            [3, 4, 5],
            [6, 7, 8],
          ],
          vector: [5, 20],
        });
      });
    });

    // Write tests for bitmask operation '@bit' which uses a mask integer created by `mask(index: number, value: boolean)` that operates on a 32-bit integer. The top 16 bits of the number turn off bits and the lower 16 turn on bits.
    // The operation should be able to set and unset bits in the mask.
    describe('bitmask', () => {
      it('should set bit in the mask', () => {
        const maskValue = bitmask(0, true);
        expect(maskValue).toBe(1);
      });

      it('should unset bit in the mask', () => {
        const maskValue = bitmask(0, false);
        expect(maskValue).toBe(32768);
      });

      it('turn a bit on in a bitmask', () => {
        expect(applyPatch(a, [{ op: '@bit', path: '/matrix/0/0', value: 4 }])).toEqual({
          matrix: [
            [4, 1, 2],
            [3, 4, 5],
            [6, 7, 8],
          ],
          vector: [10, 20],
        });

        expect(applyPatch(a, [{ op: '@bit', path: '/matrix/0/1', value: 4 }])).toEqual({
          matrix: [
            [0, 5, 2],
            [3, 4, 5],
            [6, 7, 8],
          ],
          vector: [10, 20],
        });
      });

      it('turn a bit off in a bitmask', () => {
        expect(applyPatch(a, [{ op: '@bit', path: '/matrix/1/2', value: 131072 }])).toEqual({
          matrix: [
            [0, 1, 2],
            [3, 4, 1],
            [6, 7, 8],
          ],
          vector: [10, 20],
        });
      });

      it('turn 2 bits off in a bitmask', () => {
        expect(
          applyPatch(a, [
            { op: '@bit', path: '/matrix/1/2', value: combineBitmasks(bitmask(2, false), bitmask(0, false)) },
          ])
        ).toEqual({
          matrix: [
            [0, 1, 2],
            [3, 4, 0],
            [6, 7, 8],
          ],
          vector: [10, 20],
        });
      });
    });
  });
});
