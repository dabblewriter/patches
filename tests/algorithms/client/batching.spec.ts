import { describe, it, expect, vi, beforeEach } from 'vitest';
import { breakIntoBatches } from '../../../src/algorithms/client/batching';
import type { Change } from '../../../src/types';
import * as getJSONByteSizeModule from '../../../src/algorithms/client/getJSONByteSize';
import * as breakChangeModule from '../../../src/algorithms/client/breakChange';
import * as cryptoIdModule from 'crypto-id';

// Mock the dependencies
vi.mock('../../../src/algorithms/client/getJSONByteSize');
vi.mock('../../../src/algorithms/client/breakChange');
vi.mock('crypto-id');

describe('breakIntoBatches', () => {
  const mockGetJSONByteSize = vi.mocked(getJSONByteSizeModule.getJSONByteSize);
  const mockBreakChange = vi.mocked(breakChangeModule.breakChange);
  const mockCreateId = vi.mocked(cryptoIdModule.createId);

  const createChange = (id: string, ops: any[] = []): Change => ({
    id,
    rev: 1,
    baseRev: 0,
    ops,
    created: Date.now(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateId.mockReturnValue('test-batch-id');
  });

  it('should return single batch when no maxPayloadBytes specified', () => {
    const changes = [createChange('1'), createChange('2')];

    const result = breakIntoBatches(changes);

    expect(result).toEqual([changes]);
  });

  it('should return single batch when size is under limit', () => {
    const changes = [createChange('1'), createChange('2')];
    mockGetJSONByteSize.mockReturnValue(100);

    const result = breakIntoBatches(changes, 200);

    expect(result).toEqual([changes]);
    expect(mockGetJSONByteSize).toHaveBeenCalledWith(changes);
  });

  it('should break into multiple batches when size exceeds limit', () => {
    const change1 = createChange('1', [{ op: 'add', path: '/test1', value: 'data1' }]);
    const change2 = createChange('2', [{ op: 'add', path: '/test2', value: 'data2' }]);
    const changes = [change1, change2];

    // Mock sizes: total=150, individual changes=50 each, with batch overhead
    mockGetJSONByteSize
      .mockReturnValueOnce(150) // Total size check
      .mockReturnValue(50); // Individual change sizes

    const result = breakIntoBatches(changes, 100);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1);
    expect(result[1]).toHaveLength(1);
    expect(result[0][0]).toMatchObject({ ...change1, batchId: 'test-batch-id' });
    expect(result[1][0]).toMatchObject({ ...change2, batchId: 'test-batch-id' });
  });

  it('should break large individual changes using breakChange', () => {
    const largeChange = createChange('1', [{ op: 'add', path: '/large', value: 'x'.repeat(1000) }]);
    const changes = [largeChange];

    const brokenChanges = [
      createChange('1a', [{ op: 'add', path: '/large', value: 'x'.repeat(500) }]),
      createChange('1b', [{ op: 'add', path: '/large', value: 'x'.repeat(500) }]),
    ];

    mockGetJSONByteSize
      .mockReturnValueOnce(500) // Total size check
      .mockReturnValueOnce(600) // Individual change size (too large)
      .mockReturnValue(250); // Broken change sizes

    mockBreakChange.mockReturnValue(brokenChanges);

    const result = breakIntoBatches(changes, 300);

    expect(mockBreakChange).toHaveBeenCalledWith({ ...largeChange, batchId: 'test-batch-id' }, 300);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain(brokenChanges[0]);
    expect(result[1]).toContain(brokenChanges[1]);
  });

  it('should handle empty changes array', () => {
    const result = breakIntoBatches([], 100);

    expect(result).toEqual([]);
  });

  it('should batch multiple small changes together', () => {
    const changes = [createChange('1'), createChange('2'), createChange('3'), createChange('4')];

    // Mock sizes to fit 2 changes per batch
    mockGetJSONByteSize
      .mockReturnValueOnce(200) // Total size
      .mockReturnValue(40); // Individual change sizes

    const result = breakIntoBatches(changes, 100);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(2);
    expect(result[1]).toHaveLength(2);
  });

  it('should add batchId to all changes when batching', () => {
    const changes = [createChange('1'), createChange('2')];

    mockGetJSONByteSize
      .mockReturnValueOnce(150) // Total size
      .mockReturnValue(50); // Individual sizes

    const result = breakIntoBatches(changes, 100);

    expect(mockCreateId).toHaveBeenCalledWith(12);
    result.flat().forEach(change => {
      expect(change.batchId).toBe('test-batch-id');
    });
  });

  it('should handle complex batching scenario with mixed sizes', () => {
    const smallChange = createChange('small');
    const mediumChange = createChange('medium');
    const largeChange = createChange('large');
    const changes = [smallChange, mediumChange, largeChange];

    const brokenLargeChanges = [createChange('large1'), createChange('large2')];

    mockGetJSONByteSize
      .mockReturnValueOnce(300) // Total size
      .mockReturnValueOnce(20) // small change
      .mockReturnValueOnce(30) // medium change
      .mockReturnValueOnce(150) // large change (too big)
      .mockReturnValue(40); // broken change sizes

    mockBreakChange.mockReturnValue(brokenLargeChanges);

    const result = breakIntoBatches(changes, 100);

    // Should have small+medium+broken large changes all batched appropriately
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(2); // small + medium
    expect(result[1]).toHaveLength(2); // large1 + large2 (both broken changes fit in same batch)
  });
});
