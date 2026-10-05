import { describe, expect, it } from 'vitest';
import { commitChanges } from '../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change, PatchesSnapshot } from '../../src/types';
import { OTFuzzBackend } from '../fuzz/otFuzzBackend';

/**
 * DAB-1755: production commits show a burst of N array inserts made in ONE synchronous tick
 * (dw3 `ensurePlotLineInGrid` in a loop, or a grid write plus its height pad) where the first
 * insert goes out alone and every later one reaches the server exactly one index past where it
 * was built — as if each had been rebased against its own predecessor's commit.
 *
 * These specs drive that burst through the real mint, send, server commit and receive paths and
 * assert that no change in the burst is shifted by the echo of its own predecessor, whatever
 * point in the serialized mint queue the echo lands at.
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

/** Commit the doc's sendable queue on the server (clone = the wire); returns the committed rows. */
async function commitQueue(algorithm: OTAlgorithm, backend: OTFuzzBackend, doc: OTDoc<any>): Promise<Change[]> {
  const batch = await algorithm.getPendingToSend(DOC_ID, doc);
  if (!batch) return [];
  const { catchupChanges, newChanges } = await commitChanges(backend, DOC_ID, structuredClone(batch), TIMEOUT);
  return [...catchupChanges, ...newChanges].sort((a, b) => a.rev - b.rev);
}

function strictHead(backend: OTFuzzBackend): any {
  return applyChanges(null as any, backend.log(DOC_ID));
}

/** The burst: N appends to `/cols`, each built in the view the previous one produced (one tick). */
function burst(doc: OTDoc<any>, names: string[]): JSONPatchOp[][] {
  return names.map(name => {
    const ops: JSONPatchOp[] = [{ op: 'add', path: `/cols/${doc.state.cols.length}`, value: name }];
    doc._applyOptimistic(ops);
    return ops;
  });
}

const NAMES = ['b', 'c', 'd', 'e', 'f', 'g'];

describe('DAB-1755: a burst minted in one tick is never shifted by its own echo', () => {
  // `echoAfter` = how many of the burst's mints have run when #1's commit echo is received.
  for (let echoAfter = 1; echoAfter <= NAMES.length; echoAfter++) {
    it(`echo of #1 received after ${echoAfter} mint(s)`, async () => {
      const backend = new OTFuzzBackend();
      await seedServer(backend, { cols: ['a'] });
      const { algorithm, doc } = await openAt({ cols: ['a'] }, 1);

      const opsList = burst(doc, NAMES);
      expect(opsList.map(ops => ops[0].path)).toEqual([
        '/cols/1',
        '/cols/2',
        '/cols/3',
        '/cols/4',
        '/cols/5',
        '/cols/6',
      ]);

      // Patches serializes mints per doc; #1 is minted and flushed alone.
      await algorithm.handleDocChange(DOC_ID, opsList[0], doc, {});
      const echo = await commitQueue(algorithm, backend, doc);
      expect(echo.map(c => c.ops[0].path)).toEqual(['/cols/1']);

      for (let i = 1; i < echoAfter; i++) await algorithm.handleDocChange(DOC_ID, opsList[i], doc, {});
      await algorithm.applyServerChanges(DOC_ID, echo, doc);
      for (let i = echoAfter; i < NAMES.length; i++) await algorithm.handleDocChange(DOC_ID, opsList[i], doc, {});

      const sent = await algorithm.getPendingToSend(DOC_ID, doc);
      expect(sent!.map(c => c.ops[0].path)).toEqual(['/cols/2', '/cols/3', '/cols/4', '/cols/5', '/cols/6']);

      await algorithm.applyServerChanges(DOC_ID, await commitQueue(algorithm, backend, doc), doc);
      expect(strictHead(backend)).toEqual({ cols: ['a', ...NAMES] });
      expect(doc.state).toEqual({ cols: ['a', ...NAMES] });
    });
  }

  it('echo delivered twice (commit response + broadcast) between mints', async () => {
    const backend = new OTFuzzBackend();
    await seedServer(backend, { cols: ['a'] });
    const { algorithm, doc } = await openAt({ cols: ['a'] }, 1);
    const opsList = burst(doc, NAMES);

    await algorithm.handleDocChange(DOC_ID, opsList[0], doc, {});
    const echo = await commitQueue(algorithm, backend, doc);
    await algorithm.handleDocChange(DOC_ID, opsList[1], doc, {});
    await algorithm.applyServerChanges(DOC_ID, echo, doc);
    await algorithm.applyServerChanges(DOC_ID, structuredClone(echo), doc);
    for (let i = 2; i < NAMES.length; i++) await algorithm.handleDocChange(DOC_ID, opsList[i], doc, {});

    const sent = await algorithm.getPendingToSend(DOC_ID, doc);
    expect(sent!.map(c => c.ops[0].path)).toEqual(['/cols/2', '/cols/3', '/cols/4', '/cols/5', '/cols/6']);
  });
});
