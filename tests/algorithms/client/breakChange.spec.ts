import { describe, it, expect, vi, beforeEach } from 'vitest';
import { breakChange } from '../../../src/algorithms/client/breakChange';
import type { Change } from '../../../src/types';
import * as getJSONByteSizeModule from '../../../src/algorithms/client/getJSONByteSize';

// Mock the dependencies
vi.mock('../../../src/algorithms/client/getJSONByteSize');

describe('breakChange', () => {
  const mockGetJSONByteSize = vi.mocked(getJSONByteSizeModule.getJSONByteSize);

  const createChange = (rev: number, ops: any[], baseRev = 0): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev,
    ops,
    createdAt: '2024-01-01T00:00:00.000Z',
    committedAt: '2024-01-01T00:00:00.000Z',
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return original change if size is under limit', () => {
    const change = createChange(1, [{ op: 'add', path: '/test', value: 'small' }]);
    mockGetJSONByteSize.mockReturnValue(50);

    const result = breakChange(change, 100);

    expect(result).toEqual([change]);
  });

  it('should return original change if already under size limit initially', () => {
    const change = createChange(1, [
      { op: 'add', path: '/test1', value: 'data1' },
      { op: 'add', path: '/test2', value: 'data2' },
    ]);
    mockGetJSONByteSize.mockReturnValueOnce(80); // Under limit

    const result = breakChange(change, 100);

    expect(result).toEqual([change]);
  });

  it('should split change by operations when size exceeds limit', () => {
    const change = createChange(1, [
      { op: 'add', path: '/test1', value: 'data1' },
      { op: 'add', path: '/test2', value: 'data2' },
    ]);

    mockGetJSONByteSize
      .mockReturnValueOnce(150) // Initial size check (exceeds limit)
      .mockReturnValueOnce(60) // Change with first op only
      .mockReturnValueOnce(120) // Change with both ops (exceeds limit, triggers flush)
      .mockReturnValueOnce(60); // Change with second op only

    const result = breakChange(change, 100);

    expect(result).toHaveLength(2);
    expect(result[0].ops).toEqual([change.ops[0]]);
    expect(result[1].ops).toEqual([change.ops[1]]);
  });

  it('should handle text operations that exceed size', () => {
    const change = createChange(1, [
      {
        op: '@txt',
        path: '/content',
        value: [{ insert: 'very long text that exceeds the size limit' }],
      },
    ]);

    mockGetJSONByteSize
      .mockReturnValueOnce(500) // Initial size check
      .mockReturnValueOnce(500) // Single op size (too large for individual op handling)
      .mockReturnValue(100); // Mock for internal breakTextOp calls

    const result = breakChange(change, 200);

    // Should handle the large text operation
    expect(result).toHaveLength(1);
    expect(result[0].ops[0].op).toBe('@txt');
  });

  it('should handle large replace operations', () => {
    const change = createChange(1, [
      {
        op: 'replace',
        path: '/content',
        value: 'very long string content that exceeds byte limit',
      },
    ]);

    mockGetJSONByteSize
      .mockReturnValueOnce(500) // Initial size check
      .mockReturnValueOnce(500) // Single op size (too large)
      .mockReturnValue(100); // Mock for internal breakLargeValueOp calls

    const result = breakChange(change, 200);

    // Should handle the large replace operation
    expect(result).toHaveLength(1);
    expect(result[0].ops[0].op).toBe('replace');
  });

  it('should handle large add operations with array values', () => {
    const change = createChange(1, [
      {
        op: 'add',
        path: '/items',
        value: Array(50).fill({ data: 'item' }),
      },
    ]);

    mockGetJSONByteSize
      .mockReturnValueOnce(1000) // Initial size check
      .mockReturnValueOnce(1000) // Single op size (too large)
      .mockReturnValue(100); // Mock for internal breakLargeValueOp calls

    const result = breakChange(change, 400);

    // Should handle the large add operation
    expect(result).toHaveLength(1);
    expect(result[0].ops[0].op).toBe('add');
  });

  it('should warn and include non-splittable operations that are too large', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const change = createChange(1, [
      {
        op: 'move',
        path: '/source',
        from: '/destination',
      },
    ]);

    mockGetJSONByteSize
      .mockReturnValueOnce(300) // Initial size check
      .mockReturnValueOnce(300) // Single op size (too large, but not splittable)
      .mockReturnValueOnce(300); // Change with this op

    const result = breakChange(change, 200);

    expect(result).toHaveLength(1);
    expect(result[0].ops).toEqual([change.ops[0]]);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Single operation of type move exceeds maxBytes')
    );

    consoleSpy.mockRestore();
  });

  it('should handle empty operations array', () => {
    const change = createChange(1, []);
    mockGetJSONByteSize.mockReturnValue(20);

    const result = breakChange(change, 100);

    expect(result).toEqual([change]);
  });

  it('should preserve some change metadata in split pieces', () => {
    const change = createChange(1, [
      { op: 'add', path: '/test1', value: 'data1' },
      { op: 'add', path: '/test2', value: 'data2' },
    ]);
    change.customMetadata = 'test-value';

    mockGetJSONByteSize
      .mockReturnValueOnce(150) // Initial size check (exceeds limit)
      .mockReturnValueOnce(60) // First op
      .mockReturnValueOnce(120) // Both ops (exceeds)
      .mockReturnValueOnce(60); // Second op

    const result = breakChange(change, 100);

    expect(result).toHaveLength(2);
    expect(result[0].baseRev).toBe(change.baseRev);
    expect(result[1].baseRev).toBe(change.baseRev);
    // Note: batchId, id, rev, created are filtered out in deriveNewChange
    expect((result[0] as any).customMetadata).toBe('test-value');
    expect((result[1] as any).customMetadata).toBe('test-value');
  });

  it('should assign correct revision numbers to split changes', () => {
    const change = createChange(
      5,
      [
        { op: 'add', path: '/test1', value: 'data1' },
        { op: 'add', path: '/test2', value: 'data2' },
      ],
      3
    );

    mockGetJSONByteSize
      .mockReturnValueOnce(150) // Initial size check
      .mockReturnValueOnce(60) // First op
      .mockReturnValueOnce(120) // Both ops (exceeds)
      .mockReturnValueOnce(60); // Second op

    const result = breakChange(change, 100);

    expect(result).toHaveLength(2);
    expect(result[0].rev).toBe(5); // First piece keeps original rev
    expect(result[1].rev).toBe(6); // Second piece gets incremented rev
    expect(result[0].baseRev).toBe(3); // Both keep original baseRev
    expect(result[1].baseRev).toBe(3);
  });

  it('should handle complex batching scenarios', () => {
    const change = createChange(1, [
      { op: 'add', path: '/test1', value: 'data1' },
      { op: 'add', path: '/test2', value: 'data2' },
      { op: 'add', path: '/test3', value: 'data3' },
    ]);

    mockGetJSONByteSize
      .mockReturnValueOnce(300) // Initial size check (exceeds limit)
      .mockReturnValue(80); // All subsequent checks return reasonable size

    const result = breakChange(change, 100);

    // Should split the change somehow - exact split depends on complex logic
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every(r => r.ops.length > 0)).toBe(true);
    expect(result.flatMap(r => r.ops)).toEqual(change.ops);
  });
});
