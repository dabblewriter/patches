import type { PatchesSnapshot } from '../../../types.js';
import { applyChanges } from '../shared/applyChanges.js';

/**
 * Creates the in-memory state from a snapshot.
 * @param snapshot The snapshot to create a state from.
 * @returns The new state.
 */
export function createStateFromSnapshot<T = any>(snapshot: PatchesSnapshot<T>): T {
  return applyChanges(snapshot.state, snapshot.changes);
}
