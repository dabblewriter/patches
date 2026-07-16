import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../../../src/algorithms/ot/shared/applyChanges';
import { computePendingEjection } from '../../../../src/algorithms/ot/shared/ejectPendingChange';
import { commitChanges } from '../../../../src/algorithms/ot/server/commitChanges';
import type { Change } from '../../../../src/types';
import { OTFuzzBackend } from '../../../fuzz/otFuzzBackend';
import { PRNG } from '../../../fuzz/prng';

// Runs against the real transform/invert machinery (no mocks): a mocked transform would
// hide exactly the frame-shift bugs ejection has to get right.

const COMMITTED_REV = 5;

const pending = (id: string, rev: number, ops: any[]): Change => ({
  id,
  rev,
  baseRev: COMMITTED_REV,
  ops,
  createdAt: rev,
  committedAt: 0,
});

const txt = (value: any[]) => ({ op: '@txt', path: '/text', value });
const textOf = (state: any): string =>
  new Delta(state.text).ops.map((op: any) => (typeof op.insert === 'string' ? op.insert : '')).join('');

describe('computePendingEjection', () => {
  it('returns null when the id is not in the pending queue', () => {
    const queue = [pending('a', 6, [{ op: 'replace', path: '/x', value: 1 }])];
    expect(computePendingEjection({ x: 0 }, COMMITTED_REV, queue, 'nope')).toBeNull();
  });

  it('empties the queue when the ejected change is the only pending change', () => {
    const queue = [pending('only', 6, [{ op: 'replace', path: '/x', value: 1 }])];
    const result = computePendingEjection({ x: 0 }, COMMITTED_REV, queue, 'only');
    expect(result).not.toBeNull();
    expect(result!.poison.id).toBe('only');
    expect(result!.newPending).toEqual([]);
  });

  it('leaves disjoint successors byte-identical and renumbers off committedRev', () => {
    // The Doug shape: the poison rewrites one subtree, the survivors touch a sibling subtree.
    const committed = { a: 1, text: [{ insert: 'hello\n' }] };
    const queue = [
      pending('poison', 6, [{ op: 'replace', path: '/a', value: 2 }]),
      pending('c1', 7, [{ op: 'add', path: '/comments/x', value: { body: 'hi' } }]),
      pending('c2', 8, [txt([{ insert: 'Z' }])]),
    ];
    const result = computePendingEjection(committed, COMMITTED_REV, queue, 'poison')!;

    expect(result.newPending.map(c => c.id)).toEqual(['c1', 'c2']);
    // Disjoint from the poison → ops untouched.
    expect(result.newPending[0].ops).toEqual(queue[1].ops);
    expect(result.newPending[1].ops).toEqual(queue[2].ops);
    // Renumbered contiguously off committedRev, all sharing baseRev === committedRev.
    expect(result.newPending.map(c => c.rev)).toEqual([6, 7]);
    expect(result.newPending.every(c => c.baseRev === COMMITTED_REV)).toBe(true);
    // Final state = committed with the poison's edit gone, the survivors intact.
    const ejectedState = applyChanges(committed, result.newPending) as any;
    expect(ejectedState.a).toBe(1);
    expect(ejectedState.comments).toEqual({ x: { body: 'hi' } });
    expect(textOf(ejectedState)).toBe('Zhello\n');
  });

  it('rebases an overlapping @txt successor back into the pre-poison frame', () => {
    // Empty-ish doc; poison inserts XXX at the head, the successor inserts Y right after it.
    const committed = { text: [{ insert: 'hello\n' }] };
    const queue = [
      pending('poison', 6, [txt([{ insert: 'XXX' }])]), // hello -> XXXhello
      pending('after', 7, [txt([{ retain: 3 }, { insert: 'Y' }])]), // -> XXXYhello
    ];
    // Sanity: the full program (poison included) yields XXXYhello.
    expect(textOf(applyChanges(committed, queue) as any)).toBe('XXXYhello\n');

    const result = computePendingEjection(committed, COMMITTED_REV, queue, 'poison')!;
    // With XXX gone, the Y that sat at offset 3 now lands where XXX began — offset 0.
    expect(textOf(applyChanges(committed, result.newPending) as any)).toBe('Yhello\n');
    expect(result.newPending).toHaveLength(1);
    expect(result.newPending[0].id).toBe('after');
    expect(result.newPending[0].rev).toBe(6);
  });

  it('ejects a middle change, leaving predecessors untouched and rebasing successors', () => {
    const committed = { text: [{ insert: '\n' }] };
    const queue = [
      pending('p0', 6, [txt([{ insert: 'A' }])]), // -> A
      pending('poison', 7, [txt([{ insert: 'BB' }])]), // insert at head -> BBA
      pending('p2', 8, [txt([{ retain: 2 }, { insert: 'C' }])]), // C sits between BB and A -> BBCA
    ];
    expect(textOf(applyChanges(committed, queue) as any)).toBe('BBCA\n');

    const result = computePendingEjection(committed, COMMITTED_REV, queue, 'poison')!;
    expect(result.newPending.map(c => c.id)).toEqual(['p0', 'p2']);
    // Predecessor p0 is unchanged.
    expect(result.newPending[0].ops).toEqual(queue[0].ops);
    // C sat immediately before A (offset 2 in "BBA"); with BB gone it stays before A -> "CA".
    expect(textOf(applyChanges(committed, result.newPending) as any)).toBe('CA\n');
  });

  it('throws when the ejected change cannot be inverted (corrupt/mismatched queue)', () => {
    // The poison's op can't invert against the reconstructed pre-state (`/a` is undefined, so
    // reading `/a/b` throws). A successor is present so the invert path actually runs.
    const queue = [
      pending('poison', 6, [{ op: 'replace', path: '/a/b', value: 1 }]),
      pending('after', 7, [{ op: 'add', path: '/z', value: 1 }]),
    ];
    expect(() => computePendingEjection({}, COMMITTED_REV, queue, 'poison')).toThrow();
  });
});

