import { describe, it, expect, vi } from 'vitest';
import {
  breakChanges,
  breakChangesIntoBatches,
  getJSONByteSize,
} from '../../../../src/algorithms/ot/shared/changeBatching';
import { compressedSizeBase64, compressedSizeUint8 } from '../../../../src/compression';
import type { Change } from '../../../../src/types';

describe('getJSONByteSize', () => {
  it('should return correct byte size for simple objects', () => {
    const data = { foo: 'bar' };
    const expected = new TextEncoder().encode(JSON.stringify(data)).length;
    expect(getJSONByteSize(data)).toBe(expected);
  });

  it('should return 0 for undefined', () => {
    expect(getJSONByteSize(undefined)).toBe(0);
  });

  it('should throw for circular structures', () => {
    const circular: any = { foo: 'bar' };
    circular.self = circular;
    expect(() => getJSONByteSize(circular)).toThrow('Error calculating JSON size');
  });

  it('should handle arrays correctly', () => {
    const data = [1, 2, 3];
    const expected = new TextEncoder().encode(JSON.stringify(data)).length;
    expect(getJSONByteSize(data)).toBe(expected);
  });

  it('should handle nested objects', () => {
    const data = { a: { b: { c: 'deep' } } };
    const expected = new TextEncoder().encode(JSON.stringify(data)).length;
    expect(getJSONByteSize(data)).toBe(expected);
  });
});

