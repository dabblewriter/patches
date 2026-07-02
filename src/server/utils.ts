import type { EditableVersionMetadata } from '../types.js';

// Must match the Disallowed list in EditableVersionMetadata (types.ts) — RPC callers
// bypass compile-time checks, and forged startRev/endRev corrupt snapshot selection.
const nonModifiableVersionFields = new Set([
  'id',
  'parentId',
  'groupId',
  'origin',
  'startedAt',
  'endedAt',
  'startRev',
  'endRev',
]);

/**
 * Validates that version metadata does not contain non-modifiable fields.
 * @throws Error if metadata contains any non-modifiable fields.
 */
export function assertVersionMetadata(metadata?: EditableVersionMetadata) {
  if (!metadata) return;
  for (const key in metadata) {
    if (nonModifiableVersionFields.has(key)) {
      throw new Error(`Cannot modify version field ${key}`);
    }
  }
}
