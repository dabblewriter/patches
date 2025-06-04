import { beforeEach, describe, expect, it, vi } from 'vitest';
import { breakIntoBatches } from '../../../src/algorithms/client/batching.js';
import type { Change } from '../../../src/types.js';

// Mock specific exports from the modules
vi.mock('../../../src/algorithms/client/breakChange.js', async () => {
  return {
    breakChange: vi.fn(),
  };
});
vi.mock('../../../src/algorithms/client/getJSONByteSize.js', async () => {
  return {
    getJSONByteSize: vi.fn(),
  };
});
vi.mock('crypto-id', () => ({
  createId: vi.fn(() => 'mock-batch-id'),
  createSortableId: vi.fn(() => `sortable-${Math.random().toString(36).substring(7)}`),
}));

// After mocking, import the (now mocked) functions
import { breakChange } from '../../../src/algorithms/client/breakChange.js';
import { getJSONByteSize } from '../../../src/algorithms/client/getJSONByteSize.js';

describe('breakIntoBatches', () => {
  // Use vi.mocked() to get correctly typed mocks
  const mockBreakChangeVitest = vi.mocked(breakChange);
  const mockGetJSONByteSizeVitest = vi.mocked(getJSONByteSize);

  beforeEach(() => {
    mockBreakChangeVitest.mockClear();
    mockGetJSONByteSizeVitest.mockClear();
  });

  const createMockChange = (
    id: string,
    size: number,
    ops: any[] = [{ op: 'add', path: '/foo', value: 'bar' }]
  ): Change =>
    ({
      id,
      rev: 1,
      baseRev: 0,
      ops,
      created: Date.now(),
      __mockSize: size,
    }) as any;

  it('should return all changes in one batch if under max size', () => {
    const changes = [createMockChange('c1', 100), createMockChange('c2', 100)];
    mockGetJSONByteSizeVitest.mockImplementation((data: any) => {
      if (Array.isArray(data))
        return data.reduce((sum, c) => sum + c.__mockSize, 0) + 2 + (data.length > 1 ? data.length - 1 : 0);
      return data.__mockSize ?? 50;
    });
    const result = breakIntoBatches(changes, 500);
    expect(result).toEqual([changes]);
    expect(mockBreakChangeVitest).not.toHaveBeenCalled();
  });

  it('should split changes into multiple batches if needed', () => {
    const changes = [createMockChange('c1', 200), createMockChange('c2', 200), createMockChange('c3', 200)];
    mockGetJSONByteSizeVitest.mockImplementation((data: any) => {
      if (Array.isArray(data)) {
        let total = 2;
        if (data.length > 0) total += data.map(c => c.__mockSize).reduce((s, i) => s + i, 0);
        if (data.length > 1) total += data.length - 1;
        return total;
      }
      return data.__mockSize ?? 50;
    });

    const result = breakIntoBatches(changes, 450);
    expect(result).toHaveLength(2);
    // Check content without being strict on batchId or exact Change object reference
    expect(result[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'c1' }), expect.objectContaining({ id: 'c2' })])
    );
    expect(result[0].length).toBe(2); // Ensure no extra items
    expect(result[1]).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'c3' })]));
    expect(result[1].length).toBe(1);
    expect(mockBreakChangeVitest).not.toHaveBeenCalled();
  });

  it('should handle an oversized change by calling breakChange', () => {
    const oversizedChange = createMockChange('oversized', 600);
    const changes = [oversizedChange];
    const brokenPieces = [
      {
        ...oversizedChange,
        id: 'p1',
        ops: [{ op: 'add', path: '/part1', value: 'a' }],
        __mockSize: 300,
        batchId: 'mock-batch-id',
      },
      {
        ...oversizedChange,
        id: 'p2',
        ops: [{ op: 'add', path: '/part2', value: 'b' }],
        __mockSize: 300,
        batchId: 'mock-batch-id',
      },
    ];

    mockGetJSONByteSizeVitest.mockImplementation(
      (data: any) => data.__mockSize ?? (data.id === 'oversized' ? 600 : 300)
    );
    mockBreakChangeVitest.mockReturnValue(brokenPieces as any);

    const result = breakIntoBatches(changes, 500);
    // breakChange should be invoked for the oversized item
    expect(mockBreakChangeVitest).toHaveBeenCalled();
    expect(result).toEqual([brokenPieces]);
  });

  it('should process all pieces from a broken change and potentially split them with other changes', () => {
    const normalChange1 = createMockChange('c1', 100);
    const oversizedChange = createMockChange('oversized', 600);
    const normalChange2 = createMockChange('c2', 100);
    const changes = [normalChange1, oversizedChange, normalChange2];

    const brokenPieces = [
      { ...oversizedChange, id: 'p1', ops: [], __mockSize: 200, batchId: 'mock-batch-id' },
      { ...oversizedChange, id: 'p2', ops: [], __mockSize: 200, batchId: 'mock-batch-id' },
      { ...oversizedChange, id: 'p3', ops: [], __mockSize: 200, batchId: 'mock-batch-id' },
    ];

    mockGetJSONByteSizeVitest.mockImplementation((data: any) => {
      if (data.id === 'c1') return 100;
      if (data.id === 'oversized') return 600;
      if (data.id === 'c2') return 100;
      if (data.id === 'p1' || data.id === 'p2' || data.id === 'p3') return 200;
      if (Array.isArray(data)) {
        let total = 2;
        if (data.length > 0) total += data.map(c => c.__mockSize).reduce((s, i) => s + i, 0);
        if (data.length > 1) total += data.length - 1;
        return total;
      }
      return 50;
    });
    mockBreakChangeVitest.mockReturnValue(brokenPieces as any);

    const result = breakIntoBatches(changes, 450);
    expect(mockBreakChangeVitest).toHaveBeenCalledWith(expect.objectContaining({ id: 'oversized' }), 450);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([expect.objectContaining({ id: 'c1' }), brokenPieces[0]]);
    expect(result[1]).toEqual([brokenPieces[1], brokenPieces[2]]);
    expect(result[2]).toEqual([expect.objectContaining({ id: 'c2' })]);
  });

  it('should not break changes when maxPayloadBytes is not specified', () => {
    const changes = [createMockChange('c1', 600), createMockChange('c2', 600)];
    mockGetJSONByteSizeVitest.mockImplementation((data: any) => {
      if (Array.isArray(data)) return 1205;
      return data.__mockSize;
    });

    const result = breakIntoBatches(changes, undefined);
    expect(result).toEqual([changes]);
    expect(mockBreakChangeVitest).not.toHaveBeenCalled();
  });
});
