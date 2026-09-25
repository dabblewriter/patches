import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OTDoc } from '../../src/client/OTDoc';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import { LWWIndexedDBStore } from '../../src/client/LWWIndexedDBStore';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { createChange } from '../../src/data/change';

/**
 * `listDocIdsWithPending` is the bulk form of `hasPending` (DAB-1616). Two things have to
 * hold, and the second is the whole reason it exists:
 *
 *   1. It agrees with `hasPending`, doc for doc, across every tier `hasPending` consults.
 *   2. It costs a bounded number of IndexedDB transactions — NOT one (LWW: two) per tracked
 *      doc. The per-doc shape put ~955 transactions on a 586-doc account through a single
 *      `Promise.all`, on every cold boot and again on every 60-second idle sweep, against
 *      stores that are empty for almost everyone.
 *
 * The cost assertions below are the regression guard for (2), so they count transactions
 * rather than assert a duration — the number is the invariant, and a timing assertion would
 * only be flaky about it.
 */

const op = (path: string, value: string, ts = 1000) => ({ op: 'replace' as const, path, value, ts });

describe('LWWAlgorithm.listDocIdsWithPending', () => {
  let store: LWWInMemoryStore;
  let algorithm: LWWAlgorithm;

  beforeEach(async () => {
    store = new LWWInMemoryStore();
    algorithm = new LWWAlgorithm(store);
    await store.trackDocs(['clean', 'withOps', 'withSending', 'withBoth']);
  });

  it('is empty when nothing is pending', async () => {
    expect(await algorithm.listDocIdsWithPending()).toEqual(new Set());
  });

  it('reports docs with pending ops, with a sending change, or with both — and no others', async () => {
    await store.savePendingOps('withOps', [op('/title', 'hello')]);

    // saveSendingChange clears pendingOps, so this doc has ONLY a sending change.
    await store.saveSendingChange('withSending', createChange(0, 1, [op('/title', 'sent')]));

    await store.saveSendingChange('withBoth', createChange(0, 1, [op('/title', 'sent')]));
    await store.savePendingOps('withBoth', [op('/name', 'world', 2000)]);

    expect(await algorithm.listDocIdsWithPending()).toEqual(new Set(['withOps', 'withSending', 'withBoth']));
  });

  it('agrees with hasPending for every tracked doc', async () => {
    await store.savePendingOps('withOps', [op('/title', 'hello')]);
    await store.saveSendingChange('withSending', createChange(0, 1, [op('/title', 'sent')]));

    const bulk = await algorithm.listDocIdsWithPending();
    for (const { docId } of await store.listDocs()) {
      expect(bulk.has(docId)).toBe(await algorithm.hasPending(docId));
    }
  });

  it('drops a doc once its pending work is confirmed', async () => {
    await store.savePendingOps('withOps', [op('/title', 'hello')]);
    const change = (await algorithm.getPendingToSend('withOps'))!;
    expect(await algorithm.listDocIdsWithPending()).toEqual(new Set(['withOps']));

    await algorithm.confirmSent('withOps', change);
    expect(await algorithm.listDocIdsWithPending()).toEqual(new Set());
  });
});

