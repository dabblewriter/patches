import { describe, expect, it } from 'vitest';
import { transformPatch } from '../src/ot/transformPatch.js';

const matrix = [[], [], [], [], [], [], []];
const arr = [{}, {}, {}, {}, {}, {}, {}];
const obj = { x: arr };

describe('transformPatch', () => {
  describe('soft writes', () => {
    it('does not overwrite empty objects used for lookups', () => {
      expect(
        transformPatch(
          {},
          [
            ['+/obj', {}],
            ['+/obj/foo', {}],
          ],
          [
            ['+/obj', {}],
            ['+/obj/foo', {}],
            ['+/obj/foo/bar', 'hi1'],
          ]
        )
      ).toEqual([['+/obj/foo/bar', 'hi1']]);
    });

    it('does not overwrite writes marked as soft, allowing the first one to stand', () => {
      expect(
        transformPatch(
          {},
          [
            ['+/obj', {}, 1],
            ['+/obj/foo', {}, 1],
          ],
          [
            ['+/obj', {}, 1],
            ['+/obj/foo', {}, 1],
            ['+/obj/foo/bar', 'hi1'],
          ]
        )
      ).toEqual([['+/obj/foo/bar', 'hi1']]);
    });

    it('does not overwrite writes marked as soft even if the first are not soft', () => {
      expect(
        transformPatch(
          {},
          [
            ['+/obj', { test: true }],
            ['+/obj/foo', { test: true }],
          ],
          [
            ['+/obj', { test: true }, 1],
            ['+/obj/foo', { test: true }, 1],
            ['+/obj/foo/bar', 'hi1'],
          ]
        )
      ).toEqual([['+/obj/foo/bar', 'hi1']]);
    });

    it('does not overwrite writes marked as soft within an array', () => {
      expect(transformPatch({}, [['+/obj/array/3', 'three']], [['+/obj/array/3', 'three', 1]])).toEqual([]);
    });

    it('does not overwrite writes dependent on soft writes in an array', () => {
      expect(
        transformPatch(
          {},
          [['+/obj/array/3', {}]],
          [
            ['+/obj/array/3', {}, 1],
            ['+/obj/array/3/foo', 'bar'],
          ]
        )
      ).toEqual([['+/obj/array/3/foo', 'bar']]);
    });

    it('does not overwrite soft writes in an array', () => {
      expect(transformPatch({}, [['+/obj/array/3', 'test']], [['+/obj/array/3', 'test', 1]])).toEqual([]);
    });
  });

  describe('allowing later writes', () => {
    it('removes writes that are overwritten', () => {
      expect(transformPatch({}, [['+/obj', { test: true }]], [['+/obj/foo', { test: true }]])).toEqual([]);
    });

    it('does not remove writes that are reset', () => {
      expect(
        transformPatch(
          {},
          [['+/obj', { test: true }]],
          [
            ['+/obj', { test: true }],
            ['+/obj/foo', { test: true }],
          ]
        )
      ).toEqual([
        ['+/obj', { test: true }],
        ['+/obj/foo', { test: true }],
      ]);
    });

    it('removes unrelated writes that are reset', () => {
      expect(
        transformPatch(
          {},
          [
            ['+/obj', { test: true }],
            ['+/obj2', { test: true }],
          ],
          [
            ['+/obj', { test: true }],
            ['+/obj/foo', { test: true }],
            ['+/obj2/foo', { test: true }],
          ]
        )
      ).toEqual([
        ['+/obj', { test: true }],
        ['+/obj/foo', { test: true }],
      ]);
    });
  });

  describe('operations', () => {
    describe('add vs', () => {
      it('add vs add - array', () => {
        expect(transformPatch({}, [['+/array/0', 'zero']], [['+/array/1', 'two']])).toEqual([['+/array/2', 'two']]);
      });

      it('add vs add - deep array', () => {
        expect(transformPatch(matrix, [['+/1', 'hi1']], [['+/1', 'x']])).toEqual([['+/1', 'x']]);
        expect(transformPatch(matrix, [['+/1', 'hi1']], [['+/1/foo', 'x']])).toEqual([['+/2/foo', 'x']]);
      });

      it('add vs add - object', () => {
        expect(transformPatch(obj, [['+/x', 'hi1']], [['+/x', 'x']])).toEqual([['+/x', 'x']]);
      });

      it('add vs remove - array', () => {
        expect(transformPatch(matrix, [['+/1', 'hi1']], [['-/1']])).toEqual([['-/2']]);
      });

      it('add vs remove - object', () => {
        expect(transformPatch(obj, [['+/x', 'hi1']], [['-/x']])).toEqual([]);
      });

      it('add vs replace - array', () => {
        expect(transformPatch(matrix, [['+/1', 'hi1']], [['=/1', 'x']])).toEqual([['=/2', 'x']]);
      });

      it('add vs replace - object', () => {
        expect(transformPatch(obj, [['+/x', 'hi1']], [['=/x', 'x']])).toEqual([['=/x', 'x']]);
      });

      it('add vs copy - array', () => {
        expect(transformPatch(matrix, [['+/1', 'hi1']], [['&/1', '/0']])).toEqual([['&/1', '/0']]);
        expect(transformPatch(matrix, [['+/1', 'hi1']], [['&/0', '/1']])).toEqual([['&/0', '/2']]);
      });

      it('add vs copy - object', () => {
        expect(transformPatch(obj, [['+/x', 'hi1']], [['&/x', '/y']])).toEqual([['&/x', '/y']]);
        expect(transformPatch(obj, [['+/x', 'hi1']], [['&/y', '/x']])).toEqual([]);
      });

      it('add vs move - array', () => {
        expect(transformPatch(matrix, [['+/1', 'hi1']], [['>/1', '/0']])).toEqual([['>/2', '/0']]);
        expect(transformPatch(matrix, [['+/1', 'hi1']], [['>/0', '/1']])).toEqual([['>/0', '/2']]);
      });

      it('add vs move - object', () => {
        expect(transformPatch(obj, [['+/x', 'hi1']], [['>/x', '/y']])).toEqual([['>/x', '/y']]);
        expect(transformPatch(obj, [['+/x', 'hi1']], [['>/y', '/x']])).toEqual([]);
      });
    });

    describe('remove vs', () => {
      it('remove vs add - array', () => {
        expect(transformPatch(matrix, [['-/1']], [['+/1', 'x']])).toEqual([['+/1', 'x']]);
        expect(transformPatch(matrix, [['-/1']], [['+/1/foo', 'x']])).toEqual([]);
        expect(transformPatch(matrix, [['-/1']], [['+/2/foo', 'x']])).toEqual([['+/1/foo', 'x']]);
      });

      it('remove vs add - object', () => {
        expect(transformPatch(obj, [['-/x']], [['+/x', 'x']])).toEqual([['+/x', 'x']]);
      });

      it('remove vs remove - array', () => {
        expect(transformPatch(matrix, [['-/1']], [['-/1']])).toEqual([]);
      });

      it('remove vs remove - object', () => {
        expect(transformPatch(obj, [['-/x']], [['-/x']])).toEqual([]);
      });

      it('remove vs replace - array', () => {
        expect(transformPatch(matrix, [['-/1']], [['=/1', 'x']])).toEqual([['+/1', 'x']]);
      });

      it('remove vs replace - object', () => {
        expect(transformPatch(obj, [['-/x']], [['=/x', 'x']])).toEqual([['=/x', 'x']]);
      });

      it('remove vs copy - array', () => {
        expect(transformPatch(matrix, [['-/1']], [['&/1', '/0']])).toEqual([['&/1', '/0']]);
        expect(transformPatch(matrix, [['-/1']], [['&/0', '/1']])).toEqual([]);
        expect(
          transformPatch(
            matrix,
            [['-/1']],
            [
              ['&/2', '/1'],
              ['+/4', 'foo'],
            ]
          )
        ).toEqual([['+/2', 'foo']]);
      });

      it('remove vs copy - object', () => {
        expect(transformPatch(obj, [['-/x']], [['&/x', '/y']])).toEqual([['&/x', '/y']]);
        expect(transformPatch(obj, [['-/x']], [['&/y', '/x']])).toEqual([]);
        expect(
          transformPatch(
            obj,
            [['-/x']],
            [
              ['&/y', '/x'],
              ['+/y/foo', 'hi'],
            ]
          )
        ).toEqual([]);
      });

      it('remove vs move - array', () => {
        expect(transformPatch(matrix, [['-/1']], [['>/1', '/0']])).toEqual([]);
        expect(transformPatch(matrix, [['-/1']], [['>/0', '/1']])).toEqual([]);
        expect(transformPatch(matrix, [['-/1']], [['>/5', '/1']])).toEqual([]);
        expect(transformPatch(matrix, [['-/1']], [['>/1', '/3']])).toEqual([['>/1', '/2']]);
      });

      it('remove vs move - array how it affects other ops later in the patch which must be adjusted where the move landed', () => {
        expect(transformPatch(arr, [['-/5']], [['>/1', '/5']])).toEqual([]);
        expect(
          transformPatch(
            arr,
            [['-/5']],
            [
              ['>/1', '/5'],
              ['=/3/x', 'y'],
            ]
          )
        ).toEqual([['=/2/x', 'y']]);
      });

      it('remove vs move - object', () => {
        expect(transformPatch(obj, [['-/x']], [['>/x', '/y']])).toEqual([['>/x', '/y']]);
        expect(transformPatch(obj, [['-/x']], [['>/y', '/x']])).toEqual([]);
      });
    });

    describe('replace vs', () => {
      it('replace vs add - array', () => {
        expect(transformPatch(matrix, [['=/1', 'hi1']], [['+/1', 'x']])).toEqual([['+/1', 'x']]);
        expect(transformPatch(matrix, [['=/1', 'hi1']], [['+/1/foo', 'x']])).toEqual([]);
      });

      it('replace vs add - object', () => {
        expect(transformPatch(obj, [['=/x', 'hi1']], [['+/x', 'x']])).toEqual([['+/x', 'x']]);
      });

      it('replace vs remove - array', () => {
        expect(transformPatch(matrix, [['=/1', 'hi1']], [['-/1']])).toEqual([]);
      });

      it('replace vs remove - object', () => {
        expect(transformPatch(obj, [['=/x', 'hi1']], [['-/x']])).toEqual([]);
      });

      it('replace vs replace - array', () => {
        expect(transformPatch(matrix, [['=/1', 'hi1']], [['=/1', 'x']])).toEqual([['=/1', 'x']]);
      });

      it('replace vs replace - object', () => {
        expect(transformPatch(obj, [['=/x', 'hi1']], [['=/x', 'x']])).toEqual([['=/x', 'x']]);
      });

      it('replace vs copy - array', () => {
        expect(transformPatch(matrix, [['=/1', 'hi1']], [['&/1', '/0']])).toEqual([['&/1', '/0']]);
        expect(transformPatch(matrix, [['=/1', 'hi1']], [['&/0', '/1']])).toEqual([]);
      });

      it('replace vs copy - object', () => {
        expect(transformPatch(obj, [['=/x', 'hi1']], [['&/x', '/y']])).toEqual([['&/x', '/y']]);
        expect(transformPatch(obj, [['=/x', 'hi1']], [['&/y', '/x']])).toEqual([]);
      });

      it('replace vs move - array', () => {
        expect(transformPatch(matrix, [['=/1', 'hi1']], [['>/1', '/0']])).toEqual([['>/1', '/0']]);
        expect(transformPatch(matrix, [['=/1', 'hi1']], [['>/0', '/1']])).toEqual([]);
      });

      it('replace vs move - object', () => {
        expect(transformPatch(obj, [['=/x', 'hi1']], [['>/x', '/y']])).toEqual([['>/x', '/y']]);
        expect(transformPatch(obj, [['=/x', 'hi1']], [['>/y', '/x']])).toEqual([]);
      });
    });

    describe('copy vs', () => {
      it('copy vs add - array', () => {
        expect(transformPatch(matrix, [['&/1', '/3']], [['+/1', 'x']])).toEqual([['+/1', 'x']]);
        expect(transformPatch(matrix, [['&/1', '/3']], [['+/1/foo', 'x']])).toEqual([['+/2/foo', 'x']]);
      });

      it('copy vs add - object', () => {
        expect(transformPatch(obj, [['&/x', '/y']], [['+/x', 'x']])).toEqual([['+/x', 'x']]);
      });

      it('copy vs remove - array', () => {
        expect(transformPatch(matrix, [['&/1', '/3']], [['-/1']])).toEqual([['-/2']]);
      });

      it('copy vs remove - object', () => {
        expect(transformPatch(obj, [['&/x', '/y']], [['-/x']])).toEqual([]);
      });

      it('copy vs replace - array', () => {
        expect(transformPatch(matrix, [['&/1', '/3']], [['=/1', 'x']])).toEqual([['=/2', 'x']]);
      });

      it('copy vs replace - object', () => {
        expect(transformPatch(obj, [['&/x', '/y']], [['=/x', 'x']])).toEqual([['=/x', 'x']]);
      });

      it('copy vs copy - array', () => {
        expect(transformPatch(matrix, [['&/1', '/3']], [['&/1', '/0']])).toEqual([['&/1', '/0']]);
        expect(transformPatch(matrix, [['&/1', '/3']], [['&/0', '/1']])).toEqual([['&/0', '/2']]);
      });

      it('copy vs copy - object', () => {
        expect(transformPatch(obj, [['&/x', '/y']], [['&/x', '/y']])).toEqual([['&/x', '/y']]);
        expect(transformPatch(obj, [['&/x', '/y']], [['&/y', '/x']])).toEqual([]);
      });

      it('copy vs move - array', () => {
        expect(transformPatch(matrix, [['&/1', '/3']], [['>/1', '/0']])).toEqual([['>/2', '/0']]);
        expect(transformPatch(matrix, [['&/1', '/3']], [['>/0', '/1']])).toEqual([['>/0', '/2']]);
      });

      it('copy vs move - object', () => {
        expect(transformPatch(obj, [['&/x', '/y']], [['>/x', '/y']])).toEqual([['>/x', '/y']]);
        expect(transformPatch(obj, [['&/x', '/y']], [['>/y', '/x']])).toEqual([]);
      });
    });

    describe('move vs', () => {
      it('move vs add - array', () => {
        expect(transformPatch(matrix, [['>/1', '/3']], [['+/1', 'x']])).toEqual([['+/1', 'x']]);
        expect(transformPatch(matrix, [['>/1', '/3']], [['+/1/foo', 'x']])).toEqual([['+/2/foo', 'x']]);
      });

      it('move vs add - object', () => {
        expect(transformPatch(obj, [['>/x', '/y']], [['+/x', 'x']])).toEqual([['+/x', 'x']]);
      });

      it('move vs remove - array', () => {
        expect(transformPatch(matrix, [['>/1', '/3']], [['-/1']])).toEqual([['-/2']]);
      });

      it('move vs remove - object', () => {
        expect(transformPatch(obj, [['>/x', '/y']], [['-/x']])).toEqual([]);
      });

      it('move vs replace - array', () => {
        expect(transformPatch(matrix, [['>/1', '/3']], [['=/1', 'x']])).toEqual([['=/2', 'x']]);
      });

      it('move vs replace - object', () => {
        expect(transformPatch(obj, [['>/x', '/y']], [['=/x', 'x']])).toEqual([['=/x', 'x']]);
      });

      it('move vs copy - array', () => {
        expect(transformPatch(matrix, [['>/1', '/3']], [['&/1', '/0']])).toEqual([['&/1', '/0']]);
        expect(transformPatch(matrix, [['>/1', '/3']], [['&/0', '/1']])).toEqual([['&/0', '/2']]);
      });

      it('move vs copy - object', () => {
        expect(transformPatch(obj, [['>/x', '/y']], [['&/foo', '/y']])).toEqual([['&/foo', '/x']]);
        expect(transformPatch(obj, [['>/x', '/y']], [['&/x', '/y']])).toEqual([]);
        expect(transformPatch(obj, [['>/x', '/y']], [['&/y', '/x']])).toEqual([]);
      });

      it('move vs move - array', () => {
        expect(transformPatch(matrix, [['>/1', '/3']], [['>/1', '/0']])).toEqual([['>/1', '/0']]);
        expect(transformPatch(matrix, [['>/1', '/3']], [['>/0', '/1']])).toEqual([['>/0', '/2']]);
      });

      it('move vs move - object', () => {
        expect(transformPatch(obj, [['>/x', '/y']], [['>/foo', '/y']])).toEqual([['>/foo', '/x']]);
        expect(transformPatch(obj, [['>/x', '/y']], [['>/foo', '/x']])).toEqual([]);
      });
    });

    describe('increment vs', () => {
      it('increment vs add - array', () => {
        expect(transformPatch(matrix, [['^/1', 4]], [['+/1', 'x']])).toEqual([['+/1', 'x']]);
        expect(transformPatch(matrix, [['^/1', 4]], [['+/1/foo', 'x']])).toEqual([]);
      });

      it('increment vs add - object', () => {
        expect(transformPatch(obj, [['^/x', 4]], [['+/x', 'x']])).toEqual([['+/x', 'x']]);
      });

      it('increment vs remove - array', () => {
        expect(transformPatch(matrix, [['^/1', 4]], [['-/1']])).toEqual([['-/1']]);
      });

      it('increment vs remove - object', () => {
        expect(transformPatch(obj, [['^/x', 4]], [['-/x']])).toEqual([['-/x']]);
      });

      it('increment vs replace - array', () => {
        expect(transformPatch(matrix, [['^/1', 4]], [['=/1', 'x']])).toEqual([['=/1', 'x']]);
      });

      it('increment vs replace - object', () => {
        expect(transformPatch(obj, [['^/x', 4]], [['=/x', 'x']])).toEqual([['=/x', 'x']]);
      });

      it('increment vs copy - array', () => {
        expect(transformPatch(matrix, [['^/1', 4]], [['&/1', '/0']])).toEqual([['&/1', '/0']]);
        expect(transformPatch(matrix, [['^/1', 4]], [['&/0', '/1']])).toEqual([['&/0', '/1']]);
      });

      it('increment vs copy - object', () => {
        expect(transformPatch(obj, [['^/x', 4]], [['&/x', '/y']])).toEqual([['&/x', '/y']]);
        expect(transformPatch(obj, [['^/x', 4]], [['&/y', '/x']])).toEqual([['&/y', '/x']]);
      });

      it('increment vs move - array', () => {
        expect(transformPatch(matrix, [['^/1', 4]], [['>/1', '/0']])).toEqual([['>/1', '/0']]);
        expect(transformPatch(matrix, [['^/1', 4]], [['>/0', '/1']])).toEqual([['>/0', '/1']]);
      });

      it('increment vs move - object', () => {
        expect(transformPatch(obj, [['^/x', 4]], [['>/x', '/y']])).toEqual([['>/x', '/y']]);
        expect(transformPatch(obj, [['^/x', 4]], [['>/y', '/x']])).toEqual([['>/y', '/x']]);
      });

      it('increment vs increment - object', () => {
        expect(transformPatch(obj, [['^/x', 4]], [['^/x', 2]])).toEqual([['^/x', 2]]);
      });
    });
  });

  describe('array', () => {
    it('ensure non-arrays are handled as properties', () => {
      expect(transformPatch({}, [['+/0', 'x']], [['+/1', 'hi1']])).toEqual([['+/1', 'hi1']]);
    });

    it('bumps paths when list elements are inserted or removed', () => {
      expect(transformPatch(matrix, [['+/0', 'x']], [['+/1', 'hi1']])).toEqual([['+/2', 'hi1']]);
      expect(transformPatch(matrix, [['+/0', 'x']], [['+/0', 'hi2']])).toEqual([['+/0', 'hi2']]);
      expect(transformPatch(matrix, [['+/1', 'x']], [['+/0', 'hi3']])).toEqual([['+/0', 'hi3']]);
      expect(transformPatch(matrix, [['+/0', 'x']], [['T/1', []]])).toEqual([['T/2', []]]);
      expect(transformPatch(matrix, [['+/0', 'x']], [['T/0', []]])).toEqual([['T/1', []]]);
      expect(transformPatch(matrix, [['+/1', 'x']], [['T/0', []]])).toEqual([['T/0', []]]);
      expect(transformPatch(matrix, [['&/0', '/x']], [['+/1', 'hi1']])).toEqual([['+/2', 'hi1']]);
      expect(transformPatch(matrix, [['&/0', '/x']], [['+/0', 'hi2']])).toEqual([['+/0', 'hi2']]);
      expect(transformPatch(matrix, [['&/1', '/x']], [['+/0', 'hi3']])).toEqual([['+/0', 'hi3']]);

      expect(transformPatch(matrix, [['-/0']], [['+/1', 'hi4']])).toEqual([['+/0', 'hi4']]);
      expect(transformPatch(matrix, [['-/1']], [['+/0', 'hi5']])).toEqual([['+/0', 'hi5']]);
      expect(transformPatch(matrix, [['-/0']], [['+/0', 'hi6']])).toEqual([['+/0', 'hi6']]);
      expect(transformPatch(matrix, [['-/2']], [['+/2', 'hi7']])).toEqual([['+/2', 'hi7']]);
      expect(transformPatch(obj, [['+/x/5', 'x']], [['+/x/3/x', 'hi8']])).toEqual([['+/x/3/x', 'hi8']]);
      expect(transformPatch(obj, [['+/x/0', 'x']], [['+/x/3/x', 'hi9']])).toEqual([['+/x/4/x', 'hi9']]);
      expect(transformPatch(obj, [['+/x/3', 'x']], [['+/x/3/x', 'hi9']])).toEqual([['+/x/4/x', 'hi9']]);
      expect(transformPatch(matrix, [['-/0']], [['T/1', []]])).toEqual([['T/0', []]]);
      expect(transformPatch(matrix, [['-/1']], [['T/0', []]])).toEqual([['T/0', []]]);
      expect(transformPatch(matrix, [['-/0']], [['T/0', []]])).toEqual([
        ['+/0', null], // This was { op: 'add', path: '/0', value: null }
        ['T/0', []], // This was { op: '@txt', path: '/0', value: [] }
      ]);

      expect(transformPatch(matrix, [['+/0', 'x']], [['-/0']])).toEqual([['-/1']]);
    });

    it('test no-op', () => {
      expect(transformPatch(matrix, [['~/0', 'x']], [['-/0']])).toEqual([['-/0']]);
    });

    it('converts ops on deleted elements to noops', () => {
      expect(transformPatch(matrix, [['-/1']], [['-/1']])).toEqual([]);
      expect(transformPatch(matrix, [['-/1']], [['+/1/x']])).toEqual([]);
    });

    it('converts replace ops on deleted elements to add ops', () => {
      expect(transformPatch(matrix, [['-/1']], [['T/1', []]])).toEqual([
        ['+/1', null], // This was { op: 'add', path: '/1', value: null }
        ['T/1', []], // This was { op: '@txt', path: '/1', value: [] }
      ]);
      // The JSON patch spec says 'add' requires a value, but the original test had { op: 'add', path: '/1' } which is invalid.
      // Assuming it meant to add null or an empty object. Let's assume null based on the @txt case above.
      // If the original test truly meant an invalid op, this transformation might change behavior.
      // Let's stick to transforming valid ops or interpreting intent. Adding null seems reasonable.
      expect(transformPatch(matrix, [['-/1']], [['+/1', null]])).toEqual([['+/1', null]]);
    });

    it('converts replace to add on deleted elements', () => {
      // Fixed behavior with replace which is the same as remove+add, so if there is a remove then it converts to an add
      expect(transformPatch(matrix, [['-/1']], [['=/1', 'hi1']])).toEqual([['+/1', 'hi1']]);
    });

    it('converts ops on children of replaced elements to noops', () => {
      expect(transformPatch(matrix, [['=/1', 'hi1']], [['-/1']])).toEqual([]);
      expect(transformPatch(arr, [['=/1', 'y']], [['+/1/x', 'hi']])).toEqual([]);
      expect(transformPatch(matrix, [['=/1', 'y']], [['T/1', []]])).toEqual([['T/1', []]]);
      expect(transformPatch(matrix, [['=/0', 'y']], [['+/0', 'hi']])).toEqual([['+/0', 'hi']]);
    });

    it('Puts the transformed op second if two inserts are simultaneous', () => {
      expect(transformPatch(matrix, [['+/1', 'b']], [['+/1', 'a']])).toEqual([['+/1', 'a']]);
    });

    it('converts an attempt to re-delete a list element into a no-op', () => {
      expect(transformPatch(matrix, [['-/1']], [['-/1']])).toEqual([]);
    });

    it('moves ops on a moved element with the element', () => {
      expect(transformPatch(matrix, [['>/10', '/4']], [['-/4']])).toEqual([['-/10']]);
      expect(transformPatch(matrix, [['>/10', '/4']], [['=/4', 'a']])).toEqual([['=/10', 'a']]);
      expect(transformPatch(matrix, [['>/10', '/4']], [['T/4', []]])).toEqual([['T/10', []]]);
      expect(transformPatch(matrix, [['>/10', '/4']], [['+/4/1', 'a']])).toEqual([['+/10/1', 'a']]);
      expect(transformPatch(matrix, [['>/10', '/4']], [['=/4/1', 'a']])).toEqual([['=/10/1', 'a']]);

      expect(transformPatch(matrix, [['>/1', '/0']], [['+/0', null]])).toEqual([['+/0', null]]);
      expect(transformPatch(matrix, [['>/1', '/5']], [['+/5', 'x']])).toEqual([['+/6', 'x']]);
      expect(transformPatch(matrix, [['>/1', '/5']], [['-/5']])).toEqual([['-/1']]);
      expect(transformPatch(matrix, [['>/0', '/0']], [['+/0', {}]])).toEqual([['+/0', {}]]);
      expect(transformPatch(matrix, [['>/0', '/1']], [['+/0', []]])).toEqual([['+/0', []]]);
      expect(transformPatch(matrix, [['>/1', '/0']], [['+/2', 'x']])).toEqual([['+/2', 'x']]);
      expect(transformPatch(matrix, [['>/1', '/10']], [['+/5', 'x']])).toEqual([['+/6', 'x']]);
      expect(transformPatch(matrix, [['>/10', '/1']], [['+/1', 'x']])).toEqual([['+/1', 'x']]);
      expect(transformPatch(matrix, [['>/10', '/1']], [['+/2', 'x']])).toEqual([['+/1', 'x']]);
      expect(transformPatch(matrix, [['>/10', '/0']], [['>/5', '/3']])).toEqual([['>/4', '/2']]);
    });

    it('moves target index on remove/add', () => {
      // Note: The original test had { op: 'remove', path: '/1', value: 'x' } which is invalid JSON Patch (remove doesn't use value). Assuming value should be ignored.
      expect(transformPatch(matrix, [['-/1']], [['>/2', '/0']])).toEqual([['>/1', '/0']]);
      expect(transformPatch(matrix, [['-/1']], [['>/4', '/2']])).toEqual([['>/3', '/1']]);
      expect(transformPatch(matrix, [['+/1', 'x']], [['>/2', '/0']])).toEqual([['>/3', '/0']]);
      expect(transformPatch(matrix, [['+/1', 'x']], [['>/4', '/2']])).toEqual([['>/5', '/3']]);
      expect(transformPatch(matrix, [['+/0', 28]], [['>/0', '/0']])).toEqual([]);
    });

    it('tiebreaks move vs. add/delete', () => {
      expect(transformPatch(matrix, [['-/0']], [['>/2', '/0']])).toEqual([]);
      expect(transformPatch(matrix, [['+/0', 'x']], [['>/2', '/0']])).toEqual([['>/3', '/1']]);
    });

    it('replacement vs. deletion', () => {
      expect(transformPatch(matrix, [['-/0']], [['=/0', 'y']])).toEqual([['+/0', 'y']]);
      expect(transformPatch(matrix, [['-/0']], [['+/0', 'y']])).toEqual([['+/0', 'y']]);
    });

    it('replacement vs. insertion', () => {
      expect(transformPatch(matrix, [['+/0', 'x']], [['=/0', 'y']])).toEqual([['=/1', 'y']]);
      expect(transformPatch(matrix, [['=/0', 'x']], [['+/5', 'y']])).toEqual([['+/5', 'y']]);
    });

    it('replacement vs. replacement', () => {
      expect(transformPatch(matrix, [['=/0', 'x']], [['=/0', 'y']])).toEqual([['=/0', 'y']]);
    });

    it('move vs. move', () => {
      expect(transformPatch(matrix, [['>/1', '/2']], [['>/2', '/0']])).toEqual([['>/3', '/0']]);
      expect(transformPatch(matrix, [['>/0', '/2']], [['>/2', '/0']])).toEqual([['>/2', '/1']]);
      expect(transformPatch(matrix, [['>/0', '/1']], [['>/2', '/0']])).toEqual([['>/2', '/1']]);

      expect(transformPatch(matrix, [['>/0', '/3']], [['>/3', '/2']])).toEqual([]);
      expect(transformPatch(matrix, [['>/0', '/3']], [['>/3', '/1']])).toEqual([['>/3', '/2']]);

      expect(transformPatch(matrix, [['>/0', '/5']], [['>/3', '/3']])).toEqual([]);
      expect(transformPatch(matrix, [['>/0', '/1']], [['>/0', '/2']])).toEqual([['>/0', '/2']]);
      expect(transformPatch(matrix, [['>/0', '/5']], [['>/0', '/2']])).toEqual([['>/0', '/3']]);
      expect(transformPatch(matrix, [['>/0', '/2']], [['>/5', '/2']])).toEqual([['>/5', '/0']]);
      expect(transformPatch(matrix, [['>/0', '/1']], [['>/1', '/0']])).toEqual([]);
      expect(transformPatch(matrix, [['>/3', '/1']], [['>/1', '/3']])).toEqual([['>/1', '/2']]);
      expect(transformPatch(matrix, [['>/1', '/3']], [['>/3', '/1']])).toEqual([['>/3', '/2']]);
      expect(transformPatch(matrix, [['>/1', '/0']], [['>/6', '/2']])).toEqual([['>/6', '/2']]);
      expect(transformPatch(matrix, [['>/0', '/1']], [['>/6', '/2']])).toEqual([['>/6', '/2']]);
      expect(transformPatch(matrix, [['>/1', '/2']], [['>/1', '/0']])).toEqual([['>/1', '/0']]);
      expect(transformPatch(matrix, [['>/0', '/1']], [['>/0', '/0']])).toEqual([]);
      expect(transformPatch(matrix, [['>/3', '/1']], [['>/1', '/0']])).toEqual([['>/1', '/0']]);
      expect(transformPatch(matrix, [['>/2', '/3']], [['>/1', '/2']])).toEqual([['>/1', '/3']]);
      expect(transformPatch(matrix, [['>/1', '/2']], [['>/2', '/3']])).toEqual([]);
    });

    it('changes indices correctly around a move', () => {
      expect(transformPatch(matrix, [['>/0', '/1']], [['+/0/0', {}]])).toEqual([['+/1/0', {}]]);
      expect(transformPatch(matrix, [['-/0']], [['>/0', '/1']])).toEqual([]);
      expect(transformPatch(matrix, [['-/1']], [['>/1', '/0']])).toEqual([]);
      expect(transformPatch(matrix, [['-/2']], [['>/0', '/6']])).toEqual([['>/0', '/5']]);
      expect(transformPatch(matrix, [['-/2']], [['>/0', '/1']])).toEqual([['>/0', '/1']]);
      expect(transformPatch(matrix, [['-/1']], [['>/1', '/2']])).toEqual([]);

      expect(transformPatch(matrix, [['>/2', '/1']], [['-/2']])).toEqual([['-/1']]);
      expect(transformPatch(matrix, [['>/1', '/2']], [['-/1']])).toEqual([['-/2']]);

      expect(transformPatch(matrix, [['>/1', '/0']], [['-/1']])).toEqual([['-/0']]);

      expect(transformPatch(matrix, [['>/0', '/1']], [['=/1', 2]])).toEqual([['=/0', 2]]);
      expect(transformPatch(matrix, [['>/1', '/0']], [['=/1', 3]])).toEqual([['=/0', 3]]);
      expect(transformPatch(matrix, [['>/0', '/1']], [['=/0', 4]])).toEqual([['=/1', 4]]);
    });

    it('changes indices correctly around a move from a non-list', () => {
      // expect(transformPatch(matrix, [['>/0', '/x']], [['+/0/0', {}]])).toEqual([['+/1/0', {}]]);
      // expect(transformPatch(matrix, [['>/0', '/x']], [['+/0', {}]])).toEqual([['+/0', {}]]);
      // expect(transformPatch(matrix, [['>/x', '/0']], [['+/0', {}]])).toEqual([['+/0', {}]]);
      // expect(transformPatch(matrix, [['>/1', '/x']], [['+/3', {}]])).toEqual([['+/4', {}]]);
      // expect(transformPatch(matrix, [['>/1', '/x']], [['>/3', '/1']])).toEqual([['>/4', '/2']]);
      expect(transformPatch(matrix, [['>/x', '/1']], [['>/3', '/1']])).toEqual([['>/2', '/x']]);
      expect(transformPatch(matrix, [['>/x', '/2']], [['>/1', '/3']])).toEqual([['>/1', '/2']]);
      expect(transformPatch(matrix, [['>/2', '/x']], [['>/1', '/3']])).toEqual([['>/1', '/4']]);
    });

    it('add vs. move', () => {
      expect(transformPatch(matrix, [['>/3', '/1']], [['+/0', []]])).toEqual([['+/0', []]]);
      expect(transformPatch(matrix, [['>/3', '/1']], [['+/1', []]])).toEqual([['+/1', []]]);
      expect(transformPatch(matrix, [['>/3', '/1']], [['+/2', []]])).toEqual([['+/1', []]]);
      expect(transformPatch(matrix, [['>/3', '/1']], [['+/3', []]])).toEqual([['+/3', []]]);
      expect(transformPatch(matrix, [['>/3', '/1']], [['+/4', []]])).toEqual([['+/4', []]]);

      expect(transformPatch(matrix, [['+/0', []]], [['>/3', '/1']])).toEqual([['>/4', '/2']]);
      expect(transformPatch(matrix, [['+/1', []]], [['>/3', '/1']])).toEqual([['>/4', '/2']]);
      expect(transformPatch(matrix, [['+/2', []]], [['>/3', '/1']])).toEqual([['>/4', '/1']]);
      expect(transformPatch(matrix, [['+/3', []]], [['>/3', '/1']])).toEqual([['>/4', '/1']]);
      expect(transformPatch(matrix, [['+/4', []]], [['>/3', '/1']])).toEqual([['>/3', '/1']]);

      expect(transformPatch(matrix, [['>/2', '/1']], [['+/0', []]])).toEqual([['+/0', []]]);
      expect(transformPatch(matrix, [['>/2', '/1']], [['+/1', []]])).toEqual([['+/1', []]]);
      expect(transformPatch(matrix, [['>/2', '/1']], [['+/2', []]])).toEqual([['+/2', []]]);
      expect(transformPatch(matrix, [['>/2', '/1']], [['+/3', []]])).toEqual([['+/3', []]]);

      expect(transformPatch(matrix, [['>/1', '/3']], [['+/0', []]])).toEqual([['+/0', []]]);
      expect(transformPatch(matrix, [['>/1', '/3']], [['+/1', []]])).toEqual([['+/1', []]]);
      expect(transformPatch(matrix, [['>/1', '/3']], [['+/2', []]])).toEqual([['+/3', []]]);
      expect(transformPatch(matrix, [['>/1', '/3']], [['+/3', []]])).toEqual([['+/4', []]]);
      expect(transformPatch(matrix, [['>/1', '/3']], [['+/4', []]])).toEqual([['+/4', []]]);

      expect(transformPatch(matrix, [['+/0', []]], [['>/1', '/3']])).toEqual([['>/2', '/4']]);
      expect(transformPatch(matrix, [['+/1', []]], [['>/1', '/3']])).toEqual([['>/1', '/4']]);
      expect(transformPatch(matrix, [['+/2', []]], [['>/1', '/3']])).toEqual([['>/1', '/4']]);
      expect(transformPatch(matrix, [['+/3', []]], [['>/1', '/3']])).toEqual([['>/1', '/4']]);
      expect(transformPatch(matrix, [['+/4', []]], [['>/1', '/3']])).toEqual([['>/1', '/3']]);

      expect(transformPatch(matrix, [['>/1', '/2']], [['+/0', []]])).toEqual([['+/0', []]]);
      expect(transformPatch(matrix, [['>/1', '/2']], [['+/1', []]])).toEqual([['+/1', []]]);
      expect(transformPatch(matrix, [['>/1', '/2']], [['+/2', []]])).toEqual([['+/3', []]]);
      expect(transformPatch(matrix, [['>/1', '/2']], [['+/3', []]])).toEqual([['+/3', []]]);
    });
  });

  describe('object', () => {
    it('Ops on deleted elements become noops', () => {
      expect(transformPatch(matrix, [['-/1']], [['+/1/0', 'hi']])).toEqual([]);
      expect(transformPatch(arr, [['-/1']], [['T/1/text']])).toEqual([]);
    });

    it('Ops on replaced elements become noops', () => {
      expect(transformPatch(matrix, [['=/1', 'y']], [['+/1/0', 'hi']])).toEqual([]);
      expect(transformPatch(arr, [['=/1', 'y']], [['T/1/text']])).toEqual([]);
    });

    it('If two inserts are simultaneous, the last insert will win', () => {
      expect(transformPatch(obj, [['+/x', 'b']], [['+/x', 'a']])).toEqual([['+/x', 'a']]);
      expect(transformPatch(obj, [['+/x', 'b']], [['=/x', 'a']])).toEqual([['=/x', 'a']]);
    });

    it('parallel ops on different keys miss each other', () => {
      expect(transformPatch(obj, [['+/b', 'z']], [['+/a', 'x']])).toEqual([['+/a', 'x']]);
      expect(transformPatch(obj, [['-/b']], [['+/a', 'x']])).toEqual([['+/a', 'x']]);
      expect(transformPatch(obj, [['-/and']], [['+/in/he', {}]])).toEqual([['+/in/he', {}]]);
      expect(transformPatch(obj, [['=/y', 1]], [['+/x/0', 'his ']])).toEqual([['+/x/0', 'his ']]);
      // Assuming the original [@txt, /x] meant [@txt, /x, undefined] or similar based on context
      expect(transformPatch(obj, [['=/y', 1]], [['T/x']])).toEqual([['T/x']]);
    });

    it('replacement vs. deletion', () => {
      expect(transformPatch(obj, [['-/']], [['+/', {}]])).toEqual([['+/', {}]]);
      expect(transformPatch(obj, [['-/']], [['=/', {}]])).toEqual([['=/', {}]]);
    });

    it('replacement vs. replacement', () => {
      expect(transformPatch(obj, [['-/'], ['+/', null]], [['-/'], ['=/', {}]])).toEqual([['=/', {}]]);
      expect(transformPatch(obj, [['-/'], ['+/', null]], [['-/'], ['+/', {}]])).toEqual([['+/', {}]]);
      expect(transformPatch(obj, [['=/', null]], [['=/', {}]])).toEqual([['=/', {}]]);
    });

    it('move, remove', () => {
      expect(transformPatch(obj, [['>/y', '/x']], [['+/x', true]])).toEqual([['+/x', true]]);
      expect(transformPatch(obj, [['>/y', '/x']], [['+/x/y', true]])).toEqual([['+/y/y', true]]);
      expect(transformPatch(obj, [['>/y', '/x']], [['-/x'], ['+/x', true]])).toEqual([['-/y'], ['+/x', true]]);
      expect(
        transformPatch(
          obj,
          [
            ['>/y', '/x'],
            ['>/z', '/y'],
          ],
          [['>/x/b', '/x/a']]
        )
      ).toEqual([['>/z/b', '/z/a']]);
    });

    it('copy', () => {
      expect(transformPatch(obj, [['&/x', '/y']], [['+/x/y', true]])).toEqual([]);
    });

    it('An attempt to re-delete a key becomes a no-op', () => {
      expect(transformPatch(obj, [['-/k']], [['-/k']])).toEqual([]);
    });

    it('Ops after an add, copy, or move will not be affected by a change', () => {
      expect(
        transformPatch(
          obj,
          [['-/k']],
          [
            ['+/k'], // Assuming add op needs a value, defaulting to null based on other tests
            ['=/k/g', 2],
          ]
        )
      ).toEqual([['+/k'], ['=/k/g', 2]]);
    });
  });

  describe('text', () => {
    it('applies text changes', () => {
      expect(transformPatch(obj, [['T/text', [{ insert: 'test' }]]], [['T/text', [{ insert: 'testing' }]]])).toEqual([
        ['T/text', [{ retain: 4 }, { insert: 'testing' }]],
      ]);
      expect(
        transformPatch(
          obj,
          [
            ['T/text', [{ insert: 'test' }]],
            ['T/text', [{ delete: 1 }, { insert: 'T' }]],
          ],
          [['T/text', [{ insert: 'testing' }]]]
        )
      ).toEqual([['T/text', [{ retain: 4 }, { insert: 'testing' }]]]);
      expect(transformPatch(obj, [['T/a', [{ insert: 'test' }]]], [['T/a/text', [{ insert: 'testing' }]]])).toEqual([]);
      expect(transformPatch(obj, [['T/text', [{ insert: 'test' }]]], [['=/text', true]])).toEqual([['=/text', true]]);
    });

    it('deletes values it overwrites', () => {
      expect(transformPatch(obj, [['T/x', [{ insert: 'test' }]]], [['+/x/y', 1]])).toEqual([]);
      expect(transformPatch(obj, [['T/x', [{ insert: 'test' }]]], [['-/x']])).toEqual([['-/x']]);
      expect(transformPatch(obj, [['T/x', [{ insert: 'test' }]]], [['=/x', 10]])).toEqual([['=/x', 10]]);
    });
  });

  describe('unsupported', () => {
    it('noops', () => {
      // Keeping the 'as' cast and converting based on 'add' as discussed previously.
      expect(
        transformPatch(
          obj,
          [['+/x' as '+/x', true]], // Represents { op: 'unsupported' as 'add', path: '/x', value: true }
          [['+/x', 1]]
        )
      ).toEqual([['+/x', 1]]);
    });
  });
});
