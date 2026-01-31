import type { CommitResult } from '../../server/PatchesServer.js';
import type { PatchesStoreBackend } from '../../server/types.js';
import type { Change, ChangeInput, CommitChangesOptions } from '../../types.js';
import { filterSoftWritesAgainstState } from '../../json-patch/utils/softWrites.js';
import { applyChanges } from '../shared/applyChanges.js';
import { createVersion } from './createVersion.js';
import { getSnapshotAtRevision } from './getSnapshotAtRevision.js';
import { getStateAtRevision } from './getStateAtRevision.js';
import { handleOfflineSessionsAndBatches } from './handleOfflineSessionsAndBatches.js';
import { transformIncomingChanges } from './transformIncomingChanges.js';

// Re-export for backwards compatibility
export type { CommitChangesOptions } from '../../types.js';
export type { CommitResult } from '../../server/PatchesServer.js';

/**
 * Commits a set of changes to a document, applying operational transformation as needed.
 * @param store - The backend store for persistence.
 * @param docId - The ID of the document.
 * @param changes - The changes to commit.
 * @param sessionTimeoutMillis - Timeout for session-based versioning.
 * @param options - Optional commit settings.
 * @param maxStorageBytes - Optional max bytes per change for storage limits.
 * @returns A CommitResult containing:
 *   - catchupChanges: Changes the client missed from other clients
 *   - newChanges: The client's changes after transformation
 */
export async function commitChanges(
  store: PatchesStoreBackend,
  docId: string,
  changes: ChangeInput[],
  sessionTimeoutMillis: number,
  options?: CommitChangesOptions,
  maxStorageBytes?: number
): Promise<CommitResult> {
  if (changes.length === 0) {
    return { catchupChanges: [], newChanges: [] };
  }

  const batchId = changes[0].batchId;

  // 1. Load server state details (needed before we can fill in missing baseRev)
  const { state: initialState, rev: initialRev, changes: currentChanges } = await getSnapshotAtRevision(store, docId);
  const currentState = applyChanges(initialState, currentChanges);
  const currentRev = currentChanges.at(-1)?.rev ?? initialRev;
  let baseRev = changes[0].baseRev ?? currentRev;

  // Check if this is a batched continuation (later part of an initial batch upload)
  const batchedContinuation = batchId && changes[0].rev! > 1;

  // Rebase explicit baseRev: 0 on existing docs to current revision for granular changes.
  // This avoids expensive transformation through full history when a never-synced client
  // makes changes to an existing document. Root-level ops are excluded (handled below).
  if (changes[0].baseRev === 0 && currentRev > 0 && !batchedContinuation) {
    const hasRootOp = changes.some(c => c.ops.some(op => op.path === ''));
    if (!hasRootOp) {
      baseRev = currentRev;
      // Update baseRev, filter soft writes, and remove empty changes in one pass
      changes = changes.filter(c => {
        c.baseRev = baseRev;
        c.ops = filterSoftWritesAgainstState(c.ops, currentState);
        return c.ops.length > 0;
      });
    }
  }

  // Ensure baseRev and rev are set, add committedAt, and clamp createdAt
  const serverNow = Date.now();
  let rev = baseRev + 1;
  changes.forEach(c => {
    if (c.baseRev == null) c.baseRev = baseRev;
    else if (c.baseRev !== baseRev && !options?.historicalImport) {
      throw new Error(`Client changes must have consistent baseRev in all changes for doc ${docId}.`);
    }
    if (c.rev == null) c.rev = rev++;
    else rev = c.rev + 1;
    // Set server commit time (preserve existing in historicalImport mode)
    if (!options?.historicalImport || !(c as Change).committedAt) {
      (c as Change).committedAt = serverNow;
    }
    // Clamp createdAt to not be after committedAt
    c.createdAt = c.createdAt ? Math.min(c.createdAt, serverNow) : serverNow;
  });

  // Basic validation
  if (baseRev > currentRev) {
    throw new Error(
      `Client baseRev (${baseRev}) is ahead of server revision (${currentRev}) for doc ${docId}. Client needs to reload the document.`
    );
  }

  // Prevent stale clients from wiping existing data with a root creation op (unless it's a batched continuation)
  if (changes[0].baseRev === 0 && currentRev > 0 && !batchedContinuation && changes[0].ops[0]?.path === '') {
    throw new Error(
      `Document ${docId} already exists (rev ${currentRev}). ` +
        `Cannot apply root-level replace (path: '') with baseRev 0 - this would overwrite the existing document. ` +
        `Load the existing document first, or use nested paths instead of replacing at root.`
    );
  }

  // 2. Check if we need to create a new version - if the last change was created more than a session ago
  // In historicalImport mode, use incoming change timestamp instead of serverNow for accurate gap detection
  const lastChange = currentChanges[currentChanges.length - 1];
  const compareTime = options?.historicalImport ? changes[0].createdAt : serverNow;
  if (lastChange && compareTime - lastChange.createdAt > sessionTimeoutMillis) {
    await createVersion(store, docId, currentState, currentChanges);
  }

  // 3. Load committed changes *after* the client's baseRev for transformation and idempotency checks
  const committedChanges = await store.listChanges(docId, {
    startAfter: baseRev,
    withoutBatchId: batchId,
  });

  const committedIds = new Set(committedChanges.map(c => c.id));
  let incomingChanges = changes.filter(c => !committedIds.has(c.id)) as Change[];

  // If all incoming changes were already committed, return the committed changes found
  if (incomingChanges.length === 0) {
    return { catchupChanges: committedChanges, newChanges: [] };
  }

  // 4. Handle offline-session versioning:
  // - batchId present (multi-batch uploads)
  // - or the first change is older than the session timeout (single-batch offline)
  const isOfflineTimestamp = serverNow - incomingChanges[0].createdAt > sessionTimeoutMillis;
  if (isOfflineTimestamp || batchId) {
    // Determine if we can fast-forward (no concurrent changes to transform over)
    const canFastForward = committedChanges.length === 0;
    // In historicalImport mode, always use 'main' origin
    const origin = options?.historicalImport ? 'main' : canFastForward ? 'main' : 'offline-branch';

    // Create versions for offline sessions (with isOffline metadata)
    incomingChanges = await handleOfflineSessionsAndBatches(
      store,
      sessionTimeoutMillis,
      docId,
      incomingChanges,
      baseRev,
      batchId,
      origin,
      true, // isOffline
      maxStorageBytes
    );

    // Fast-forward: no transformation needed, save changes directly
    if (canFastForward) {
      await store.saveChanges(docId, incomingChanges);
      return { catchupChanges: [], newChanges: incomingChanges };
    }
  }

  // 5. Transform the *entire batch* of incoming (and potentially collapsed offline) changes
  //    against committed changes that happened *after* the client's baseRev.
  //    The state used for transformation should be the server state *at the client's baseRev*.
  const stateAtBaseRev = (await getStateAtRevision(store, docId, baseRev)).state;
  const transformedChanges = transformIncomingChanges(
    incomingChanges,
    stateAtBaseRev,
    committedChanges,
    currentRev,
    options?.forceCommit
  );

  if (transformedChanges.length > 0) {
    await store.saveChanges(docId, transformedChanges);
  }

  // Return catchup changes and newly transformed changes separately
  return { catchupChanges: committedChanges, newChanges: transformedChanges };
}
