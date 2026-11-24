import { describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import type { JSONPatchOp } from '../../src/json-patch/types';
import { UnstoredPendingError } from '../../src/net/error';
import type { Change, PatchesSnapshot } from '../../src/types';

/**
 * DAB-1386: `UnstoredPendingError` named changes that were committed on the server (11 of 12
 * sampled from production). The receive's store write landed but its promise rejected — the
 * IndexedDB guard rejects on its timeout before aborting, and a late abort does not undo a
 * transaction that already committed — so the open doc stayed a frame behind its store, still
 * holding its own committed change as pending, and the next flush withheld it as unstored.
 */
const DOC_ID = 'projects/p/content';

async function setup() {
  const store = new OTInMemoryStore();
  const algorithm = new OTAlgorithm(store);
  await store.trackDocs([DOC_ID]);
  await store.saveDoc(DOC_ID, { state: { body: 'a' }, rev: 1 });
  const doc = algorithm.createDoc<any>(DOC_ID, (await algorithm.loadDoc(DOC_ID)) as PatchesSnapshot<any>) as OTDoc<any>;
  const errors: unknown[] = [];
  algorithm.onError((err: unknown) => errors.push(err));
  return { store, algorithm, doc, errors };
}

async function mint(algorithm: OTAlgorithm, doc: OTDoc<any>, ops: JSONPatchOp[]): Promise<Change[]> {
  doc._applyOptimistic(ops);
  return algorithm.handleDocChange(DOC_ID, ops, doc, {});
}

/** Mint X and Y; return X as the server commits it at rev 2. */
async function mintTwoAndCommitFirst(algorithm: OTAlgorithm, doc: OTDoc<any>) {
  const [x] = await mint(algorithm, doc, [{ op: 'replace', path: '/x', value: 1 }]);
  const [y] = await mint(algorithm, doc, [{ op: 'replace', path: '/y', value: 2 }]);
  const committedX: Change = { ...x, rev: 2, baseRev: 1, committedAt: Date.now() };
  return { x, y, committedX };
}

function timeoutError(): Error {
  return Object.assign(new Error('IndexedDB transaction did not settle within 4009ms'), {
    name: 'StorageTimeoutError',
  });
}

const unstored = (errors: unknown[]) => errors.filter(e => e instanceof UnstoredPendingError);

describe('OTAlgorithm.applyServerChanges when the store write throws (DAB-1386)', () => {
  it('finishes the receive when the batch landed despite the rejection', async () => {
    const { store, algorithm, doc, errors } = await setup();
    const { x, y, committedX } = await mintTwoAndCommitFirst(algorithm, doc);

    const real = store.applyServerChanges.bind(store);
    store.applyServerChanges = async (...args: Parameters<typeof real>) => {
      await real(...args);
      throw timeoutError();
    };
    await algorithm.applyServerChanges(DOC_ID, [committedX], doc);
    store.applyServerChanges = real;

    expect(doc.committedRev).toBe(2);
    expect(doc.getPendingChanges().map(c => c.id)).toEqual([y.id]);
    expect(doc.state).toEqual({ body: 'a', x: 1, y: 2 });

    const toSend = await algorithm.getPendingToSend(DOC_ID, doc);
    expect(toSend!.map(c => c.id)).toEqual([y.id]);
    expect(toSend!.map(c => c.id)).not.toContain(x.id);
    expect(unstored(errors)).toHaveLength(0);
  });

  it('still throws when the write did not land', async () => {
    const { store, algorithm, doc } = await setup();
    const { x, committedX } = await mintTwoAndCommitFirst(algorithm, doc);

    store.applyServerChanges = async () => {
      throw timeoutError();
    };
    await expect(algorithm.applyServerChanges(DOC_ID, [committedX], doc)).rejects.toThrow(/did not settle/);
    expect(doc.committedRev).toBe(1);
    expect(doc.getPendingChanges().map(c => c.id)).toContain(x.id);
  });

  it('keeps the original error when the store cannot even be asked', async () => {
    const { store, algorithm, doc } = await setup();
    const { committedX } = await mintTwoAndCommitFirst(algorithm, doc);

    // The connection dies with the write: every read after it fails too.
    let dead = false;
    const realRev = store.getCommittedRev.bind(store);
    store.getCommittedRev = async (docId: string) => {
      if (dead) throw new Error('database connection is closing');
      return realRev(docId);
    };
    store.applyServerChanges = async () => {
      dead = true;
      throw timeoutError();
    };
    await expect(algorithm.applyServerChanges(DOC_ID, [committedX], doc)).rejects.toThrow(/did not settle/);
  });

  it('keeps the original error when the store dies after confirming the batch', async () => {
    const { store, algorithm, doc } = await setup();
    const { committedX } = await mintTwoAndCommitFirst(algorithm, doc);

    // The probe sees the batch landed, then the connection goes before the queue can be re-read.
    const real = store.applyServerChanges.bind(store);
    store.applyServerChanges = async (...args: Parameters<typeof real>) => {
      await real(...args);
      store.getPendingChanges = async () => {
        throw new Error('database connection is closing');
      };
      throw timeoutError();
    };
    await expect(algorithm.applyServerChanges(DOC_ID, [committedX], doc)).rejects.toThrow(/did not settle/);
  });
});

describe('OTAlgorithm.getPendingToSend with the doc a frame behind its store (DAB-1386)', () => {
  it('catches the doc up instead of reporting its own committed change as unstored', async () => {
    const { store, algorithm, doc, errors } = await setup();
    const { x, y, committedX } = await mintTwoAndCommitFirst(algorithm, doc);

    // The store takes the batch and the doc never hears (another context's receive, or a
    // receive torn after its store write) — the store's queue is renumbered above the commit.
    const [, storedY] = await store.getPendingChanges(DOC_ID);
    await store.applyServerChanges(DOC_ID, [committedX], [{ ...storedY, rev: 3, baseRev: 2 }]);
    expect(doc.committedRev).toBe(1);

    const toSend = await algorithm.getPendingToSend(DOC_ID, doc);

    expect(unstored(errors)).toHaveLength(0);
    expect(toSend!.map(c => c.id)).toEqual([y.id]);
    expect(doc.committedRev).toBe(2);
    expect(doc.getPendingChanges().map(c => c.id)).not.toContain(x.id);
  });

  it('still reports a genuinely unstored row on an aligned doc', async () => {
    const { store, algorithm, doc, errors } = await setup();
    const [x] = await mint(algorithm, doc, [{ op: 'replace', path: '/x', value: 1 }]);
    await mint(algorithm, doc, [{ op: 'replace', path: '/y', value: 2 }]);

    // X leaves the store without the doc being told; the doc is on the store's frame.
    const [, storedY] = await store.getPendingChanges(DOC_ID);
    await store.applyServerChanges(DOC_ID, [], [{ ...storedY, rev: 2 }]);

    await algorithm.getPendingToSend(DOC_ID, doc);

    const reported = unstored(errors) as UnstoredPendingError[];
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain(x.id);
  });
});
