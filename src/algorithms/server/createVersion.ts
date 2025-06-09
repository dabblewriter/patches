import { createVersionMetadata } from '../../data/version.js';
import type { Change, EditableVersionMetadata, VersionMetadata } from '../../types';
import type { PatchesStoreBackend } from '../../server/types';

/**
 * Creates a new version snapshot of a document's state from changes.
 * @param store The storage backend to save the version to.
 * @param docId The document ID.
 * @param state The document state at the time of the version.
 * @param changes The changes since the last version that created the state.
 * @param metadata Optional additional metadata for the version.
 * @returns The created version metadata, or undefined if no changes provided.
 */
export async function createVersion(
  store: PatchesStoreBackend,
  docId: string,
  state: any,
  changes: Change[],
  metadata?: EditableVersionMetadata
): Promise<VersionMetadata | undefined> {
  if (changes.length === 0) return;
  
  const baseRev = changes[0].baseRev;
  if (baseRev === undefined) {
    throw new Error(`Client changes must include baseRev for doc ${docId}.`);
  }

  const sessionMetadata = createVersionMetadata({
    origin: 'main',
    startDate: changes[0].created,
    endDate: changes[changes.length - 1].created,
    rev: changes[changes.length - 1].rev,
    baseRev,
    ...metadata,
  });

  await store.createVersion(docId, sessionMetadata, state, changes);
  return sessionMetadata;
}