describe('OTAlgorithm.listDocIdsWithPending', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['clean', 'withPending', 'withUnstored']);
  });

  it('is empty when nothing is pending', async () => {
    expect(await algorithm.listDocIdsWithPending()).toEqual(new Set());
  });

  it('reports docs with pending changes in the store', async () => {
    await store.savePendingChanges('withPending', [
      createChange(0, 1, [{ op: 'replace', path: '/title', value: 'x' }]),
    ]);

    expect(await algorithm.listDocIdsWithPending()).toEqual(new Set(['withPending']));
  });

  it('reports a doc whose only pending work is an unstored outbox row', async () => {
    // Storage hardening A1: a change the store REFUSED lives in memory only. `hasPending`
    // checks `hasUnstoredChanges` before it reads the store, so the bulk form has to union
    // the outbox in or a degraded doc would read as clean — exactly the doc most at risk.
    await store.saveDoc('withUnstored', { state: { items: ['a'] }, rev: 5 });
    const doc = algorithm.createDoc('withUnstored', {
      state: { items: ['a'] },
      rev: 5,
      changes: [],
    }) as unknown as OTDoc<any>;

    let emitted: any[] = [];
    const off = doc.onChange(ops => (emitted = ops));
    doc.change(patch => patch.add('/items/-', 'u'));
    off();
    algorithm.queueUnstoredChange('withUnstored', emitted, doc, {}, 'refused');

    expect(await store.getPendingChanges('withUnstored')).toEqual([]);
    expect(await algorithm.hasPending('withUnstored')).toBe(true);
    expect(await algorithm.listDocIdsWithPending()).toEqual(new Set(['withUnstored']));
  });

  it('agrees with hasPending for every tracked doc', async () => {
    await store.savePendingChanges('withPending', [
      createChange(0, 1, [{ op: 'replace', path: '/title', value: 'x' }]),
    ]);

    const bulk = await algorithm.listDocIdsWithPending();
    for (const { docId } of await store.listDocs()) {
      expect(bulk.has(docId)).toBe(await algorithm.hasPending(docId));
    }
  });
});

/**
 * `listDocIdsWithPending` is optional on all three interfaces, following this repo's convention
 * for capability additions (`hasPendingBeyond?`, `listChanges?`) — a store that cannot enumerate
 * its pending keys omits it and keeps compiling. The algorithms must then fall back to the
 * per-doc reads: slower, but the same answer. A silent wrong answer here would be worse than the
 * cost this whole change exists to remove.
 */
describe('fallback when the store does not implement listDocIdsWithPending', () => {
  /** Hide the method on one instance, as an external store that never defined it would. */
  function withoutBulkQuery<T extends object>(store: T): T {
    Object.defineProperty(store, 'listDocIdsWithPending', { value: undefined, configurable: true });
    return store;
  }

  it('LWW: falls back to the per-doc reads and returns the same set', async () => {
    const store = withoutBulkQuery(new LWWInMemoryStore());
    const algorithm = new LWWAlgorithm(store);
    await store.trackDocs(['clean', 'withOps', 'withSending']);
    await store.savePendingOps('withOps', [op('/title', 'hello')]);
    await store.saveSendingChange('withSending', createChange(0, 1, [op('/title', 'sent')]));

    expect(store.listDocIdsWithPending).toBeUndefined();
    expect(await algorithm.listDocIdsWithPending()).toEqual(new Set(['withOps', 'withSending']));
  });

  it('OT: falls back to the per-doc reads and still unions the in-memory outbox', async () => {
    const store = withoutBulkQuery(new OTInMemoryStore());
    const algorithm = new OTAlgorithm(store);
    await store.trackDocs(['clean', 'withPending', 'withUnstored']);
    await store.savePendingChanges('withPending', [
      createChange(0, 1, [{ op: 'replace', path: '/title', value: 'x' }]),
    ]);

    await store.saveDoc('withUnstored', { state: { items: ['a'] }, rev: 5 });
    const doc = algorithm.createDoc('withUnstored', {
      state: { items: ['a'] },
      rev: 5,
      changes: [],
    }) as unknown as OTDoc<any>;
    let emitted: any[] = [];
    const off = doc.onChange(ops => (emitted = ops));
    doc.change(patch => patch.add('/items/-', 'u'));
    off();
    algorithm.queueUnstoredChange('withUnstored', emitted, doc, {}, 'refused');

    expect(store.listDocIdsWithPending).toBeUndefined();
    expect(await algorithm.listDocIdsWithPending()).toEqual(new Set(['withPending', 'withUnstored']));
  });
});

/**
 * The cost guard. Counts real IndexedDB transactions opened during the call, over
 * fake-indexeddb with the real stores — the boot seed's exact shape, just smaller.
 */
