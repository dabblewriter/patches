import { describe, expect, it } from 'vitest';
import { commitChanges } from '../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change, PatchesSnapshot } from '../../src/types';
import { OTFuzzBackend } from '../fuzz/otFuzzBackend';

/**
 * DAB-1755 (fuzz seed 1001691, faults + unstored, normalization off): a snapshot reload whose
 * `reconcilePending` commits but whose `saveDoc` fails leaves the STORE on the reload's frame
 * (committed tail installed, pending rebased across it) while the open doc still sits on the old
 * one. The next delivery of that same tail is contiguous for the doc, so the receive path trusts
 * the doc's committedRev and rebases the store's pending queue across the tail a SECOND time —
 * every array index in it shifts twice. The doubled row is then sent: one past the end (poison,
 * or a commit-time clamp), or silently misplaced.
 *
 * The same split is the everyday state of a second tab: tabs share one store, and dw3 fans each
 * tab's commits out to the others (`pupSync.applyPeerCommitted`), which receive a batch the store
 * already applied. When that batch is the committing tab's own echo, the echo's row has already
 * left the shared queue, so the second tab reads it as FOREIGN and shifts the rest of the burst
 * past it — the production shape behind the DAB-1755 commit-time clamps.
 */

const TIMEOUT = 30 * 60_000;
const DOC_ID = 'doc1';

async function seedServer(backend: OTFuzzBackend, state: object): Promise<void> {
  await commitChanges(
    backend,
    DOC_ID,
    [{ id: 'seed', rev: 1, baseRev: 0, ops: [{ op: 'replace', path: '', value: state }], createdAt: 0 }],
    TIMEOUT
  );
}

async function openAt(state: object, rev: number) {
  const store = new OTInMemoryStore();
  const algorithm = new OTAlgorithm(store);
  await store.trackDocs([DOC_ID]);
  await store.saveDoc(DOC_ID, { state, rev });
  const doc = algorithm.createDoc<any>(DOC_ID, (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>) as OTDoc<any>;
  return { store, algorithm, doc };
}

async function mint(algorithm: OTAlgorithm, doc: OTDoc<any>, ops: JSONPatchOp[]): Promise<Change[]> {
  doc._applyOptimistic(ops);
  return algorithm.handleDocChange(DOC_ID, ops, doc, {});
}

async function commitForeign(backend: OTFuzzBackend, id: string, baseRev: number, ops: JSONPatchOp[]): Promise<Change> {
  const { newChanges } = await commitChanges(
    backend,
    DOC_ID,
    [createChange(baseRev, baseRev + 1, ops, {}, id)],
    TIMEOUT
  );
  return newChanges[0];
}

describe('DAB-1755: a receive after a torn reload does not rebase pending across the tail twice', () => {
  it('the store already reconciled the tail; delivering it to the doc must not shift pending again', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend, { tags: ['draft'] });
    const { store, algorithm, doc } = await openAt({ tags: ['draft'] }, 1);

    // Local edit on the doc's frame: retitle tag 0.
    await mint(algorithm, doc, [{ op: 'replace', path: '/tags/0', value: 'quill' }]);

    // Someone else inserts a tag at the front (rev 2).
    const f2 = await commitForeign(backend, 'f2', 1, [{ op: 'add', path: '/tags/0', value: 'ink' }]);

    // A snapshot reload starts: reconcilePending installs rev 2 and rebases the queue across it
    // (replace /tags/0 → /tags/1) in one store transaction. Then the reload's saveDoc fails, so
    // the doc is never re-imported: it is still at rev 1.
    await algorithm.reconcilePending!(DOC_ID, [f2]);
    expect(await store.getCommittedRev(DOC_ID)).toBe(2);
    expect((await store.getPendingChanges(DOC_ID))[0].ops).toEqual([
      { op: 'replace', path: '/tags/1', value: 'quill' },
    ]);
    expect(doc.committedRev).toBe(1);

    // The broadcast of rev 2 now reaches the doc. It is contiguous for the doc (1 → 2).
    await algorithm.applyServerChanges(DOC_ID, [f2], doc);

    // The pending edit is shifted by the foreign insert ONCE, not twice.
    const pending = await store.getPendingChanges(DOC_ID);
    expect(pending.map(c => c.ops)).toEqual([[{ op: 'replace', path: '/tags/1', value: 'quill' }]]);
    expect(doc.committedRev).toBe(2);
    expect(doc.state).toEqual({ tags: ['ink', 'quill'] });

    // And it commits in range: the server head strict-replays to the intended state.
    const batch = await algorithm.getPendingToSend(DOC_ID, doc);
    const { newChanges } = await commitChanges(backend, DOC_ID, structuredClone(batch!), TIMEOUT, {
      normalizeArrayIndices: false,
    });
    await algorithm.applyServerChanges(DOC_ID, newChanges, doc);
    expect(applyChanges(null as any, backend.log(DOC_ID))).toEqual({ tags: ['ink', 'quill'] });
  });

  it('the +1 shape: an append minted from the doc after the torn reload lands at the committed end', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend, { cols: ['a'] });
    const { store, algorithm, doc } = await openAt({ cols: ['a'] }, 1);

    await mint(algorithm, doc, [{ op: 'add', path: '/cols/1', value: 'b' }]);
    const f2 = await commitForeign(backend, 'f2', 1, [{ op: 'add', path: '/cols/0', value: 'z' }]);

    await algorithm.reconcilePending!(DOC_ID, [f2]);
    await algorithm.applyServerChanges(DOC_ID, [f2], doc);

    expect((await store.getPendingChanges(DOC_ID)).map(c => c.ops)).toEqual([
      [{ op: 'add', path: '/cols/2', value: 'b' }],
    ]);
    expect(doc.state).toEqual({ cols: ['z', 'a', 'b'] });

    // The next append reads cols.length from this view.
    const [next] = await mint(algorithm, doc, [{ op: 'add', path: `/cols/${doc.state.cols.length}`, value: 'c' }]);
    expect(next.ops).toEqual([{ op: 'add', path: '/cols/3', value: 'c' }]);

    const batch = await algorithm.getPendingToSend(DOC_ID, doc);
    await commitChanges(backend, DOC_ID, structuredClone(batch!), TIMEOUT, { normalizeArrayIndices: false });
    expect(applyChanges(null as any, backend.log(DOC_ID))).toEqual({ cols: ['z', 'a', 'b', 'c'] });
  });
});

