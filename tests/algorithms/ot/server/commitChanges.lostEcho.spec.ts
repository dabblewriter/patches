import { describe, expect, it } from 'vitest';
import { commitChanges } from '../../../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../../../src/algorithms/ot/shared/applyChanges';
import type { Change, ChangeInput } from '../../../../src/types';
import { OTFuzzBackend } from '../../../fuzz/otFuzzBackend';

/**
 * F3-interleave regression: a foreign commit lands BEFORE the sender's lost echo.
 *
 * The client flushed [A]; the server committed A but the response was lost. A foreign change F
 * had committed just before A. The client keeps editing (B minted on top of pending A) and
 * re-flushes [A, B]. rebaseChanges (the client mirror) advances F through the RAW resent head A
 * before it meets B, then drops A at its echo's rev. The server must walk in lockstep: keeping
 * resent already-committed changes in the transform queue as advance-only entries, removed when
 * the walk reaches their committed echo, committing only non-echo survivors. Merely deleting
 * the echo from the transform set AND the head from the queue transforms B against F in the
 * wrong frame — with real content silently deleted (B committed as `remove /tags/1`, deleting
 * 'x', instead of no-oping).
 *
 * These tests run the real commitChanges against a real in-memory backend (no mocks).
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

describe('commitChanges — lost echo with an interleaved foreign commit', () => {
  it('rebases the resent tail through the raw resent head (blocker repro: B must no-op)', async () => {
    const backend = new OTFuzzBackend();
    await seed(backend, { tags: ['x', 'y'] }); // rev 1

    // Foreign F commits first: removes 'y'.
    await commitChanges(backend, DOC, [change('F', 1, [{ op: 'remove', path: '/tags/1' }])], sessionTimeoutMillis); // rev 2

    // The sender flushes [A]; the server commits it (rev 3) but the response is lost.
    await commitChanges(
      backend,
      DOC,
      [change('A', 1, [{ op: 'add', path: '/tags/0', value: 'a' }])],
      sessionTimeoutMillis
    );
    expect(headState(backend).tags).toEqual(['a', 'x']);

    // The client keeps editing on top of pending A (local frame [a, x, y]): B removes 'y' at
    // index 2, then re-flushes [A, B].
    const result = await commitChanges(
      backend,
      DOC,
      [
        change('A', 1, [{ op: 'add', path: '/tags/0', value: 'a' }]),
        change('B', 1, [{ op: 'remove', path: '/tags/2' }]),
      ],
      sessionTimeoutMillis
    );

    // B targeted 'y', which F already removed — it must rebase away, not delete 'x'.
    expect(result.newChanges).toEqual([]);
    // The echo of A (and the missed F) still come back as catchup so the client can confirm.
    expect(result.catchupChanges.map(c => c.id)).toEqual(['F', 'A']);
    expect(headState(backend).tags).toEqual(['a', 'x']);
  });

  it('commits a surviving tail in the frame advanced through the resent head', async () => {
    const backend = new OTFuzzBackend();
    await seed(backend, { tags: ['x', 'y'] }); // rev 1

    // Foreign F inserts 'f' at the head.
    await commitChanges(
      backend,
      DOC,
      [change('F', 1, [{ op: 'add', path: '/tags/0', value: 'f' }])],
      sessionTimeoutMillis
    ); // rev 2

    // Sender's A commits (rev 3) but the response is lost. Server: [a, f, x, y].
    await commitChanges(
      backend,
      DOC,
      [change('A', 1, [{ op: 'add', path: '/tags/0', value: 'a' }])],
      sessionTimeoutMillis
    );
    expect(headState(backend).tags).toEqual(['a', 'f', 'x', 'y']);

    // B replaces 'y' (index 2 in the client frame [a, x, y]); resend [A, B].
    const result = await commitChanges(
      backend,
      DOC,
      [
        change('A', 1, [{ op: 'add', path: '/tags/0', value: 'a' }]),
        change('B', 1, [{ op: 'replace', path: '/tags/2', value: 'z' }]),
      ],
      sessionTimeoutMillis
    );

    // B survives and must land on 'y' — not on whatever sits at an un-advanced offset.
    expect(result.newChanges.map(c => c.id)).toEqual(['B']);
    expect(headState(backend).tags).toEqual(['a', 'f', 'x', 'z']);
  });
});

describe('commitChanges — own-echo matching is origin-aware (DAB-601)', () => {
  it('a foreign committed change with a colliding id is still transformed against', async () => {
    const backend = new OTFuzzBackend();
    await seed(backend, { tags: ['x', 'y'] }); // rev 1

    // A foreign client committed a change whose id collides with one this sender will use.
    await commitChanges(
      backend,
      DOC,
      [{ ...change('X', 1, [{ op: 'add', path: '/tags/0', value: 'f' }]), clientId: 'client-foreign' }],
      sessionTimeoutMillis
    ); // rev 2 — tags: ['f', 'x', 'y']

    // A DIFFERENT client sends a batch reusing id X plus a tail change minted in its own
    // frame (tags without the foreign insert). Matching echoes by id alone excluded the
    // foreign change from the transform set AND swallowed the sender's X as already
    // committed — the tail then committed unshifted, deleting 'x' instead of 'y'.
    //
    // With the write-time id guard (DAB-607) the store refuses the second commit of id X
    // outright: ids are globally unique per doc, because per-origin markers would reopen
    // the reconnect-retry duplicate (a reconnect mints a fresh clientId). The sender's
    // colliding X is dropped as a duplicate — a genuine id collision is a client id-
    // generation defect, and refusing it is the data-safe resolution. What DAB-601
    // guards must STILL hold for the tail: B is not swallowed, and it transforms
    // against the foreign X in the correct frame — deleting 'y', not 'x'.
    const result = await commitChanges(
      backend,
      DOC,
      [
        { ...change('X', 1, [{ op: 'replace', path: '/a', value: 1 }]), clientId: 'client-me' },
        { ...change('B', 1, [{ op: 'remove', path: '/tags/1' }]), clientId: 'client-me' },
      ],
      sessionTimeoutMillis
    );

    expect(result.newChanges.map(c => c.id)).toEqual(['B']); // X refused by the id guard, B survives
    const state = headState(backend);
    expect(state.tags).toEqual(['f', 'x']); // B removed 'y' (shifted), not 'x'
    expect(state.a).toBeUndefined(); // the colliding X was dropped, not committed
  });

  it('falls back to id-only matching when committed rows carry no origin (pre-stamp history)', async () => {
    const backend = new OTFuzzBackend();
    await seed(backend, { tags: ['x', 'y'] }); // rev 1

    // The sender's own earlier commit, persisted before origin stamping existed (no clientId).
    await commitChanges(backend, DOC, [change('A', 1, [{ op: 'remove', path: '/tags/1' }])], sessionTimeoutMillis); // rev 2

    // The response was lost; the client re-flushes A (now stamped) with a tail change.
    const result = await commitChanges(
      backend,
      DOC,
      [
        { ...change('A', 1, [{ op: 'remove', path: '/tags/1' }]), clientId: 'client-me' },
        { ...change('B', 1, [{ op: 'replace', path: '/tags/0', value: 'z' }]), clientId: 'client-me' },
      ],
      sessionTimeoutMillis
    );

    // A recognized as the sender's own echo (id fallback): echoed for confirmation, not recommitted.
    expect(result.newChanges.map(c => c.id)).toEqual(['B']);
    expect(result.catchupChanges.some(c => c.id === 'A')).toBe(true);
    expect(headState(backend).tags).toEqual(['z']);
  });
});