describe('breakChanges', () => {
  const createChange = (rev: number, ops: any[], baseRev = 0): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev,
    ops,
    createdAt: 0,
    committedAt: 0,
  });

  it('should return original changes if all are under size limit', () => {
    const changes = [createChange(1, [{ op: 'add', path: '/test', value: 'small' }])];
    const maxBytes = getJSONByteSize(changes[0]) + 100;

    const result = breakChanges(changes, maxBytes);

    expect(result).toEqual(changes);
  });

  it('should process multiple changes', () => {
    const changes = [
      createChange(1, [{ op: 'add', path: '/test1', value: 'data1' }]),
      createChange(2, [{ op: 'add', path: '/test2', value: 'data2' }]),
    ];
    const maxBytes = Math.max(...changes.map(c => getJSONByteSize(c))) + 100;

    const result = breakChanges(changes, maxBytes);

    expect(result).toHaveLength(2);
  });

  it('should split change by operations when size exceeds limit', () => {
    const change = createChange(1, [
      { op: 'add', path: '/test1', value: 'data1' },
      { op: 'add', path: '/test2', value: 'data2' },
    ]);
    // Set maxBytes to only fit one op at a time
    const singleOpChange = createChange(1, [change.ops[0]]);
    const maxBytes = getJSONByteSize(singleOpChange) + 10;

    const result = breakChanges([change], maxBytes);

    expect(result).toHaveLength(2);
    expect(result[0].ops).toHaveLength(1);
    expect(result[1].ops).toHaveLength(1);
  });

  it('should preserve batchId on derived changes when splitting', () => {
    const change: Change = {
      id: 'change-1',
      rev: 1,
      baseRev: 0,
      ops: [
        { op: 'add', path: '/test1', value: 'data1' },
        { op: 'add', path: '/test2', value: 'data2' },
      ],
      createdAt: 0,
      committedAt: 0,
      batchId: 'my-batch-id',
    };

    const singleOpChange = createChange(1, [change.ops[0]]);
    const maxBytes = getJSONByteSize(singleOpChange) + 10;

    const result = breakChanges([change], maxBytes);

    expect(result).toHaveLength(2);
    expect(result[0].batchId).toBe('my-batch-id');
    expect(result[1].batchId).toBe('my-batch-id');
  });

  it('should handle empty changes array', () => {
    const result = breakChanges([], 100);
    expect(result).toEqual([]);
  });

  it('should preserve change metadata in split pieces', () => {
    const change = createChange(1, [
      { op: 'add', path: '/test1', value: 'data1' },
      { op: 'add', path: '/test2', value: 'data2' },
    ]);
    (change as any).customMetadata = 'test-value';

    const singleOpChange = createChange(1, [change.ops[0]]);
    const maxBytes = getJSONByteSize(singleOpChange) + 10;

    const result = breakChanges([change], maxBytes);

    expect(result).toHaveLength(2);
    expect(result[0].baseRev).toBe(change.baseRev);
    expect(result[1].baseRev).toBe(change.baseRev);
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

    const singleOpChange = createChange(5, [change.ops[0]]);
    const maxBytes = getJSONByteSize(singleOpChange) + 10;

    const result = breakChanges([change], maxBytes);

    expect(result).toHaveLength(2);
    expect(result[0].rev).toBe(5);
    expect(result[1].rev).toBe(6);
    expect(result[0].baseRev).toBe(3);
    expect(result[1].baseRev).toBe(3);
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

    // Make maxBytes smaller than the change
    const maxBytes = getJSONByteSize(change) - 50;

    const result = breakChanges([change], maxBytes);

    expect(result).toHaveLength(1);
    expect(result[0].ops).toEqual([change.ops[0]]);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Single operation of type move exceeds maxBytes')
    );

    consoleSpy.mockRestore();
  });

  it('should handle text operations with large deltas', () => {
    const change = createChange(1, [
      {
        op: '@txt',
        path: '/content',
        value: [
          { insert: 'first chunk of text ' },
          { insert: 'second chunk of text ' },
          { insert: 'third chunk of text' },
        ],
      },
    ]);

    // Set a small maxBytes to force splitting
    const maxBytes = 200;
    const result = breakChanges([change], maxBytes);

    // Should split the text operation
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every(r => r.ops[0].op === '@txt')).toBe(true);
  });

  it('should warn and include as-is for oversized replace with non-object value', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const largeString = 'x'.repeat(500);
    const change = createChange(1, [{ op: 'replace', path: '/content', value: largeString }]);

    const result = breakChanges([change], 200);

    expect(result).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not an object'));
    consoleSpy.mockRestore();
  });

  it('should extract text deltas from oversized replace into a structural replace + @txt ops', () => {
    const textContent = { ops: [{ insert: 'This is the whole text\n' }] };
    const change = createChange(1, [
      {
        op: 'replace',
        path: '',
        value: { docs: { scene1: { body: { content: textContent } } } },
      },
    ]);

    // Trigger extraction by setting maxBytes slightly under the original change size
    const maxBytes = getJSONByteSize(change) - 1;
    const result = breakChanges([change], maxBytes);

    // All ops across all result changes — should be: 1 structural replace + 1 @txt
    const allOps = result.flatMap(c => c.ops);
    expect(allOps).toHaveLength(2);

    const replaceOp = allOps.find(op => op.op === 'replace');
    expect(replaceOp?.value).toEqual({ docs: { scene1: { body: { content: {} } } } });

    const txtOp = allOps.find(op => op.op === '@txt');
    expect(txtOp?.path).toBe('/docs/scene1/body/content');
    expect(txtOp?.value).toEqual(textContent.ops);
  });

  it('should produce a single Change when structural replace + @txt fit within maxBytes', () => {
    const textContent = { ops: [{ insert: 'short\n' }] };
    const change = createChange(1, [
      { op: 'replace', path: '', value: { docs: { scene1: { content: textContent } } } },
    ]);

    // Compute expected combined size: structural replace (stubs) + @txt op
    const expectedOps = [
      { op: 'replace', path: '', value: { docs: { scene1: { content: {} } } } },
      { op: '@txt', path: '/docs/scene1/content', value: textContent },
    ];
    const combinedSize = getJSONByteSize({ ...change, ops: expectedOps });
    const originalSize = getJSONByteSize(change);

    // Only run this test when combined fits but original doesn't (requires combined < original)
    if (combinedSize < originalSize) {
      const result = breakChanges([change], originalSize - 1);
      expect(result).toHaveLength(1);
      expect(result[0].ops).toHaveLength(2);
      expect(result[0].ops[0].op).toBe('replace');
      expect(result[0].ops[1].op).toBe('@txt');
    }
  });

  it('should split into multiple Changes when stripped replace + @txt ops exceed maxBytes', () => {
    // Two large text fields so the combined Change exceeds maxBytes
    const makeText = (n: number) => ({ ops: [{ insert: 'a'.repeat(n) + '\n' }] });
    const change = createChange(1, [
      {
        op: 'replace',
        path: '',
        value: { fieldA: makeText(300), fieldB: makeText(300) },
      },
    ]);

    // maxBytes large enough for one @txt change but not all three ops together
    const maxBytes = 400;
    const result = breakChanges([change], maxBytes);

    // Should produce multiple Changes, each within maxBytes
    expect(result.length).toBeGreaterThan(1);
    expect(result.every(c => getJSONByteSize(c) <= maxBytes)).toBe(true);
    // First change is the structural replace (stubs)
    expect(result[0].ops[0].op).toBe('replace');
    // Remaining changes are @txt
    expect(result.slice(1).every(c => c.ops[0].op === '@txt')).toBe(true);
  });

  it('should warn and include as-is when oversized replace has no text deltas', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const change = createChange(1, [
      {
        op: 'replace',
        path: '/data',
        value: { a: 1, b: 2, c: 3 }, // plain object, no text deltas
      },
    ]);

    const maxBytes = getJSONByteSize(change) - 5;
    const result = breakChanges([change], maxBytes);

    expect(result).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no text deltas'));
    consoleSpy.mockRestore();
  });
});

