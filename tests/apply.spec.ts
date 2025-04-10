import { beforeEach, describe, expect, it } from 'vitest';
import { applyPatch } from '../src/json-patch/applyPatch.js';
import { bitmask, combineBitmasks } from '../src/json-patch/ops/bitmask.js';

describe('applyPatch', () => {
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
      expect(applyPatch(a, [['>/matrix/1/-', '/matrix/2/0']])).toEqual({
        matrix: [
          [0, 1, 2],
          [3, 4, 5, 6],
          [7, 8],
        ],
        vector: [10, 20],
      });
    });

    it('move correctly forward in one array', () => {
      expect(applyPatch(a, [['>/matrix/0/2', '/matrix/0/0']])).toEqual({
        matrix: [
          [1, 2, 0],
          [3, 4, 5],
          [6, 7, 8],
        ],
        vector: [10, 20],
      });
    });

    it('move correctly backward in one array', () => {
      expect(applyPatch(a, [['>/matrix/0/0', '/matrix/0/2']])).toEqual({
        matrix: [
          [2, 0, 1],
          [3, 4, 5],
          [6, 7, 8],
        ],
        vector: [10, 20],
      });
    });

    it('move correctly between arrays', () => {
      expect(applyPatch(a, [['>/matrix/1/3', '/matrix/0/0']])).toEqual({
        matrix: [
          [1, 2],
          [3, 4, 5, 0],
          [6, 7, 8],
        ],
        vector: [10, 20],
      });
    });

    it('object', () => {
      expect(applyPatch(a, [['>/matrix/-', '/vector']])).toEqual({
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
      expect(applyPatch(a, [['>/matrix/-', '/matrix/-']])).toEqual({
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
        expect(applyPatch(a, [['^/matrix/0/0', 1]])).toEqual({
          matrix: [
            [1, 1, 2],
            [3, 4, 5],
            [6, 7, 8],
          ],
          vector: [10, 20],
        });
      });

      it('increment in object', () => {
        expect(applyPatch(a, [['^/vector/0', 5]])).toEqual({
          matrix: [
            [0, 1, 2],
            [3, 4, 5],
            [6, 7, 8],
          ],
          vector: [15, 20],
        });
      });

      it('increment in non-existing path', () => {
        expect(applyPatch(a, [['^/nonexistent', 1]])).toEqual({ ...a, nonexistent: 1 });
      });

      it('decrement in object', () => {
        expect(applyPatch(a, [['^/vector/0', -5]])).toEqual({
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
        expect(applyPatch(a, [['~/matrix/0/0', 4]])).toEqual({
          matrix: [
            [4, 1, 2],
            [3, 4, 5],
            [6, 7, 8],
          ],
          vector: [10, 20],
        });

        expect(applyPatch(a, [['~/matrix/0/1', 4]])).toEqual({
          matrix: [
            [0, 5, 2],
            [3, 4, 5],
            [6, 7, 8],
          ],
          vector: [10, 20],
        });
      });

      it('turn a bit off in a bitmask', () => {
        expect(applyPatch(a, [['~/matrix/1/2', 131072]])).toEqual({
          matrix: [
            [0, 1, 2],
            [3, 4, 1],
            [6, 7, 8],
          ],
          vector: [10, 20],
        });
      });

      it('turn 2 bits off in a bitmask', () => {
        expect(applyPatch(a, [['~/matrix/1/2', combineBitmasks(bitmask(2, false), bitmask(0, false))]])).toEqual({
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
