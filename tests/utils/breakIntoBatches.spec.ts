import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Change } from '../../src/types';

// Mock dependencies using correct relative paths
vi.mock('../../src/utils/getJSONByteSize.js', () => ({
  getJSONByteSize: vi.fn(),
}));
vi.mock('../../src/utils/breakChange.js', () => ({
  breakChange: vi.fn(),
}));
vi.mock('crypto-id', () => ({
  createId: vi.fn((...args: any[]) => 'mock-batch-id'),
}));

// Import using correct relative paths
import { createId } from 'crypto-id';
import { breakIntoBatches } from '../../src/utils/batching';
import { breakChange } from '../../src/utils/breakChange.js';
import { getJSONByteSize } from '../../src/utils/getJSONByteSize.js';

describe('breakIntoBatches', () => {
  // Helper to create a change for testing
  function createTestChange(id: string, rev: number, payloadSize: number = 10): Change {
    return {
      id,
      rev,
      ops: [{ op: 'add', path: '/data', value: 'x'.repeat(payloadSize) }],
      baseRev: rev - 1,
      created: Date.now(),
    };
  }

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    // Provide default implementations if needed (optional, depends on test needs)
    vi.mocked(getJSONByteSize).mockImplementation((data: any) => {
      // If data is an array (the initial changes array), make it large by default for tests that need to bypass the shortcut
      if (Array.isArray(data)) {
        return 9999; // A large value to ensure batching logic is hit by default
      }
      // Default small size estimate for individual changes
      return new TextEncoder().encode(JSON.stringify(data)).length;
    });
    vi.mocked(breakChange).mockImplementation((change: Change) => [change]); // Default: pass through
    vi.mocked(createId).mockReturnValue('mock-batch-id');
  });

  it('should return all changes in one batch if under max size', () => {
    // Use default mocks or override if specific behavior is needed for this test
    vi.mocked(getJSONByteSize).mockImplementation((data: any) => {
      // For this specific test, the initial array IS small
      if (Array.isArray(data)) {
        return 100; // Small value to trigger the shortcut
      }
      return new TextEncoder().encode(JSON.stringify(data)).length;
    });
    const changes = [createTestChange('c1', 1), createTestChange('c2', 2), createTestChange('c3', 3)];
    const result = breakIntoBatches(changes, 10000);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(3);
    expect(result[0].map(c => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(result[0].every(c => c.batchId === undefined)).toBe(true);
    expect(vi.mocked(breakChange)).not.toHaveBeenCalled();
  });

  it('should split changes into multiple batches if needed', () => {
    // Use real size calculation via default mock for getJSONByteSize
    const changes = [
      createTestChange('c1', 1, 100),
      createTestChange('c2', 2, 100),
      createTestChange('c3', 3, 100),
      createTestChange('c4', 4, 100),
    ];
    // Real sizes are ~230 bytes. Max 250 allows only one per batch.
    const result = breakIntoBatches(changes, 250);
    expect(result.length).toBe(4);
    expect(result.flat().length).toBe(4);
    expect(result.every(batch => batch.every(c => c.batchId === 'mock-batch-id'))).toBe(true);
    expect(vi.mocked(breakChange)).not.toHaveBeenCalled();
  });

  it('should handle an oversized change by calling breakChange', () => {
    // Override getJSONByteSize for this test
    vi.mocked(getJSONByteSize).mockImplementation((data: any) => {
      if (Array.isArray(data)) return 5000; // Ensure main function proceeds
      if (data && data.id === 'large') return 500; // Make 'large' oversized
      return 100; // Other items are small
    });
    const normalChange = createTestChange('normal', 1, 10);
    const largeChange = createTestChange('large', 2, 1000);
    const result = breakIntoBatches([normalChange, largeChange], 200);
    expect(vi.mocked(breakChange)).toHaveBeenCalled();
    expect(result.flat().every(c => c.batchId === 'mock-batch-id')).toBe(true);
  });

  it('should process all pieces from a broken change', () => {
    const mockPieces = [
      { ...createTestChange('large-1', 2, 50), batchId: 'mock-batch-id' },
      { ...createTestChange('large-2', 3, 50), batchId: 'mock-batch-id' },
      { ...createTestChange('large-3', 4, 50), batchId: 'mock-batch-id' },
    ];
    // Mock the return value of breakChange
    vi.mocked(breakChange).mockReturnValue(mockPieces);
    // Mock getJSONByteSize to trigger breakChange and size pieces
    vi.mocked(getJSONByteSize).mockImplementation((data: any) => {
      if (Array.isArray(data)) return 5000; // Ensure main function proceeds
      if (data && data.id === 'large') return 500;
      if (data && data.id?.startsWith('large-')) return 50;
      return 100; // 'normal'
    });
    const changes = [createTestChange('normal', 1, 50), createTestChange('large', 2, 1000)];
    const result = breakIntoBatches(changes, 200);
    expect(vi.mocked(breakChange)).toHaveBeenCalled();
    expect(result.flat().length).toBe(4);
    const ids = result.flat().map(c => c.id);
    expect(ids.includes('normal')).toBe(true);
    expect(ids.includes('large-1')).toBe(true);
    expect(ids.includes('large-2')).toBe(true);
    expect(ids.includes('large-3')).toBe(true);
  });

  it('should not break changes when maxPayloadBytes is not specified', () => {
    const changes = [createTestChange('c1', 1, 100), createTestChange('c2', 2, 200)];
    // Ensure that for this test, getJSONByteSize on the array also triggers the shortcut
    vi.mocked(getJSONByteSize).mockImplementation((data: any) => {
      if (Array.isArray(data)) {
        return 100; // Small value to trigger the shortcut (as maxPayloadBytes is undefined)
      }
      return new TextEncoder().encode(JSON.stringify(data)).length;
    });
    const result = breakIntoBatches(changes);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(changes);
    expect(vi.mocked(breakChange)).not.toHaveBeenCalled();
  });

  it('should distribute split changes across batches when needed', () => {
    const mockPieces = Array(10)
      .fill(null)
      .map((_, i) => ({ ...createTestChange(`split-${i}`, 2 + i, 20), batchId: 'mock-batch-id' }));
    vi.mocked(breakChange).mockReturnValueOnce(mockPieces);
    // Mock sizes to trigger breakChange and control batching of pieces
    vi.mocked(getJSONByteSize).mockImplementation((data: any) => {
      if (Array.isArray(data)) return 5000; // Ensure main function proceeds
      if (data && data.id === 'large') return 500; // Trigger breakChange
      // Make pieces and normal changes small
      if (data && (data.id?.startsWith('split-') || data.id?.startsWith('normal'))) return 20;
      return 20; // Default
    });
    const changes = [
      createTestChange('normal1', 1, 20),
      createTestChange('large', 2, 1000),
      createTestChange('normal2', 12, 20),
    ];
    const result = breakIntoBatches(changes, 85); // Max size 85, pieces are 20 bytes
    expect(vi.mocked(breakChange)).toHaveBeenCalled();
    expect(result.flat().length).toBe(12); // normal1 + 10 pieces + normal2
    expect(result.length).toBe(3); // Expect 3 batches based on size 85 and piece size 20
  });
});
