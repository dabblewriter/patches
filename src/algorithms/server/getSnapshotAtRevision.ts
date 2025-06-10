import type { PatchesStoreBackend } from '../../server.js';
import type { PatchesSnapshot } from '../../types.js';

/**
 * Retrieves the document state of the version before the given revision and changes after up to that revision or all
 * changes since that version.
 * @param docId The document ID.
 * @param rev The revision number. If not provided, the latest state, its revision, and all changes since are returned.
 * @returns The document state at the last version before the revision, its revision number, and all changes up to the specified revision (or all changes if no revision is provided).
 */
export async function getSnapshotAtRevision(
  store: PatchesStoreBackend,
  docId: string,
  rev?: number
): Promise<PatchesSnapshot> {
  const versions = await store.listVersions(docId, {
    limit: 1,
    reverse: true,
    startAfter: rev ? rev + 1 : undefined,
    origin: 'main',
    orderBy: 'rev',
  });
  const latestMainVersion = versions[0];
  const versionState = (latestMainVersion && (await store.loadVersionState(docId, latestMainVersion.id))) || null;
  const versionRev = latestMainVersion?.rev ?? 0;

  // Get *all* changes since that version up to the target revision (if specified)
  const changesSinceVersion = await store.listChanges(docId, {
    startAfter: versionRev,
    endBefore: rev ? rev + 1 : undefined,
  });

  return {
    state: versionState, // State from the base version
    rev: versionRev, // Revision of the base version's state
    changes: changesSinceVersion, // Changes that occurred *after* the base version state
  };
}
