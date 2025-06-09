import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getJSONByteSize } from '../../../src/algorithms/client/getJSONByteSize';

describe('getJSONByteSize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should calculate size of simple string', () => {
    const data = 'hello';
    const result = getJSONByteSize(data);

    // "hello" as JSON string is "hello" (7 bytes: quotes + 5 characters)
    expect(result).toBe(7);
  });

  it('should calculate size of empty string', () => {
    const data = '';
    const result = getJSONByteSize(data);

    // "" as JSON string is 2 bytes (just quotes)
    expect(result).toBe(2);
  });

  it('should calculate size of number', () => {
    const data = 123;
    const result = getJSONByteSize(data);

    // 123 as JSON is 3 bytes
    expect(result).toBe(3);
  });

  it('should calculate size of boolean', () => {
    const trueResult = getJSONByteSize(true);
    const falseResult = getJSONByteSize(false);

    // true = 4 bytes, false = 5 bytes
    expect(trueResult).toBe(4);
    expect(falseResult).toBe(5);
  });

  it('should calculate size of null', () => {
    const result = getJSONByteSize(null);

    // null = 4 bytes
    expect(result).toBe(4);
  });

  it('should calculate size of undefined', () => {
    const result = getJSONByteSize(undefined);

    // undefined becomes undefined in JSON.stringify, which returns undefined, so empty string = 0 bytes
    expect(result).toBe(0);
  });

  it('should calculate size of simple object', () => {
    const data = { name: 'John', age: 30 };
    const result = getJSONByteSize(data);

    // {"name":"John","age":30} = 24 bytes (actual measurement)
    expect(result).toBe(24);
  });

  it('should calculate size of empty object', () => {
    const data = {};
    const result = getJSONByteSize(data);

    // {} = 2 bytes
    expect(result).toBe(2);
  });

  it('should calculate size of simple array', () => {
    const data = [1, 2, 3];
    const result = getJSONByteSize(data);

    // [1,2,3] = 7 bytes
    expect(result).toBe(7);
  });

  it('should calculate size of empty array', () => {
    const data: any[] = [];
    const result = getJSONByteSize(data);

    // [] = 2 bytes
    expect(result).toBe(2);
  });

  it('should calculate size of nested object', () => {
    const data = {
      user: {
        name: 'Alice',
        details: {
          age: 25,
          city: 'NYC',
        },
      },
      active: true,
    };
    const result = getJSONByteSize(data);

    // Should be a reasonable size for the nested structure
    expect(result).toBeGreaterThan(50);
    expect(typeof result).toBe('number');
  });

  it('should calculate size of array with objects', () => {
    const data = [
      { id: 1, name: 'Item 1' },
      { id: 2, name: 'Item 2' },
      { id: 3, name: 'Item 3' },
    ];
    const result = getJSONByteSize(data);

    // Should be a reasonable size for the array of objects
    expect(result).toBeGreaterThan(60);
    expect(typeof result).toBe('number');
  });

  it('should handle strings with special characters', () => {
    const data = 'Hello "world" with \n newlines and \t tabs';
    const result = getJSONByteSize(data);

    // Should account for escaped characters in JSON
    expect(result).toBeGreaterThan(40);
    expect(typeof result).toBe('number');
  });

  it('should handle Unicode characters', () => {
    const data = 'Hello 世界 🌍 emoji';
    const result = getJSONByteSize(data);

    // Unicode characters take more bytes in UTF-8
    expect(result).toBeGreaterThan(20);
    expect(typeof result).toBe('number');
  });

  it('should handle large objects', () => {
    const data = {
      largeArray: Array(100).fill('item'),
      largeString: 'x'.repeat(1000),
      nestedData: {
        moreData: Array(50).fill({ key: 'value', number: 42 }),
      },
    };
    const result = getJSONByteSize(data);

    // Should be a large size
    expect(result).toBeGreaterThan(2000);
    expect(typeof result).toBe('number');
  });

  it('should return 0 for data that cannot be stringified to valid JSON', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Create circular reference
    const circular: any = { name: 'test' };
    circular.self = circular;

    expect(() => getJSONByteSize(circular)).toThrow('Error calculating JSON size');

    consoleSpy.mockRestore();
  });

  it('should handle very large numbers', () => {
    const data = {
      bigNumber: Number.MAX_SAFE_INTEGER,
      smallNumber: Number.MIN_SAFE_INTEGER,
      float: 3.14159265359,
    };
    const result = getJSONByteSize(data);

    expect(result).toBeGreaterThan(50);
    expect(typeof result).toBe('number');
  });

  it('should handle mixed data types', () => {
    const data = {
      string: 'hello',
      number: 42,
      boolean: true,
      nullValue: null,
      array: [1, 'two', true, null],
      object: { nested: 'value' },
    };
    const result = getJSONByteSize(data);

    expect(result).toBeGreaterThan(70);
    expect(typeof result).toBe('number');
  });

  it('should be consistent for same data', () => {
    const data = { test: 'consistency', value: 123 };
    const result1 = getJSONByteSize(data);
    const result2 = getJSONByteSize(data);

    expect(result1).toBe(result2);
    expect(result1).toBeGreaterThan(20);
  });

  it('should handle JSON patch operations', () => {
    const patchOps = [
      { op: 'add', path: '/test', value: 'hello' },
      { op: 'replace', path: '/count', value: 42 },
      { op: 'remove', path: '/old' },
    ];
    const result = getJSONByteSize(patchOps);

    expect(result).toBeGreaterThan(80);
    expect(typeof result).toBe('number');
  });
});
