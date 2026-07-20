import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';

/**
 * DAB-783: N browser tabs share ONE IndexedDB, each with its own store instance over it, and
 * ANY tab may mint pending changes. There is no shared in-process lock across tabs — the
 * IndexedDB transaction is the cross-context arbiter and in-txn rev assignment is the sole
 * sequencer (R1). These exercise two store instances over one database (fake-indexeddb is a
 * shared backing store keyed by db name) to prove the guarantees hold with no shared lock.
 */
let dbSeq = 0;

describe('OTIndexedDBStore in-txn mint under a cross-context race (DAB-783)', () => {
  let dbName: string;
  let storeA: OTIndexedDBStore;
  let storeB: OTIndexedDBStore;

  beforeEach(async () => {
    dbName = `crosscontext-${dbSeq++}`;
    storeA = new OTIndexedDBStore(dbName);
    storeB = new OTIndexedDBStore(dbName);
    await storeA.saveDoc('doc1', { state: { committed: true }, rev: 4 });
  });

  it('assigns distinct, strictly increasing revs when two instances mint concurrently', async () => {
    const fromA = createChange(4, 5, [{ op: 'add', path: '/a', value: 1 }]);
    const fromB = createChange(4, 5, [{ op: 'add', path: '/b', value: 2 }]);

    // Two tabs mint for the same doc with no shared lock. Pre-R1 both stamp rev 5 and one
    // `[docId, rev]` row overwrites the other (silent loss); the in-txn mint serializes them.
    await Promise.all([storeA.savePendingChanges('doc1', [fromA]), storeB.savePendingChanges('doc1', [fromB])]);

    const pending = await storeA.getPendingChanges('doc1');
    expect(pending).toHaveLength(2); // neither mint lost
    const revs = pending.map(c => c.rev);
    expect(new Set(revs).size).toBe(2); // no rev collision
    expect([...revs].sort((x, y) => x - y)).toEqual([5, 6]); // strictly increasing off the tail
    expect(new Set(pending.map(c => c.id))).toEqual(new Set([fromA.id, fromB.id]));
  });

  it('re-stamps the passed change objects in place so callers carry the persisted rev', async () => {
    const a = createChange(4, 5, [{ op: 'add', path: '/a', value: 1 }]);
    const b = createChange(4, 5, [{ op: 'add', path: '/b', value: 2 }]);
    await storeA.savePendingChanges('doc1', [a]);
    await storeB.savePendingChanges('doc1', [b]);

    // Second writer read the first's row and stamped the next rev; the object reflects it.
    expect(a.rev).toBe(5);
    expect(b.rev).toBe(6);
  });
});

describe('OTAlgorithm.applyServerChanges conflict-safe replace (R2)', () => {
  let dbName: string;
  let store: OTIndexedDBStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    dbName = `conflict-replace-${dbSeq++}`;
    store = new OTIndexedDBStore(dbName);
    algorithm = new OTAlgorithm(store);
    await store.saveDoc('doc1', { state: { committed: true }, rev: 4 });
    // One un-sent local change already pending (baseRev 4, rev 5).
    await store.savePendingChanges('doc1', [createChange(4, 5, [{ op: 'add', path: '/local', value: 1 }])]);
  });

  it('retries and folds in a foreign mint that lands between the rebase read and the store replace', async () => {
    const foreignMint = createChange(4, 6, [{ op: 'add', path: '/foreign', value: 9 }]);
    let injected = false;
    // Land a foreign tab's mint into the shared store on the FIRST replace attempt, after the
    // algorithm has read pending but before its write commits. The store sees a row past the
    // caller's pendingTailRev and returns 'conflict'; the algorithm re-reads and recomputes.
    const realApply = store.applyServerChanges.bind(store);
    store.applyServerChanges = (async (docId, serverChanges, rebased, tailRev) => {
      if (!injected) {
        injected = true;
        const other = new OTIndexedDBStore(dbName);
        await other.savePendingChanges(docId, [foreignMint]);
      }
      return realApply(docId, serverChanges, rebased, tailRev);
    }) as typeof store.applyServerChanges;

    const serverChange = createChange(4, 5, [{ op: 'add', path: '/server', value: 1 }], { committedAt: 1000 });
    await algorithm.applyServerChanges('doc1', [serverChange], undefined);

    const pending = await store.getPendingChanges('doc1');
    const paths = pending.flatMap(c => c.ops.map(o => o.path));
    // Nothing wiped: the rebased local change AND the foreign mint both survive.
    expect(paths).toContain('/local');
    expect(paths).toContain('/foreign');
    expect(new Set(pending.map(c => c.rev)).size).toBe(pending.length); // distinct revs
    expect(injected).toBe(true); // the conflict path actually fired
  });

  it('applies cleanly with no conflict when no foreign mint races (single attempt)', async () => {
    let attempts = 0;
    const realApply = store.applyServerChanges.bind(store);
    store.applyServerChanges = (async (...args: Parameters<typeof store.applyServerChanges>) => {
      attempts++;
      return realApply(...args);
    }) as typeof store.applyServerChanges;

    const serverChange = createChange(4, 5, [{ op: 'add', path: '/server', value: 1 }], { committedAt: 1000 });
    await algorithm.applyServerChanges('doc1', [serverChange], undefined);

    expect(attempts).toBe(1);
    const pending = await store.getPendingChanges('doc1');
    expect(pending.flatMap((c: Change) => c.ops.map(o => o.path))).toContain('/local');
  });
});

