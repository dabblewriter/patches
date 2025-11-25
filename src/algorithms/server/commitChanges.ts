import type { PatchesStoreBackend } from '../../server/types.js';
import type { Change, ChangeInput } from '../../types.js';
import { applyChanges } from '../shared/applyChanges.js';
import { createVersion } from './createVersion.js';
import { getSnapshotAtRevision } from './getSnapshotAtRevision.js';
import { getStateAtRevision } from './getStateAtRevision.js';
import { handleOfflineSessionsAndBatches } from './handleOfflineSessionsAndBatches.js';
import { transformIncomingChanges } from './transformIncomingChanges.js';

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
  changes: ChangeInput[],
  sessionTimeoutMillis: number
): Promise<[Change[], Change[]]> {
  if (changes.length === 0) {
    return [[], []];
  }

  const batchId = changes[0].batchId;

  // 1. Load server state details (needed before we can fill in missing baseRev)
  const { state: initialState, rev: initialRev, changes: currentChanges } = await getSnapshotAtRevision(store, docId);
  const currentState = applyChanges(initialState, currentChanges);
  const currentRev = currentChanges.at(-1)?.rev ?? initialRev;
  const baseRev = changes[0].baseRev ?? currentRev;

  // Ensure all new changes' `created` field is in the past and that `baseRev` and `rev` are set
  let rev = baseRev + 1;
  changes.forEach(c => {
    if (c.baseRev == null) c.baseRev = baseRev;
    else if (c.baseRev !== baseRev) {
      throw new Error(`Client changes must have consistent baseRev in all changes for doc ${docId}.`);
    }
    if (c.rev == null) c.rev = rev++;
    else rev = c.rev + 1;
    c.created = Math.min(c.created, Date.now());
  });

  // Basic validation
  if (baseRev > currentRev) {
    throw new Error(
      `Client baseRev (${baseRev}) is ahead of server revision (${currentRev}) for doc ${docId}. Client needs to reload the document.`
    );
  }

  // Prevent stale clients from wiping existing data with a root creation op (unless it's a batched continuation)
  const laterPartOfAnInitialBatch = batchId && changes[0].rev! > 1;
  if (baseRev === 0 && currentRev > 0 && !laterPartOfAnInitialBatch && changes[0].ops[0]?.path === '') {
    throw new Error(
      `Document ${docId} already exists at rev ${currentRev}, but client is attempting to create it. Client needs to load the existing document.`
    );
  }

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
  let incomingChanges = changes.filter(c => !committedIds.has(c.id)) as Change[];

  // If all incoming changes were already committed, return the committed changes found
  if (incomingChanges.length === 0) {
    return [committedChanges, []];
  }

  // 4. Handle offline-session versioning:
  // - batchId present (multi-batch uploads)
  // - or the first change is older than the session timeout (single-batch offline)
  const isOfflineTimestamp = incomingChanges[0].created < Date.now() - sessionTimeoutMillis;
  if (isOfflineTimestamp || batchId) {
    incomingChanges = await handleOfflineSessionsAndBatches(
      store,
      sessionTimeoutMillis,
      docId,
      incomingChanges,
      baseRev,
      batchId
    );
  }

  // 5. Transform the *entire batch* of incoming (and potentially collapsed offline) changes
  //    against committed changes that happened *after* the client's baseRev.
  //    The state used for transformation should be the server state *at the client's baseRev*.
  const stateAtBaseRev = (await getStateAtRevision(store, docId, baseRev)).state;
  const transformedChanges = transformIncomingChanges(incomingChanges, stateAtBaseRev, committedChanges, currentRev);

  if (transformedChanges.length > 0) {
    await store.saveChanges(docId, transformedChanges);
  }

  // Return committed changes and newly transformed changes separately
  return [committedChanges, transformedChanges];
}
