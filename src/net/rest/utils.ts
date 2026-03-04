/**
 * Encode a hierarchical doc ID for use in URL path segments.
 * Each segment is individually encoded so slashes are preserved as path separators.
 *
 * @example encodeDocId('users/abc/stats/2026-01') => 'users/abc/stats/2026-01'
 * @example encodeDocId('docs/hello world') => 'docs/hello%20world'
 */
export function encodeDocId(docId: string): string {
  return docId.split('/').map(encodeURIComponent).join('/');
}

/**
 * Normalize a string or string array to a string array.
 */
export function normalizeIds(ids: string | string[]): string[] {
  return Array.isArray(ids) ? ids : [ids];
}
