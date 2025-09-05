import type { JSONPatch } from '../..';
import { createChange } from '../../data/change.js';
import { createJSONPatch } from '../../json-patch/createJSONPatch.js';
import type { Change, DeepRequired, PatchesSnapshot } from '../../types.js';
import { breakChange } from './breakChange.js';
import { createStateFromSnapshot } from './createStateFromSnapshot.js';

export function makeChange<T = any>(
  snapshot: PatchesSnapshot<T>,
  mutator: (draft: DeepRequired<T>, patch: JSONPatch) => void,
  changeMetadata?: Record<string, any>,
  maxPayloadBytes?: number
): Change[] {
  const pendingChanges = snapshot.changes;
  const pendingRev = pendingChanges[pendingChanges.length - 1]?.rev ?? snapshot.rev;
  const state = createStateFromSnapshot(snapshot); // Current state including pending
  const patch = createJSONPatch(state, mutator);
  if (patch.ops.length === 0) {
    return [];
  }

  // Optimistic rev for local sorting, based on the latest known rev (committed or pending)
  const rev = pendingRev + 1;

  // Create the initial change. BaseRev is always the last *committed* revision from the snapshot.
  let newChangesArray = [createChange(snapshot.rev, rev, patch.ops, changeMetadata)];

  // Optimistically apply the patch to the current state (which includes pending changes)
  // This state is temporary for validation/splitting and not stored back directly in PatchesDoc from here.
  try {
    // Note: The 'state' variable here is the one derived from createStateFromSnapshot (committed + pending).
    // Applying the new patch to it is for the purpose of creating the correct Change object(s).
    // PatchesDoc.change will apply these returned changes to its own _state later.
    patch.apply(state); // This line primarily serves to ensure the patch is valid against the current view.
  } catch (error) {
    console.error('Failed to apply change to state during makeChange:', error);
    throw new Error(`Failed to apply change to state during makeChange: ${error}`);
  }

  if (maxPayloadBytes) {
    // If the single change (or its parts) exceed maxPayloadBytes, break it down.
    // breakChange will handle creating multiple Change objects if necessary,
    // maintaining the original baseRev but incrementing revs for the pieces.
    newChangesArray = breakChange(newChangesArray[0], maxPayloadBytes);
  }
  // PatchesDoc.change will take this returned array and push its contents onto its internal snapshot.
  return newChangesArray;
}