describe('DAB-1755: two contexts sharing one store (tabs) each receive the same batch', () => {
  it('the second context to receive a batch does not rebase the shared queue across it again', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend, { cols: ['a'] });
    const store = new OTInMemoryStore();
    await store.trackDocs([DOC_ID]);
    await store.saveDoc(DOC_ID, { state: { cols: ['a'] }, rev: 1 });
    const algA = new OTAlgorithm(store);
    const algB = new OTAlgorithm(store);
    const docA = algA.createDoc<any>(DOC_ID, (await algA.loadDoc(DOC_ID)) as PatchesSnapshot<any>) as OTDoc<any>;
    const docB = algB.createDoc<any>(DOC_ID, (await algB.loadDoc(DOC_ID)) as PatchesSnapshot<any>) as OTDoc<any>;

    // Tab A appends 'b' (pending in the shared store).
    await mint(algA, docA, [{ op: 'add', path: '/cols/1', value: 'b' }]);
    const f2 = await commitForeign(backend, 'f2', 1, [{ op: 'add', path: '/cols/0', value: 'z' }]);

    // Both tabs receive the broadcast: A first, then B.
    await algA.applyServerChanges(DOC_ID, [f2], docA);
    await algB.applyServerChanges(DOC_ID, [f2], docB);

    expect((await store.getPendingChanges(DOC_ID)).map(c => c.ops)).toEqual([
      [{ op: 'add', path: '/cols/2', value: 'b' }],
    ]);
  });

  it('the 7mjq shape: a peer tab re-applying our OWN echo shifts the rest of our burst by one', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend, { cols: ['a'] });
    const store = new OTInMemoryStore();
    await store.trackDocs([DOC_ID]);
    await store.saveDoc(DOC_ID, { state: { cols: ['a'] }, rev: 1 });
    const algA = new OTAlgorithm(store);
    const algB = new OTAlgorithm(store);
    const docA = algA.createDoc<any>(DOC_ID, (await algA.loadDoc(DOC_ID)) as PatchesSnapshot<any>) as OTDoc<any>;
    const docB = algB.createDoc<any>(DOC_ID, (await algB.loadDoc(DOC_ID)) as PatchesSnapshot<any>) as OTDoc<any>;

    // Tab A (leader) mints a burst of appends; only the first is flushed.
    await mint(algA, docA, [{ op: 'add', path: '/cols/1', value: 'oyMx' }]);
    const first = await algA.getPendingToSend(DOC_ID, docA);
    const { newChanges } = await commitChanges(backend, DOC_ID, structuredClone(first!.slice(0, 1)), TIMEOUT);
    await mint(algA, docA, [{ op: 'add', path: '/cols/2', value: 'n8jQ' }]);
    await mint(algA, docA, [{ op: 'add', path: '/cols/3', value: '1U9U' }]);

    // A applies its own echo; then the fan-out reaches tab B (pupSync.applyPeerCommitted).
    await algA.applyServerChanges(DOC_ID, newChanges, docA);
    await algB.applyServerChanges(DOC_ID, newChanges, docB);

    // The queued appends must still target 2 and 3. B finds the echo's id gone from the shared
    // queue (A retired it), treats it as foreign, and walks the queue across it: 3 and 4.
    expect((await store.getPendingChanges(DOC_ID)).map(c => c.ops[0].path)).toEqual(['/cols/2', '/cols/3']);
  });
});
