import { describe, expect, it } from 'vitest';
import { rebaseChanges } from '../../src/algorithms/ot/shared/rebaseChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change, PatchesSnapshot } from '../../src/types';

/**
 * DAB-1760 (follow-up to DAB-1755): when the store is already ahead of the open doc — another tab
 * applied the batch first, or a torn reload installed it — the store's pending rows sit on the
 * STORE's frame, already carried across the part of the batch the store holds. Rows on the DOC's
 * frame (a doc-only torn write, a frozen outbox row) were minted on top of the doc's own copies of
 * those store rows, so the batch must be walked through those copies before it meets them.
 * Walking them alone, or behind the store-frame copies, leaves them an index off: the same class
 * DAB-1755 fixed for the store rows.
 */

const DOC_ID = 'doc1';
const BASE = { a: ['p', 'q', 'r'] };

async function openAt(state: object, rev: number) {
  const store = new OTInMemoryStore();
  const algorithm = new OTAlgorithm(store);
  await store.trackDocs([DOC_ID]);
  await store.saveDoc(DOC_ID, { state, rev });
  const doc = algorithm.createDoc<any>(DOC_ID, (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>) as OTDoc<any>;
  return { store, algorithm, doc };
}

async function mint(algorithm: OTAlgorithm, doc: OTDoc<any>, ops: JSONPatchOp[]): Promise<Change> {
  doc._applyOptimistic(ops);
  const [change] = await algorithm.handleDocChange(DOC_ID, ops, doc, {});
  return change;
}

/** Another context sharing the store receives `committed` first: the store moves, this doc does not. */
async function otherTabReceives(store: OTInMemoryStore, committed: Change[]): Promise<void> {
  const pending = await store.getPendingChanges(DOC_ID);
  const tailRev = pending[pending.length - 1]?.rev;
  await store.applyServerChanges(DOC_ID, committed, rebaseChanges(committed, pending), tailRev);
}

const committed = (baseRev: number, rev: number, ops: JSONPatchOp[], id: string): Change => ({
  ...createChange(baseRev, rev, ops, {}, id),
  committedAt: Date.now(),
});

describe('DAB-1760: rows on the doc frame cross a batch through the doc copies of the store rows', () => {
  it('a doc-only (torn write) row is walked behind the store rows, not alone', async () => {
    const { store, algorithm, doc } = await openAt(BASE, 1);

    // A store row S, then a doc-only row D minted on top of it (the store never took D).
    const sOps: JSONPatchOp[] = [{ op: 'add', path: '/a/0', value: 's' }];
    const S = await mint(algorithm, doc, sOps);
    const dOps: JSONPatchOp[] = [{ op: 'add', path: '/a/2', value: 'd' }]; // s, p, d, q, r
    doc._applyOptimistic(dOps);
    // Rev 9, not 3: the other tab's receive re-sequences S to 3, and a doc-only row at or below
    // the store tail reads as a stale copy and is withheld — a separate collision, not the
    // context question pinned here.
    const D = createChange(1, 9, dOps, {}, 'D');
    doc.applyChanges([D]);
    expect(doc.state).toEqual({ a: ['s', 'p', 'd', 'q', 'r'] });
    expect((await store.getPendingChanges(DOC_ID)).map(c => c.id)).toEqual([S.id]);

    // A foreign insert before q lands in another tab first.
    const F = committed(1, 2, [{ op: 'add', path: '/a/1', value: 'f' }], 'F');
    await otherTabReceives(store, [F]);
    await algorithm.applyServerChanges(DOC_ID, [F], doc);

    // The doc-frame walk: F through S, then D — not D across F on its own.
    const expected = rebaseChanges(
      [F],
      [
        { ...S, ops: sOps },
        { ...D, ops: dOps },
      ]
    ).find(c => c.id === 'D')!;
    expect(expected.ops).toEqual([{ op: 'add', path: '/a/2', value: 'd' }]);
    const stored = (await store.getPendingChanges(DOC_ID)).find(c => c.id === 'D')!;
    expect(stored.ops).toEqual(expected.ops);
    // The view and the queue agree: committed p, f, q, r + S at 0 + D at 2.
    expect(doc.state).toEqual({ a: ['s', 'p', 'd', 'f', 'q', 'r'] });
  });

  it('a frozen outbox row is walked behind the doc copies of the store rows, not the store-frame copies', async () => {
    const { store, algorithm, doc } = await openAt(BASE, 1);

    // A store row S, then an outbox row U the store refused, minted on top of S.
    const sOps: JSONPatchOp[] = [{ op: 'add', path: '/a/1', value: 's' }];
    const S = await mint(algorithm, doc, sOps);
    const uOps: JSONPatchOp[] = [{ op: 'add', path: '/a/1', value: 'u' }]; // p, u, s, q, r
    doc._applyOptimistic(uOps);
    algorithm.queueUnstoredChange(DOC_ID, uOps, doc, {}, 'U');
    // The doc closes, freezing U on its frame (rev 1); it reopens from the store with S pending.
    algorithm.detachUnstoredChanges(DOC_ID, doc);
    const reopened = algorithm.createDoc<any>(
      DOC_ID,
      (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>
    ) as OTDoc<any>;
    expect(reopened.committedRev).toBe(1);
    expect(algorithm.listUnstoredChanges(DOC_ID)[0]).toMatchObject({ id: 'U', baseRev: 1 });

    // A foreign remove of p lands in another tab first.
    const F = committed(1, 2, [{ op: 'remove', path: '/a/0' }], 'F');
    await otherTabReceives(store, [F]);
    await algorithm.applyServerChanges(DOC_ID, [F], reopened);

    const expected = rebaseChanges([F], [{ ...S, ops: sOps }, createChange(1, 3, uOps, {}, 'U')]).find(
      c => c.id === 'U'
    )!;
    expect(expected.ops).toEqual([{ op: 'add', path: '/a/0', value: 'u' }]); // u, s, q, r
    expect(algorithm.listUnstoredChanges(DOC_ID)[0].ops).toEqual(expected.ops);
  });

  // The DAB-1755 shape on these paths: the other tab receives the echo of our own S first, which
  // retires S from the shared store. S is then in neither the store queue nor the merged doc-only
  // set, so only the doc's whole pending queue still carries it as context.
  it("a frozen outbox row minted over our own S is not shifted by S's echo", async () => {
    const { store, algorithm, doc } = await openAt(BASE, 1);
    const sOps: JSONPatchOp[] = [{ op: 'add', path: '/a/0', value: 's' }];
    const S = await mint(algorithm, doc, sOps);
    const T = await mint(algorithm, doc, [{ op: 'add', path: '/a/1', value: 't' }]);
    const uOps: JSONPatchOp[] = [{ op: 'add', path: '/a/2', value: 'u' }]; // s, t, u, p, q, r
    doc._applyOptimistic(uOps);
    algorithm.queueUnstoredChange(DOC_ID, uOps, doc, {}, 'U');
    algorithm.detachUnstoredChanges(DOC_ID, doc);
    const reopened = algorithm.createDoc<any>(
      DOC_ID,
      (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>
    ) as OTDoc<any>;
    expect(reopened.getPendingChanges().map(c => c.id)).toEqual([S.id, T.id]);

    const E = committed(1, 2, sOps, S.id);
    await otherTabReceives(store, [E]);
    expect((await store.getPendingChanges(DOC_ID)).map(c => c.id)).toEqual([T.id]);
    await algorithm.applyServerChanges(DOC_ID, [E], reopened);

    expect(algorithm.listUnstoredChanges(DOC_ID)[0].ops).toEqual(uOps);
  });

  it("a doc-only row minted over our own S is not shifted by S's echo, and the view agrees", async () => {
    const { store, algorithm, doc } = await openAt(BASE, 1);
    const sOps: JSONPatchOp[] = [{ op: 'add', path: '/a/0', value: 's' }];
    const S = await mint(algorithm, doc, sOps);
    await mint(algorithm, doc, [{ op: 'add', path: '/a/1', value: 't' }]);
    const dOps: JSONPatchOp[] = [{ op: 'add', path: '/a/2', value: 'd' }]; // s, t, d, p, q, r
    doc._applyOptimistic(dOps);
    doc.applyChanges([createChange(1, 9, dOps, {}, 'D')]);

    const E = committed(1, 2, sOps, S.id);
    await otherTabReceives(store, [E]);
    await algorithm.applyServerChanges(DOC_ID, [E], doc);

    expect((await store.getPendingChanges(DOC_ID)).find(c => c.id === 'D')!.ops).toEqual(dOps);
    expect(doc.state).toEqual({ a: ['s', 't', 'd', 'p', 'q', 'r'] });
  });
});
