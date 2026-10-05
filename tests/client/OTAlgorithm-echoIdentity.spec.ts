import { describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change, PatchesSnapshot } from '../../src/types';

/**
 * DAB-1409: `handleDocChange` must tell the doc which ids it minted BEFORE it awaits the store.
 * Under a slow store the change can be sent and its echo delivered to the doc (by another context)
 * while this mint is still waiting on its write — the DAB-1366 window. If the ids were recorded
 * only after the write, a server-TRANSFORMED echo arriving inside that window would read as
 * foreign and the doc would apply the edit twice. Real algorithm, real store; only the write is
 * held open.
 */

const DOC_ID = 'doc1';

async function openAt(state: object, rev: number) {
  const store = new OTInMemoryStore();
  const algorithm = new OTAlgorithm(store);
  await store.trackDocs([DOC_ID]);
  await store.saveDoc(DOC_ID, { state, rev });
  const doc = algorithm.createDoc<any>(DOC_ID, (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>) as OTDoc<any>;
  return { store, algorithm, doc };
}

/** Hold the store's pending write open until `release()`; `minted` resolves with what it was handed. */
function holdPendingWrite(store: OTInMemoryStore) {
  const save = store.savePendingChanges.bind(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  let seen!: (changes: Change[]) => void;
  const minted = new Promise<Change[]>(resolve => (seen = resolve));
  store.savePendingChanges = async (docId: string, changes: Change[]) => {
    seen(changes);
    await gate;
    return save(docId, changes);
  };
  return { minted, release };
}

describe('OTAlgorithm.handleDocChange — minted ids reach the doc before the store write (DAB-1409)', () => {
  it('a server-transformed echo delivered while the write is pending is applied once', async () => {
    const { store, algorithm, doc } = await openAt({ items: ['a', 'b'] }, 1);
    const { minted, release } = holdPendingWrite(store);

    const ops: JSONPatchOp[] = [{ op: 'add', path: '/items/1', value: 'X' }];
    doc._applyOptimistic(ops);
    const minting = algorithm.handleDocChange(DOC_ID, ops, doc, {});
    const [change] = await minted;

    // A foreign add at 0 committed first, so the server transformed ours to /items/2.
    doc.applyChanges([
      { id: 'f', baseRev: 1, rev: 2, ops: [{ op: 'add', path: '/items/0', value: 'W' }], createdAt: 1, committedAt: 1 },
      { ...change, baseRev: 1, rev: 3, ops: [{ op: 'add', path: '/items/2', value: 'X' }], committedAt: 1 },
    ]);

    expect(doc.state.items).toEqual(['W', 'a', 'X', 'b']);
    expect(doc.optimisticBatchCount).toBe(0);

    release();
    await minting;

    // The late local confirmation is for a change already committed: nothing re-queues.
    expect(doc.state.items).toEqual(['W', 'a', 'X', 'b']);
    expect(doc.getPendingChanges().map(c => c.id)).not.toContain(change.id);
  });
});
