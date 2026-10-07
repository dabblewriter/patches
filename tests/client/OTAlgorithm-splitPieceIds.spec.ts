import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitChanges } from '../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { rebaseChanges } from '../../src/algorithms/ot/shared/rebaseChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import type { Change } from '../../src/types';
import { OTFuzzBackend } from '../fuzz/otFuzzBackend';

/**
 * DAB-1754: a change split by `maxStorageBytes` derives its piece ids from the stable id it was
 * minted under, so a retried persist re-presents the same ids.
 *
 * The case it closes: a persist that timed out but landed. Its pieces are queued (and may already
 * be on the wire) when the retry re-mints the same entry and queues them again. The server dedups
 * by change id, which only helps if the second set carries the first set's ids — with fresh random
 * ids for every piece past the first, the split content committed once per attempt.
 */

const DOC = 'doc1';
const sessionTimeoutMillis = 5 * 60_000;

// Two appends, each too big to share a 250-byte change with the other, so the mint splits.
const bigOps = () => [
  { op: 'add' as const, path: '/list/-', value: 'x'.repeat(120) },
  { op: 'add' as const, path: '/list/-', value: 'y'.repeat(120) },
];
// One entry, before and after a rebase: the same three inserts, shifted by a foreign insert
// ahead of them. The content never changes; only the indexes gain digits, which pushes the last
// two inserts past the seam they shared — two pieces become three. (The shift is exaggerated to
// gain enough digits in a small test; a real one needs only a piece already near its budget.)
const seamOps = (shift: number) => [
  { op: 'add' as const, path: `/list/${shift}`, value: 'x'.repeat(100) },
  { op: 'add' as const, path: `/list/${shift + 1}`, value: 'y'.repeat(38) },
  { op: 'add' as const, path: `/list/${shift + 2}`, value: 'z'.repeat(38) },
];

describe('OTAlgorithm — split piece ids derive from the stable id (DAB-1754)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store, { maxStorageBytes: 250 });
    await store.trackDocs([DOC]);
  });

  it('names pieces past the first `${id}_${k}`, and stamps every piece with the split', async () => {
    const changes = await algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid');
    expect(changes.map(c => c.id)).toEqual(['cid', 'cid_1']);
    expect(changes.map(c => c.splitFrom)).toEqual([
      { id: 'cid', count: 2 },
      { id: 'cid', count: 2 },
    ]);
  });

  it('keeps piece ids inside the id alphabet stores guard duplicates for', async () => {
    // pup's write-time `_changeIds` marker only covers `[\w-]{1,64}`; an id outside it commits
    // with no duplicate guard at all.
    const changes = await algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'aB3dE6gH9jK2');
    expect(changes.every(c => /^[\w-]{1,64}$/.test(c.id))).toBe(true);
  });

  it('leaves an unsplit change unstamped', async () => {
    const [change] = await algorithm.handleDocChange(DOC, [bigOps()[0]], undefined, {}, 'cid');
    expect(change.splitFrom).toBeUndefined();
  });

  it('re-mints the same piece ids on every attempt', async () => {
    const first = await algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid');
    const second = await algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid');
    expect(second.map(c => c.id)).toEqual(first.map(c => c.id));
  });

  it('mints unrelated random ids when no stable id is supplied', async () => {
    const first = await algorithm.handleDocChange(DOC, bigOps(), undefined, {});
    const second = await algorithm.handleDocChange(DOC, bigOps(), undefined, {});
    expect(first).toHaveLength(2);
    expect(new Set([...first, ...second].map(c => c.id)).size).toBe(4);
    expect([...first, ...second].some(c => c.id.includes('_') || c.splitFrom)).toBe(false);
  });

  describe('a landed attempt and its retry commit once on the server', () => {
    let backend: OTFuzzBackend;
    let attempt1: Change[];
    let attempt2: Change[];

    beforeEach(async () => {
      backend = new OTFuzzBackend();
      await commitChanges(
        backend,
        DOC,
        [{ id: 'seed', baseRev: 0, ops: [{ op: 'replace', path: '', value: { list: [] } }], createdAt: Date.now() }],
        sessionTimeoutMillis
      );
      await store.saveDoc(DOC, { state: { list: [] }, rev: 1 });

      // Attempt 1's write timed out but landed; the retry re-mints the same entry and lands too.
      await algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid');
      await algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid');
      const pending = await store.getPendingChanges(DOC);
      expect(pending).toHaveLength(4);
      attempt1 = pending.slice(0, 2);
      attempt2 = pending.slice(2);
    });

    const expectCommittedOnce = () => {
      const state = applyChanges(null, backend.log(DOC)) as any;
      expect(state.list).toEqual(['x'.repeat(120), 'y'.repeat(120)]);
      expect(backend.log(DOC).map(c => c.id)).toEqual(['seed', 'cid', 'cid_1']);
    };

    it('in one upload', async () => {
      await commitChanges(backend, DOC, [...attempt1, ...attempt2], sessionTimeoutMillis);
      expectCommittedOnce();
    });

    it('in a later request on the same base (read-side dedup)', async () => {
      await commitChanges(backend, DOC, attempt1, sessionTimeoutMillis);
      await commitChanges(backend, DOC, attempt2, sessionTimeoutMillis);
      expectCommittedOnce();
    });

    it('in a later request rebased past the first commit (store-level id guard)', async () => {
      await commitChanges(backend, DOC, attempt1, sessionTimeoutMillis);
      // The retry's rows were sent after the client took attempt 1's echo, so their base is past
      // the committed copies and the read-side window cannot see them.
      const head = backend.log(DOC).at(-1)!.rev;
      await commitChanges(
        backend,
        DOC,
        attempt2.map(c => ({ ...c, baseRev: head })),
        sessionTimeoutMillis
      );
      expectCommittedOnce();
    });
  });
});

