import type { Change } from '../../../types.js';
import { applyChanges } from '../shared/applyChanges.js';

/**
 * Committed state advanced through the pending queue, for the OPTIMISTIC VIEW.
 *
 * The queue is the wire contract, and it can legitimately hold a row left on an older frame: a
 * mint that landed while its doc lagged the store keeps its TRUE baseRev so the server — which
 * holds every committed change past it — can run the transform the client no longer can
 * (DAB-951; see `OTAlgorithm._withConsistentBaseRev`). Such a row's ops address a frame the
 * committed state has moved past, so they may not apply against it. That is debt the flush seam
 * is deliberately carrying, not corruption: it must not throw, and the row must not be dropped
 * from the queue — dropping it would discard an unsent edit locally, the very loss the honest
 * baseRev exists to prevent. It simply has no place in the view until its commit echoes back.
 *
 * Strict apply runs first, so a frame-consistent queue — and a deferred row that happens to
 * still apply — behaves exactly as before. Only when that throws are the frame-debt rows left
 * out. A failure that survives their removal is a genuine invariant break and rethrows.
 */
export function applyPendingForView<T>(committedState: T, committedRev: number, pending: Change[]): T {
  try {
    return applyChanges(committedState, pending);
  } catch (err) {
    const inFrame = pending.filter(change => change.baseRev >= committedRev);
    if (inFrame.length === pending.length) throw err;
    return applyChanges(committedState, inFrame);
  }
}
