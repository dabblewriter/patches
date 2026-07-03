import { transformPatch } from '../../../json-patch/transformPatch.js';
import type { Change } from '../../../types.js';

/**
 * Transforms incoming changes against committed changes that happened *after* the client's baseRev.
 * Stateless: passes null to transformPatch (no server state needed for transformation).
 * Bad transformations produce empty ops and are filtered as noops.
 *
 * Both inputs are *sequential programs*: incoming change N is expressed in the frame produced by
 * incoming changes 1..N-1, and likewise for the committed log. Each committed change is therefore
 * walked through the incoming queue — transforming each incoming change against it and advancing
 * it through that change's (pre-transform) ops before meeting the next one (the standard OT
 * diamond). Transforming every incoming change against the same raw committed ops would land
 * changes 2..N at shifted offsets, permanently committing deletes/inserts of the wrong
 * characters. The client performs the mirror walk in `rebaseChanges`; the two must stay in
 * lockstep for client and server to converge.
 *
 * When `isOwnCommitted` is provided, `committedChanges` may include committed echoes of the
 * sender's own changes (a resend after a lost response, or earlier parts of the same batch).
 * These mirror rebaseChanges' own-echo handling exactly: an echo is never transformed against
 * the queue — the matching queue entry is dropped at the echo's position (its raw ops served as
 * the advance frame for every foreign change committed BEFORE the echo, exactly as the client's
 * pending head did) and only non-echo survivors are committed.
 *
 * @param changes The incoming changes (may include already-committed resent changes when
 *   `isOwnCommitted` is provided — they act as advance-only frame entries).
 * @param committedChanges The committed changes that happened *after* the client's baseRev.
 * @param currentRev The current/latest revision number (these changes will have their `rev` set > `currentRev`).
 * @param forceCommit If true, skip filtering of no-op changes (useful for migrations).
 * @param isOwnCommitted Identifies committed changes that are the sender's own echoes.
 * @returns The transformed changes.
 */
export function transformIncomingChanges(
  changes: Change[],
  committedChanges: Change[],
  currentRev: number,
  forceCommit = false,
  isOwnCommitted?: (change: Change) => boolean
): Change[] {
  const queue = changes.map(change => ({ change, ops: change.ops }));

  for (const committed of committedChanges) {
    if (isOwnCommitted?.(committed)) {
      // One of the sender's own changes come back committed: drop it from the queue
      // untransformed — the remaining entries' frames already include it (they were minted on
      // top of it). Mirrors rebaseChanges step 1.
      const index = queue.findIndex(entry => entry.change.id === committed.id);
      if (index !== -1) queue.splice(index, 1);
      continue;
    }
    let committedOps = committed.ops;
    for (const entry of queue) {
      const transformed = transformPatch(null, committedOps, entry.ops);
      // Advancing the committed ops swaps the argument order relative to real time — the
      // committed change actually precedes the queue — so `otherOpsFirst` makes conflicting
      // intents resolve the same way in both halves of the diamond (see transformPatch).
      committedOps = transformPatch(null, entry.ops, committedOps, undefined, true);
      entry.ops = transformed;
    }
  }

  let rev = currentRev + 1;
  const result: Change[] = [];
  for (const entry of queue) {
    if (entry.ops.length === 0 && !forceCommit) continue; // Change is obsolete after transformation
    result.push({ ...entry.change, rev: rev++, ops: entry.ops });
  }
  return result;
}
