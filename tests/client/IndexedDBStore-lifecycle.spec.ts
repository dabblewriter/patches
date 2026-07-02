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
