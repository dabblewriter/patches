import { describe, expect, it } from 'vitest';
import { encodeDocId, normalizeIds } from '../../../src/net/rest/utils';

describe('encodeDocId', () => {
  it('should pass simple IDs through', () => {
    expect(encodeDocId('doc1')).toBe('doc1');
  });

  it('should preserve slashes as path separators', () => {
    expect(encodeDocId('users/abc/stats/2026-01')).toBe('users/abc/stats/2026-01');
  });

  it('should encode special characters within segments', () => {
    expect(encodeDocId('users/hello world')).toBe('users/hello%20world');
  });

  it('should encode each segment independently', () => {
    expect(encodeDocId('a b/c d')).toBe('a%20b/c%20d');
  });

  it('should handle empty string', () => {
    expect(encodeDocId('')).toBe('');
  });
});

describe('normalizeIds', () => {
  it('should wrap a string in an array', () => {
    expect(normalizeIds('doc1')).toEqual(['doc1']);
  });

  it('should pass an array through', () => {
    expect(normalizeIds(['doc1', 'doc2'])).toEqual(['doc1', 'doc2']);
  });

  it('should handle empty array', () => {
    expect(normalizeIds([])).toEqual([]);
  });
});