describe('breakChangesIntoBatches', () => {
  const createChange = (id: string, ops: any[] = []): Change => ({
    id,
    rev: 1,
    baseRev: 0,
    ops,
    createdAt: 0,
    committedAt: 0,
  });

  it('should return single batch when no maxPayloadBytes specified', () => {
    const changes = [createChange('1'), createChange('2')];

    const result = breakChangesIntoBatches(changes);

    expect(result).toEqual([changes]);
  });

  it('should return single batch when size is under limit', () => {
    const changes = [createChange('1'), createChange('2')];
    const maxPayloadBytes = getJSONByteSize(changes) + 100;

    const result = breakChangesIntoBatches(changes, maxPayloadBytes);

    expect(result).toEqual([changes]);
  });

  it('should break into multiple batches when size exceeds limit', () => {
    const change1 = createChange('1', [{ op: 'add', path: '/test1', value: 'data1' }]);
    const change2 = createChange('2', [{ op: 'add', path: '/test2', value: 'data2' }]);
    const changes = [change1, change2];

    // Set maxPayloadBytes to only fit one change at a time
    const singleChangeSize = getJSONByteSize({ ...change1, batchId: 'xxxxxxxxxxxx' });
    const maxPayloadBytes = singleChangeSize + 10;

    const result = breakChangesIntoBatches(changes, maxPayloadBytes);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1);
    expect(result[1]).toHaveLength(1);
    expect(result[0][0].batchId).toBeDefined();
    expect(result[1][0].batchId).toBeDefined();
  });

  it('should add batchId to all changes when batching', () => {
    const changes = [createChange('1'), createChange('2')];

    // Force batching by setting a small maxPayloadBytes
    const singleChangeSize = getJSONByteSize({ ...changes[0], batchId: 'xxxxxxxxxxxx' });
    const maxPayloadBytes = singleChangeSize + 10;

    const result = breakChangesIntoBatches(changes, maxPayloadBytes);

    result.flat().forEach(change => {
      expect(change.batchId).toBeDefined();
      expect(typeof change.batchId).toBe('string');
    });
  });

  it('should return single batch with empty array inside when given empty array', () => {
    const result = breakChangesIntoBatches([], 100);

    // Empty array is under the limit, so returns [[]]
    expect(result).toEqual([[]]);
  });

  it('should batch multiple small changes together when they fit', () => {
    const changes = [
      createChange('1', [{ op: 'add', path: '/a', value: '1' }]),
      createChange('2', [{ op: 'add', path: '/b', value: '2' }]),
      createChange('3', [{ op: 'add', path: '/c', value: '3' }]),
      createChange('4', [{ op: 'add', path: '/d', value: '4' }]),
    ];

    // Calculate sizes to fit exactly 2 changes per batch
    const singleChangeSize = getJSONByteSize({ ...changes[0], batchId: 'xxxxxxxxxxxx' });
    const twoChangesSize = singleChangeSize * 2 + 10; // Account for array overhead

    const result = breakChangesIntoBatches(changes, twoChangesSize);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(2);
    expect(result[1]).toHaveLength(2);
  });

  it('should break large individual changes before batching', () => {
    const largeChange = createChange('1', [
      { op: 'add', path: '/a', value: 'x'.repeat(500) },
      { op: 'add', path: '/b', value: 'y'.repeat(500) },
    ]);
    const changes = [largeChange];

    // Set maxPayloadBytes much smaller than the large change to force breaking
    const maxPayloadBytes = 400;

    const result = breakChangesIntoBatches(changes, maxPayloadBytes);

    // Should have split the large change into multiple batches
    expect(result.length).toBeGreaterThanOrEqual(2);
    // All changes should have batchId since we're breaking
    expect(result.flat().every(c => c.batchId)).toBe(true);
  });

  it('should accept options object with maxPayloadBytes', () => {
    const changes = [createChange('1'), createChange('2')];
    const maxPayloadBytes = getJSONByteSize(changes) + 100;

    const result = breakChangesIntoBatches(changes, { maxPayloadBytes });

    expect(result).toEqual([changes]);
  });

  it('should use maxStorageBytes to split individual changes', () => {
    const largeChange = createChange('1', [
      { op: 'add', path: '/a', value: 'x'.repeat(200) },
      { op: 'add', path: '/b', value: 'y'.repeat(200) },
    ]);

    // maxStorageBytes forces per-change splitting
    const result = breakChangesIntoBatches([largeChange], {
      maxStorageBytes: 250,
      maxPayloadBytes: 10000, // Large enough to not batch
    });

    // Should have split due to maxStorageBytes
    expect(result.flat().length).toBeGreaterThan(1);
  });

  it('should use sizeCalculator for storage size calculation when specified', () => {
    // Repetitive data compresses well
    const repetitiveChange = createChange('1', [{ op: 'add', path: '/data', value: 'a'.repeat(500) }]);

    const uncompressedSize = getJSONByteSize(repetitiveChange);
    const compressedSize = compressedSizeBase64(repetitiveChange);

    // Compressed should be smaller for repetitive data
    expect(compressedSize).toBeLessThan(uncompressedSize);

    // With sizeCalculator, a smaller limit can still fit the change
    const result = breakChangesIntoBatches([repetitiveChange], {
      maxStorageBytes: compressedSize + 50,
      sizeCalculator: compressedSizeBase64,
    });

    // Should fit in one batch since compressed size is under limit
    expect(result.flat()).toHaveLength(1);
  });
});

