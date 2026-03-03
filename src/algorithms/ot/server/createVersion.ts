import { createVersionMetadata } from '../../../data/version.js';
import type { OTStoreBackend } from '../../../server/types.js';
import type { Change, EditableVersionMetadata, VersionMetadata } from '../../../types.js';

/**
 * Options for creating a version.
 */
export interface CreateVersionOptions {
  /** The origin of the version. Defaults to 'main'. */
  origin?: 'main' | 'offline-branch';
  /** ID of the parent version in the history chain. */
  parentId?: string;
  /** Optional additional metadata for the version. */
  metadata?: EditableVersionMetadata;
}

/**
 * Creates a version for all changes since the last version up to (and including) `endRev`.
 *
 * Looks up the last existing version to determine `startRev`, then loads all
 * changes from there to `endRev` from the change log. This ensures the version
 * covers the complete session, not just a single change.
 *
 * @param store The storage backend.
 * @param docId The document ID.
 * @param endRev The revision to end the version at (inclusive).
 * @param options Options including origin and metadata.
 * @returns The created version metadata, or undefined if no changes were found.
 */
export async function createVersionAtRev(
  store: OTStoreBackend,
  docId: string,
  endRev: number,
  options?: CreateVersionOptions
): Promise<VersionMetadata | undefined> {
  const [lastVersion] = await store.listVersions(docId, {
    limit: 1,
    reverse: true,
    orderBy: 'endRev',
  });
  const startAfterRev = lastVersion?.endRev ?? 0;

  const changes = await store.listChanges(docId, {
    startAfter: startAfterRev,
    endBefore: endRev + 1,
  });

  if (changes.length === 0) return undefined;

  return createVersion(store, docId, changes, {
    ...options,
    parentId: options?.parentId ?? lastVersion?.id,
  });
}

/**
 * Creates a new version record from changes.
 *
 * Saves metadata and changes to the store via `store.createVersion`. The store
 * implementation is responsible for building and persisting version state — inline
 * or queued — and must throw if that fails.
 *
 * @param store The storage backend to save the version to.
 * @param docId The document ID.
 * @param changes The changes since the last version.
 * @param options Options including origin and metadata.
 * @returns The created version metadata, or undefined if no changes provided.
 */
export async function createVersion(
  store: OTStoreBackend,
  docId: string,
  changes: Change[],
  options?: CreateVersionOptions
): Promise<VersionMetadata | undefined> {
  if (changes.length === 0) return;

  const startRev = changes[0].rev;
  if (startRev === undefined) {
    throw new Error(`Client changes must include rev for doc ${docId}.`);
  }

  const sessionMetadata = createVersionMetadata({
    origin: options?.origin ?? 'main',
    startedAt: changes[0].createdAt,
    endedAt: changes[changes.length - 1].createdAt,
    endRev: changes[changes.length - 1].rev,
    startRev,
    ...(options?.parentId !== undefined && { parentId: options.parentId }),
    ...options?.metadata,
  });

  await store.createVersion(docId, sessionMetadata, changes);

  return sessionMetadata;
}