/**
 * R2 conflict watermark: the pendingTailRev a receive/eject passes must be the STORE tail it read,
 * never inflated by a doc-only in-memory change merged for the torn-write rebase. When the open
 * doc holds a change one rev past the store tail, a foreign mint the store re-stamps to that SAME
 * rev is authoritative (it is the store row), and inflating the watermark to the doc-only rev
 * would make its conflict check `rev > tailRev` false — silently wiping the foreign row.
 */
describe('R2 pendingTailRev is the store tail, not the doc-merged max', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: {}, rev: 4 });
  });

  it('applyServerChanges does not wipe a foreign mint colliding a doc-only rev (finding 4)', async () => {
    // Open doc is one change ahead of the (empty) store: a doc-only change at rev 5 that a torn
    // write never persisted. A foreign tab then mints straight into the store; savePendingChanges
    // reads the store tail (4) and re-stamps it to rev 5 too — same rev as the doc-only change.
    const docOnly = createChange(4, 5, [{ op: 'add', path: '/docOnly', value: 1 }]);
    const foreign = createChange(4, 5, [{ op: 'add', path: '/foreign', value: 9 }]);
    const doc = { committedRev: 4, getPendingChanges: () => [docOnly], applyChanges: () => {} };

    let injected = false;
    const realApply = store.applyServerChanges.bind(store);
    store.applyServerChanges = (async (...args: Parameters<typeof store.applyServerChanges>) => {
      if (!injected) {
        injected = true;
        await store.savePendingChanges('doc1', [foreign]); // lands at store rev 5
      }
      return realApply(...args);
    }) as typeof store.applyServerChanges;

    const serverChange = createChange(4, 5, [{ op: 'add', path: '/server', value: 1 }], { committedAt: 1000 });
    await algorithm.applyServerChanges('doc1', [serverChange], doc as any);

    expect(injected).toBe(true);
    // The authoritative store row survives; before the fix its rev tied the inflated watermark and
    // the replace wiped it.
    const paths = (await store.getPendingChanges('doc1')).flatMap(c => c.ops.map(o => o.path));
    expect(paths).toContain('/foreign');
  });

  it('ejectPendingChange does not wipe a foreign mint colliding a doc-only rev (finding 5)', async () => {
    const poison = createChange(4, 5, [{ op: 'add', path: '/poison', value: 1 }]);
    await store.savePendingChanges('doc1', [poison]); // store tail 5
    const docOnly = createChange(4, 6, [{ op: 'add', path: '/docOnly', value: 1 }]);
    const foreign = createChange(4, 6, [{ op: 'add', path: '/foreign', value: 9 }]);
    const doc = { committedRev: 4, getPendingChanges: () => [poison, docOnly], import: () => {} };

    let injected = false;
    const realQuarantine = store.quarantinePendingChange.bind(store);
    store.quarantinePendingChange = (async (...args: Parameters<typeof store.quarantinePendingChange>) => {
      if (!injected) {
        injected = true;
        await store.savePendingChanges('doc1', [foreign]); // lands at store rev 6, tying docOnly
      }
      return realQuarantine(...args);
    }) as typeof store.quarantinePendingChange;

    const result = await algorithm.ejectPendingChange('doc1', poison.id, 'rejected', doc as any);

    expect(injected).toBe(true);
    expect(result).not.toBeNull();
    const paths = (await store.getPendingChanges('doc1')).flatMap(c => c.ops.map(o => o.path));
    expect(paths).toContain('/foreign'); // authoritative store row not quarantined away
    expect(paths).not.toContain('/poison'); // the ejected change is gone
  });
});
