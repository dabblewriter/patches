import 'fake-indexeddb/auto';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { IndexedDBStore } from '../../src/client/IndexedDBStore';
import { LWWIndexedDBStore } from '../../src/client/LWWIndexedDBStore';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';

let dbSeq = 0;

/** Open a connection directly, bypassing the store — used to squat on a database version. */
function openRaw(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The real blocked grace period is 5s — deliberately longer than a vitest timeout, since it
 * only expires when a peer genuinely never closes. Shrink it so the blocked tests stay fast,
 * and restore it so nothing else sees the override.
 */
function useShortBlockedGrace(ms = 20): () => void {
  const store = IndexedDBStore as unknown as { OPEN_BLOCKED_TIMEOUT_MS: number };
  const original = store.OPEN_BLOCKED_TIMEOUT_MS;
  store.OPEN_BLOCKED_TIMEOUT_MS = ms;
  return () => {
    store.OPEN_BLOCKED_TIMEOUT_MS = original;
  };
}

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

  it('close() during an in-flight reopen does not resurrect the store', async () => {
    const store = new IndexedDBStore(`lifecycle-test-${dbSeq++}`);
    await store.trackDocs(['doc1']);

    // Kill the live connection so the next write takes the reopen path.
    const raw = (store as unknown as { db: IDBDatabase }).db;
    raw.close();

    // Start a write. It reopens synchronously (nulls this.db) and then parks awaiting the
    // fresh connection. fake-indexeddb dispatches open success on a macrotask, so spinning
    // microtasks lands us squarely in the window where this.db is null and the reopen's
    // onsuccess is still pending — exactly when a concurrent close() used to be lost.
    const write = store.trackDocs(['doc2']);
    for (let i = 0; i < 100 && (store as unknown as { db: IDBDatabase | null }).db !== null; i++) {
      await Promise.resolve();
    }
    expect((store as unknown as { db: IDBDatabase | null }).db).toBeNull();

    // Close inside that window. The reopen's onsuccess must honor the close, not adopt the
    // fresh connection — so the in-flight write fails cleanly and the store stays closed.
    const closing = store.close();
    await expect(write).rejects.toThrow('Store has been closed');
    await closing;
    expect((store as unknown as { db: IDBDatabase | null }).db).toBeNull();
    await expect(store.listDocs()).rejects.toThrow('Store has been closed');
  });

  it('a failed reopen does not surface an unhandled rejection', async () => {
    const store = new IndexedDBStore(`lifecycle-test-${dbSeq++}`);
    await store.trackDocs(['doc1']);
    const original = (store as unknown as { db: IDBDatabase }).db;

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    const realOpen = indexedDB.open;
    try {
      // Force the reopen the versionchange handler kicks off to fail with a non-VersionError
      // (quota/corruption). Nothing awaits that reopen's promise, so without the .catch guard
      // its rejection would surface as an unhandled rejection on an idle tab.
      (indexedDB as unknown as { open: unknown }).open = () => {
        const request: Record<string, unknown> = {};
        setTimeout(() => {
          request.error = Object.assign(new Error('mock reopen failure'), { name: 'QuotaExceededError' });
          (request.onerror as (() => void) | undefined)?.();
        }, 0);
        return request;
      };

      // Drive the versionchange handler the browser would fire when another connection upgrades.
      (original as unknown as { onversionchange: () => void }).onversionchange();

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      (indexedDB as unknown as { open: unknown }).open = realOpen;
      process.off('unhandledRejection', onRejection);
    }
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

  /**
   * `blocked` settles nothing — unlike `error` it is not terminal — so an open blocked by a
   * peer that never closes used to leave `dbPromise` pending forever, hanging every read and
   * write through the store with no error and no log. Peers honoring `onversionchange` close
   * in milliseconds; one that cannot (a suspended tab, an external connection) must not cost
   * the store its entire future.
   */
  it('rejects waiters instead of hanging forever when an open stays blocked', async () => {
    const dbName = `lifecycle-test-${dbSeq++}`;
    const restoreGrace = useShortBlockedGrace();
    // Hold a raw connection open at v1 that never honors versionchange — a suspended peer.
    const squatter = await openRaw(dbName, 1);

    try {
      // The store opens at DB_VERSION (2) — blocked by the squatter, so neither success nor
      // error ever fires. Without the blocked handler this line hangs until the test times out.
      const store = new IndexedDBStore(dbName);
      await expect(store.listDocs()).rejects.toThrow(/blocked/i);
      await store.close();
    } finally {
      squatter.close();
      restoreGrace();
    }
  });

  it('heals if the blocker closes after waiters were rejected', async () => {
    const dbName = `lifecycle-test-${dbSeq++}`;
    const restoreGrace = useShortBlockedGrace();
    const squatter = await openRaw(dbName, 1);
    const store = new IndexedDBStore(dbName);

    try {
      await expect(store.listDocs()).rejects.toThrow(/blocked/i);

      // The peer finally goes away — the original open completes and resolves the fresh
      // deferred, so the store works again without anyone reopening it.
      squatter.close();
      await expect(store.listDocs()).resolves.toEqual([]);
      await store.close();
    } finally {
      squatter.close();
      restoreGrace();
    }
  });
});
