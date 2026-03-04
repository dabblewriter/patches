import type { OTStoreBackend } from '../../../server/types.js';
import type { Change } from '../../../types.js';
import { createVersion } from './createVersion.js';

/**
 * Handles offline/large batch versioning logic for multi-batch uploads.
 *
 * Detects session boundaries from timestamps and creates versions for each session.
 * Changes are never collapsed — they're preserved individually.
 *
 * Each session version gets a `parentId` linking it to the preceding version:
 * - Session 1's parent: the last main-timeline version before the batch's first change
 * - Session N's parent (N > 1): the immediately preceding session's version
 *
 * @param store Store backend for version creation
 * @param sessionTimeoutMillis Timeout for detecting session boundaries
 * @param docId Document ID
 * @param changes The incoming changes
 * @param origin The origin for version metadata
 */
export async function handleOfflineSessionsAndBatches(
  store: OTStoreBackend,
  sessionTimeoutMillis: number,
  docId: string,
  changes: Change[],
  origin: 'main' | 'offline-branch' = 'offline-branch'
) {
  // For offline branches, find the last main version to use as the initial parent.
  // This anchors the offline session chain to the main timeline.
  let parentId: string | undefined;
  if (origin === 'offline-branch' && changes.length > 0) {
    const firstRev = changes[0].rev;
    const mainVersions = await store.listVersions(docId, {
      limit: 1,
      reverse: true,
      startAfter: firstRev,
      origin: 'main',
      orderBy: 'endRev',
    });
    parentId = mainVersions[0]?.id;
  }

  let sessionStartIndex = 0;

  for (let i = 1; i <= changes.length; i++) {
    const isLastChange = i === changes.length;
    const timeDiff = isLastChange ? Infinity : changes[i].createdAt - changes[i - 1].createdAt;

    // Session boundary: gap exceeds timeout or we've processed all changes
    if (timeDiff > sessionTimeoutMillis || isLastChange) {
      const sessionChanges = changes.slice(sessionStartIndex, i);
      if (sessionChanges.length > 0) {
        const version = await createVersion(store, docId, sessionChanges, { origin, parentId });
        parentId = version?.id; // Each subsequent session's parent is the prior session
        sessionStartIndex = i;
      }
    }
  }
}
