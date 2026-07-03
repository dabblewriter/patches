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