describe('commitChanges — a second copy of an entry split differently commits nothing (DAB-1754)', () => {
  let backend: OTFuzzBackend;

  const piece = (id: string, value: string, count?: number): Change =>
    ({
      id,
      baseRev: 1,
      rev: 0,
      ops: [{ op: 'add', path: '/list/-', value }],
      createdAt: Date.now(),
      committedAt: 0,
      ...(count && { splitFrom: { id: 'cid', count } }),
    }) as Change;
  const whole = (): Change => ({ ...piece('cid', 'x'), ops: [...piece('', 'x').ops, ...piece('', 'y').ops] });
  const twoPieces = () => [piece('cid', 'x', 2), piece('cid_1', 'y', 2)];
  const threePieces = () => [piece('cid', 'x', 3), piece('cid_1', 'y', 3), piece('cid_2', 'z', 3)];
  const list = () => (applyChanges(null, backend.log(DOC)) as any).list;
  const ids = () => backend.log(DOC).map(c => c.id);

  beforeEach(async () => {
    backend = new OTFuzzBackend();
    await commitChanges(
      backend,
      DOC,
      [{ id: 'seed', baseRev: 0, ops: [{ op: 'replace', path: '', value: { list: [] } }], createdAt: Date.now() }],
      sessionTimeoutMillis
    );
  });

  it('drops the pieces a later copy with more pieces has that the first lacks', async () => {
    await commitChanges(backend, DOC, twoPieces(), sessionTimeoutMillis);
    const result = await commitChanges(backend, DOC, threePieces(), sessionTimeoutMillis);

    expect(ids()).toEqual(['seed', 'cid', 'cid_1']);
    expect(list()).toEqual(['x', 'y']);
    expect(result.newChanges).toEqual([]);
  });

  it('drops them from the same upload too', async () => {
    await commitChanges(backend, DOC, [...twoPieces(), ...threePieces()], sessionTimeoutMillis);
    expect(ids()).toEqual(['seed', 'cid', 'cid_1']);
  });

  it('drops landed pieces sent after the outbox committed the entry whole', async () => {
    // The outbox went out before the landed pieces were readable; the whole entry is `cid`.
    await commitChanges(backend, DOC, [whole()], sessionTimeoutMillis);
    await commitChanges(backend, DOC, twoPieces(), sessionTimeoutMillis);

    expect(ids()).toEqual(['seed', 'cid']);
    expect(list()).toEqual(['x', 'y']);
  });

  it('commits the changes queued behind a dropped copy in the frame they were minted in', async () => {
    await commitChanges(backend, DOC, [whole()], sessionTimeoutMillis);
    // The sender's queue: the landed pieces, then an edit made after the entry (index 2 = after
    // x and y, as the sender's view had them).
    const after = { ...piece('later', 'w'), ops: [{ op: 'add', path: '/list/2', value: 'w' }] } as Change;
    await commitChanges(backend, DOC, [...twoPieces(), after], sessionTimeoutMillis);

    expect(list()).toEqual(['x', 'y', 'w']);
  });

  it('treats the committed copy as the sender’s own even when no id is shared with it', async () => {
    // Piece 0 was confirmed by a response the sender already took; only piece 1 and the edit
    // queued behind the entry remain. Transforming the edit against the whole copy as if it were
    // foreign would push it past content its own frame already counted. An insert between x and
    // y shows it: misframed, it lands after y.
    const at = (c: Change, index: number) =>
      ({ ...c, ops: c.ops.map(op => ({ ...op, path: `/list/${index}` })) }) as Change;
    await commitChanges(
      backend,
      DOC,
      [{ ...whole(), ops: [at(piece('', 'x'), 0).ops[0], at(piece('', 'y'), 1).ops[0]] }],
      sessionTimeoutMillis
    );
    await commitChanges(backend, DOC, [at(twoPieces()[1], 1), at(piece('later', 'w'), 1)], sessionTimeoutMillis);

    expect(list()).toEqual(['x', 'w', 'y']);
  });

  describe('walks foreign changes through a dropped copy exactly as the client rebase does', () => {
    const ch = (id: string, ops: Change['ops'], extra: Partial<Change> = {}): Change =>
      ({ id, baseRev: 1, rev: 0, ops, createdAt: Date.now(), committedAt: 0, clientId: 'me', ...extra }) as Change;
    const add = (index: number, value: string) => ({ op: 'add' as const, path: `/list/${index}`, value });
    const stamp = (count: number) => ({ splitFrom: { id: 'cid', count } });

    beforeEach(async () => {
      backend = new OTFuzzBackend();
      await commitChanges(
        backend,
        DOC,
        [ch('seed', [{ op: 'replace', path: '', value: { list: ['a', 'b'] } }], { baseRev: 0 })],
        sessionTimeoutMillis
      );
      // A foreign insert lands in the sender's window.
      await commitChanges(backend, DOC, [ch('X', [add(1, 'X')], { clientId: 'other' })], sessionTimeoutMillis);
    });

    /** What the client's rebase makes of `queue` against everything committed past its base. */
    const clientView = (queue: Change[]) => {
      const rebased = rebaseChanges(
        backend.log(DOC).slice(1),
        queue.map(c => ({ ...c }))
      );
      return (applyChanges(applyChanges(null, backend.log(DOC)) as any, rebased) as any).list;
    };

    it('when the winning copy committed earlier (the outbox went first)', async () => {
      await commitChanges(backend, DOC, [ch('cid', [add(0, 'x'), add(1, 'y1'), add(2, 'y2')])], sessionTimeoutMillis);
      // The landed pieces, then an edit between y2 and a.
      const queue = [
        ch('cid', [add(0, 'x')], stamp(2)),
        ch('cid_1', [add(1, 'y1'), add(2, 'y2')], stamp(2)),
        ch('Q', [add(3, 'Q')]),
      ];
      const expected = clientView(queue);
      await commitChanges(backend, DOC, queue, sessionTimeoutMillis);

      expect(list()).toEqual(expected);
      expect(list()).toEqual(['x', 'y1', 'y2', 'Q', 'a', 'X', 'b']);
    });

    it('when both copies are in the same upload', async () => {
      const queue = [
        ch('cid', [add(0, 'x'), add(1, 'y1')], stamp(2)),
        ch('cid_1', [add(2, 'y2')], stamp(2)),
        ch('cid', [add(0, 'x')], stamp(3)),
        ch('cid_1', [add(1, 'y1')], stamp(3)),
        ch('cid_2', [add(2, 'y2')], stamp(3)),
        ch('Q', [add(3, 'Q')]),
      ];
      // The client keeps every row until the echo of the first copy retires the second; its
      // rebase against X must place Q where the server does.
      const rebased = rebaseChanges(
        backend.log(DOC).slice(1),
        queue.map(c => ({ ...c }))
      );
      const result = await commitChanges(backend, DOC, queue, sessionTimeoutMillis);

      expect(result.newChanges.map(c => c.id)).toEqual(['cid', 'cid_1', 'Q']);
      expect(result.newChanges.map(c => c.rev)).toEqual([3, 4, 5]);
      expect(result.newChanges.at(-1)!.ops).toEqual(rebased.at(-1)!.ops);
    });
  });

  it('echoes a committed piece the request carries under other ids, so the response has no gap', async () => {
    await commitChanges(backend, DOC, twoPieces(), sessionTimeoutMillis);
    const result = await commitChanges(backend, DOC, [threePieces()[2]], sessionTimeoutMillis);
    expect(result.catchupChanges.map(c => c.id)).toEqual(['cid', 'cid_1']);
  });

  it('keeps both copies on a replay, which re-commits a log as it stands', async () => {
    await commitChanges(backend, DOC, twoPieces(), sessionTimeoutMillis);
    await commitChanges(backend, DOC, [threePieces()[2]], sessionTimeoutMillis, { forceCommit: true });
    expect(ids()).toEqual(['seed', 'cid', 'cid_1', 'cid_2']);
  });

  it('commits the pieces a later re-split cut from a stamped piece, which inherit its stamp', async () => {
    // PatchesSync re-split `cid_1` under a tighter budget: a random-id child carries `{cid, 2}`.
    const reSplit = [piece('cid', 'x', 2), piece('cid_1', 'y', 2), piece('r4nd0m', 'y2', 2)];
    await commitChanges(backend, DOC, reSplit, sessionTimeoutMillis);
    expect(list()).toEqual(['x', 'y', 'y2']);
  });

  it('still commits a split whose first copy never arrived', async () => {
    await commitChanges(backend, DOC, threePieces(), sessionTimeoutMillis);
    expect(list()).toEqual(['x', 'y', 'z']);
  });

  it('ignores a malformed stamp rather than acting on it', async () => {
    await commitChanges(backend, DOC, [whole()], sessionTimeoutMillis);
    const forged = { ...piece('other', 'q'), splitFrom: { id: 'cid', count: 'many' } } as unknown as Change;
    await commitChanges(backend, DOC, [forged], sessionTimeoutMillis);

    expect(ids()).toEqual(['seed', 'cid', 'other']);
    expect(backend.log(DOC).at(-1)!.splitFrom).toBeUndefined();
  });

  it('stores a valid stamp as just its id and count', async () => {
    const padded = { ...piece('cid', 'x', 2), splitFrom: { id: 'cid', count: 2, junk: 'x'.repeat(1000) } } as Change;
    await commitChanges(backend, DOC, [padded], sessionTimeoutMillis);
    expect(backend.log(DOC).at(-1)!.splitFrom).toEqual({ id: 'cid', count: 2 });
  });

  it('does not let a foreign connection drop the sender’s pieces', async () => {
    await commitChanges(backend, DOC, [{ ...whole(), clientId: 'someone-else' }], sessionTimeoutMillis);
    await commitChanges(
      backend,
      DOC,
      threePieces().map(c => ({ ...c, id: `mine${c.id.slice(3)}`, clientId: 'me' })),
      sessionTimeoutMillis
    );
    expect(list()).toEqual(['x', 'y', 'x', 'y', 'z']);
  });
});

