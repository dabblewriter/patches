import { describe, expect, it } from 'vitest';
import { commitChanges } from '../../../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../../../src/algorithms/ot/shared/applyChanges';
import type { Change, ChangeInput } from '../../../../src/types';
import { OTFuzzBackend } from '../../../fuzz/otFuzzBackend';

/**
 * DAB-607 server-side guard: a change id must never commit twice, no matter how the
 * retry arrives.
 *
 * The read-side dedup in commitChanges checks incoming ids against committed changes
 * AFTER the incoming baseRev. Two real-world paths slip past it:
 *
 * 1. Rebased retry — the client re-sends an already-committed change after catching up
 *    (e.g. via a snapshot catch-up that carries no change ids), so its baseRev has
 *    advanced PAST the original commit and the committed copy is outside the window.
 * 2. Concurrent duplicate — two sends of the same change race; both pass the read-side
 *    check before either saves.
 *
 * The store's write-time id guard (DuplicateChangeIdsError from saveChanges) is the
 * authoritative backstop; commitChanges must resolve such requests as resends —
 * confirming committed work, never double-applying it. Duplicated non-idempotent ops
 * are real data corruption: a replayed `remove /children/6` deletes whatever slid into
 * index 6 (the production incident this guards against orphaned a chapter), and a
 * replayed text delta pastes the same prose again.
 *
 * These tests run the real commitChanges against the in-memory backend (no mocks).
 */

const DOC = 'doc1';
const sessionTimeoutMillis = 5 * 60_000;

const change = (id: string, baseRev: number, ops: Change['ops']): ChangeInput => ({
  id,
  baseRev,
  ops,
  createdAt: Date.now(),
});

async function seed(backend: OTFuzzBackend, state: object): Promise<void> {
  await commitChanges(
    backend,
    DOC,
    [change('seed', 0, [{ op: 'replace', path: '', value: state }])],
    sessionTimeoutMillis
  );
}

const headState = (backend: OTFuzzBackend) => applyChanges(null, backend.log(DOC)) as any;
const copiesOf = (backend: OTFuzzBackend, id: string) => backend.log(DOC).filter(c => c.id === id);