describe('computePendingEjection — convergence against the real OT server', () => {
  const TIMEOUT = 30 * 60_000;

  // Commit a base change so the server head sits at COMMITTED_REV with known state, mirroring a
  // client whose committed state is `committed`.
  async function seed(backend: OTFuzzBackend, docId: string, committed: any) {
    // One root replace at rev 1 establishes the doc; treat that as the committed base. We then
    // pretend the client's committedRev is 1 for the ejected queue (baseRev rewritten to 1).
    await commitChanges(
      backend,
      docId,
      [{ id: 'seed', rev: 1, baseRev: 0, ops: [{ op: 'replace', path: '', value: committed }], createdAt: 0 }],
      TIMEOUT
    );
  }

  it('a queue with an ejected change commits cleanly and converges (no drops, no dupes, poison absent)', async () => {
    const backend = new OTFuzzBackend();
    const docId = 'doc';
    const committed = { text: [{ insert: 'hello\n' }], comments: {} };
    await seed(backend, docId, committed);

    // Client queue sitting on committedRev 1.
    const queue: Change[] = [
      { id: 'poison', rev: 2, baseRev: 1, ops: [txt([{ insert: 'XXX' }])], createdAt: 0, committedAt: 0 },
      {
        id: 'c1',
        rev: 3,
        baseRev: 1,
        ops: [{ op: 'add', path: '/comments/a', value: { body: 'note' } }],
        createdAt: 0,
        committedAt: 0,
      },
      { id: 'after', rev: 4, baseRev: 1, ops: [txt([{ retain: 3 }, { insert: 'Y' }])], createdAt: 0, committedAt: 0 },
    ];

    const result = computePendingEjection(committed, 1, queue, 'poison')!;
    expect(result.newPending.map(c => c.id)).toEqual(['c1', 'after']);

    // The server accepts the ejected queue and commits it. commitChanges throws on rev
    // conflicts / duplicate ids and drops nothing silently, so a malformed rebase fails here.
    const { newChanges } = await commitChanges(backend, docId, result.newPending, TIMEOUT);

    // No foreign changes, so the server transform is identity: its committed ids are exactly
    // the survivors, and the poison never reaches the log.
    const log = backend.log(docId);
    const committedIds = log.map(c => c.id);
    expect(committedIds).toContain('c1');
    expect(committedIds).toContain('after');
    expect(committedIds).not.toContain('poison');
    // Contiguous revs 1..N, every survivor committed exactly once.
    expect(log.map(c => c.rev)).toEqual([1, 2, 3]);
    expect(newChanges).toHaveLength(2);

    // Server head state equals what the client believes it committed — the fundamental OT
    // convergence property — and the poison's "XXX" is nowhere in it.
    const serverHead = applyChanges(null as any, log) as any;
    const clientBelief = applyChanges(committed, result.newPending) as any;
    expect(serverHead).toEqual(clientBelief);
    expect(textOf(serverHead)).toBe('Yhello\n');
    expect(serverHead.comments).toEqual({ a: { body: 'note' } });
  });
});

