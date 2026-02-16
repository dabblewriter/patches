/**
 * Escapes a single path component for use in a JSON Pointer (RFC 6901).
 * `~` is escaped as `~0` and `/` is escaped as `~1`.
 */
export function escapePathComponent(component: string): string {
  return component.replace(/~/g, '~0').replace(/\//g, '~1');
}
