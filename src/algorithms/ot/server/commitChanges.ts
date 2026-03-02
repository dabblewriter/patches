import type { CommitResult } from '../../../server/PatchesServer.js';
import type { OTStoreBackend } from '../../../server/types.js';
import type { Change, ChangeInput, CommitChangesOptions } from '../../../types.js';
import { createVersion } from './createVersion.js';
import { handleOfflineSessionsAndBatches } from './handleOfflineSessionsAndBatches.js';
import { transformIncomingChanges } from './transformIncomingChanges.js';

// Re-export for backwards compatibility
export type { CommitChangesOptions } from '../../../types.js';
export type { CommitResult } from '../../../server/PatchesServer.js';

/**
 * Commits a set of changes to a document, applying operational transformation as needed.
 *
 * ## Stateless Design
 *
 * This function never loads or builds document state. It uses `getCurrentRev` to get the
 * current revision and transforms changes against committed changes only (no state parameter
 * passed to transformPatch). Bad ops become noops during transformation.
 *
 * ## Version Creation
 *
 * Versions are created (metadata + changes saved to store) when session timeouts are
 * detected. After saving, `onVersionCreated` is emitted so subscribers can build and
 * persist state out of band.
 *
 * @param store - The backend store for persistence.
 * @param docId - The ID of the document.
 * @param changes - The changes to commit.
 * @param sessionTimeoutMillis - Timeout for session-based versioning.
 * @param options - Optional commit settings.
 * @returns A CommitResult containing:
 *   - catchupChanges: Changes the client missed
 *   - newChanges: The client's changes after transformation
 */
export async function commitChanges(
  store: OTStoreBackend,
  docId: string,
  changes: ChangeInput[],
  sessionTimeoutMillis: number,
  options?: CommitChangesOptions
): Promise<CommitResult> {
  if (changes.length === 0) {
    return { catchupChanges: [], newChanges: [] };
  }

  const batchId = changes[0].batchId;

  // 1. Get current revision without loading state
  const currentRev = await store.getCurrentRev(docId);
  let baseRev = changes[0].baseRev ?? currentRev;

  // Check if this is a batched continuation (later part of an initial batch upload)
  const batchedContinuation = batchId && changes[0].rev! > 1;

  // Rebase explicit baseRev: 0 on existing docs to current revision.
  // The client will get the current state via getDoc on reconnect.
  if (changes[0].baseRev === 0 && currentRev > 0 && !batchedContinuation) {
    const hasRootOp = changes.some(c => c.ops.some(op => op.path === ''));
    if (!hasRootOp) {
      baseRev = currentRev;
      for (const c of changes) {
        c.baseRev = baseRev;
      }
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

  // 2. Check if we need to create a version - if the last committed change
  //    was created more than a session ago. Use listChanges with limit:1 + reverse.
  const [lastChange] = await store.listChanges(docId, { reverse: true, limit: 1 });
  const compareTime = options?.historicalImport ? (changes[0].createdAt ?? serverNow) : serverNow;
  if (lastChange && compareTime - lastChange.createdAt > sessionTimeoutMillis) {
    // Create version for the previous session (metadata + changes, no state)
    await createVersion(store, docId, [lastChange]);
  }

  // 3. Load committed changes *after* the client's baseRev for transformation and idempotency checks
  const committedChanges = await store.listChanges(docId, {
    startAfter: baseRev,
    withoutBatchId: batchId,
  });

  const committedIds = new Set(committedChanges.map(c => c.id));
  const incomingChanges = changes.filter(c => !committedIds.has(c.id)) as Change[];

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

    // Create versions for offline sessions (metadata + changes, no state)
    await handleOfflineSessionsAndBatches(store, sessionTimeoutMillis, docId, incomingChanges, origin);

    // Fast-forward: no transformation needed, save changes directly
    if (canFastForward) {
      await store.saveChanges(docId, incomingChanges);
      return { catchupChanges: [], newChanges: incomingChanges };
    }
  }

  // 5. Transform the incoming changes against committed changes (stateless — no state loaded)
  const transformedChanges = transformIncomingChanges(
    incomingChanges,
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
