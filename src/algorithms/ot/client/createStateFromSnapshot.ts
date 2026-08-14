import type { PatchesSnapshot } from '../../../types.js';
import { applyPendingForView } from './applyPendingForView.js';

/**
 * Creates the in-memory state from a snapshot.
 * @param snapshot The snapshot to create a state from.
 * @returns The new state.
 */
export function createStateFromSnapshot<T = any>(snapshot: PatchesSnapshot<T>): T {
  return applyPendingForView(snapshot.state, snapshot.rev, snapshot.changes);
}
