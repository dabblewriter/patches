import { describe, it, expect } from 'vitest';
import { fractionalIndex, healDuplicateOrders, sortByOrder } from '../src/fractionalIndex.js';

describe('fractionalIndex', () => {
  it('should generate first index when both bounds are null', () => {
    expect(fractionalIndex(null, null)).toBe('a0');
  });

  it('should generate index after a given value', () => {
    expect(fractionalIndex('a0', null)).toBe('a1');
    expect(fractionalIndex('a1', null)).toBe('a2');
  });

  it('should generate index before a given value', () => {
    const before = fractionalIndex(null, 'a0');
    expect(before < 'a0').toBe(true);
  });

  it('should generate index between two values', () => {
    const between = fractionalIndex('a0', 'a2');
    expect(between > 'a0').toBe(true);
    expect(between < 'a2').toBe(true);
  });

  it('should auto-correct swapped arguments', () => {
    const normal = fractionalIndex('a0', 'a2');
    const swapped = fractionalIndex('a2', 'a0');
    expect(normal).toBe(swapped);
  });

  it('should generate multiple indices when count is provided', () => {
    const indices = fractionalIndex('a0', null, 3);
    expect(indices).toHaveLength(3);
    expect(indices[0] < indices[1]).toBe(true);
    expect(indices[1] < indices[2]).toBe(true);
  });

  it('should spread bulk indices across available space', () => {
    const indices = fractionalIndex('a0', 'a5', 3);
    expect(indices).toHaveLength(3);
    for (const idx of indices) {
      expect(idx > 'a0').toBe(true);
      expect(idx < 'a5').toBe(true);
    }
  });
});

describe('healDuplicateOrders', () => {
  it('should return null when no duplicates exist', () => {
    const items = {
      a: { order: 'a0' },
      b: { order: 'a1' },
      c: { order: 'a2' },
    };

    const fixes = healDuplicateOrders(items);

    expect(fixes).toBeNull();
  });

  it('should return fixes for two items with the same order', () => {
    const items = {
      a: { order: 'a1' },
      b: { order: 'a1' }, // duplicate
    };

    const fixes = healDuplicateOrders(items);

    expect(fixes).not.toBeNull();
    expect(Object.keys(fixes!)).toEqual(['b']);
    // New order for b should be after a1
    expect(fixes!.b > 'a1').toBe(true);
  });

  it('should return fixes for multiple duplicates', () => {
    const items = {
      a: { order: 'a1' },
      b: { order: 'a1' }, // duplicate
      c: { order: 'a1' }, // duplicate
    };

    const fixes = healDuplicateOrders(items);

    expect(fixes).not.toBeNull();
    expect(Object.keys(fixes!).sort()).toEqual(['b', 'c']);
    // Fixes should maintain sort order: a1 < b's fix < c's fix
    expect(fixes!.b > 'a1').toBe(true);
    expect(fixes!.c > fixes!.b).toBe(true);
  });

  it('should return fixes for duplicates at different positions', () => {
    const items = {
      a: { order: 'a1' },
      b: { order: 'a1' }, // duplicate with a
      c: { order: 'a5' },
      d: { order: 'a5' }, // duplicate with c
    };

    const fixes = healDuplicateOrders(items);

    expect(fixes).not.toBeNull();
    expect(Object.keys(fixes!).sort()).toEqual(['b', 'd']);
  });

  it('should be idempotent when fixes are applied', () => {
    const items = {
      a: { order: 'a1' },
      b: { order: 'a1' },
    };

    const fixes = healDuplicateOrders(items);
    expect(fixes).not.toBeNull();

    // Apply fixes
    for (const [key, newOrder] of Object.entries(fixes!)) {
      items[key as keyof typeof items].order = newOrder;
    }

    // Second call should return null
    const secondFixes = healDuplicateOrders(items);
    expect(secondFixes).toBeNull();
  });

  it('should use key as tiebreaker for stable ordering', () => {
    // Run multiple times to ensure stability
    for (let i = 0; i < 5; i++) {
      const items = {
        zzz: { order: 'a1' },
        aaa: { order: 'a1' },
      };

      const fixes = healDuplicateOrders(items);

      // 'aaa' comes first by key sort, so 'zzz' gets the fix
      expect(fixes).not.toBeNull();
      expect(Object.keys(fixes!)).toEqual(['zzz']);
      expect(fixes!.zzz > 'a1').toBe(true);
    }
  });

  it('should work with custom order field name', () => {
    const items = {
      a: { sortKey: 'a1' },
      b: { sortKey: 'a1' },
    };

    const fixes = healDuplicateOrders(items, 'sortKey');

    expect(fixes).not.toBeNull();
    expect(Object.keys(fixes!)).toEqual(['b']);
  });

  it('should work when values are order strings directly', () => {
    const items: Record<string, string> = {
      a: 'a1',
      b: 'a1',
    };

    const fixes = healDuplicateOrders(items, false);

    expect(fixes).not.toBeNull();
    expect(Object.keys(fixes!)).toEqual(['b']);
    expect(fixes!.b > 'a1').toBe(true);
  });

  it('should handle multiple duplicates with string values', () => {
    const items: Record<string, string> = {
      a: 'a1',
      b: 'a1',
      c: 'a1',
    };

    const fixes = healDuplicateOrders(items, false);

    expect(fixes).not.toBeNull();
    expect(Object.keys(fixes!).sort()).toEqual(['b', 'c']);
    expect(fixes!.b > 'a1').toBe(true);
    expect(fixes!.c > fixes!.b).toBe(true);
  });

  it('should return null for empty object', () => {
    const items: Record<string, { order: string }> = {};
    const fixes = healDuplicateOrders(items);
    expect(fixes).toBeNull();
  });

  it('should return null for single item', () => {
    const items = {
      a: { order: 'a1' },
    };
    const fixes = healDuplicateOrders(items);
    expect(fixes).toBeNull();
  });

  it('should generate valid fractional indices between existing orders', () => {
    const items = {
      a: { order: 'a1' },
      b: { order: 'a1' },
      c: { order: 'a3' },
    };

    const fixes = healDuplicateOrders(items);

    expect(fixes).not.toBeNull();
    expect(Object.keys(fixes!)).toEqual(['b']);
    // b's fix should be between a1 and a3
    expect(fixes!.b > 'a1').toBe(true);
    expect(fixes!.b < 'a3').toBe(true);
  });
});

