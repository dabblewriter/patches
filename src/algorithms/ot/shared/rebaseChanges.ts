import { JSONPatch } from '../../../json-patch/JSONPatch.js';
import type { Change } from '../../../types.js';

/**
 * Rebases local changes against server changes using operational transformation.
 * This function handles the transformation of local changes to be compatible with server changes
 * that have been applied in the meantime.
 *
 * The process:
 * 1. Filters out local changes that are already in server changes
 * 2. Creates a patch from server changes that need to be transformed against
 * 3. Transforms each remaining local change against the server patch
 * 4. Updates revision numbers for the transformed changes
 *
 * @param serverChanges - Array of changes received from the server
 * @param localChanges - Array of local changes that need to be rebased
 * @returns Array of rebased local changes with updated revision numbers
 */
export function rebaseChanges(serverChanges: Change[], localChanges: Change[]): Change[] {
  if (!serverChanges.length || !localChanges.length) {
    return localChanges;
  }

  const lastChange = serverChanges[serverChanges.length - 1];
  const receivedIds = new Set(serverChanges.map(change => change.id));
  const transformAgainstIds = new Set(receivedIds);

  // Filter out local changes that are already in server changes
  const filteredLocalChanges: Change[] = [];
  for (const change of localChanges) {
    if (receivedIds.has(change.id)) {
      transformAgainstIds.delete(change.id);
    } else {
      filteredLocalChanges.push(change);
    }
  }

  // Create a patch from server changes that need to be transformed against
  const transformPatch = new JSONPatch(
    serverChanges
      .filter(change => transformAgainstIds.has(change.id))
      .map(change => change.ops)
      .flat()
  );

  // Rebase local changes against server changes
  const baseRev = lastChange.rev;
  let rev = lastChange.rev;
  return filteredLocalChanges
    .map(change => {
      rev++;
      const ops = transformPatch.transform(change.ops).ops;
      if (!ops.length) return null;
      return { ...change, baseRev, rev, ops };
    })
    .filter(Boolean) as Change[];
}
