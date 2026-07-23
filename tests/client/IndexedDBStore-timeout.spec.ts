import 'fake-indexeddb/auto';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlowStorageInfo } from '../../src/client/IndexedDBStore';
import { createLWWIndexedDBPatches, createMultiAlgorithmIndexedDBPatches } from '../../src/client/factories';
import { IDBTransactionWrapper, IndexedDBStore } from '../../src/client/IndexedDBStore';
import { LWWIndexedDBStore } from '../../src/client/LWWIndexedDBStore';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { StorageError, StorageTimeoutError } from '../../src/net/error';

let dbSeq = 0;

interface FakeTx {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: unknown;
  objectStoreNames: string[];
  abort: ReturnType<typeof vi.fn>;
  objectStore: (name: string) => unknown;
}

/** A controllable transaction that never settles on its own (the hung-IDB machine class). */
function hungTx(storeNames = ['docs']): FakeTx {
  const tx: FakeTx = {
    oncomplete: null,
    onerror: null,
    onabort: null,
    error: null,
    objectStoreNames: storeNames,
    // A real abort() fires onabort with an AbortError; model that so tests prove the
    // typed timeout beats the AbortError the guard's own abort produces.
    abort: vi.fn(() => {
      tx.error = new DOMException('The transaction was aborted.', 'AbortError');
      tx.onabort?.();
    }),
    objectStore: () => hungObjectStore(),
  };
  return tx;
}

/** An object store whose every request hangs forever (no success, no error). */
function hungObjectStore() {
  const inertRequest = () => ({ onsuccess: null, onerror: null, error: null });
  return { get: inertRequest, put: inertRequest, getAll: inertRequest } as unknown as IDBObjectStore;
}

/** Track whether a promise has settled without consuming its rejection. */
function settleFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  return () => settled;
}

