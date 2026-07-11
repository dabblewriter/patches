import 'fake-indexeddb/auto';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { IndexedDBStore } from '../../src/client/IndexedDBStore';
import { LWWIndexedDBStore } from '../../src/client/LWWIndexedDBStore';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';

let dbSeq = 0;

describe('IndexedDBStore lifecycle (real store over fake-indexeddb)', () => {
  it('creates missing algorithm stores when a database created with another algorithm set is reopened', async () => {
    const dbName = `lifecycle-test-${dbSeq++}`;

    // First session: OT-only factory creates the database without LWW stores
    const ot = new OTIndexedDBStore(dbName);
    await ot.trackDocs(['doc1']);
    await ot.close();

    // Second session: LWW store on the same database. The version already matches, so no
    // upgrade fires on a plain open — the store must detect the missing object stores and
    // bump the version, or every LWW operation throws NotFoundError.
    const lww = new LWWIndexedDBStore(dbName);
    await lww.savePendingOps('doc1', [{ op: 'replace', path: '/a', value: 1, ts: 1 }]);
    expect(await lww.getPendingOps('doc1')).toHaveLength(1);
    // Existing data survives the version bump
    expect((await lww.db.listDocs(false, 'ot')).map(d => d.docId)).toEqual(['doc1']);
    await lww.close();

    // Third session: reopening at the default version after the bump (VersionError path)
    const ot2 = new OTIndexedDBStore(dbName);
    expect((await ot2.listDocs()).map(d => d.docId)).toEqual(['doc1']);
    await ot2.close();
  });

  it('recovers a transaction when the browser closes the live connection out from under us', async () => {
    const store = new IndexedDBStore(`lifecycle-test-${dbSeq++}`);
    await store.trackDocs(['doc1']);

    // Simulate the browser putting the still-referenced connection into its "closing"
    // state — a suspended tab/worker (Safari) or a versionchange — WITHOUT our own
    // close(), which would null this.db. db.transaction() would otherwise throw
    // InvalidStateError: "The database connection is closing" (DABBLE-WRITER-3-CA).
    const raw = (store as unknown as { db: IDBDatabase }).db;
    expect(raw).toBeTruthy();
    raw.close();

    // The next write transparently reopens the connection and succeeds instead of throwing.
    await expect(store.trackDocs(['doc2'])).resolves.toBeUndefined();
    expect((await store.listDocs()).map(d => d.docId).sort()).toEqual(['doc1', 'doc2']);
    expect((store as unknown as { db: IDBDatabase | null }).db).not.toBe(raw);

    await store.close();
  });

  it('closes and reopens on versionchange so it never blocks another connection upgrading', async () => {
    const dbName = `lifecycle-test-${dbSeq++}`;
    const store = new IndexedDBStore(dbName);
    await store.trackDocs(['doc1']);
    const original = (store as unknown as { db: IDBDatabase }).db;

    // A second connection upgrading past our version fires versionchange on us. Without
    // the handler this open() would stay blocked until we closed; the handler closes and
    // reopens us, so the upgrade proceeds and our store stays usable on the new version.
    const higher = original.version + 1;
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, higher);
      req.onupgradeneeded = () => req.result.createObjectStore('extra');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('upgrade blocked — versionchange not handled'));
    });
    upgraded.close();

    // Store still works, on a fresh connection at the new version.
    await store.trackDocs(['doc2']);
    expect((await store.listDocs()).map(d => d.docId).sort()).toEqual(['doc1', 'doc2']);
    expect((store as unknown as { db: IDBDatabase }).db).not.toBe(original);

    await store.close();
  });

  it('close() rejects later use without leaving an unhandled rejection', async () => {
    const store = new IndexedDBStore(`lifecycle-test-${dbSeq++}`);
    await store.listDocs();

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      await store.close();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    await expect(store.listDocs()).rejects.toThrow('Store has been closed');
  });
});
