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

/** Context for a committed change skipped during historical reconstruction. */
export interface SkippedChange {
  /** The committed change that failed strict apply and was skipped. */
  change: Change;
  /** The index of the skipped change within the batch passed in. */
  index: number;
  /** The underlying patch error thrown by strict apply. */
  error: unknown;
}

/**
 * Options for {@link applyChangesForReconstruction}.
 */
export interface ReconstructionOptions {
  /**
   * Telemetry hook — called once per skipped change with full context
   * (the change itself, its batch index, and the patch error), so affected
   * `(docId, changeId, op path)` tuples can be enumerated for a data-repair
   * sweep. Defaults to logging via `console.error`.
   */
  onSkippedChange?: (skipped: SkippedChange) => void;
}

/**
 * Replay options threaded through committed-history replay helpers
 * (`buildVersionState`, `getStateAtRevision`, …). Strict apply is the
 * default; setting `reconstruction` explicitly opts a replay into
 * {@link applyChangesForReconstruction}'s skip-and-continue semantics.
 * See that function's doc for when this is legitimate.
 */
export interface ReplayOptions {
  reconstruction?: ReconstructionOptions;
}

/**
 * HISTORICAL-RECONSTRUCTION variant of {@link applyChanges} — a change that
 * fails to apply is SKIPPED (with telemetry) instead of aborting the replay.
 *
 * This is only legitimate when replaying committed history whose effects are
 * already settled — the committed head is the truth and the replay merely
 * reconstructs it. Concretely:
 *
 * - building version state from the committed change log
 * - computing a history-scrubbing baseline (state before/within a version)
 *
 * A historically-invalid op (committed long ago under lenient semantics) must
 * not make that history permanently unreadable or block versioning forever;
 * skipping the whole failing change reproduces exactly what pre-strict clients
 * computed when the change was originally applied, so the reconstructed state
 * matches the settled head.
 *
 * NEVER use this for live commit application or for materializing a client's
 * current document (`applyChanges` is strict for those paths on purpose —
 * skipping there silently diverges the client from the rest of the system;
 * see {@link ApplyChangesError}).
 *
 * @param state - The initial state to apply changes to
 * @param changes - Array of committed changes to replay
 * @param options - Optional telemetry hook for skipped changes
 * @returns The state after all applicable changes have been applied
 */
export function applyChangesForReconstruction<T>(state: T, changes: Change[], options?: ReconstructionOptions): T {
  if (!changes.length) return state;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    try {
      state = applyPatch(state, change.ops, { strict: true });
    } catch (error) {
      if (options?.onSkippedChange) {
        options.onSkippedChange({ change, index: i, error });
      } else {
        console.error(
          `applyChangesForReconstruction: skipping invalid committed change ${change.id} (rev ${change.rev}, index ${i} of batch):`,
          error
        );
      }
    }
  }
  return state;
}