describe('commitChanges — write-time duplicate id guard (DAB-607)', () => {
  it('resolves a rebased retry as a resend instead of committing a duplicate', async () => {
    const backend = new OTFuzzBackend();
    await seed(backend, { tags: ['x'] }); // rev 1

    // Original commit of A at rev 2; the response is lost.
    await commitChanges(
      backend,
      DOC,
      [change('A', 1, [{ op: 'add', path: '/tags/0', value: 'a' }])],
      sessionTimeoutMillis
    );

    // Foreign work advances the tip to rev 3.
    await commitChanges(
      backend,
      DOC,
      [change('F', 2, [{ op: 'add', path: '/tags/-', value: 'f' }])],
      sessionTimeoutMillis
    );

    // The client catches up via snapshot (no change ids), keeps pending A, rebases it
    // to baseRev 3, and re-flushes. A's committed copy (rev 2) is outside the
    // startAfter:3 window — only the store's id guard can catch it.
    const result = await commitChanges(
      backend,
      DOC,
      [change('A', 3, [{ op: 'add', path: '/tags/0', value: 'a' }])],
      sessionTimeoutMillis
    );

    expect(result.newChanges).toEqual([]);
    expect(copiesOf(backend, 'A')).toHaveLength(1);
    expect(headState(backend).tags).toEqual(['a', 'x', 'f']);
  });

  it('never double-applies a non-idempotent array remove (chapter-eating repro)', async () => {
    const backend = new OTFuzzBackend();
    await seed(backend, { children: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'tmp', 'c6'] }); // rev 1

    // Original commit removes the temporary entry at index 6 (rev 2).
    await commitChanges(backend, DOC, [change('X', 1, [{ op: 'remove', path: '/children/6' }])], sessionTimeoutMillis);
    expect(headState(backend).children).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);

    // Rebased retry: baseRev advanced to the tip (2). Without the guard, the replayed
    // remove would delete 'c6' — the neighbor that slid into index 6.
    const result = await commitChanges(
      backend,
      DOC,
      [change('X', 2, [{ op: 'remove', path: '/children/6' }])],
      sessionTimeoutMillis
    );

    expect(result.newChanges).toEqual([]);
    expect(copiesOf(backend, 'X')).toHaveLength(1);
    expect(headState(backend).children).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  });

  it('survives a self-chasing retry loop (baseRev advancing one rev per attempt)', async () => {
    const backend = new OTFuzzBackend();
    await seed(backend, { tags: [] }); // rev 1

    await commitChanges(
      backend,
      DOC,
      [change('P', 1, [{ op: 'add', path: '/tags/-', value: 'paste' }])],
      sessionTimeoutMillis
    ); // rev 2

    // Each retry rebases onto the tip it just observed — the production triple-commit.
    for (const baseRev of [2, 3]) {
      // Tip never advances past 2 because every retry dedups; a baseRev ahead of the
      // server rev is a client-state error and 409s, which is fine — the important
      // invariant is no duplicate commit. Only retry with valid baseRevs.
      if (baseRev > (await backend.getCurrentRev(DOC))) break;
      const result = await commitChanges(
        backend,
        DOC,
        [change('P', baseRev, [{ op: 'add', path: '/tags/-', value: 'paste' }])],
        sessionTimeoutMillis
      );
      expect(result.newChanges).toEqual([]);
    }

    expect(copiesOf(backend, 'P')).toHaveLength(1);
    expect(headState(backend).tags).toEqual(['paste']);
  });

  it('commits the fresh tail of a resend whose head is an out-of-window duplicate', async () => {
    const backend = new OTFuzzBackend();
    await seed(backend, { tags: ['x'] }); // rev 1

    // A commits at rev 2; the echo is lost.
    await commitChanges(
      backend,
      DOC,
      [change('A', 1, [{ op: 'add', path: '/tags/0', value: 'a' }])],
      sessionTimeoutMillis
    );

    // The client re-flushes [A, B] rebased to the tip (2): B was minted on top of
    // pending A, so its frame already includes A's effects. A must dedup; B must
    // commit exactly once, in its own frame.
    const result = await commitChanges(
      backend,
      DOC,
      [
        change('A', 2, [{ op: 'add', path: '/tags/0', value: 'a' }]),
        change('B', 2, [{ op: 'add', path: '/tags/1', value: 'b' }]),
      ],
      sessionTimeoutMillis
    );

    expect(result.newChanges.map(c => c.id)).toEqual(['B']);
    expect(copiesOf(backend, 'A')).toHaveLength(1);
    expect(copiesOf(backend, 'B')).toHaveLength(1);
    expect(headState(backend).tags).toEqual(['a', 'b', 'x']);
  });

  it('still echoes an in-window resend without touching the store guard', async () => {
    const backend = new OTFuzzBackend();
    await seed(backend, { tags: ['x'] }); // rev 1

    await commitChanges(
      backend,
      DOC,
      [change('A', 1, [{ op: 'add', path: '/tags/0', value: 'a' }])],
      sessionTimeoutMillis
    ); // rev 2

    // Identical resend with the ORIGINAL baseRev — the committed copy is inside the
    // read-side window and is echoed back as a catch-up confirmation.
    const result = await commitChanges(
      backend,
      DOC,
      [change('A', 1, [{ op: 'add', path: '/tags/0', value: 'a' }])],
      sessionTimeoutMillis
    );

    expect(result.newChanges).toEqual([]);
    expect(result.catchupChanges.map(c => c.id)).toContain('A');
    expect(copiesOf(backend, 'A')).toHaveLength(1);
    expect(headState(backend).tags).toEqual(['a', 'x']);
  });
});
