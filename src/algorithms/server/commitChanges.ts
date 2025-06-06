import type { PatchesStoreBackend } from '../../server/types';
import type { Change } from '../../types';
import { applyChanges } from '../shared/applyChanges';
import { createVersion } from './createVersion';
import { getSnapshotAtRevision } from './getSnapshotAtRevision';
import { getStateAtRevision } from './getStateAtRevision';
import { handleOfflineSessionsAndBatches } from './handleOfflineSessionsAndBatches';
import { transformIncomingChanges } from './transformIncomingChanges';

/**
 * Commits a set of changes to a document, applying operational transformation as needed.
 * @param docId - The ID of the document.
 * @param changes - The changes to commit.
 * @param originClientId - The ID of the client that initiated the commit.
 * @returns A tuple of [committedChanges, transformedChanges] where:
 *   - committedChanges: Changes that were already committed to the server after the client's base revision
 *   - transformedChanges: The client's changes after being transformed against concurrent changes
 */
export async function commitChanges(
  store: PatchesStoreBackend,
  docId: string,
  changes: Change[],
  sessionTimeoutMillis: number
): Promise<[Change[], Change[]]> {
  if (changes.length === 0) {
    return [[], []];
  }

  // Assume all changes share the same baseRev. Client ensures
  const batchId = changes[0].batchId;
  const baseRev = changes[0].baseRev;
  if (baseRev === undefined) {
    throw new Error(`Client changes must include baseRev for doc ${docId}.`);
  }

  // Add check for inconsistent baseRev within the batch if needed
  if (changes.some(c => c.baseRev !== baseRev)) {
    throw new Error(`Client changes must have consistent baseRev in all changes for doc ${docId}.`);
  }

  // 1. Load server state details (assuming store methods exist)
  const { state: initialState, rev: initialRev, changes: currentChanges } = await getSnapshotAtRevision(store, docId);
  const currentState = applyChanges(initialState, currentChanges);
  const currentRev = currentChanges.at(-1)?.rev ?? initialRev;

  // Basic validation
  if (baseRev > currentRev) {
    throw new Error(
      `Client baseRev (${baseRev}) is ahead of server revision (${currentRev}) for doc ${docId}. Client needs to reload the document.`
    );
  }

  const partOfInitialBatch = batchId && changes[0].rev > 1;
  if (baseRev === 0 && currentRev > 0 && !partOfInitialBatch && changes[0].ops[0].path === '') {
    throw new Error(
      `Client baseRev is 0 but server has already been created for doc ${docId}. Client needs to load the existing document.`
    );
  }

  // Ensure all new changes' `created` field is in the past, that each `rev` is correct, and that `baseRev` is set
  changes.forEach(c => {
    c.created = Math.min(c.created, Date.now());
    c.baseRev = baseRev;
  });

  // 2. Check if we need to create a new version - if the last change was created more than a session ago
  const lastChange = currentChanges[currentChanges.length - 1];
  if (lastChange && lastChange.created < Date.now() - sessionTimeoutMillis) {
    await createVersion(store, docId, currentState, currentChanges);
  }

  // 3. Load committed changes *after* the client's baseRev for transformation and idempotency checks
  const committedChanges = await store.listChanges(docId, {
    startAfter: baseRev,
    withoutBatchId: batchId,
  });

  const committedIds = new Set(committedChanges.map(c => c.id));
  changes = changes.filter(c => !committedIds.has(c.id));

  // If all incoming changes were already committed, return the committed changes found
  if (changes.length === 0) {
    return [committedChanges, []];
  }

  // 4. Handle offline-session versioning:
  // - batchId present (multi-batch uploads)
  // - or the first change is older than the session timeout (single-batch offline)
  const isOfflineTimestamp = changes[0].created < Date.now() - sessionTimeoutMillis;
  if (isOfflineTimestamp || batchId) {
    changes = await handleOfflineSessionsAndBatches(store, sessionTimeoutMillis, docId, changes, baseRev, batchId);
  }

  // 5. Transform the *entire batch* of incoming (and potentially collapsed offline) changes
  //    against committed changes that happened *after* the client's baseRev.
  //    The state used for transformation should be the server state *at the client's baseRev*.
  const stateAtBaseRev = (await getStateAtRevision(store, docId, baseRev)).state;
  const transformedChanges = transformIncomingChanges(changes, stateAtBaseRev, committedChanges, currentRev);

  if (transformedChanges.length > 0) {
    await store.saveChanges(docId, transformedChanges);
  }

  // Return committed changes and newly transformed changes separately
  return [committedChanges, transformedChanges];
}
