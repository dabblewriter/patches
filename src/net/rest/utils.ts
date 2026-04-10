/**
 * Normalize a string or string array to a string array.
 */
export function normalizeIds(ids: string | string[]): string[] {
  return Array.isArray(ids) ? ids : [ids];
}
