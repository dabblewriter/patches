import type { SyncedDoc } from '../types.js';

/**
 * Returns true if a document has completed its initial load — i.e., it has data
 * to display (server data, cached data, or local changes) or sync has resolved.
 */
export function isDocLoaded(doc: Pick<SyncedDoc, 'committedRev' | 'hasPending' | 'syncStatus'>): boolean {
  return doc.committedRev > 0 || doc.hasPending || doc.syncStatus === 'synced' || doc.syncStatus === 'error';
}

/**
 * Resolves a path template by replacing `:param` placeholders with values.
 *
 * @example
 * ```typescript
 * fillPath('projects/:projectId/content', { projectId: 'abc' })
 * // => 'projects/abc/content'
 * ```
 *
 * @param template - Path template with `:param` placeholders
 * @param params - Object mapping parameter names to values
 * @returns Resolved path string
 * @throws Error if a parameter in the template is missing from params
 */
export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:(\w+)/g, (match, name) => {
    const value = params[name];
    if (value == null) {
      throw new Error(`Missing parameter ":${name}" for path "${template}"`);
    }
    return value;
  });
}

/**
 * Compares two sets for equality.
 * @internal
 */
export function areSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
