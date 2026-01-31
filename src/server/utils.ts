import type { EditableVersionMetadata } from '../types.js';

const nonModifiableVersionFields = new Set([
  'id',
  'parentId',
  'groupId',
  'origin',
  'branchName',
  'startedAt',
  'endedAt',
  'rev',
  'baseRev',
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