describe('sortByOrder', () => {
  it('should sort by order field', () => {
    const items = {
      c: { order: 'a3' },
      a: { order: 'a1' },
      b: { order: 'a2' },
    };

    const sorted = sortByOrder(items);

    expect(sorted.map(([k]) => k)).toEqual(['a', 'b', 'c']);
  });

  it('should use key as tiebreaker for equal orders', () => {
    const items = {
      zzz: { order: 'a1' },
      aaa: { order: 'a1' },
      mmm: { order: 'a1' },
    };

    const sorted = sortByOrder(items);

    expect(sorted.map(([k]) => k)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('should work with custom order field', () => {
    const items = {
      b: { sortKey: 'a2' },
      a: { sortKey: 'a1' },
    };

    const sorted = sortByOrder(items, 'sortKey');

    expect(sorted.map(([k]) => k)).toEqual(['a', 'b']);
  });

  it('should work when values are order strings directly', () => {
    const items: Record<string, string> = {
      c: 'a3',
      a: 'a1',
      b: 'a2',
    };

    const sorted = sortByOrder(items, false);

    expect(sorted.map(([k]) => k)).toEqual(['a', 'b', 'c']);
  });

  it('should return empty array for empty object', () => {
    const items: Record<string, { order: string }> = {};
    const sorted = sortByOrder(items);
    expect(sorted).toEqual([]);
  });

  it('should return tuples with both key and value', () => {
    const items = {
      a: { order: 'a1', name: 'Alice' },
      b: { order: 'a2', name: 'Bob' },
    };

    const sorted = sortByOrder(items);

    expect(sorted).toEqual([
      ['a', { order: 'a1', name: 'Alice' }],
      ['b', { order: 'a2', name: 'Bob' }],
    ]);
  });
});
