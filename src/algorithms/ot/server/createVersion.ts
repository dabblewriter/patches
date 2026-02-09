import { createVersionMetadata } from '../../../data/version.js';
import type { OTStoreBackend } from '../../../server/types.js';
import type { Change, EditableVersionMetadata, VersionMetadata } from '../../../types.js';

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
  store: OTStoreBackend,
  docId: string,
  state: any,
  changes: Change[],
  metadata?: EditableVersionMetadata
): Promise<VersionMetadata | undefined> {
  if (changes.length === 0) return;

  const startRev = changes[0].rev;
  if (startRev === undefined) {
    throw new Error(`Client changes must include rev for doc ${docId}.`);
  }

  const sessionMetadata = createVersionMetadata({
    origin: 'main',
    startedAt: changes[0].createdAt,
    endedAt: changes[changes.length - 1].createdAt,
    endRev: changes[changes.length - 1].rev,
    startRev,
    ...metadata,
  });

  await store.createVersion(docId, sessionMetadata, state, changes);
  return sessionMetadata;
}
