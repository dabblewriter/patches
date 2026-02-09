import { applyPatch } from '../../../json-patch/applyPatch.js';
import { transformPatch } from '../../../json-patch/transformPatch.js';
import type { Change } from '../../../types.js';

/**
 * Transforms incoming changes against committed changes that happened *after* the client's baseRev.
 * The state used for transformation should be the server state *at the client's baseRev*.
 * @param changes The incoming changes.
 * @param stateAtBaseRev The server state *at the client's baseRev*.
 * @param committedChanges The committed changes that happened *after* the client's baseRev.
 * @param currentRev The current/latest revision number (these changes will have their `rev` set > `currentRev`).
 * @param forceCommit If true, skip filtering of no-op changes (useful for migrations).
 * @returns The transformed changes.
 */
export function transformIncomingChanges(
  changes: Change[],
  stateAtBaseRev: any,
  committedChanges: Change[],
  currentRev: number,
  forceCommit = false
): Change[] {
  const committedOps = committedChanges.flatMap(c => c.ops);
  let state = stateAtBaseRev;
  let rev = currentRev + 1;

  // Apply transformation based on state at baseRev
  return changes
    .map(change => {
      // Transform the incoming change's ops against the ops committed since baseRev
      const transformedOps = transformPatch(stateAtBaseRev, committedOps, change.ops);
      if (transformedOps.length === 0 && !forceCommit) {
        return null; // Change is obsolete after transformation
      }
      if (transformedOps.length > 0) {
        try {
          const previous = state;
          state = applyPatch(state, transformedOps, { strict: true });
          if (previous === state && !forceCommit) {
            // Changes were no-ops, we can skip this change
            return null;
          }
        } catch (error) {
          console.error(`Error applying change ${change.id} to state:`, error);
          return null;
        }
      }
      // Return a new change object with transformed ops and original metadata
      return { ...change, rev: rev++, ops: transformedOps };
    })
    .filter(Boolean) as Change[];
}
