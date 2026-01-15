import { describe, it, expect } from 'vitest';
import { base64Compressor, uint8Compressor, compressedSizeBase64, compressedSizeUint8 } from '../../src/compression';
import type { JSONPatchOp } from '../../src/json-patch/types';

describe('OpsCompressor', () => {
  const sampleOps: JSONPatchOp[] = [
    { op: 'add', path: '/test', value: 'hello' },
    { op: 'replace', path: '/test', value: 'world' },
    { op: 'remove', path: '/old' },
  ];

  describe('base64Compressor', () => {
    describe('compress', () => {
      it('should compress ops to base64 string', () => {
        const result = base64Compressor.compress(sampleOps);

        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
        // Base64 should be ASCII printable
        expect(result).toMatch(/^[\x20-\x7E]+$/);
      });

      it('should handle empty ops array', () => {
        const result = base64Compressor.compress([]);

        expect(typeof result).toBe('string');
      });

      it('should compress large ops effectively', () => {
        const largeOps: JSONPatchOp[] = [
          {
            op: 'add',
            path: '/content',
            value: 'a'.repeat(10000), // Large repetitive string compresses well
          },
        ];

        const compressed = base64Compressor.compress(largeOps) as string;
        const originalSize = new TextEncoder().encode(JSON.stringify(largeOps)).length;
        const compressedSize = new TextEncoder().encode(compressed).length;

        // LZ compression on repetitive data should be significantly smaller
        expect(compressedSize).toBeLessThan(originalSize);
      });

      it('should handle unicode content', () => {
        const unicodeOps: JSONPatchOp[] = [{ op: 'add', path: '/text', value: 'Hello, \u4e16\u754c! \u{1F600}' }];

        const result = base64Compressor.compress(unicodeOps);

        expect(typeof result).toBe('string');
      });

      it('should handle nested objects in ops', () => {
        const nestedOps: JSONPatchOp[] = [
          {
            op: 'add',
            path: '/nested',
            value: {
              level1: {
                level2: {
                  level3: { data: 'deep' },
                },
              },
            },
          },
        ];

        const result = base64Compressor.compress(nestedOps);
        expect(typeof result).toBe('string');
      });
    });

    describe('decompress', () => {
      it('should roundtrip compression', () => {
        const compressed = base64Compressor.compress(sampleOps);
        const decompressed = base64Compressor.decompress(compressed);

        expect(decompressed).toEqual(sampleOps);
      });

      it('should handle empty compressed data', () => {
        const emptyCompressed = base64Compressor.compress([]);
        const result = base64Compressor.decompress(emptyCompressed);

        expect(result).toEqual([]);
      });

      it('should roundtrip large ops', () => {
        const largeOps: JSONPatchOp[] = Array.from({ length: 100 }, (_, i) => ({
          op: 'add',
          path: `/item${i}`,
          value: `value-${i}-${'x'.repeat(100)}`,
        }));

        const compressed = base64Compressor.compress(largeOps);
        const decompressed = base64Compressor.decompress(compressed);
        expect(decompressed).toEqual(largeOps);
      });

      it('should roundtrip unicode content', () => {
        const unicodeOps: JSONPatchOp[] = [
          { op: 'add', path: '/emoji', value: '\u{1F600}\u{1F601}\u{1F602}' },
          { op: 'replace', path: '/chinese', value: '\u4e2d\u6587\u6d4b\u8bd5' },
        ];

        const compressed = base64Compressor.compress(unicodeOps);
        const decompressed = base64Compressor.decompress(compressed);

        expect(decompressed).toEqual(unicodeOps);
      });

      it('should roundtrip text delta operations', () => {
        const textOps: JSONPatchOp[] = [
          {
            op: '@txt' as any,
            path: '/content',
            value: [{ insert: 'Hello ' }, { retain: 5 }, { insert: 'World', attributes: { bold: true } }],
          },
        ];

        const compressed = base64Compressor.compress(textOps);
        const decompressed = base64Compressor.decompress(compressed);

        expect(decompressed).toEqual(textOps);
      });
    });

    describe('isCompressed', () => {
      it('should return true for string (base64 compressed)', () => {
        const compressed = base64Compressor.compress(sampleOps);

        expect(base64Compressor.isCompressed(compressed)).toBe(true);
      });

      it('should return false for array (uncompressed ops)', () => {
        expect(base64Compressor.isCompressed(sampleOps)).toBe(false);
      });

      it('should return false for object', () => {
        expect(base64Compressor.isCompressed({ op: 'add', path: '/test', value: 1 })).toBe(false);
      });

      it('should return false for null and undefined', () => {
        expect(base64Compressor.isCompressed(null)).toBe(false);
        expect(base64Compressor.isCompressed(undefined)).toBe(false);
      });

      it('should return false for number', () => {
        expect(base64Compressor.isCompressed(123)).toBe(false);
      });

      it('should return true for empty string', () => {
        // Empty string is technically a valid compressed format indicator
        expect(base64Compressor.isCompressed('')).toBe(true);
      });
    });
  });

  describe('uint8Compressor', () => {
    describe('compress', () => {
      it('should compress ops to Uint8Array', () => {
        const result = uint8Compressor.compress(sampleOps);

        expect(result).toBeInstanceOf(Uint8Array);
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle empty ops array', () => {
        const result = uint8Compressor.compress([]);

        expect(result).toBeInstanceOf(Uint8Array);
      });
    });

    describe('decompress', () => {
      it('should roundtrip compression', () => {
        const compressed = uint8Compressor.compress(sampleOps);
        const decompressed = uint8Compressor.decompress(compressed);

        expect(decompressed).toEqual(sampleOps);
      });

      it('should roundtrip large ops', () => {
        const largeOps: JSONPatchOp[] = Array.from({ length: 100 }, (_, i) => ({
          op: 'add',
          path: `/item${i}`,
          value: `value-${i}-${'x'.repeat(100)}`,
        }));

        const compressed = uint8Compressor.compress(largeOps);
        const decompressed = uint8Compressor.decompress(compressed);
        expect(decompressed).toEqual(largeOps);
      });
    });

    describe('isCompressed', () => {
      it('should return true for Uint8Array (binary compressed)', () => {
        const compressed = uint8Compressor.compress(sampleOps);

        expect(uint8Compressor.isCompressed(compressed)).toBe(true);
      });

      it('should return false for array (uncompressed ops)', () => {
        expect(uint8Compressor.isCompressed(sampleOps)).toBe(false);
      });

      it('should return false for string', () => {
        expect(uint8Compressor.isCompressed('test')).toBe(false);
      });
    });
  });

  describe('compression efficiency', () => {
    it('should compress better with uint8 than base64', () => {
      const ops: JSONPatchOp[] = [{ op: 'add', path: '/data', value: 'a'.repeat(1000) }];

      const base64 = base64Compressor.compress(ops) as string;
      const uint8 = uint8Compressor.compress(ops) as Uint8Array;

      const base64Size = new TextEncoder().encode(base64).length;
      const uint8Size = uint8.length;

      // Uint8array should be smaller (no base64 encoding overhead)
      expect(uint8Size).toBeLessThan(base64Size);
    });
  });
});

