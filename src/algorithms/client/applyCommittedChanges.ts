import type { Change, PatchesSnapshot } from '../../types.js';
import { applyChanges } from '../shared/applyChanges.js';
import { rebaseChanges } from '../shared/rebaseChanges.js';

/**
 * Applies incoming changes from the server that were *not* initiated by this client.
 * @param snapshot The current state of the document (the state without pending changes applied) and the pending changes.
 * @param committedChangesFromServer An array of sequential changes from the server.
 * @returns The new committed state, the new committed revision, and the new/rebased pending changes.
 */
export function applyCommittedChanges(
  snapshot: PatchesSnapshot,
  committedChangesFromServer: Change[]
): PatchesSnapshot {
  let { state, rev, changes } = snapshot;

  // Filter out any server changes that are already reflected in the current snapshot's revision.
  // Server changes should always have a rev.
  const newServerChanges = committedChangesFromServer.filter(change => change.rev > rev);

  if (newServerChanges.length === 0) {
    // No new changes to apply, return the snapshot as is.
    return { state, rev, changes };
  }

  const firstChange = newServerChanges[0];
  const lastChange = newServerChanges[newServerChanges.length - 1];

  // Ensure the new server changes are sequential to the current snapshot's revision.
  if (firstChange.rev !== rev + 1) {
    throw new Error(
      `Missing changes from the server. Expected rev ${rev + 1}, got ${firstChange.rev}. Request changes since ${rev}.`
    );
  }

  // 1. Apply to committed state
  try {
    state = applyChanges(state, newServerChanges);
  } catch (error) {
    console.error('Failed to apply server changes to committed state:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Critical sync error applying server changes: ${errorMessage}`);
  }

  // 2. Update committed revision to the latest one from the applied server changes.
  rev = lastChange.rev;

  // 3. Rebase pending local changes against the newly applied server changes.
  if (changes && changes.length > 0) {
    changes = rebaseChanges(newServerChanges, changes);
  }

  return { state, rev, changes };
}