describe('OTAlgorithm — a retry adopts the rows a persist that threw left behind (DAB-1754)', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  /** The next persist commits, then rejects anyway: a storage timeout that landed. */
  const landThenThrow = () => {
    const save = store.savePendingChanges.bind(store);
    return vi.spyOn(store, 'savePendingChanges').mockImplementationOnce(async (docId, changes) => {
      await save(docId, changes);
      throw new Error('storage timeout');
    });
  };

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store, { maxStorageBytes: 250 });
    await store.trackDocs([DOC]);
    await store.saveDoc(DOC, { state: { list: [] }, rev: 1 });
  });

  it('queues nothing new when a rebase between attempts would have split the entry differently', async () => {
    // Precondition: the rebase really does move the seam.
    const probe = new OTAlgorithm(new OTInMemoryStore(), { maxStorageBytes: 250 });
    expect(await probe.handleDocChange('probe', seamOps(0), undefined, {}, 'p')).toHaveLength(2);
    expect(await probe.handleDocChange('probe', seamOps(1_000_000_000), undefined, {}, 'q')).toHaveLength(3);

    landThenThrow();
    await expect(algorithm.handleDocChange(DOC, seamOps(0), undefined, {}, 'cid')).rejects.toThrow('storage timeout');

    // Minting the rebased entry would add a piece (`cid_2`) the server has never seen, carrying
    // content attempt 1's pieces already hold.
    const retry = await algorithm.handleDocChange(DOC, seamOps(1_000_000_000), undefined, {}, 'cid');

    expect(retry.map(c => c.id)).toEqual(['cid', 'cid_1']);
    expect((await store.getPendingChanges(DOC)).map(c => c.id)).toEqual(['cid', 'cid_1']);
  });

  it('adopts only the earliest copy when two attempts both landed', async () => {
    landThenThrow();
    await expect(algorithm.handleDocChange(DOC, seamOps(0), undefined, {}, 'cid')).rejects.toThrow('storage timeout');
    // Attempt 2 could not see attempt 1's rows yet (they committed after its read), minted the
    // rebased entry in three pieces, and also threw after landing: the store holds both copies.
    const probe = new OTAlgorithm(new OTInMemoryStore(), { maxStorageBytes: 250 });
    const secondCopy = await probe.handleDocChange('probe', seamOps(1_000_000_000), undefined, {}, 'cid');
    expect(secondCopy.map(c => c.id)).toEqual(['cid', 'cid_1', 'cid_2']);
    await store.savePendingChanges(DOC, secondCopy);

    const retry = await algorithm.handleDocChange(DOC, seamOps(1_000_000_000), undefined, {}, 'cid');
    expect(retry.map(c => [c.id, c.splitFrom?.count])).toEqual([
      ['cid', 2],
      ['cid_1', 2],
    ]);
  });

  it('settles an id whose entry was rebased away, so a later mint under it reads nothing', async () => {
    vi.spyOn(store, 'savePendingChanges').mockRejectedValueOnce(new Error('aborted'));
    await expect(algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid')).rejects.toThrow('aborted');
    await algorithm.handleDocChange(DOC, [], undefined, {}, 'cid');

    const read = vi.spyOn(store, 'getPendingChanges');
    await algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid');
    expect(read).toHaveBeenCalledTimes(1); // the closed-doc path's own read only
  });

  it('forgets unsettled ids when the doc is untracked', async () => {
    vi.spyOn(store, 'savePendingChanges').mockRejectedValueOnce(new Error('aborted'));
    await expect(algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid')).rejects.toThrow('aborted');
    await algorithm.untrackDocs([DOC]);
    expect((algorithm as any)._unsettledMints.has(DOC)).toBe(false);
  });

  it('never lets an app metadata key named splitFrom reach the change', async () => {
    const [change] = await algorithm.handleDocChange(
      DOC,
      [bigOps()[0]],
      undefined,
      { splitFrom: { id: 'someone-elses', count: 9 } },
      'cid'
    );
    expect(change.splitFrom).toBeUndefined();
  });

  it('never lets it reach an outbox row either', async () => {
    const doc = new OTDoc<{ list: string[] }>(DOC, { state: { list: [] }, rev: 1, changes: [] });
    doc.change(patch => patch.add('/list/-', 'x'));
    const ops = (doc as any)._optimisticOps[0];

    const row = algorithm.queueUnstoredChange(DOC, ops, doc, { splitFrom: { id: 'someone-elses', count: 9 } }, 'cid');
    expect(row).not.toBeNull();
    expect(row!.splitFrom).toBeUndefined();
  });

  it('mints as normal when the persist that threw saved nothing', async () => {
    vi.spyOn(store, 'savePendingChanges').mockRejectedValueOnce(new Error('aborted'));
    await expect(algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid')).rejects.toThrow('aborted');

    const retry = await algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid');
    expect(retry.map(c => c.id)).toEqual(['cid', 'cid_1']);
    expect((await store.getPendingChanges(DOC)).map(c => c.id)).toEqual(['cid', 'cid_1']);
  });

  it('does not read the store for an id whose persist never threw', async () => {
    const read = vi.spyOn(store, 'getPendingChanges');
    await algorithm.handleDocChange(DOC, bigOps(), undefined, {}, 'cid');
    // The one read is the closed-doc path's own, for the pending tail rev.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('hands the open doc the landed rows in place of its parked entry', async () => {
    const doc = new OTDoc<{ list: string[] }>(DOC, { state: { list: [] }, rev: 1, changes: [] });
    doc.change(patch => {
      patch.add('/list/-', 'x'.repeat(120));
      patch.add('/list/-', 'y'.repeat(120));
    });
    const ops = (doc as any)._optimisticOps[0];

    landThenThrow();
    await expect(algorithm.handleDocChange(DOC, ops, doc, {}, 'cid')).rejects.toThrow('storage timeout');
    await algorithm.handleDocChange(DOC, ops, doc, {}, 'cid');

    expect(doc.state.list).toEqual(['x'.repeat(120), 'y'.repeat(120)]);
    expect((doc as any)._optimisticOps).toEqual([]);
    expect(doc.getPendingChanges().map(c => c.id)).toEqual(['cid', 'cid_1']);
    expect((await store.getPendingChanges(DOC)).map(c => c.id)).toEqual(['cid', 'cid_1']);
  });

  it('adds nothing twice when a receive already put the landed rows in the doc', async () => {
    const doc = new OTDoc<{ list: string[] }>(DOC, { state: { list: [] }, rev: 1, changes: [] });
    doc.change(patch => {
      patch.add('/list/-', 'x'.repeat(120));
      patch.add('/list/-', 'y'.repeat(120));
    });
    const ops = (doc as any)._optimisticOps[0];

    landThenThrow();
    await expect(algorithm.handleDocChange(DOC, ops, doc, {}, 'cid')).rejects.toThrow('storage timeout');
    // A receive rebuilt the doc's pending from the store, attempt 1's rows included.
    (doc as any)._pendingChanges = await store.getPendingChanges(DOC);
    await algorithm.handleDocChange(DOC, ops, doc, {}, 'cid');

    expect(doc.getPendingChanges().map(c => c.id)).toEqual(['cid', 'cid_1']);
    expect(doc.state.list).toEqual(['x'.repeat(120), 'y'.repeat(120)]);
  });
});

describe('rebaseChanges — the echo of one copy retires every other copy of the entry (DAB-1754)', () => {
  it('drops the queued pieces of a copy split differently, untransformed', async () => {
    const { rebaseChanges } = await import('../../src/algorithms/ot/shared/rebaseChanges');
    const stamp = (count: number) => ({ splitFrom: { id: 'cid', count } });
    const row = (id: string, value: string, extra = {}): Change => ({
      id,
      baseRev: 1,
      rev: 0,
      ops: [{ op: 'add', path: '/list/-', value }],
      createdAt: 1,
      committedAt: 0,
      ...extra,
    });
    // Committed: attempt 1's two pieces. Queued: attempt 2's three, then a later edit.
    const committed = [row('cid', 'x', stamp(2)), row('cid_1', 'y', stamp(2))].map((c, i) => ({
      ...c,
      rev: 2 + i,
      committedAt: 1,
    }));
    const later = { ...row('later', 'w'), ops: [{ op: 'add' as const, path: '/list/2', value: 'w' }] };
    const pending = [row('cid', 'x', stamp(3)), row('cid_1', 'y', stamp(3)), row('cid_2', 'z', stamp(3)), later];

    const rebased = rebaseChanges(committed, pending);

    expect(rebased.map(c => c.id)).toEqual(['later']);
    expect(rebased[0].ops).toEqual(later.ops);
  });

  it('treats a committed sibling piece as ours even when the queue no longer holds its id', async () => {
    const { rebaseChanges } = await import('../../src/algorithms/ot/shared/rebaseChanges');
    const stamp = { splitFrom: { id: 'cid', count: 2 } };
    // `cid` was confirmed and left the queue; its echo arrives again beside `cid_1`'s.
    const committed = {
      id: 'cid',
      baseRev: 1,
      rev: 2,
      ops: [{ op: 'add', path: '/list/0', value: 'x' }],
      createdAt: 1,
      committedAt: 1,
      ...stamp,
    } as Change;
    const queued = {
      id: 'cid_1',
      baseRev: 1,
      rev: 3,
      ops: [{ op: 'add', path: '/list/1', value: 'y' }],
      createdAt: 1,
      committedAt: 0,
      ...stamp,
    } as Change;

    const [rebased] = rebaseChanges([committed], [queued]);
    // Ours, so untransformed: as foreign it would shift to /list/2.
    expect(rebased.ops).toEqual(queued.ops);
  });
});

describe('OTDoc — a retried mint re-notes the same piece ids (DAB-1754)', () => {
  const change = (id: string, rev: number, ops: Change['ops'], committed: boolean): Change => ({
    id,
    baseRev: 1,
    rev,
    ops,
    createdAt: Date.now(),
    committedAt: committed ? Date.now() : 0,
  });

  it("recognises the earlier attempt's echoes after the retry re-noted the entry", () => {
    const doc = new OTDoc<{ items: string[] }>('doc-1', { state: { items: ['a'] }, rev: 1, changes: [] });
    doc.change(patch => {
      patch.add('/items/-', 'A');
      patch.add('/items/-', 'B');
    });
    const ops = (doc as any)._optimisticOps[0];
    const pieces = (committed: boolean) => [
      change('cid', 2, [ops[0]], committed),
      change('cid_1', 3, [ops[1]], committed),
    ];

    // Attempt 1 notes its pieces, then its write times out (but lands, and goes out). The retry
    // re-mints the entry and notes it again before the echo of attempt 1 arrives.
    doc._noteMinted(pieces(false), ops);
    doc._noteMinted(pieces(false), ops);
    doc.applyChanges(pieces(true));

    expect(doc.state.items).toEqual(['a', 'A', 'B']);
    expect((doc as any)._optimisticOps).toEqual([]);
  });
});