describe('computePendingEjection — randomized property tests', () => {
  const TIMEOUT = 30 * 60_000;
  const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

  // A random @txt delta against `text` of the given length: a run of retains then an insert
  // and/or a delete, always leaving the doc non-empty.
  function randomTextOps(rng: PRNG, textLen: number): any[] {
    const delta = new Delta();
    let cursor = 0;
    const retain = rng.int(Math.max(1, textLen)); // keep at least the trailing "\n" untouched
    if (retain > 0) {
      delta.retain(retain);
      cursor = retain;
    }
    if (rng.chance(0.7)) delta.insert(rng.pick(['a', 'bb', 'ccc']));
    if (rng.chance(0.4) && cursor < textLen - 1) delta.delete(1);
    return delta.ops.length ? [txt(delta.ops)] : [txt([{ retain: 1 }])];
  }

  // Build a random pending program on committedRev 1: a mix of @txt edits and object writes on
  // a small fixed key space, each a separate pending change.
  function randomProgram(rng: PRNG, committed: any): Change[] {
    const n = rng.intBetween(2, 6);
    const changes: Change[] = [];
    let state = committed;
    for (let i = 0; i < n; i++) {
      const textLen = textOf(state).length;
      const ops = rng.chance(0.5)
        ? randomTextOps(rng, textLen)
        : [{ op: 'replace' as const, path: `/o/${rng.pick(['x', 'y', 'z'])}`, value: rng.int(1000) }];
      changes.push({ id: `p${i}`, rev: 2 + i, baseRev: 1, ops, createdAt: 0, committedAt: 0 });
      state = applyChanges(state, [changes[changes.length - 1]]);
    }
    return changes;
  }

  it.each(SEEDS)('seed %i: ejected queue commits cleanly and converges with the server', seed => {
    const rng = new PRNG(seed);
    const committed = { text: [{ insert: 'seedtext\n' }], o: { x: 0, y: 0, z: 0 } };
    const program = randomProgram(rng, committed);
    const ejectIndex = rng.int(program.length);
    const ejectId = program[ejectIndex].id;

    const result = computePendingEjection(committed, 1, program, ejectId);
    expect(result).not.toBeNull();
    const { newPending } = result!;

    // The queue keeps the OT invariant: contiguous revs off committedRev, all baseRev === 1,
    // and the ejected id is gone.
    expect(newPending.map(c => c.baseRev)).toEqual(newPending.map(() => 1));
    expect(newPending.map(c => c.rev)).toEqual(newPending.map((_, i) => 2 + i));
    expect(newPending.some(c => c.id === ejectId)).toBe(false);

    // The real server accepts the ejected queue and converges: commitChanges throws on
    // rev/id conflicts and drops nothing silently, so a malformed rebase fails right here.
    const backend = new OTFuzzBackend();
    const docId = `doc-${seed}`;
    return commitChanges(
      backend,
      docId,
      [{ id: 'seed', rev: 1, baseRev: 0, ops: [{ op: 'replace', path: '', value: committed }], createdAt: 0 }],
      TIMEOUT
    )
      .then(() => commitChanges(backend, docId, newPending, TIMEOUT))
      .then(() => {
        const log = backend.log(docId);
        // Revs contiguous 1..N; the ejected change never reaches the log.
        expect(log.map(c => c.rev)).toEqual(log.map((_, i) => i + 1));
        expect(log.some(c => c.id === ejectId)).toBe(false);
        // Server head equals the client's post-ejection belief — the core OT convergence property.
        expect(applyChanges(null as any, log)).toEqual(applyChanges(committed, newPending));
      });
  });

  it.each(SEEDS)('seed %i: ejecting a disjoint change leaves every survivor byte-identical', seed => {
    const rng = new PRNG(seed);
    // The poison writes /poisoned; the survivors only ever touch /text and /o — provably
    // disjoint, so ejection must not alter a single survivor op (the Doug shape, generalized).
    const committed = { text: [{ insert: 'seedtext\n' }], o: { x: 0, y: 0, z: 0 }, poisoned: 0 };
    const survivorsBefore = randomProgram(rng, committed);
    const poisonAt = rng.int(survivorsBefore.length + 1);
    const poison: Change = {
      id: 'poison',
      rev: 0,
      baseRev: 1,
      ops: [{ op: 'replace', path: '/poisoned', value: 1 }],
      createdAt: 0,
      committedAt: 0,
    };
    // Splice the poison in at a random position and renumber the whole program contiguously.
    const program = [...survivorsBefore.slice(0, poisonAt), poison, ...survivorsBefore.slice(poisonAt)].map((c, i) => ({
      ...c,
      rev: 2 + i,
      baseRev: 1,
    }));

    const { newPending } = computePendingEjection(committed, 1, program, 'poison')!;

    // Every survivor keeps its exact ops (disjoint from the poison ⇒ no transform), in order.
    const survivorOps = program.filter(c => c.id !== 'poison').map(c => c.ops);
    expect(newPending.map(c => c.ops)).toEqual(survivorOps);
    // And the poison's edit is gone from the resulting state while the survivors' effects remain.
    const ejectedState = applyChanges(committed, newPending) as any;
    const fullMinusPoison = applyChanges(
      committed,
      program.filter(c => c.id !== 'poison')
    ) as any;
    expect(ejectedState).toEqual(fullMinusPoison);
    expect(ejectedState.poisoned).toBe(0);
  });
});