describe('IDBTransactionWrapper max-time guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the soft hook exactly once at the threshold, without rejecting', async () => {
    const onSlowStorage = vi.fn();
    const tx = hungTx(['docs', 'snapshots']);
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction, { onSlowStorage });
    const settled = settleFlag(wrapper.complete());

    await vi.advanceTimersByTimeAsync(999);
    expect(onSlowStorage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onSlowStorage).toHaveBeenCalledTimes(1);
    expect(onSlowStorage).toHaveBeenCalledWith({
      operation: 'transaction',
      storeNames: ['docs', 'snapshots'],
      elapsedMs: 1000,
    });

    // Soft is advisory only: nothing rejects and it never fires again.
    await vi.advanceTimersByTimeAsync(2999);
    expect(onSlowStorage).toHaveBeenCalledTimes(1);
    expect(settled()).toBe(false);
  });

  it('aborts and rejects with StorageTimeoutError at the default hard threshold (no options)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tx = hungTx(['docs']);
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction);
    const result = wrapper.complete().then(
      () => {
        throw new Error('should have rejected');
      },
      (e: unknown) => e
    );

    await vi.advanceTimersByTimeAsync(4000);
    const err = (await result) as StorageTimeoutError;
    expect(err).toBeInstanceOf(StorageTimeoutError);
    expect(err.name).toBe('StorageTimeoutError');
    expect(err.operation).toBe('transaction');
    expect(err.storeNames).toEqual(['docs']);
    expect(err.elapsedMs).toBeGreaterThanOrEqual(4000);
    expect(tx.abort).toHaveBeenCalledTimes(1);
    // Default soft hook (console.warn) fired at 1000ms on the way; ships enabled.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('the typed timeout wins over the AbortError its own abort fires', async () => {
    const tx = hungTx();
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction, { onSlowStorage: () => undefined });
    const result = wrapper.complete().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBeInstanceOf(StorageTimeoutError);
  });

  it('still rejects with StorageTimeoutError when abort() itself throws', async () => {
    const tx = hungTx();
    tx.abort = vi.fn(() => {
      throw new DOMException('The transaction has finished.', 'InvalidStateError');
    });
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction, { onSlowStorage: () => undefined });
    const result = wrapper.complete().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBeInstanceOf(StorageTimeoutError);
    expect(tx.abort).toHaveBeenCalledTimes(1);
  });

  it('a transaction that completes before the threshold fires nothing', async () => {
    const onSlowStorage = vi.fn();
    const tx = hungTx();
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction, { onSlowStorage });

    await vi.advanceTimersByTimeAsync(5);
    tx.oncomplete!();
    await expect(wrapper.complete()).resolves.toBeUndefined();

    // Timers were cleared on settle: nothing fires later, even a healthy-but-slow-ish 900ms
    // write never comes near the guard.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSlowStorage).not.toHaveBeenCalled();
    expect(tx.abort).not.toHaveBeenCalled();
  });

  it('a transaction that errors before the threshold clears the guard timers', async () => {
    const onSlowStorage = vi.fn();
    const tx = hungTx();
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction, { onSlowStorage });
    const result = wrapper.complete().catch((e: unknown) => e);

    tx.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    tx.onerror!();
    expect(await result).toBeInstanceOf(StorageError);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSlowStorage).not.toHaveBeenCalled();
    expect(tx.abort).not.toHaveBeenCalled();
  });

  it('respects custom thresholds', async () => {
    const onSlowStorage = vi.fn();
    const tx = hungTx();
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction, {
      slowStorageMs: 50,
      storageTimeoutMs: 120,
      onSlowStorage,
    });
    const result = wrapper.complete().catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(49);
    expect(onSlowStorage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSlowStorage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(70);
    const err = (await result) as StorageTimeoutError;
    expect(err).toBeInstanceOf(StorageTimeoutError);
    expect(err.elapsedMs).toBeGreaterThanOrEqual(120);
  });

  it('a hung individual request rejects through the transaction guard instead of parking forever', async () => {
    const tx = hungTx(['docs']);
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction, { onSlowStorage: () => undefined });
    const store = wrapper.getStore('docs');

    // The caller awaits the request (as every store method does); without the guard this
    // promise would never settle even after the transaction-level timeout fired.
    const result = store.get('some-key').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBeInstanceOf(StorageTimeoutError);
  });

  it('a bulk transaction whose requests keep settling is never aborted, however long it runs', async () => {
    const tx = hungTx(['docs']);
    const pending: Array<() => void> = [];
    tx.objectStore = () => ({
      get: () => {
        const req: Record<string, any> = { onsuccess: null, onerror: null, error: null, result: 'value' };
        pending.push(() => req.onsuccess?.());
        return req;
      },
    });
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction, { onSlowStorage: () => undefined });
    const store = wrapper.getStore('docs');
    const settled = settleFlag(wrapper.complete());

    // 4 rounds of 3s each: 12s total lifetime, but every settle is progress that pushes
    // the hard deadline out, so the guard never fires.
    for (let i = 0; i < 4; i++) {
      const request = store.get('key');
      await vi.advanceTimersByTimeAsync(3000);
      pending.shift()!();
      expect(await request).toBe('value');
    }
    expect(settled()).toBe(false);
    expect(tx.abort).not.toHaveBeenCalled();

    // Once requests stop settling, the deadline runs out as usual.
    const hung = store.get('key').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await hung).toBeInstanceOf(StorageTimeoutError);
    expect(tx.abort).toHaveBeenCalledTimes(1);
  });

  it('a queued transaction with no own settles defers to connection activity, then times out once silent', async () => {
    // The store hands every transaction the same beacon; model that with a shared object.
    const beacon = { lastSettleAt: Date.now() };

    // A: sits queued behind other work — none of ITS own requests ever settle.
    const txA = hungTx(['docs']);
    const wrapperA = new IDBTransactionWrapper(
      txA as unknown as IDBTransaction,
      { onSlowStorage: () => undefined },
      beacon
    );
    const settledA = settleFlag(wrapperA.complete());

    // B: a sibling transaction on the same connection whose requests keep settling.
    const txB = hungTx(['docs']);
    const pending: Array<() => void> = [];
    txB.objectStore = () => ({
      get: () => {
        const req: Record<string, any> = { onsuccess: null, onerror: null, error: null, result: 'value' };
        pending.push(() => req.onsuccess?.());
        return req;
      },
    });
    const wrapperB = new IDBTransactionWrapper(
      txB as unknown as IDBTransaction,
      { onSlowStorage: () => undefined },
      beacon
    );
    const storeB = wrapperB.getStore('docs');

    // Every 3s (inside the 4s window) B settles a request, keeping the connection observably
    // alive. A's own 4s deadline elapses during this, but the beacon shows recent activity so it
    // defers instead of aborting a healthy-but-queued transaction.
    for (let i = 0; i < 4; i++) {
      const request = storeB.get('key');
      await vi.advanceTimersByTimeAsync(3000);
      pending.shift()!();
      expect(await request).toBe('value');
      expect(settledA()).toBe(false);
      expect(txA.abort).not.toHaveBeenCalled();
    }

    // B commits and the connection goes silent. Once the whole window passes with no activity
    // anywhere on the connection, A finally times out and aborts.
    txB.oncomplete!();
    const result = wrapperA.complete().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBeInstanceOf(StorageTimeoutError);
    expect(txA.abort).toHaveBeenCalledTimes(1);
  });

  it('rides connection activity while queued, but the defer backstop still fires it eventually', async () => {
    // The connection stays observably alive the whole time, but THIS transaction never settles a
    // request of its own — the "wedged at the head while unrelated-scope work keeps flowing" case,
    // which the unbounded connection-silence gate alone would let hang its caller forever.
    const beacon = { lastSettleAt: Date.now() };
    const txA = hungTx(['docs']);
    const wrapperA = new IDBTransactionWrapper(
      txA as unknown as IDBTransaction,
      { onSlowStorage: () => undefined },
      beacon
    );
    const result = wrapperA.complete().catch((e: unknown) => e);
    const settledA = settleFlag(wrapperA.complete());

    // Something settles every half-window, so the connection never goes silent for a full window.
    const bumpAndAdvance = async () => {
      beacon.lastSettleAt = Date.now();
      await vi.advanceTimersByTimeAsync(2000);
    };

    // It defers on that activity instead of aborting at the first window (the beacon defer working)...
    await bumpAndAdvance();
    await bumpAndAdvance();
    await bumpAndAdvance();
    expect(settledA()).toBe(false);
    expect(txA.abort).not.toHaveBeenCalled();

    // ...but not forever: past the backstop it fires despite the still-active connection rather than
    // hanging indefinitely. The bound guards against a regression to the old unbounded behavior.
    let windows = 3;
    while (!settledA() && windows < 200) {
      await bumpAndAdvance();
      windows++;
    }
    expect(settledA()).toBe(true);
    expect(await result).toBeInstanceOf(StorageTimeoutError);
    expect(txA.abort).toHaveBeenCalledTimes(1);
  });
});

