import { createChange } from '../../../data/change.js';
import { applyPatch } from '../../../json-patch/applyPatch.js';
import { invertPatch } from '../../../json-patch/invertPatch.js';
import type { Change } from '../../../types.js';
import { applyChanges } from './applyChanges.js';
import { rebaseChanges } from './rebaseChanges.js';

export interface PendingEjection {
  /** The change removed from the queue, unchanged, for quarantine. */
  poison: Change;
  /** The queue with the poison gone and every survivor renumbered off `committedRev`. */
  newPending: Change[];
}

/**
 * Remove one change from a sequential OT pending program, rebasing its successors as
 * though it had never been minted.
 *
 * The pending queue is a *sequential program*: each change's ops are expressed in the
 * frame the changes before it produce (the same model {@link rebaseChanges} documents).
 * Dropping a change from the middle therefore can't be a plain array splice — every
 * successor was built on top of the ejected change and must be transformed back into the
 * frame that skips it.
 *
 * The transform is exactly the diamond walk `rebaseChanges` already runs for an incoming
 * server change: the ejected change genuinely *preceded* its successors, so its inverse is
 * the "already-happened" side those successors' position ties yield to. We invert the
 * ejected change against the state it applied to (committed + predecessors) and walk that
 * inverse through the successors. Predecessors are untouched. Every survivor is then
 * renumbered contiguously off `committedRev`, preserving the OT pending invariant that all
 * pending share `baseRev === committedRev` with sequential revs (see
 * `OTAlgorithm._withConsistentBaseRev`).
 *
 * The server accepts `newPending` as a valid poison-free queue and both sides converge on it
 * deterministically. Exact tie-resolution follows the same one-sided transform as a normal
 * rebase (see the tie-break note in {@link rebaseChanges}), so at concurrent same-offset ties
 * this is *a* queue as if the change were never minted, not provably the unique one — the same
 * caveat every OT rebase carries, not a convergence gap.
 *
 * A successor whose edits were scoped to structure the ejected change created (e.g. it added
 * `/a`, the successor set `/a/b`) transforms away to nothing under the inverse and is dropped —
 * its content is lost, since it edited something the ejection removes. Only the ejected change
 * itself is preserved (in quarantine); its dependents are not.
 *
 * @param committedState Committed-only doc state — the frame every pending `baseRev` points at.
 * @param committedRev   The committed revision the queue sits on.
 * @param pending        The full ordered pending queue.
 * @param changeId       Id of the change to eject.
 * @returns The ejected change plus the rebased queue, or null when `changeId` isn't pending.
 * @throws If the ejected change can't be inverted — including when it no longer applies
 *   cleanly to its own frame (a patch/state mismatch), where an inverse would be computed
 *   from values the change never actually saw. The caller must treat a throw as "cannot
 *   safely eject" and leave the queue untouched — this function itself mutates nothing, so
 *   a throw leaves no partial state. Only a poison with successors needs the invert; a
 *   tail-of-queue poison ejects without it.
 */
export function computePendingEjection(
  committedState: unknown,
  committedRev: number,
  pending: Change[],
  changeId: string
): PendingEjection | null {
  const index = pending.findIndex(change => change.id === changeId);
  if (index === -1) return null;

  const before = pending.slice(0, index);
  const poison = pending[index];
  const after = pending.slice(index + 1);

  let rebasedAfter: Change[];
  if (after.length === 0) {
    // Nothing depends on the ejected change, so no rebase (and no invert) is needed — the
    // common case, since the poison is usually the oldest change blocking the queue head.
    rebasedAfter = [];
  } else {
    // The state the poison applied to = committed state advanced through its predecessors.
    // invertPatch reads each op's prior value (e.g. the base Delta of a `@txt` op) from this
    // state, so it must be the exact frame the poison was minted against.
    const preState = applyChanges(committedState, before);
    // invertPatch's contract requires ops that apply to the state it reads from. On a
    // mismatched poison it doesn't reliably throw: a one-level miss (e.g. `replace /arr/5`
    // over a 3-element array) reads `undefined` silently and fabricates an inverse for an
    // effect that never happened, which the rebase below would then walk through every
    // survivor. Probe first so a mismatch always lands on the documented throw-and-latch
    // path instead of persisting a queue derived from a phantom inverse.
    try {
      applyPatch(preState, poison.ops, { strict: true, silent: true });
    } catch (cause) {
      throw new Error(
        `Cannot eject change ${changeId}: it does not apply cleanly to its own frame, so its inverse cannot be trusted`,
        { cause }
      );
    }
    const invertedOps = invertPatch(preState, poison.ops);
    // A synthetic one-change carrier for the inverse. Its rev/baseRev are irrelevant — the
    // survivors are renumbered below — only the diamond walk matters. A fresh id keeps it
    // out of the successors' id set so rebaseChanges walks it rather than dropping it.
    const inverseCarrier = createChange(poison.baseRev, poison.rev, invertedOps, {});
    rebasedAfter = rebaseChanges([inverseCarrier], after);
  }

  // Renumber survivors contiguously off committedRev. Predecessors already sit on
  // committedRev with these very revs, so this is a no-op for them and only re-seats the
  // rebased successors into the gap the poison left. rebaseChanges has already dropped any
  // successor whose ops transformed away to nothing.
  let rev = committedRev;
  const newPending = [...before, ...rebasedAfter].map(change => ({
    ...change,
    baseRev: committedRev,
    rev: ++rev,
  }));

  return { poison, newPending };
}
