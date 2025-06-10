import { createSortableId } from 'crypto-id';
import type { VersionMetadata } from '../types.js';

/**
 * Create a version id for a given document. Uses a sortable 16 character id.
 * @returns The version id.
 */
export function createVersionId() {
  return createSortableId();
}

/**
 * Create a version.
 * @param data - The version data.
 * @returns The version.
 */
export function createVersionMetadata(data: Omit<VersionMetadata, 'id'>): VersionMetadata {
  data.id = createVersionId();
  return data as VersionMetadata;
}