describe('IndexedDBStore open() max-time guard', () => {
  const realOpen = indexedDB.open;
  let openRequests: Array<Record<string, any>>;

  /** A fake IDBDatabase good enough for the open success path. */
  function fakeDb() {
    return {
      version: 2,
      objectStoreNames: { contains: () => true },
      close: () => undefined,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    openRequests = [];
    // An open that never settles: no success, error, or blocked event.
    (indexedDB as unknown as { open: unknown }).open = () => {
      const request: Record<string, any> = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      openRequests.push(request);
      return request;
    };
  });

  afterEach(() => {
    (indexedDB as unknown as { open: unknown }).open = realOpen;
    vi.useRealTimers();
  });

  it('rejects waiters with StorageTimeoutError when open() hangs past the default hard threshold', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`);
    const waiter = store.listDocs();
    const settled = settleFlag(waiter);
    const result = waiter.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(3999);
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = (await result) as StorageTimeoutError;
    expect(err).toBeInstanceOf(StorageTimeoutError);
    expect(err.operation).toBe('open');
    expect(err.storeNames).toEqual([]);
    expect(err.elapsedMs).toBeGreaterThanOrEqual(4000);
    // Default soft hook fired at 1000ms; the guard ships enabled with no options.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('fires a custom soft hook once for a slow open', async () => {
    const onSlowStorage = vi.fn();
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage });
    const result = store.listDocs().catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onSlowStorage).toHaveBeenCalledTimes(1);
    expect(onSlowStorage).toHaveBeenCalledWith({ operation: 'open', storeNames: [], elapsedMs: 1000 });

    await vi.advanceTimersByTimeAsync(3000);
    expect(onSlowStorage).toHaveBeenCalledTimes(1);
    expect(await result).toBeInstanceOf(StorageTimeoutError);
  });

  it('respects custom thresholds for open()', async () => {
    const onSlowStorage = vi.fn();
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, {
      slowStorageMs: 30,
      storageTimeoutMs: 80,
      onSlowStorage,
    });
    const result = store.listDocs().catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(30);
    expect(onSlowStorage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeInstanceOf(StorageTimeoutError);
  });

  it('callers arriving after a timeout also fail fast while the open stays hung', async () => {
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage: () => undefined });
    const first = store.listDocs().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await first).toBeInstanceOf(StorageTimeoutError);

    const second = store.listDocs().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await second).toBeInstanceOf(StorageTimeoutError);
  });

  it('a success that lands after the timeout still heals the store', async () => {
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage: () => undefined });
    const first = store.listDocs().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await first).toBeInstanceOf(StorageTimeoutError);

    const request = openRequests[0];
    request.result = fakeDb();
    request.onsuccess();
    const db = await (store as unknown as { getDB(): Promise<IDBDatabase> }).getDB();
    expect(db).toBe(request.result);
  });

  it('an open that settles before the threshold fires nothing', async () => {
    const onSlowStorage = vi.fn();
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage });

    await vi.advanceTimersByTimeAsync(10);
    const request = openRequests[0];
    request.result = fakeDb();
    request.onsuccess();
    await expect((store as unknown as { getDB(): Promise<IDBDatabase> }).getDB()).resolves.toBe(request.result);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSlowStorage).not.toHaveBeenCalled();
  });

  it('a blocked open defers to the blocked grace period instead of the hang guard', async () => {
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage: () => undefined });
    const waiter = store.listDocs();
    const settled = settleFlag(waiter);
    const result = waiter.catch((e: unknown) => e);

    // `blocked` is an observable state with its own 5s grace + heal path; the silent-hang
    // guard must stand down rather than double-reject.
    openRequests[0].onblocked();
    await vi.advanceTimersByTimeAsync(4500);
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(String(await result)).toMatch(/blocked/i);
    expect(await result).not.toBeInstanceOf(StorageTimeoutError);
  });

  it('a blocked open crossing the soft threshold still fires onSlowStorage', async () => {
    const onSlowStorage = vi.fn();
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage });
    store.listDocs().catch(() => undefined);

    openRequests[0].onblocked();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSlowStorage).toHaveBeenCalledTimes(1);
    expect(onSlowStorage.mock.calls[0][0].operation).toBe('open');
  });

  it('callers arriving after the blocked-grace rejection fail fast while the open stays blocked', async () => {
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage: () => undefined });
    const first = store.listDocs().catch((e: unknown) => e);
    openRequests[0].onblocked();
    await vi.advanceTimersByTimeAsync(5000);
    expect(String(await first)).toMatch(/blocked/i);

    // Without re-arming the hard guard after the grace rejection, this waiter would park
    // forever on the fresh deferred, the silent-hang class the guard exists to close.
    const second = store.listDocs().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await second).toBeInstanceOf(StorageTimeoutError);
  });

  /** Drives an open to `upgradeneeded` and hands back the request. */
  function beginUpgrade(request: Record<string, any>) {
    request.result = fakeDb();
    request.transaction = { objectStore: () => ({ indexNames: { contains: () => true } }) };
    request.onupgradeneeded({ target: request, oldVersion: 1 });
    return request;
  }

  it('a long-running upgrade gets a longer budget than the normal open', async () => {
    const onSlowStorage = vi.fn();
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage });
    const waiter = (store as unknown as { getDB(): Promise<IDBDatabase> }).getDB();
    const settled = settleFlag(waiter);

    const request = beginUpgrade(openRequests[0]);

    // The upgrade transaction legitimately runs long (index builds), so the 4s open budget
    // must not apply — but it is not unlimited either.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled()).toBe(false);
    // The soft hook still reported the slow open.
    expect(onSlowStorage).toHaveBeenCalledTimes(1);

    request.onsuccess();
    expect(await waiter).toBe(request.result);
  });

  it('an upgrade that stalls forever rejects at the re-armed budget instead of hanging', async () => {
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage: () => undefined });
    const waiter = (store as unknown as { getDB(): Promise<IDBDatabase> }).getDB();
    const settled = settleFlag(waiter);
    const result = waiter.catch((e: unknown) => e);

    beginUpgrade(openRequests[0]);

    // A blocked version change or a crashed backend leaves the upgrade transaction pending
    // and fires nothing further. Clearing the hard timer outright (rather than re-arming it)
    // is exactly the wedge the max-time guard exists to close.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = (await result) as StorageTimeoutError;
    expect(err).toBeInstanceOf(StorageTimeoutError);
    expect(err.operation).toBe('open');
    expect(err.elapsedMs).toBeGreaterThanOrEqual(30_000);
  });

  it('a hung deleteDatabase that reports blocked rejects with a descriptive Error, never null', async () => {
    const realDelete = indexedDB.deleteDatabase;
    const requests: Array<Record<string, any>> = [];
    (indexedDB as unknown as { deleteDatabase: unknown }).deleteDatabase = () => {
      // Real browsers fire `blocked` with a null `request.error` — nothing failed yet.
      const request: Record<string, any> = { onsuccess: null, onerror: null, onblocked: null, error: null };
      requests.push(request);
      return request;
    };
    try {
      const dbName = `timeout-open-${dbSeq++}`;
      const store = new IndexedDBStore(dbName, { onSlowStorage: () => undefined });
      const result = store.deleteDB().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);

      requests[0].onblocked();
      const err = await result;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(dbName);
      expect((err as Error).message).toMatch(/blocked/i);
    } finally {
      (indexedDB as unknown as { deleteDatabase: unknown }).deleteDatabase = realDelete;
    }
  });

  it('setName during a hung open cancels the stale guard so the new connection stays healthy', async () => {
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage: () => undefined });
    const first = store.listDocs().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await first).toBeInstanceOf(StorageTimeoutError);

    store.setName(`timeout-open-${dbSeq++}`);
    const request = openRequests[1];
    request.result = fakeDb();
    request.onsuccess();
    const getDB = () => (store as unknown as { getDB(): Promise<IDBDatabase> }).getDB();
    expect(await getDB()).toBe(request.result);

    // The abandoned first open's guard must not reject or replace the healthy promise.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await getDB()).toBe(request.result);
  });

  it('close() during an in-flight open cancels the guard timers', async () => {
    const onSlowStorage = vi.fn();
    const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage });
    await store.close();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSlowStorage).not.toHaveBeenCalled();
  });

  it('a hung deleteDatabase rejects with StorageTimeoutError instead of parking forever', async () => {
    const realDelete = indexedDB.deleteDatabase;
    (indexedDB as unknown as { deleteDatabase: unknown }).deleteDatabase = () => ({
      onsuccess: null,
      onerror: null,
      onblocked: null,
    });
    try {
      const onSlowStorage = vi.fn();
      const store = new IndexedDBStore(`timeout-open-${dbSeq++}`, { onSlowStorage });
      const result = store.deleteDB().catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(4000);
      const err = (await result) as StorageTimeoutError;
      expect(err).toBeInstanceOf(StorageTimeoutError);
      expect(err.operation).toBe('delete');
      expect(onSlowStorage).toHaveBeenCalledWith({ operation: 'delete', storeNames: [], elapsedMs: 1000 });
    } finally {
      (indexedDB as unknown as { deleteDatabase: unknown }).deleteDatabase = realDelete;
    }
  });
});

describe('max-time guard on real stores (fake-indexeddb, real timers)', () => {
  it('normal operations settle without ever tripping the guard', async () => {
    const onSlowStorage = vi.fn();
    const store = new IndexedDBStore(`timeout-e2e-${dbSeq++}`, { onSlowStorage });
    await store.trackDocs(['doc1', 'doc2']);
    expect((await store.listDocs()).map(d => d.docId).sort()).toEqual(['doc1', 'doc2']);
    expect(onSlowStorage).not.toHaveBeenCalled();
    await store.close();
  });

  it('OT and LWW stores pass guard options through to the shared IndexedDBStore', async () => {
    const events: SlowStorageInfo[] = [];
    const onSlowStorage = (info: SlowStorageInfo) => events.push(info);

    const ot = new OTIndexedDBStore(`timeout-e2e-${dbSeq++}`, { onSlowStorage });
    await ot.trackDocs(['doc1']);
    expect((ot.db as unknown as { options: object }).options).toEqual({ onSlowStorage });
    await ot.close();

    const lww = new LWWIndexedDBStore(`timeout-e2e-${dbSeq++}`, { storageTimeoutMs: 8000, onSlowStorage });
    await lww.savePendingOps('doc1', [{ op: 'replace', path: '/a', value: 1, ts: 1 }]);
    expect(await lww.getPendingOps('doc1')).toHaveLength(1);
    expect(events).toEqual([]);
    await lww.close();
  });

  it('factories pass storeOptions through to the IndexedDB store', async () => {
    const onSlowStorage = () => undefined;
    const patches = createLWWIndexedDBPatches({ dbName: `timeout-e2e-${dbSeq++}`, storeOptions: { onSlowStorage } });
    const store = (patches.algorithms.lww as unknown as { store: LWWIndexedDBStore }).store;
    expect((store.db as unknown as { options: object }).options).toEqual({ onSlowStorage });
    await store.listDocs();
    await store.close();

    const multi = createMultiAlgorithmIndexedDBPatches({
      dbName: `timeout-e2e-${dbSeq++}`,
      storeOptions: { storageTimeoutMs: 8000 },
    });
    const multiStore = (multi.algorithms.ot as unknown as { store: OTIndexedDBStore }).store;
    expect((multiStore.db as unknown as { options: object }).options).toEqual({ storageTimeoutMs: 8000 });
    await multiStore.listDocs();
    await multiStore.close();
  });

  it('rejects guard options alongside an existing IndexedDBStore instance at the type level', async () => {
    const base = new IndexedDBStore(`timeout-e2e-${dbSeq++}`);
    // @ts-expect-error guard options belong on the IndexedDBStore that owns the connection
    new OTIndexedDBStore(base, { storageTimeoutMs: 8000 });
    // @ts-expect-error guard options belong on the IndexedDBStore that owns the connection
    new LWWIndexedDBStore(base, { storageTimeoutMs: 8000 });
    await base.listDocs();
    await base.close();
  });

  it('a hard timeout with no awaiters does not surface an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const tx = hungTx();
      // Nobody ever calls complete(); the guard's rejection must be swallowed internally.
      new IDBTransactionWrapper(tx as unknown as IDBTransaction, {
        slowStorageMs: 5,
        storageTimeoutMs: 10,
        onSlowStorage: () => undefined,
      });
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

// A suspended/throttled tab freezes the event loop, so on resume the hard timer can dispatch
// grossly late (Sentry saw elapsed up to 20 minutes). These tests decouple the wall clock
// (`Date.now`) from the fake timer clock so a timer can be made to fire far later than its
// budget — exactly the background-tab artifact the re-arm exists to absorb.
describe('IDBTransactionWrapper late-fire re-arm (suspended tab)', () => {
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-arms once when the hard timer fires grossly late, then fires if still silent', async () => {
    const tx = hungTx(['docs']);
    const wrapper = new IDBTransactionWrapper(tx as unknown as IDBTransaction, { onSlowStorage: () => undefined });
    const result = wrapper.complete().catch((e: unknown) => e);
    const settled = settleFlag(wrapper.complete());

    // The event loop was frozen for 60s; when the 4s hard timer finally dispatches it is grossly
    // late (> 2x its budget), so it re-arms for a fresh full window instead of aborting.
    now += 60_000;
    await vi.advanceTimersByTimeAsync(4000);
    expect(settled()).toBe(false);
    expect(tx.abort).not.toHaveBeenCalled();

    // The re-armed window elapses on time with the connection still silent → it now fires.
    now += 4000;
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBeInstanceOf(StorageTimeoutError);
    expect(tx.abort).toHaveBeenCalledTimes(1);
  });
});

describe('IndexedDBStore open() late-fire re-arm (suspended tab)', () => {
  const realOpen = indexedDB.open;
  let openRequests: Array<Record<string, any>>;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    openRequests = [];
    (indexedDB as unknown as { open: unknown }).open = () => {
      const request: Record<string, any> = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      openRequests.push(request);
      return request;
    };
  });
  afterEach(() => {
    (indexedDB as unknown as { open: unknown }).open = realOpen;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-arms once when the open timer dispatches grossly late, then rejects if still hung', async () => {
    const store = new IndexedDBStore(`late-open-${dbSeq++}`, { onSlowStorage: () => undefined });
    const waiter = store.listDocs();
    const settled = settleFlag(waiter);
    const result = waiter.catch((e: unknown) => e);

    now += 60_000;
    await vi.advanceTimersByTimeAsync(4000);
    expect(settled()).toBe(false);

    now += 4000;
    await vi.advanceTimersByTimeAsync(4000);
    const err = (await result) as StorageTimeoutError;
    expect(err).toBeInstanceOf(StorageTimeoutError);
    expect(err.operation).toBe('open');
  });
});
