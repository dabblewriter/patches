import { createChange } from '../../../data/change.js';
import { applyPatch } from '../../../json-patch/applyPatch.js';
import { invertPatch } from '../../../json-patch/invertPatch.js';
import type { Change } from '../../../types.js';
import { reconstructMintFrame } from './applyChanges.js';
import { rebaseChanges } from './rebaseChanges.js';

export interface PendingEjection {
  /** The change removed from the queue, unchanged, for quarantine. */
  poison: Change;
  /** The queue with the poison gone and every survivor renumbered off `committedRev`. */
  newPending: Change[];
  /**
   * True when every successor survived the inverse walk with its ops untouched — the
   * ejection removes the poison's content and nothing else. False when any successor was
   * dropped (it edited structure the ejection removes) or had its ops transformed, which
   * is the documented dependent-loss case above. A poison with no successors is trivially
   * lossless. Note the strict reading: a successor whose ops were merely position-shifted
   * by the inverse also reports false — content-preserving, but no longer byte-identical —
   * so gating callers err toward refusing.
   */
  lossless: boolean;
}

/**
 * Thrown by an ejection the caller constrained with `onlyIfLossless` when the computed
 * ejection would drop or alter successor changes (see {@link PendingEjection.lossless}).
 * Nothing is mutated; the queue and the poison are exactly as they were. Distinct from
 * both return shapes on purpose: `null` means nothing matched, a plain throw means the
 * eject was attempted and failed — this means the eject would have SUCCEEDED but at the
 * price of queued work the caller declared untouchable. Detect it with
 * {@link isLossyEjectionError} rather than `instanceof`, which breaks across an RPC or
 * worker boundary that rehydrates errors.
 */
export class LossyEjectionError extends Error {
  override readonly name = 'LossyEjectionError';
}

/** Duck-typed {@link LossyEjectionError} check that survives error rehydration (name, not instanceof). */
export function isLossyEjectionError(err: unknown): boolean {
  return err instanceof Error && err.name === 'LossyEjectionError';
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
 * inverse through the successors that share the ejected change's frame. Predecessors are
 * untouched. Every survivor is then renumbered contiguously off `committedRev`, preserving the
 * OT pending invariant that all pending share `baseRev === committedRev` with sequential revs
 * (see `OTAlgorithm._withConsistentBaseRev`). A row minted a frame behind — on either side of
 * the poison — keeps its true baseRev and sits out the walk; see the frame-debt notes below.
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
    // Nothing depends on the ejected change, so no rebase (and no invert) is needed. This is
    // the tail-of-queue case — which includes the single-change queue, where the poison
    // blocking the head IS the tail. (A mid-queue poison with work stacked behind it takes
    // the invert path below.)
    rebasedAfter = [];
  } else {
    // The state the poison applied to = committed state advanced through the predecessors that
    // were in its frame. invertPatch reads each op's prior value (e.g. the base Delta of a
    // `@txt` op) from this state, so it must be the exact frame the poison was minted against —
    // which is why a predecessor from a lagging context is filtered out rather than applied
    // (DAB-1028; the same rule the successor filter below applies). See reconstructMintFrame.
    const preState = reconstructMintFrame(committedState, pending, index);
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
    // Only successors minted in the poison's OWN frame were stacked on it. A successor from a
    // lagging context (a different baseRev) never had the poison in frame, so the inverse —
    // computed in the poison's frame — must not walk through it. Same rule the receive path
    // applies (see `OTAlgorithm._rebasePendingPreservingFrameDebt`); such a row rides through
    // untouched below.
    rebasedAfter = rebaseChanges(
      [inverseCarrier],
      after.filter(change => change.baseRev === poison.baseRev)
    );
  }

  // Renumber survivors contiguously off committedRev, re-seating the rebased successors into
  // the gap the poison left. rebaseChanges has already dropped any successor whose ops
  // transformed away to nothing.
  //
  // Every survivor keeps its OWN baseRev. On the invariant queue — all of it on committedRev —
  // that is the same result as stamping committedRev on each. A row minted a frame behind (the
  // same mint/rebase race `OTAlgorithm._withConsistentBaseRev` defers at the flush seam) keeps
  // its true baseRev instead, on both sides of the poison: relabeling it would commit its ops
  // in a frame they were never transformed into (DAB-951) — the very poison class this
  // function exists to remove. Warn on both halves — the strict probe above only vouches for
  // the poison's frame, not the queue's.
  //
  // Such a row is left with a rev/baseRev gap. Nothing reads that pair as a frame: rev only has
  // to stay strictly increasing across the queue (it does — every survivor takes the next one),
  // getPendingToSend slices the flush on baseRev and ranges the store read on rev
  // independently, and the server reassigns rev on commit.
  const staleBaseRevs = [...before, ...after].filter(change => change.baseRev !== committedRev);
  if (staleBaseRevs.length > 0) {
    console.warn(
      `[patches] Ejection of ${changeId} has ${staleBaseRevs.length} queue neighbour(s) on older frame(s) (baseRev ` +
        `${staleBaseRevs.map(c => c.baseRev).join(',')} vs committed ${committedRev}) — a mint/rebase race ` +
        `(likely two client instances over one store). Their true baseRev is preserved; they flush separately.`
    );
  }
  const rebasedById = new Map(rebasedAfter.map(change => [change.id, change]));
  let rev = committedRev;
  const newPending: Change[] = before.map(change => ({ ...change, rev: ++rev }));
  for (const change of after) {
    const rebased = rebasedById.get(change.id);
    if (rebased) newPending.push({ ...rebased, baseRev: change.baseRev, rev: ++rev });
    // Absent from the walk's output for one of two reasons: it was left out of the walk (a
    // different frame — ride it through untouched), or it was walked and transformed away to
    // nothing under the inverse (drop it, as before).
    else if (change.baseRev !== poison.baseRev) newPending.push({ ...change, rev: ++rev });
  }

  // Losslessness is judged against `after` only — predecessors are untouched by
  // construction. Ops-identity by JSON: renumbering doesn't touch ops, so any difference
  // here is the inverse walk's doing.
  const survivorsById = new Map(newPending.map(change => [change.id, change]));
  const lossless = after.every(change => {
    const survivor = survivorsById.get(change.id);
    return !!survivor && JSON.stringify(survivor.ops) === JSON.stringify(change.ops);
  });

  return { poison, newPending, lossless };
}
