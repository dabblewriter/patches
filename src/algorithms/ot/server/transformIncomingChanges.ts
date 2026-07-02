import { transformPatch } from '../../../json-patch/transformPatch.js';
import type { Change } from '../../../types.js';

/**
 * Transforms incoming changes against committed changes that happened *after* the client's baseRev.
 * Stateless: passes null to transformPatch (no server state needed for transformation).
 * Bad transformations produce empty ops and are filtered as noops.
 *
 * Both inputs are *sequential programs*: incoming change N is expressed in the frame produced by
 * incoming changes 1..N-1, and likewise for the committed log. Each committed change is therefore
 * walked through the incoming queue — transforming each incoming change against it and advancing
 * it through that change's (pre-transform) ops before meeting the next one (the standard OT
 * diamond). Transforming every incoming change against the same raw committed ops would land
 * changes 2..N at shifted offsets, permanently committing deletes/inserts of the wrong
 * characters. The client performs the mirror walk in `rebaseChanges`; the two must stay in
 * lockstep for client and server to converge.
 *
 * @param changes The incoming changes.
 * @param committedChanges The committed changes that happened *after* the client's baseRev.
 * @param currentRev The current/latest revision number (these changes will have their `rev` set > `currentRev`).
 * @param forceCommit If true, skip filtering of no-op changes (useful for migrations).
 * @returns The transformed changes.
 */
export function transformIncomingChanges(
  changes: Change[],
  committedChanges: Change[],
  currentRev: number,
  forceCommit = false
): Change[] {
  const queue = changes.map(change => ({ change, ops: change.ops }));

  for (const committed of committedChanges) {
    let committedOps = committed.ops;
    for (const entry of queue) {
      const transformed = transformPatch(null, committedOps, entry.ops);
      committedOps = transformPatch(null, entry.ops, committedOps);
      entry.ops = transformed;
    }
  }

  let rev = currentRev + 1;
  const result: Change[] = [];
  for (const entry of queue) {
    if (entry.ops.length === 0 && !forceCommit) continue; // Change is obsolete after transformation
    result.push({ ...entry.change, rev: rev++, ops: entry.ops });
  }
  return result;
}
