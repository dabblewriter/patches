import { describe, it, expect } from 'vitest';
import { collapsePendingChanges } from '../../../src/algorithms/client/collapsePendingChanges';
import type { Change } from '../../../src/types';

describe('collapsePendingChanges', () => {
  const createChange = (rev: number, ops: any[] = []): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev: rev - 1,
    ops,
    createdAt: 0,
    committedAt: 0,
  });

  describe('basic collapsing', () => {
    it('should return empty array unchanged', () => {
      const result = collapsePendingChanges([]);
      expect(result).toEqual([]);
    });

    it('should return single change unchanged', () => {
      const changes = [createChange(1, [{ op: 'replace', path: '/opened', value: true }])];
      const result = collapsePendingChanges(changes);
      expect(result).toEqual(changes);
    });

    it('should collapse consecutive boolean toggles on same path', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/opened', value: true }]),
        createChange(2, [{ op: 'replace', path: '/opened', value: false }]),
        createChange(3, [{ op: 'replace', path: '/opened', value: true }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(1);
      expect(result[0].rev).toBe(3);
      expect(result[0].ops[0].value).toBe(true);
    });

    it('should collapse non-consecutive changes on same path', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/folders/abc/opened', value: true }]),
        createChange(2, [{ op: 'replace', path: '/items/xyz/name', value: 'foo' }]),
        createChange(3, [{ op: 'replace', path: '/folders/abc/opened', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(2);
      // First should be the items change (not collapsed)
      expect(result[0].ops[0].path).toBe('/items/xyz/name');
      expect(result[0].rev).toBe(2);
      // Second should be the final folders change
      expect(result[1].ops[0].path).toBe('/folders/abc/opened');
      expect(result[1].ops[0].value).toBe(false);
      expect(result[1].rev).toBe(3);
    });

    it('should collapse number updates on same path', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/count', value: 1 }]),
        createChange(2, [{ op: 'replace', path: '/count', value: 2 }]),
        createChange(3, [{ op: 'replace', path: '/count', value: 3 }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(1);
      expect(result[0].ops[0].value).toBe(3);
    });

    it('should collapse string updates on same path', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/name', value: 'draft' }]),
        createChange(2, [{ op: 'replace', path: '/name', value: 'final' }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(1);
      expect(result[0].ops[0].value).toBe('final');
    });

    it('should collapse null values on same path', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/value', value: 'something' }]),
        createChange(2, [{ op: 'replace', path: '/value', value: null }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(1);
      expect(result[0].ops[0].value).toBe(null);
    });
  });

  describe('non-collapsible changes', () => {
    it('should NOT collapse object values', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/data', value: { a: 1 } }]),
        createChange(2, [{ op: 'replace', path: '/data', value: { b: 2 } }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(2);
    });

    it('should NOT collapse array values', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/items', value: [1, 2] }]),
        createChange(2, [{ op: 'replace', path: '/items', value: [3, 4] }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(2);
    });

    it('should NOT collapse different paths', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/a', value: true }]),
        createChange(2, [{ op: 'replace', path: '/b', value: true }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(2);
    });

    it('should NOT collapse add operations', () => {
      const changes = [
        createChange(1, [{ op: 'add', path: '/new', value: 1 }]),
        createChange(2, [{ op: 'add', path: '/new', value: 2 }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(2);
    });

    it('should NOT collapse remove operations', () => {
      const changes = [
        createChange(1, [{ op: 'remove', path: '/old' }]),
        createChange(2, [{ op: 'remove', path: '/old' }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(2);
    });

    it('should NOT collapse multi-op changes', () => {
      const changes = [
        createChange(1, [
          { op: 'replace', path: '/a', value: true },
          { op: 'replace', path: '/b', value: true },
        ]),
        createChange(2, [
          { op: 'replace', path: '/a', value: false },
          { op: 'replace', path: '/b', value: false },
        ]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(2);
    });
  });

  describe('path invalidation', () => {
    it('should NOT collapse across remove of the path', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/folders/abc/opened', value: true }]),
        createChange(2, [{ op: 'remove', path: '/folders/abc' }]),
        createChange(3, [{ op: 'add', path: '/folders/abc', value: { opened: false } }]),
        createChange(4, [{ op: 'replace', path: '/folders/abc/opened', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      // Change 1 cannot be collapsed with change 4 because the folder was removed/recreated
      expect(result).toHaveLength(4);
    });

    it('should NOT collapse across remove of parent path', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/folders/abc/settings/opened', value: true }]),
        createChange(2, [{ op: 'remove', path: '/folders/abc' }]),
        createChange(3, [{ op: 'add', path: '/folders/abc', value: { settings: { opened: false } } }]),
        createChange(4, [{ op: 'replace', path: '/folders/abc/settings/opened', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(4);
    });

    it('should NOT collapse across array index add (shifts indices)', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/items/0/selected', value: true }]),
        createChange(2, [{ op: 'add', path: '/items/0', value: { selected: false } }]),
        createChange(3, [{ op: 'replace', path: '/items/0/selected', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      // Change 1 was on the original /items/0, which is now /items/1 after the add
      // Cannot collapse 1 and 3 because they refer to different items
      expect(result).toHaveLength(3);
    });

    it('should NOT collapse across array index remove (shifts indices)', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/items/1/selected', value: true }]),
        createChange(2, [{ op: 'remove', path: '/items/0' }]),
        createChange(3, [{ op: 'replace', path: '/items/1/selected', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(3);
    });

    it('should NOT collapse across move operation affecting path', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/folders/abc/opened', value: true }]),
        createChange(2, [{ op: 'move', path: '/folders/abc', from: '/archive/abc' }]),
        createChange(3, [{ op: 'replace', path: '/folders/abc/opened', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(3);
    });

    it('should continue collapsing after path is re-established', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/folders/abc/opened', value: true }]),
        createChange(2, [{ op: 'remove', path: '/folders/abc' }]),
        createChange(3, [{ op: 'add', path: '/folders/abc', value: { opened: false } }]),
        createChange(4, [{ op: 'replace', path: '/folders/abc/opened', value: true }]),
        createChange(5, [{ op: 'replace', path: '/folders/abc/opened', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      // Changes 4 and 5 should be collapsed since they come after the recreation
      expect(result).toHaveLength(4);
      expect(result[3].rev).toBe(5);
      expect(result[3].ops[0].value).toBe(false);
    });

    it('should only invalidate affected paths, not unrelated ones', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/folders/abc/opened', value: true }]),
        createChange(2, [{ op: 'replace', path: '/folders/xyz/opened', value: true }]),
        createChange(3, [{ op: 'remove', path: '/folders/abc' }]),
        createChange(4, [{ op: 'replace', path: '/folders/xyz/opened', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      // Changes 2 and 4 should be collapsed (xyz wasn't affected by abc removal)
      expect(result).toHaveLength(3);
      expect(result[0].ops[0].path).toBe('/folders/abc/opened');
      expect(result[1].ops[0].path).toBe('/folders/abc');
      expect(result[2].ops[0].path).toBe('/folders/xyz/opened');
      expect(result[2].ops[0].value).toBe(false);
    });
  });

  describe('afterRev bookmark', () => {
    it('should not collapse changes at or before afterRev', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/opened', value: true }]),
        createChange(2, [{ op: 'replace', path: '/opened', value: false }]),
        createChange(3, [{ op: 'replace', path: '/opened', value: true }]),
      ];

      const result = collapsePendingChanges(changes, 2);

      // Changes 1 and 2 are protected by bookmark, only change 3 is after it
      expect(result).toHaveLength(3);
    });

    it('should collapse changes after afterRev', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/opened', value: true }]),
        createChange(2, [{ op: 'replace', path: '/opened', value: false }]),
        createChange(3, [{ op: 'replace', path: '/opened', value: true }]),
        createChange(4, [{ op: 'replace', path: '/opened', value: false }]),
      ];

      const result = collapsePendingChanges(changes, 1);

      // Change 1 is protected, changes 2-4 can be collapsed to just 4
      expect(result).toHaveLength(2);
      expect(result[0].rev).toBe(1);
      expect(result[1].rev).toBe(4);
      expect(result[1].ops[0].value).toBe(false);
    });

    it('should handle afterRev when no changes are before it', () => {
      const changes = [
        createChange(5, [{ op: 'replace', path: '/opened', value: true }]),
        createChange(6, [{ op: 'replace', path: '/opened', value: false }]),
      ];

      const result = collapsePendingChanges(changes, 2);

      // All changes are after bookmark, should collapse
      expect(result).toHaveLength(1);
      expect(result[0].rev).toBe(6);
    });

    it('should handle afterRev when all changes are before it', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/opened', value: true }]),
        createChange(2, [{ op: 'replace', path: '/opened', value: false }]),
      ];

      const result = collapsePendingChanges(changes, 5);

      // All changes are protected by bookmark
      expect(result).toHaveLength(2);
    });
  });

  describe('ordering preservation', () => {
    it('should preserve relative order of non-collapsed changes', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/a', value: 1 }]),
        createChange(2, [{ op: 'replace', path: '/b', value: 2 }]),
        createChange(3, [{ op: 'replace', path: '/c', value: 3 }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(3);
      expect(result[0].ops[0].path).toBe('/a');
      expect(result[1].ops[0].path).toBe('/b');
      expect(result[2].ops[0].path).toBe('/c');
    });

    it('should place collapsed change at the position of the last occurrence', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/first', value: true }]),
        createChange(2, [{ op: 'replace', path: '/toggled', value: true }]),
        createChange(3, [{ op: 'replace', path: '/middle', value: true }]),
        createChange(4, [{ op: 'replace', path: '/toggled', value: false }]),
        createChange(5, [{ op: 'replace', path: '/last', value: true }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(4);
      expect(result[0].ops[0].path).toBe('/first');
      expect(result[1].ops[0].path).toBe('/middle');
      expect(result[2].ops[0].path).toBe('/toggled');
      expect(result[2].ops[0].value).toBe(false);
      expect(result[3].ops[0].path).toBe('/last');
    });
  });

  describe('edge cases', () => {
    it('should handle undefined rev gracefully', () => {
      const changeWithoutRev: Change = {
        id: 'change-1',
        ops: [{ op: 'replace', path: '/opened', value: true }],
        createdAt: 0,
        committedAt: 0,
        baseRev: 0,
        rev: undefined as any, // Simulating optional rev
      };

      const result = collapsePendingChanges([changeWithoutRev], 5);

      expect(result).toHaveLength(1);
    });

    it('should handle deeply nested paths', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/a/b/c/d/e/f/value', value: 1 }]),
        createChange(2, [{ op: 'replace', path: '/a/b/c/d/e/f/value', value: 2 }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(1);
      expect(result[0].ops[0].value).toBe(2);
    });

    it('should treat different array indices as different paths', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/items/0/selected', value: true }]),
        createChange(2, [{ op: 'replace', path: '/items/1/selected', value: true }]),
        createChange(3, [{ op: 'replace', path: '/items/0/selected', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      // /items/0/selected and /items/1/selected are different paths
      expect(result).toHaveLength(2);
      expect(result[0].ops[0].path).toBe('/items/1/selected');
      expect(result[1].ops[0].path).toBe('/items/0/selected');
      expect(result[1].ops[0].value).toBe(false);
    });

    it('should handle empty string values', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/name', value: 'hello' }]),
        createChange(2, [{ op: 'replace', path: '/name', value: '' }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(1);
      expect(result[0].ops[0].value).toBe('');
    });

    it('should handle zero values', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/count', value: 5 }]),
        createChange(2, [{ op: 'replace', path: '/count', value: 0 }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(1);
      expect(result[0].ops[0].value).toBe(0);
    });

    it('should handle false values', () => {
      const changes = [
        createChange(1, [{ op: 'replace', path: '/enabled', value: true }]),
        createChange(2, [{ op: 'replace', path: '/enabled', value: false }]),
      ];

      const result = collapsePendingChanges(changes);

      expect(result).toHaveLength(1);
      expect(result[0].ops[0].value).toBe(false);
    });
  });
});