describe('SizeCalculator', () => {
  it('compressedSizeBase64 should return compressed size', () => {
    const data = { text: 'hello world' };
    const size = compressedSizeBase64(data);

    expect(size).toBeGreaterThan(0);
    expect(typeof size).toBe('number');
  });

  it('compressedSizeUint8 should return compressed size', () => {
    const data = { text: 'hello world' };
    const size = compressedSizeUint8(data);

    expect(size).toBeGreaterThan(0);
    expect(typeof size).toBe('number');
  });

  it('should return smaller size for repetitive data', () => {
    const repetitiveData = { text: 'a'.repeat(1000) };
    const uncompressedSize = new TextEncoder().encode(JSON.stringify(repetitiveData)).length;
    const compressedSize = compressedSizeBase64(repetitiveData);

    expect(compressedSize).toBeLessThan(uncompressedSize);
  });

  it('compressedSizeUint8 should be smaller than compressedSizeBase64', () => {
    const data = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, value: 'test' })) };

    const base64Size = compressedSizeBase64(data);
    const uint8Size = compressedSizeUint8(data);

    // Binary should be smaller than base64 (no encoding overhead)
    expect(uint8Size).toBeLessThan(base64Size);
  });

  it('should return 0 for undefined', () => {
    expect(compressedSizeBase64(undefined)).toBe(0);
    expect(compressedSizeUint8(undefined)).toBe(0);
  });

  it('should return 0 for circular structures', () => {
    const circular: any = { foo: 'bar' };
    circular.self = circular;

    // New API returns 0 instead of throwing
    expect(compressedSizeBase64(circular)).toBe(0);
    expect(compressedSizeUint8(circular)).toBe(0);
  });
});