describe('listDocIdsWithPending transaction cost (real stores over fake-indexeddb)', () => {
  const DOC_COUNT = 40;
  let dbSeq = 0;
  let opened: number;
  let restore: () => void;

  beforeEach(() => {
    opened = 0;
    const proto = IDBDatabase.prototype;
    const original = proto.transaction;
    const spy = vi.spyOn(proto, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase['transaction']>
    ) {
      opened++;
      return original.apply(this, args);
    });
    restore = () => spy.mockRestore();
  });

  afterEach(() => restore());

  it('LWW: one transaction for the whole account, not two per doc', async () => {
    const store = new LWWIndexedDBStore(`lww-bulk-pending-${dbSeq++}`);
    const docIds = Array.from({ length: DOC_COUNT }, (_, i) => `doc${i}`);
    await store.trackDocs(docIds);
    // One doc is dirty; the rest are the common case the per-doc fan wasted a transaction on.
    await store.savePendingOps('doc7', [op('/title', 'hello')]);

    opened = 0;
    const pending = await store.listDocIdsWithPending();

    expect(pending).toEqual(new Set(['doc7']));
    expect(opened).toBe(1);

    // What it replaces, measured on the same store: listDocs + hasPending per doc.
    opened = 0;
    const algorithm = new LWWAlgorithm(store);
    for (const { docId } of await store.listDocs()) await algorithm.hasPending(docId);
    expect(opened).toBeGreaterThanOrEqual(2 * DOC_COUNT);

    await store.close();
  });

  // The production LWW store reads TWO stores, and the sendingChanges half had no coverage at
  // all until this case: deleting `for (const docId of sendingKeys)` from the implementation
  // left the entire 3,855-test suite green. A doc mid-flush is exactly the doc that matters —
  // `saveSendingChange` clears every pendingOps row, so its ONLY pending trace is the
  // sendingChanges row, and missing it reports unflushed work as clean.
  it('LWW: finds a doc whose only pending trace is an in-flight sending change', async () => {
    const store = new LWWIndexedDBStore(`lww-bulk-pending-sending-${dbSeq++}`);
    await store.trackDocs(['clean', 'flushing']);
    await store.savePendingOps('flushing', [op('/title', 'hello')]);
    await store.saveSendingChange('flushing', createChange(0, 1, [op('/title', 'hello')]));

    // saveSendingChange cleared the pendingOps rows — sendingChanges is the only trace left.
    expect(await store.getPendingOps('flushing')).toEqual([]);

    opened = 0;
    expect(await store.listDocIdsWithPending()).toEqual(new Set(['flushing']));
    expect(opened).toBe(1);

    await store.close();
  });

  it('OT: one transaction for the whole account, not one per doc', async () => {
    const store = new OTIndexedDBStore(`ot-bulk-pending-${dbSeq++}`);
    const docIds = Array.from({ length: DOC_COUNT }, (_, i) => `doc${i}`);
    await store.trackDocs(docIds);
    await store.savePendingChanges('doc7', [createChange(0, 1, [{ op: 'replace', path: '/title', value: 'x' }])]);

    opened = 0;
    const pending = await store.listDocIdsWithPending();

    expect(pending).toEqual(new Set(['doc7']));
    expect(opened).toBe(1);

    opened = 0;
    const algorithm = new OTAlgorithm(store);
    for (const { docId } of await store.listDocs()) await algorithm.hasPending(docId);
    expect(opened).toBeGreaterThanOrEqual(DOC_COUNT);

    await store.close();
  });

  it('LWW: cost does not grow with the account — 4× the docs, same one transaction', async () => {
    const store = new LWWIndexedDBStore(`lww-bulk-pending-scale-${dbSeq++}`);
    await store.trackDocs(Array.from({ length: DOC_COUNT * 4 }, (_, i) => `doc${i}`));

    opened = 0;
    await store.listDocIdsWithPending();
    expect(opened).toBe(1);

    await store.close();
  });
});
