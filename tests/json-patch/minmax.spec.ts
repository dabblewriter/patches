import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';
import { composePatch } from '../../src/json-patch/composePatch.js';
import { invertPatch } from '../../src/json-patch/invertPatch.js';
import { JSONPatch } from '../../src/json-patch/JSONPatch.js';

describe('max and min operations', () => {
  describe('@max apply', () => {
    it('sets value when path is undefined', () => {
      expect(applyPatch({}, [{ op: '@max', path: '/x', value: 5 }])).toEqual({ x: 5 });
    });

    it('sets value when path is null', () => {
      expect(applyPatch({ x: null }, [{ op: '@max', path: '/x', value: 5 }])).toEqual({ x: 5 });
    });

    it('updates when new value is greater (numbers)', () => {
      expect(applyPatch({ x: 5 }, [{ op: '@max', path: '/x', value: 10 }])).toEqual({ x: 10 });
    });

    it('keeps current when current is greater (numbers)', () => {
      const obj = { x: 10 };
      const result = applyPatch(obj, [{ op: '@max', path: '/x', value: 5 }]);
      expect(result).toEqual({ x: 10 });
      expect(result).toBe(obj); // Same reference, no mutation
    });

    it('keeps current when values are equal', () => {
      const obj = { x: 10 };
      const result = applyPatch(obj, [{ op: '@max', path: '/x', value: 10 }]);
      expect(result).toEqual({ x: 10 });
      expect(result).toBe(obj); // Same reference, no mutation
    });

    it('updates when new value is greater (ISO dates)', () => {
      expect(
        applyPatch(
          { lastModified: '2024-01-15T10:00:00Z' },
          [{ op: '@max', path: '/lastModified', value: '2024-01-20T10:00:00Z' }]
        )
      ).toEqual({ lastModified: '2024-01-20T10:00:00Z' });
    });

    it('keeps current when current is greater (ISO dates)', () => {
      const obj = { lastModified: '2024-01-20T10:00:00Z' };
      const result = applyPatch(obj, [{ op: '@max', path: '/lastModified', value: '2024-01-15T10:00:00Z' }]);
      expect(result).toEqual({ lastModified: '2024-01-20T10:00:00Z' });
      expect(result).toBe(obj);
    });

    it('works in arrays', () => {
      expect(applyPatch({ arr: [5, 10, 15] }, [{ op: '@max', path: '/arr/1', value: 20 }])).toEqual({
        arr: [5, 20, 15],
      });
    });

    it('works with nested paths', () => {
      expect(
        applyPatch({ a: { b: { c: 5 } } }, [{ op: '@max', path: '/a/b/c', value: 10 }])
      ).toEqual({ a: { b: { c: 10 } } });
    });

    it('handles zero correctly (0 is a valid value)', () => {
      expect(applyPatch({ x: 0 }, [{ op: '@max', path: '/x', value: 5 }])).toEqual({ x: 5 });
      expect(applyPatch({ x: 0 }, [{ op: '@max', path: '/x', value: -5 }])).toEqual({ x: 0 });
    });
  });

  describe('@min apply', () => {
    it('sets value when path is undefined', () => {
      expect(applyPatch({}, [{ op: '@min', path: '/x', value: 5 }])).toEqual({ x: 5 });
    });

    it('sets value when path is null', () => {
      expect(applyPatch({ x: null }, [{ op: '@min', path: '/x', value: 5 }])).toEqual({ x: 5 });
    });

    it('updates when new value is smaller (numbers)', () => {
      expect(applyPatch({ x: 10 }, [{ op: '@min', path: '/x', value: 5 }])).toEqual({ x: 5 });
    });

    it('keeps current when current is smaller (numbers)', () => {
      const obj = { x: 5 };
      const result = applyPatch(obj, [{ op: '@min', path: '/x', value: 10 }]);
      expect(result).toEqual({ x: 5 });
      expect(result).toBe(obj); // Same reference, no mutation
    });

    it('keeps current when values are equal', () => {
      const obj = { x: 10 };
      const result = applyPatch(obj, [{ op: '@min', path: '/x', value: 10 }]);
      expect(result).toEqual({ x: 10 });
      expect(result).toBe(obj); // Same reference, no mutation
    });

    it('updates when new value is smaller (ISO dates)', () => {
      expect(
        applyPatch(
          { createdAt: '2024-01-20T10:00:00Z' },
          [{ op: '@min', path: '/createdAt', value: '2024-01-15T10:00:00Z' }]
        )
      ).toEqual({ createdAt: '2024-01-15T10:00:00Z' });
    });

    it('keeps current when current is smaller (ISO dates)', () => {
      const obj = { createdAt: '2024-01-15T10:00:00Z' };
      const result = applyPatch(obj, [{ op: '@min', path: '/createdAt', value: '2024-01-20T10:00:00Z' }]);
      expect(result).toEqual({ createdAt: '2024-01-15T10:00:00Z' });
      expect(result).toBe(obj);
    });

    it('works in arrays', () => {
      expect(applyPatch({ arr: [5, 10, 15] }, [{ op: '@min', path: '/arr/1', value: 3 }])).toEqual({
        arr: [5, 3, 15],
      });
    });

    it('works with nested paths', () => {
      expect(
        applyPatch({ a: { b: { c: 10 } } }, [{ op: '@min', path: '/a/b/c', value: 5 }])
      ).toEqual({ a: { b: { c: 5 } } });
    });

    it('handles zero correctly (0 is a valid value)', () => {
      expect(applyPatch({ x: 0 }, [{ op: '@min', path: '/x', value: 5 }])).toEqual({ x: 0 });
      expect(applyPatch({ x: 0 }, [{ op: '@min', path: '/x', value: -5 }])).toEqual({ x: -5 });
    });
  });

  describe('@max compose', () => {
    it('composes multiple @max ops to the maximum value', () => {
      expect(
        composePatch([
          { op: '@max', path: '/x', value: 5 },
          { op: '@max', path: '/x', value: 10 },
          { op: '@max', path: '/x', value: 3 },
        ])
      ).toEqual([{ op: '@max', path: '/x', value: 10 }]);
    });

    it('composes ISO date @max ops correctly', () => {
      expect(
        composePatch([
          { op: '@max', path: '/lastModified', value: '2024-01-15T10:00:00Z' },
          { op: '@max', path: '/lastModified', value: '2024-01-20T10:00:00Z' },
          { op: '@max', path: '/lastModified', value: '2024-01-10T10:00:00Z' },
        ])
      ).toEqual([{ op: '@max', path: '/lastModified', value: '2024-01-20T10:00:00Z' }]);
    });

    it('does not compose @max ops on different paths', () => {
      expect(
        composePatch([
          { op: '@max', path: '/x', value: 5 },
          { op: '@max', path: '/y', value: 10 },
        ])
      ).toEqual([
        { op: '@max', path: '/x', value: 5 },
        { op: '@max', path: '/y', value: 10 },
      ]);
    });
  });

  describe('@min compose', () => {
    it('composes multiple @min ops to the minimum value', () => {
      expect(
        composePatch([
          { op: '@min', path: '/x', value: 10 },
          { op: '@min', path: '/x', value: 5 },
          { op: '@min', path: '/x', value: 15 },
        ])
      ).toEqual([{ op: '@min', path: '/x', value: 5 }]);
    });

    it('composes ISO date @min ops correctly', () => {
      expect(
        composePatch([
          { op: '@min', path: '/createdAt', value: '2024-01-15T10:00:00Z' },
          { op: '@min', path: '/createdAt', value: '2024-01-10T10:00:00Z' },
          { op: '@min', path: '/createdAt', value: '2024-01-20T10:00:00Z' },
        ])
      ).toEqual([{ op: '@min', path: '/createdAt', value: '2024-01-10T10:00:00Z' }]);
    });
  });

  describe('@max invert', () => {
    it('inverts to replace with original value', () => {
      const obj = { x: 5 };
      const ops = [{ op: '@max', path: '/x', value: 10 }];
      const inverted = invertPatch(obj, ops);
      expect(inverted).toEqual([{ op: 'replace', path: '/x', value: 5 }]);
    });

    it('inverts to remove when original was undefined', () => {
      const obj = {};
      const ops = [{ op: '@max', path: '/x', value: 10 }];
      const inverted = invertPatch(obj, ops);
      expect(inverted).toEqual([{ op: 'remove', path: '/x' }]);
    });
  });

  describe('@min invert', () => {
    it('inverts to replace with original value', () => {
      const obj = { x: 10 };
      const ops = [{ op: '@min', path: '/x', value: 5 }];
      const inverted = invertPatch(obj, ops);
      expect(inverted).toEqual([{ op: 'replace', path: '/x', value: 10 }]);
    });

    it('inverts to remove when original was undefined', () => {
      const obj = {};
      const ops = [{ op: '@min', path: '/x', value: 5 }];
      const inverted = invertPatch(obj, ops);
      expect(inverted).toEqual([{ op: 'remove', path: '/x' }]);
    });
  });

  describe('JSONPatch convenience methods', () => {
    it('max() creates @max operation', () => {
      const patch = new JSONPatch();
      patch.max('/lastModified', '2024-01-20T10:00:00Z');
      expect(patch.ops).toEqual([{ op: '@max', path: '/lastModified', value: '2024-01-20T10:00:00Z' }]);
    });

    it('min() creates @min operation', () => {
      const patch = new JSONPatch();
      patch.min('/createdAt', '2024-01-15T10:00:00Z');
      expect(patch.ops).toEqual([{ op: '@min', path: '/createdAt', value: '2024-01-15T10:00:00Z' }]);
    });

    it('max() with number', () => {
      const patch = new JSONPatch();
      patch.max('/score', 100);
      expect(patch.ops).toEqual([{ op: '@max', path: '/score', value: 100 }]);
    });

    it('min() with number', () => {
      const patch = new JSONPatch();
      patch.min('/score', 0);
      expect(patch.ops).toEqual([{ op: '@min', path: '/score', value: 0 }]);
    });

    it('max() applies correctly', () => {
      const patch = new JSONPatch();
      patch.max('/x', 10);
      expect(patch.apply({ x: 5 })).toEqual({ x: 10 });
      expect(patch.apply({ x: 15 })).toEqual({ x: 15 });
    });

    it('min() applies correctly', () => {
      const patch = new JSONPatch();
      patch.min('/x', 10);
      expect(patch.apply({ x: 15 })).toEqual({ x: 10 });
      expect(patch.apply({ x: 5 })).toEqual({ x: 5 });
    });

    it('max() handles Date objects with toJSON', () => {
      const patch = new JSONPatch();
      const date = new Date('2024-01-20T10:00:00Z');
      patch.max('/lastModified', date as any);
      expect(patch.ops).toEqual([{ op: '@max', path: '/lastModified', value: '2024-01-20T10:00:00.000Z' }]);
    });

    it('min() handles Date objects with toJSON', () => {
      const patch = new JSONPatch();
      const date = new Date('2024-01-15T10:00:00Z');
      patch.min('/createdAt', date as any);
      expect(patch.ops).toEqual([{ op: '@min', path: '/createdAt', value: '2024-01-15T10:00:00.000Z' }]);
    });
  });
});
