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

  /**
   * Replay `@txt` under the semantics the log was written with: a retain that overran the
   * document stays padded with spaces instead of being dropped (see
   * `ApplyJSONPatchOptions.legacyTextOverrunPadding`). Off by default.
   *
   * The distinction is NOT reconstruction-vs-live. It is whether the replayed output is a
   * **rendering of this log**, whose later entries were authored against that padding, or
   * **new state that starts a fresh log**:
   *
   * - Rendering settled history (scrubbing a version, streaming a past revision for
   *   display) → opt IN. Later entries in the same log depend on the padded text; drop it
   *   and an in-bounds delete authored against the padding lands on real prose instead.
   * - Seeding a new document from a past revision (branch/review-copy creation) → leave OFF.
   *   The new document's history begins at the snapshot, so nothing downstream depends on
   *   the padding — and padding it would bake invented characters into a branch as ordinary
   *   authored text, which can then merge back into the source (DAB-1064).
   *
   * When in doubt, leave it off: the cost is a historical view that differs from what the
   * author saw, not corruption of live content.
   */
  legacyTextOverrunPadding?: boolean;
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
 * not make that history permanently unreadable or block versioning forever.
 *
 * Skipping is CHANGE-granular: the whole failing change is dropped, not just the
 * offending op. For a single-op change that reproduces what pre-strict clients
 * computed; for a multi-op change it does not (lenient `applyPatch` skipped only
 * the failing op and kept its siblings), so the reconstructed state can differ
 * from what those clients saw. Change-granular is nonetheless the right unit,
 * because it is the one every consumer of this function shares — version state,
 * history baselines, and the client's own committed-poison floor all converge on
 * the same skip, which is what keeps server and client agreeing on a settled head.
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
      // Opt-in, not automatic: a replay that RENDERS this log needs the padding its later
      // entries were authored against, while a replay that SEEDS a new document must not
      // bake those invented characters in as authored text. See ReconstructionOptions.
      state = applyPatch(state, change.ops, {
        strict: true,
        legacyTextOverrunPadding: options?.legacyTextOverrunPadding === true,
      });
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

/**
 * Rebuild the committed-plus-predecessors frame one pending change was minted against.
 *
 * The queue is a sequential program, so the change at `index` was expressed on top of the
 * changes before it — but only the ones that were actually IN ITS FRAME. A neighbour minted a
 * frame behind (an older `baseRev` — the mint/rebase race `OTAlgorithm._withConsistentBaseRev`
 * defers at the flush seam) came from a lagging context this change never saw, so its ops are
 * not part of this change's frame and must not be applied here. That is the same rule
 * `computePendingEjection` already applies on the other side of the queue, where the inverse
 * walk skips successors on a different `baseRev`.
 *
 * Filtering is what keeps the frame reconstructable at all. Applying an older-frame row to the
 * committed state is not merely off-model — it can throw, because that row's ops were never
 * transformed across the committed span it missed (a `remove /items/3` that was valid at its
 * own baseRev is out of range now). Strict-applying it took the whole ejection down with it,
 * latching the quarantine path with nothing behind it to recover (DAB-1028).
 *
 * Note the bound on what this reconstructs: `committedState` is the CURRENT committed frame, so
 * when the named change is itself the straggler its own frame is unreachable — the committed
 * span it missed is already collapsed into local state, exactly as
 * `OTAlgorithm._rebasePendingPreservingFrameDebt` documents. This returns the best available
 * approximation there; callers still probe the change against it and treat a miss as "cannot
 * safely act", which is the documented latch.
 *
 * @param committedState Committed-only doc state.
 * @param pending        The full ordered pending queue.
 * @param index          Index of the change whose mint frame is wanted.
 * @returns The state that change was minted against.
 * @throws {ApplyChangesError} When an in-frame predecessor fails strict apply — a genuinely
 *   corrupt queue, not the frame-debt case above.
 */
export function reconstructMintFrame<T>(committedState: T, pending: Change[], index: number): T {
  const { baseRev } = pending[index];
  return applyChanges(
    committedState,
    pending.slice(0, index).filter(change => change.baseRev === baseRev)
  );
}
