import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitChanges } from '../../src/algorithms/ot/server/commitChanges';
import { ApplyChangesError, applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import type { OTClientStore } from '../../src/client/OTClientStore';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { Patches } from '../../src/client/Patches';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';
import { OTFuzzBackend } from '../fuzz/otFuzzBackend';

/**
 * What a hydration "drop" does and does not do, end to end over a real store, algorithm and
 * server commit, once per store.
 *
 * OTDoc's constructor leaves out of its view the pending changes that fail strict apply
 * against the committed state, and `Patches.openDoc` reports them through `onPendingDropped`.
 * That is the whole of it: the store keeps the rows, the send path reads the store, and the
 * server commits them. The comments on that path once said the next pending write made the
 * truncation permanent. It does not, and these tests hold the description to the behaviour.
 *
 * The assertions name the change that fails and leave open what happens to the change built
 * on it, so they hold whether or not that later change is left out with it.
 */

const TIMEOUT = 30 * 60_000;
const DOC_ID = 'doc1';
const COMMITTED = { docs: { group: { id: 'group', children: [] as string[] } } };

let dbSeq = 0;

const STORES: [string, () => OTClientStore][] = [
  ['OTInMemoryStore', () => new OTInMemoryStore()],
  ['OTIndexedDBStore', () => new OTIndexedDBStore(`hydration-drop-${dbSeq++}`)],
];

/** One flush pass, wired the way PatchesSync.flushDoc drives it (clone = the wire boundary). */
async function flushOnce(algorithm: OTAlgorithm, backend: OTFuzzBackend, doc: OTDoc<any>): Promise<Change[]> {
  const batch = await algorithm.getPendingToSend(DOC_ID, doc);
  if (!batch) return [];
  const { catchupChanges, newChanges } = await commitChanges(backend, DOC_ID, structuredClone(batch), TIMEOUT);
  const committed = [...catchupChanges, ...newChanges].sort((a, b) => a.rev - b.rev);
  if (committed.length > 0) await algorithm.applyServerChanges(DOC_ID, committed, doc);
  return batch;
}

const ids = (changes: Change[]) => changes.map(c => c.id);

describe.each(STORES)('a pending change left out of the view at hydration — %s', (_name, makeStore) => {
  let patches: InstanceType<typeof Patches> | undefined;

  afterEach(async () => {
    await patches?.close();
    patches = undefined;
    vi.restoreAllMocks();
  });

  /**
   * Server and client both at rev 1 with an empty `group.children`, and `pending` queued in the
   * client's store. Opens the doc through a real Patches, collecting `onPendingDropped`.
   */
  async function open(pending: Change[]) {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const backend = new OTFuzzBackend();
    await commitChanges(
      backend,
      DOC_ID,
      [{ id: 'seed', rev: 1, baseRev: 0, ops: [{ op: 'replace', path: '', value: COMMITTED }], createdAt: 0 }],
      TIMEOUT
    );
    const store = makeStore();
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs([DOC_ID]);
    await store.saveDoc(DOC_ID, { state: structuredClone(COMMITTED), rev: 1 });
    await store.savePendingChanges(DOC_ID, pending);

    patches = new Patches({ algorithms: { ot: algorithm } });
    const reported: string[] = [];
    patches.onPendingDropped((_docId, dropped) => reported.push(...ids(dropped)));
    const doc = (await patches.openDoc<any>(DOC_ID)) as unknown as OTDoc<any>;
    return { backend, store, algorithm, doc, reported, consoleError };
  }

  /**
   * A create whose listing index is one past the end of `group.children` (fails strict apply
   * locally; the server corrects the index), then a change that adds a child to what it created.
   */
  function createThenAddChild() {
    const create = createChange(1, 2, [
      { op: 'add', path: '/docs/timeline', value: { id: 'timeline', type: 'timeline', children: ['track'] } },
      { op: 'add', path: '/docs/group/children/1', value: 'timeline' },
    ]);
    const addChild = createChange(1, 3, [
      { op: 'add', path: '/docs/event', value: { id: 'event', type: 'event' } },
      { op: 'add', path: '/docs/timeline/children/1', value: 'event' },
    ]);
    return { create, addChild };
  }

  const COMPLETE = {
    group: { id: 'group', children: ['timeline'] },
    timeline: { id: 'timeline', type: 'timeline', children: ['track', 'event'] },
    event: { id: 'event', type: 'event' },
  };

  it('keeps every row in the store: only the doc and its view go without the change', async () => {
    const { create, addChild } = createThenAddChild();
    const { store, doc, reported, consoleError } = await open([create, addChild]);

    expect(reported).toContain(create.id);
    expect(ids(doc.getPendingChanges())).not.toContain(create.id);
    expect(doc.state.docs.group.children).toEqual([]);

    expect(ids(await store.getPendingChanges(DOC_ID))).toEqual([create.id, addChild.id]);
    // The console line says the same thing the store does.
    expect(String(consoleError.mock.calls[0][0])).toContain('still queued in the store and will be sent');
  });

  it('sends the change it reported, and the server commits it whole', async () => {
    const { create, addChild } = createThenAddChild();
    const { backend, store, algorithm, doc, reported } = await open([create, addChild]);
    expect(reported).toContain(create.id);

    const sent = await flushOnce(algorithm, backend, doc);

    expect(ids(sent)).toEqual([create.id, addChild.id]);
    // Committed, with the listing index corrected from 1 to 0 (DAB-1557).
    const log = backend.log(DOC_ID);
    expect(ids(log)).toEqual(['seed', create.id, addChild.id]);
    expect(log[1].ops[1]).toEqual({ op: 'add', path: '/docs/group/children/0', value: 'timeline' });
    // So a consumer that kept the reported payload holds a copy of work that is now live.
    expect(ids(log)).toEqual(expect.arrayContaining(reported));

    const serverHead = applyChanges(null as any, log) as any;
    expect(serverHead.docs).toEqual(COMPLETE);
    expect(doc.state).toEqual(serverHead);
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
  });

  it('hands the change back to the doc on a receive that lands before the flush', async () => {
    const { create, addChild } = createThenAddChild();
    const { backend, store, algorithm, doc } = await open([create, addChild]);
    const { newChanges } = await commitChanges(
      backend,
      DOC_ID,
      [{ id: 'foreign', rev: 2, baseRev: 1, ops: [{ op: 'add', path: '/docs/note', value: { id: 'note' } }] }],
      TIMEOUT
    );

    // The receive rebases the STORE's queue and gives it to the doc, so the change is queued in
    // the doc again and its view is rebuilt under strict apply, which it still fails. The store
    // has already taken the batch by then. PatchesSync answers an ApplyChangesError from a
    // receive with a syncDoc, which is the flush below.
    await expect(algorithm.applyServerChanges(DOC_ID, newChanges, doc)).rejects.toBeInstanceOf(ApplyChangesError);

    expect(ids(doc.getPendingChanges())).toEqual([create.id, addChild.id]);
    expect(ids(await store.getPendingChanges(DOC_ID))).toEqual([create.id, addChild.id]);
    expect(await store.getCommittedRev(DOC_ID)).toBe(2);

    await flushOnce(algorithm, backend, doc);

    const serverHead = applyChanges(null as any, backend.log(DOC_ID)) as any;
    expect(serverHead.docs).toEqual({ ...COMPLETE, note: { id: 'note' } });
    expect(doc.state).toEqual(serverHead);
    expect(await store.getPendingChanges(DOC_ID)).toEqual([]);
  });

  it('sends a change the server does not correct, and the server commits it as sent', async () => {
    // A move from a path that does not exist fails strict apply here and on every replay.
    // Being left out of the view keeps it off neither the wire nor the committed log.
    const unappliable = createChange(1, 2, [{ op: 'move', from: '/docs/missing', path: '/docs/moved' }]);
    const independent = createChange(1, 3, [{ op: 'add', path: '/docs/note', value: { id: 'note' } }]);
    const { backend, store, algorithm, doc, reported } = await open([unappliable, independent]);

    expect(reported).toEqual([unappliable.id]);
    expect(ids(await store.getPendingChanges(DOC_ID))).toEqual([unappliable.id, independent.id]);

    const batch = await algorithm.getPendingToSend(DOC_ID, doc);
    expect(ids(batch!)).toEqual([unappliable.id, independent.id]);
    await commitChanges(backend, DOC_ID, structuredClone(batch!), TIMEOUT);

    const log = backend.log(DOC_ID);
    expect(ids(log)).toEqual(['seed', unappliable.id, independent.id]);
    expect(log[1].ops).toEqual(unappliable.ops);
  });
});
