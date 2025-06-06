import { createSortableId } from 'crypto-id';
import { createVersionMetadata } from '../../data/version';
import type { PatchesStoreBackend } from '../../server';
import type { Change } from '../../types';
import { applyChanges } from '../shared/applyChanges';
import { getStateAtRevision } from './getStateAtRevision';

/**
 * Handles offline/large batch versioning logic for multi-batch uploads.
 * Groups changes into sessions, merges with previous batch if needed, and creates/extends versions.
 * @param docId Document ID
 * @param changes The incoming changes (all with the same batchId)
 * @param baseRev The base revision for the batch
 * @param batchId The batch identifier
 * @returns The collapsed changes for transformation
 */
export async function handleOfflineSessionsAndBatches(
  store: PatchesStoreBackend,
  sessionTimeoutMillis: number,
  docId: string,
  changes: Change[],
  baseRev: number,
  batchId?: string
) {
  // Use batchId as groupId for multi-batch uploads; default offline sessions have no groupId
  const groupId = batchId ?? createSortableId();
  // Find the last version for this groupId (if any)
  const [lastVersion] = await store.listVersions(docId, {
    groupId,
    reverse: true,
    limit: 1,
  });

  let offlineBaseState: any;
  let parentId: string | undefined;

  if (lastVersion) {
    // Continue from the last version's state
    // loadVersionState returns a PatchState ({state, rev}); extract the .state
    const vs = await store.loadVersionState(docId, lastVersion.id);
    offlineBaseState = (vs as any).state ?? vs;
    parentId = lastVersion.id;
  } else {
    // First batch for this batchId: start at baseRev
    offlineBaseState = (await getStateAtRevision(store, docId, baseRev)).state;
  }

  let sessionStartIndex = 0;

  for (let i = 1; i <= changes.length; i++) {
    const isLastChange = i === changes.length;
    const timeDiff = isLastChange ? Infinity : changes[i].created - changes[i - 1].created;

    // Session ends if timeout exceeded OR it's the last change in the batch
    if (timeDiff > sessionTimeoutMillis || isLastChange) {
      const sessionChanges = changes.slice(sessionStartIndex, i);
      if (sessionChanges.length > 0) {
        // Check if this is a continuation of the previous session (merge/extend)
        const isContinuation = !!lastVersion && sessionChanges[0].created - lastVersion.endDate <= sessionTimeoutMillis;

        if (isContinuation) {
          // Merge/extend the existing version
          const mergedState = applyChanges(offlineBaseState, sessionChanges);
          await store.saveChanges(docId, sessionChanges);
          await store.updateVersion(docId, lastVersion.id, {}); // metadata already updated above
          offlineBaseState = mergedState;
          parentId = lastVersion.parentId;
        } else {
          // Create a new version for this session
          offlineBaseState = applyChanges(offlineBaseState, sessionChanges);

          const sessionMetadata = createVersionMetadata({
            parentId,
            groupId,
            origin: 'offline',
            startDate: sessionChanges[0].created,
            endDate: sessionChanges[sessionChanges.length - 1].created,
            rev: sessionChanges[sessionChanges.length - 1].rev,
            baseRev,
          });
          await store.createVersion(docId, sessionMetadata, offlineBaseState, sessionChanges);
          parentId = sessionMetadata.id;
        }
        sessionStartIndex = i;
      }
    }
  }

  // Collapse all changes into one for transformation
  return [
    changes.reduce((firstChange, nextChange) => {
      firstChange.ops = [...firstChange.ops, ...nextChange.ops];
      return firstChange;
    }),
  ];
}
