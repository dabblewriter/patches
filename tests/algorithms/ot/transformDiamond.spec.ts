import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../../src/json-patch/applyPatch';
import { rebaseChanges } from '../../../src/algorithms/ot/shared/rebaseChanges';
import { transformIncomingChanges } from '../../../src/algorithms/ot/server/transformIncomingChanges';
import { createChange } from '../../../src/data/change';
import type { Change, ChangeInput } from '../../../src/types';

/**
 * DAB-601 — the two halves of the rebase diamond must agree, and everything the
 * server commits must strictly apply against the committed frame it lands in.
 *
 * These pins run the ticket's verified repros through the REAL machinery, both
 * directions, and assert three things per scenario:
 *   1. every committed change strict-applies in sequence (no replay wedge),
 *   2. the converged state is the intended one,
 *   3. the client's rebase produces the identical committed ops (diamond lockstep)
 *      and its materialized state matches the converged state.
 *
 * The failure mode being pinned: the `otherOpsFirst` advance rules resolve
 * "later writer wins" for a queue MOVE even when the mirror half killed that
 * move (same-source committed move, or a committed hard-set clobbering the
 * move's source or an ancestor of it) — the two halves then disagree and later
 * queue entries commit against a frame that never existed.
 */

/** Strictly apply each change in sequence, throwing where a real replay would wedge. */
function replayStrict(base: any, ...changeSets: Change[][]): any {
  let state = base;
  for (const changes of changeSets) {
    for (const change of changes) {
      state = applyPatch(state, change.ops, { strict: true });
    }
  }
  return state;
}

function diamond(base: any, committedOps: ChangeInput['ops'], queueOps: ChangeInput['ops'][]) {
  const committed = [{ ...createChange(0, 1, committedOps), id: 'A1' }];
  const queue = queueOps.map((ops, i) => ({ ...createChange(0, 0, ops), id: `B${i + 1}` }));

  const serverCommitted = transformIncomingChanges(queue, committed, 1);
  const clientRebased = rebaseChanges(committed, queue);

  return { committed, serverCommitted, clientRebased };
}

describe('DAB-601 — advance/mirror diamond agreement for queue moves', () => {
  it('same-source moves: committed array-destination move survives the advance (repro 1)', () => {
    const base = { s: 9, arr: [1, 2, 3] };
    const { committed, serverCommitted, clientRebased } = diamond(
      base,
      [
        { op: 'move', from: '/s', path: '/arr/0' },
        { op: 'replace', path: '/arr/0', value: 88 },
      ],
      [
        [
          { op: 'move', from: '/s', path: '/q' },
          { op: 'replace', path: '/arr/1', value: { k: 1 } },
        ],
        [{ op: 'replace', path: '/arr/1/k', value: 2 }],
      ]
    );

    // The wedge: change 2 committed unshifted (/arr/1/k) throws on strict replay
    // ("Cannot create property 'k' on number '1'").
    const state = replayStrict(base, committed, serverCommitted);
    expect(state).toEqual({ arr: [88, 1, { k: 2 }, 3] });

    // Diamond lockstep: the client commits what the server commits, and its
    // materialized state is the converged state.
    expect(clientRebased.map(c => c.ops)).toEqual(serverCommitted.map(c => c.ops));
    expect(replayStrict(base, committed, clientRebased)).toEqual({ arr: [88, 1, { k: 2 }, 3] });
  });

  it('a committed move-in outlives a queue move the mirror already killed (repro 2)', () => {
    const base = { n: { x: { v: 1 } }, tags: [18, 19], d: {} };
    const { committed, serverCommitted, clientRebased } = diamond(
      base,
      [
        { op: 'replace', path: '/n', value: { y: 1 } },
        { op: 'move', from: '/tags', path: '/d/b' },
      ],
      [[{ op: 'move', from: '/n/x', path: '/d/b' }], [{ op: 'replace', path: '/d/b/v', value: 7 }]]
    );

    // The wedge: change 2 committed as-is edits /d/b/v against a frame where
    // /d/b is [18, 19].
    const state = replayStrict(base, committed, serverCommitted);
    expect(state).toEqual({ n: { y: 1 }, d: { b: [18, 19] } });

    expect(clientRebased.map(c => c.ops)).toEqual(serverCommitted.map(c => c.ops));
    expect(replayStrict(base, committed, clientRebased)).toEqual({ n: { y: 1 }, d: { b: [18, 19] } });
  });

  it('queue edits of a dropped move destination die with it instead of resurrecting the path (repro 3)', () => {
    // Object-path variant of repro 1: the committed tail clobbers the followed
    // value, so the mirror drops the queue move entirely. The queue's later
    // edit of its own (dead) destination must die with it — not commit against
    // a path that never exists in the committed frame (silent orphaned data).
    const base = { s: { w: 1 } };
    const { committed, serverCommitted, clientRebased } = diamond(
      base,
      [
        { op: 'move', from: '/s', path: '/t' },
        { op: 'replace', path: '/t', value: { w: 88 } },
      ],
      [[{ op: 'move', from: '/s', path: '/q' }], [{ op: 'replace', path: '/q/w', value: 5 }]]
    );

    const state = replayStrict(base, committed, serverCommitted);
    expect(state).toEqual({ t: { w: 88 } });
    expect(state.q).toBeUndefined();

    expect(clientRebased.map(c => c.ops)).toEqual(serverCommitted.map(c => c.ops));
    expect(replayStrict(base, committed, clientRebased)).toEqual({ t: { w: 88 } });
  });

  it('a same-source queue move that survives the mirror still wins as the later writer', () => {
    // No committed tail kills the followed value, so the mirror lets the queue
    // move win the final home — the pre-DAB-601 advance behavior must be
    // preserved for this case: committed move dropped, its tail (none here)
    // remapped, and the queue edit lands at the queue destination.
    const base = { s: { w: 1 } };
    const { committed, serverCommitted, clientRebased } = diamond(
      base,
      [{ op: 'move', from: '/s', path: '/t' }],
      [[{ op: 'move', from: '/s', path: '/q' }], [{ op: 'replace', path: '/q/w', value: 5 }]]
    );

    const state = replayStrict(base, committed, serverCommitted);
    expect(state).toEqual({ q: { w: 5 } });
    expect(state.t).toBeUndefined();

    expect(clientRebased.map(c => c.ops)).toEqual(serverCommitted.map(c => c.ops));
    expect(replayStrict(base, committed, clientRebased)).toEqual({ q: { w: 5 } });
  });
});