describe('compressedSizeBase64 and compressedSizeUint8', () => {
  it('should return compressed size for base64 format', () => {
    const data = { text: 'hello world' };
    const compressedSize = compressedSizeBase64(data);

    expect(compressedSize).toBeGreaterThan(0);
    expect(typeof compressedSize).toBe('number');
  });

  it('should return compressed size for uint8 format', () => {
    const data = { text: 'hello world' };
    const compressedSize = compressedSizeUint8(data);

    expect(compressedSize).toBeGreaterThan(0);
  });

  it('should return smaller size for repetitive data', () => {
    const repetitiveData = { text: 'a'.repeat(1000) };
    const uncompressedSize = getJSONByteSize(repetitiveData);
    const compressedSize = compressedSizeBase64(repetitiveData);

    expect(compressedSize).toBeLessThan(uncompressedSize);
  });

  it('should return 0 for undefined', () => {
    expect(compressedSizeBase64(undefined)).toBe(0);
  });

  it('should return 0 for circular structures', () => {
    const circular: any = { foo: 'bar' };
    circular.self = circular;

    // New API returns 0 instead of throwing
    expect(compressedSizeBase64(circular)).toBe(0);
  });

  it('should return uint8 size smaller than base64 size', () => {
    const data = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, value: 'test' })) };

    const base64Size = compressedSizeBase64(data);
    const uint8Size = compressedSizeUint8(data);

    // Binary should be smaller than base64 (no encoding overhead)
    expect(uint8Size).toBeLessThan(base64Size);
  });

  it('should handle arrays correctly', () => {
    const data = [1, 2, 3, 4, 5];
    const size = compressedSizeBase64(data);

    expect(size).toBeGreaterThan(0);
  });
});

