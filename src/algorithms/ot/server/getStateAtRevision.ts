import type { OTStoreBackend } from '../../../server/types.js';
import type { PatchesState } from '../../../types.js';
import { applyChanges } from '../shared/applyChanges.js';
import { getSnapshotAtRevision } from './getSnapshotAtRevision.js';

/**
 * Gets the state at a specific revision.
 * @param docId The document ID.
 * @param rev The revision number. If not provided, the latest state and its revision is returned.
 * @returns The state at the specified revision *and* its revision number.
 */
export async function getStateAtRevision(
  store: OTStoreBackend,
  docId: string,
  rev?: number
): Promise<PatchesState> {
  // Note: _getSnapshotAtRevision now returns the state *of the version* and changes *since* it.
  // We need to apply the changes to get the state *at* the target revision.
  const { state: versionState, rev: snapshotRev, changes } = await getSnapshotAtRevision(store, docId, rev);
  return {
    // Ensure null is passed if versionState is null/undefined
    state: applyChanges(versionState ?? null, changes),
    rev: changes.at(-1)?.rev ?? snapshotRev,
  };
}
