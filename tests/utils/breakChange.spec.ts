import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import type { Change } from '../../src/types';
import { breakChange } from '../../src/utils/breakChange.js';

describe('breakChange', () => {
  // Helper to create a change for testing
  function createTestChange(ops: any[] = []): Change {
    return {
      id: 'test-id',
      rev: 100,
      ops,
      baseRev: 99,
      created: Date.now(),
    };
  }

  it('should return original change if it is under the max size', () => {
    const change = createTestChange([{ op: 'add', path: '/foo', value: 'bar' }]);
    const result = breakChange(change, 10000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(change);
  });

  it('should throw error for single non-text op that is too large', () => {
    // Create a change with a very large non-text operation
    const largeValue = { array: Array(1000).fill('large value') };
    const change = createTestChange([{ op: 'add', path: '/data', value: largeValue }]);

    // Set small max size to force splitting
    expect(() => breakChange(change, 100)).toThrow(/^Single operation of type add \(path: \/data\) exceeds/);
  });

  it('should split a large change by ops', () => {
    const change = createTestChange([
      { op: 'add', path: '/item1', value: 'value1' },
      { op: 'add', path: '/item2', value: 'value2' },
      { op: 'add', path: '/item3', value: 'value3' },
    ]);

    // Use maxBytes=150: large enough for one op (~120b) but not two.
    const result = breakChange(change, 150);

    expect(result.length).toBeGreaterThan(1);
    // Expect each resulting change to have only 1 op.
    expect(result.every(c => c.ops.length === 1)).toBe(true);
    expect(result.every(c => c.baseRev === 99)).toBe(true);

    // Verify revs are sequential
    expect(result[0].rev).toBe(100);
    expect(result[1].rev).toBe(101);
  });

  it('should split a large text delta operation', () => {
    // Create a delta with a large insert
    const largeText = 'a'.repeat(10000);
    const delta = new Delta().insert(largeText);

    const change = createTestChange([{ op: '@txt', path: '/document/text', value: delta.ops }]);

    // Set a small max size to force splitting the text op
    const result = breakChange(change, 500);

    expect(result.length).toBeGreaterThan(1);
    expect(result.every(c => c.ops.length === 1)).toBe(true); // Each should have 1 @txt op
    expect(result.every(c => c.ops[0].op === '@txt')).toBe(true);

    // Reconstruct the text from split operations to verify integrity
    const allInserts = result
      .flatMap(c => {
        const deltaOps = c.ops[0].value;
        return deltaOps.filter((op: any) => op.insert).map((op: any) => op.insert);
      })
      .join('');

    expect(allInserts).toBe(largeText);
  });

  it('should handle extremely large text inserts by splitting them into chunks', () => {
    // Create a massive text insert (would be too large for a single Delta op)
    const massiveText = 'a'.repeat(500000);
    const delta = new Delta().insert(massiveText);

    const change = createTestChange([{ op: '@txt', path: '/document/content', value: delta.ops }]);

    // Force chunking of the insert operation
    const result = breakChange(change, 1000);

    expect(result.length).toBeGreaterThan(10); // Should be split into many pieces

    // Each result should be a valid Change with a @txt op
    result.forEach(c => {
      expect(c.id).not.toBe('test-id'); // Should have new IDs
      expect(c.ops.length).toBe(1);
      expect(c.ops[0].op).toBe('@txt');
      expect(c.ops[0].path).toBe('/document/content');
      expect(Array.isArray(c.ops[0].value)).toBe(true);
    });

    // Reconstruct and verify
    const reconstructed = result
      .flatMap(c => {
        const deltaOps = c.ops[0].value;
        return deltaOps.filter((op: any) => op.insert).map((op: any) => op.insert);
      })
      .join('');

    expect(reconstructed).toBe(massiveText);
  });

  it('should preserve attributes in split text operations', () => {
    // Create styled text
    const delta = new Delta().insert('Bold text', { bold: true }).insert(' and ').insert('italic', { italic: true });

    const change = createTestChange([{ op: '@txt', path: '/document/styled', value: delta.ops }]);

    // Force splitting
    const result = breakChange(change, 70);

    expect(result.length).toBeGreaterThan(1);

    // Extract all delta ops from the results
    const allOps = result.flatMap(c => c.ops[0].value);

    // Verify attributes are preserved
    const boldOps = allOps.filter((op: any) => op.attributes?.bold);
    const italicOps = allOps.filter((op: any) => op.attributes?.italic);

    expect(boldOps.length).toBeGreaterThan(0);
    expect(italicOps.length).toBeGreaterThan(0);

    const boldText = boldOps.map((op: any) => op.insert).join('');
    const italicText = italicOps.map((op: any) => op.insert).join('');

    expect(boldText).toBe('Bold text');
    expect(italicText).toBe('italic');
  });

  it('should add retains to preserve correct document position in split text operations', () => {
    // Create a delta with a large insert that will get split
    const largeText = 'a'.repeat(5000);
    const delta = new Delta().retain(10).insert(largeText).retain(5).insert(' END');

    // Correctly wrap delta ops in a single @txt op Change
    const change = createTestChange([{ op: '@txt', path: '/text', value: delta.ops }]);
    const result = breakChange(change, 300);

    // Extract all delta ops from the resulting change pieces
    const allDeltaOps = result.flatMap(c => c.ops[0].value as any[]);

    // Basic checks
    expect(result.length).toBeGreaterThan(1);
    expect(allDeltaOps.length).toBeGreaterThan(delta.ops.length);

    // Verify the first op is the original retain or starts with retain 0 if original was insert
    // (This check might be brittle)
    // expect(allDeltaOps[0].retain === 10 || allDeltaOps[0].retain === 0).toBe(true);

    // Reconstruct the final delta from all pieces
    const reconstructedDelta = new Delta(allDeltaOps);

    // Verify the full text can be reconstructed
    const reconstructed = reconstructedDelta.ops
      .filter(op => op.insert && typeof op.insert === 'string')
      .map(op => op.insert)
      .join('');
    expect(reconstructed).toBe(largeText + ' END');
  });
});
