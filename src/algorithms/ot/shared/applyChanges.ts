import { applyPatch } from '../../../json-patch/applyPatch.js';
import type { Change } from '../../../types.js';

/**
 * Thrown when a change in a batch fails to apply to the state (a strict patch
 * failure). Carries the failing change's id, rev, and index within the batch,
 * with the underlying patch error as `cause`.
 *
 * Consumers (e.g. `PatchesSync`) detect this via `instanceof` to trigger
 * recovery (reload the authoritative snapshot from the server) rather than
 * matching on message text.
 */
export class ApplyChangesError extends Error {
  constructor(
    /** The id of the change that failed to apply. */
    readonly changeId: string,
    /** The revision of the change that failed to apply. */
    readonly rev: number,
    /** The index of the failing change within the batch passed to `applyChanges`. */
    readonly index: number,
    /** The underlying patch error. */
    cause: unknown
  ) {
    super(
      `Failed to apply change ${changeId} (rev ${rev}, index ${index} of batch): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = 'ApplyChangesError';
  }
}

/**
 * Applies a sequence of changes to a state object.
 * Each change is applied in sequence using the applyPatch function.
 *
 * A change that fails to apply throws — it must NOT be skipped. Skipping would
 * silently drop the change on this client while other clients apply it,
 * diverging the document with zero signal (every later state is computed from
 * a base the rest of the system doesn't have). Callers that can recover do so
 * explicitly (e.g. `PatchesSync` reloads the authoritative snapshot); callers
 * that can't should surface the error rather than proceed on corrupt state.
 *
 * @param state - The initial state to apply changes to
 * @param changes - Array of changes to apply
 * @returns The state after all changes have been applied
 * @throws {ApplyChangesError} When a change fails to apply, identifying the
 *   failing change (id, rev, batch index) and wrapping the patch error as `cause`.
 */
export function applyChanges<T>(state: T, changes: Change[]): T {
  if (!changes.length) return state;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    try {
      state = applyPatch(state, change.ops, { strict: true });
    } catch (e) {
      throw new ApplyChangesError(change.id, change.rev, i, e);
    }
  }
  return state;
}
