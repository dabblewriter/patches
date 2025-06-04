import { describe, expect, it, vi } from 'vitest';
import { getJSONByteSize } from '../../../src/algorithms/client/getJSONByteSize.js';

describe('getJSONByteSize', () => {
  it('should return correct byte size for simple objects', () => {
    // {"a":1,"b":"hello"} -> UTF-8 bytes: 1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1 = 19
    expect(getJSONByteSize({ a: 1, b: 'hello' })).toBe(19);
  });

  it('should return correct byte size for empty object', () => {
    expect(getJSONByteSize({})).toBe(2); // {}
  });

  it('should return correct byte size for null', () => {
    expect(getJSONByteSize(null)).toBe(4); // null
  });

  it('should return correct byte size for an array', () => {
    // [1,"two",{"c":3}] -> UTF-8 bytes: 1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1 = 17
    expect(getJSONByteSize([1, 'two', { c: 3 }])).toBe(17);
  });

  it('should return correct byte size for unicode characters', () => {
    // {"key":"€uro"} -> € is 3 bytes. Total 16 bytes.
    expect(getJSONByteSize({ key: '€uro' })).toBe(16);
    // {"key":"你好"} -> 你 and 好 are 3 bytes each. Total 16 bytes.
    expect(getJSONByteSize({ key: '你好' })).toBe(16);
  });

  it('should throw an error for circular structures (and log error)', () => {
    const circular: any = { a: 1 };
    circular.b = circular;
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Expect the function to throw an error that starts with "Error calculating JSON size:"
    expect(() => getJSONByteSize(circular)).toThrow(/^Error calculating JSON size:/);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('should handle various data types', () => {
    expect(getJSONByteSize(123)).toBe(3);
    expect(getJSONByteSize('string')).toBe(8); // "string"
    expect(getJSONByteSize(true)).toBe(4);
    expect(getJSONByteSize(undefined)).toBe(0); // Corrected: function returns 0 for undefined stringified
  });
});