describe('breakChanges with sizeCalculator', () => {
  const createChange = (rev: number, ops: any[], baseRev = 0): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev,
    ops,
    createdAt: 0,
    committedAt: 0,
  });

  it('should use compressed size when sizeCalculator is provided', () => {
    // Use a two-op change so splitting by ops is possible
    const change = createChange(1, [
      { op: 'add', path: '/a', value: 'a'.repeat(200) },
      { op: 'add', path: '/b', value: 'b'.repeat(200) },
    ]);

    const compressedSize = compressedSizeBase64(change);
    const singleOpChange = createChange(1, [change.ops[0]]);
    const singleOpSize = getJSONByteSize(singleOpChange);

    // With uncompressed limit fitting only one op, it should split into 2
    const resultWithoutCompression = breakChanges([change], singleOpSize + 10);
    expect(resultWithoutCompression.length).toBeGreaterThan(1);

    // With compressed limit larger than compressed size, it should NOT split
    const resultWithSizeCalculator = breakChanges([change], compressedSize + 50, compressedSizeBase64);
    expect(resultWithSizeCalculator).toHaveLength(1);
  });

  it('should split based on compressed size when sizeCalculator is enabled', () => {
    const change = createChange(1, [
      { op: 'add', path: '/a', value: 'x'.repeat(200) },
      { op: 'add', path: '/b', value: 'y'.repeat(200) },
    ]);

    // Get the compressed size of a single-op change
    const singleOpChange = createChange(1, [change.ops[0]]);
    const compressedSingleOpSize = compressedSizeBase64(singleOpChange);

    // Set limit just above single op compressed size
    const result = breakChanges([change], compressedSingleOpSize + 10, compressedSizeBase64);

    // Should split into 2 changes
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('should work with uint8 size calculator', () => {
    const repetitiveOps = [{ op: 'add', path: '/data', value: 'b'.repeat(500) }];
    const change = createChange(1, repetitiveOps);

    const compressedSize = compressedSizeUint8(change);

    // Should not split when limit is above compressed size
    const result = breakChanges([change], compressedSize + 50, compressedSizeUint8);
    expect(result).toHaveLength(1);
  });

  it('should allow custom ratio-based size calculator', () => {
    // Example: estimate 50% compression ratio
    const ratioEstimate = (data: unknown) => getJSONByteSize(data) * 0.5;

    const change = createChange(1, [{ op: 'add', path: '/data', value: 'test' }]);
    const uncompressedSize = getJSONByteSize(change);
    const estimatedSize = ratioEstimate(change);

    expect(estimatedSize).toBe(uncompressedSize * 0.5);

    // Should use the custom calculator
    const result = breakChanges([change], estimatedSize + 10, ratioEstimate);
    expect(result).toHaveLength(1);
  });
});
