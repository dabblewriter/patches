import { transformPatch } from '../../../json-patch/transformPatch.js';
import type { Change } from '../../../types.js';

/**
 * Transforms incoming changes against committed changes that happened *after* the client's baseRev.
 * Stateless: passes null to transformPatch (no server state needed for transformation).
 * Bad transformations produce empty ops and are filtered as noops.
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
  const committedOps = committedChanges.flatMap(c => c.ops);
  let rev = currentRev + 1;

  return changes
    .map(change => {
      // Transform the incoming change's ops against the ops committed since baseRev
      // Stateless: null state means transformPatch doesn't check against state
      const transformedOps = transformPatch(null, committedOps, change.ops);
      if (transformedOps.length === 0 && !forceCommit) {
        return null; // Change is obsolete after transformation
      }
      // Return a new change object with transformed ops and original metadata
      return { ...change, rev: rev++, ops: transformedOps };
    })
    .filter(Boolean) as Change[];
}
