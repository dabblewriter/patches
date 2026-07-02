import { transformPatch } from '../../../json-patch/transformPatch.js';
import type { Change } from '../../../types.js';

/**
 * Rebases local changes against server changes using operational transformation.
 *
 * Server changes are walked in commit order so every transform happens in the right coordinate space:
 * - A server change that echoes one of our own (matched by id) is removed from the pending set without transforming —
 *   the remaining pending changes were already written after it locally, so their coordinates already include it.
 * - A foreign server change is transformed against each pending change in sequence, advancing its ops over each
 *   pending change's ops so the next pending change (written after the previous one) sees the right coordinates.
 *
 * @param serverChanges - Array of changes received from the server, in commit order
 * @param localChanges - Array of local changes that need to be rebased, in creation order
 * @returns Array of rebased local changes with updated revision numbers
 */
export function rebaseChanges(serverChanges: Change[], localChanges: Change[]): Change[] {
  if (!serverChanges.length || !localChanges.length) {
    return localChanges;
  }

  let pending = localChanges;
  for (const serverChange of serverChanges) {
    const ownIndex = pending.findIndex(change => change.id === serverChange.id);
    if (ownIndex !== -1) {
      pending = pending.filter((_, i) => i !== ownIndex);
      continue;
    }
    let serverOps = serverChange.ops;
    const rebased: Change[] = [];
    for (const change of pending) {
      const ops = transformPatch(null, serverOps, change.ops);
      // Advance the server ops over this change's original ops for the next pending change in the sequence
      serverOps = transformPatch(null, change.ops, serverOps);
      if (!ops.length) continue; // Drop changes that became no-ops
      rebased.push({ ...change, ops });
    }
    pending = rebased;
  }

  // Renumber the surviving changes on top of the last server revision
  const baseRev = serverChanges[serverChanges.length - 1].rev;
  return pending.map((change, i) => ({ ...change, baseRev, rev: baseRev + i + 1 }));
}
