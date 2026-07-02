import { transformPatch } from '../../../json-patch/transformPatch.js';
import type { Change } from '../../../types.js';

/**
 * Rebases local changes against server changes using operational transformation.
 * This function handles the transformation of local changes to be compatible with server changes
 * that have been applied in the meantime.
 *
 * Both inputs are *sequential programs*: each change's ops are expressed in the frame produced
 * by the changes before it. Transforming every local change against the same raw server ops
 * would mix frames — local change N is based on local changes 1..N-1, so the server ops must
 * be advanced through each local change as the queue is walked (the standard OT diamond), or
 * every local change after the first lands at shifted offsets and deletes/inserts the wrong
 * characters. The server performs the mirror walk in `transformIncomingChanges`; the two must
 * stay in lockstep for client and server to converge.
 *
 * The process, for each server change in order:
 * 1. A server change that is one of ours come back committed is dropped from the local queue
 *    untransformed — the remaining local changes' frames already include it.
 * 2. A foreign server change is walked through the local queue: each local change is
 *    transformed against it, and it is advanced through that local change's (pre-transform)
 *    ops before meeting the next one.
 * 3. Surviving local changes get sequential revs after the last server change; changes whose
 *    ops transformed away entirely are dropped without consuming a rev.
 *
 * Known limitation: advancing server ops through local ops reuses the same one-sided transform
 * (the side transformed against wins position ties), so two sides inserting at the exact same
 * offset concurrently can interleave differently than a fully tie-symmetric transform would.
 * Client and server share the same walk, so they still converge with each other.
 *
 * @param serverChanges - Array of changes received from the server
 * @param localChanges - Array of local changes that need to be rebased
 * @returns Array of rebased local changes with updated revision numbers
 */
export function rebaseChanges(serverChanges: Change[], localChanges: Change[]): Change[] {
  if (!serverChanges.length || !localChanges.length) {
    return localChanges;
  }

  const localIds = new Set(localChanges.map(change => change.id));
  const queue = localChanges.map(change => ({ change, ops: change.ops }));

  for (const serverChange of serverChanges) {
    if (localIds.has(serverChange.id)) {
      const index = queue.findIndex(entry => entry.change.id === serverChange.id);
      if (index !== -1) queue.splice(index, 1);
      continue;
    }

    let foreignOps = serverChange.ops;
    for (const entry of queue) {
      const transformed = transformPatch(null, foreignOps, entry.ops);
      foreignOps = transformPatch(null, entry.ops, foreignOps);
      entry.ops = transformed;
    }
  }

  const baseRev = serverChanges[serverChanges.length - 1].rev;
  let rev = baseRev;
  const result: Change[] = [];
  for (const entry of queue) {
    if (!entry.ops.length) continue; // Drop empty changes without incrementing rev
    rev++;
    result.push({ ...entry.change, baseRev, rev, ops: entry.ops });
  }

  return result;
}
