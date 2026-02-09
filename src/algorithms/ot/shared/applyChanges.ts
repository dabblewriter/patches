import { applyPatch } from '../../../json-patch/applyPatch.js';
import type { Change } from '../../../types.js';

/**
 * Applies a sequence of changes to a state object.
 * Each change is applied in sequence using the applyPatch function.
 *
 * @param state - The initial state to apply changes to
 * @param changes - Array of changes to apply
 * @returns The state after all changes have been applied
 */
export function applyChanges<T>(state: T, changes: Change[]): T {
  if (!changes.length) return state;
  for (const change of changes) {
    state = applyPatch(state, change.ops, { strict: true });
  }
  return state;
}
