import { describe, expect, it } from 'vitest';
import { normalizeIds } from '../../../src/net/rest/utils';

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
