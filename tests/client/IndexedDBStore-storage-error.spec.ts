import { describe, expect, it } from 'vitest';
import { IDBStoreWrapper, IDBTransactionWrapper } from '../../src/client/IndexedDBStore';
import { isStorageError, StorageError } from '../../src/net/error';

/**
 * The IndexedDB request/transaction wrappers must convert a raw WebKit storage-fault
 * DOMException (`UnknownError` / `QuotaExceededError`) into a typed {@link StorageError} at the
 * reject boundary, so PatchesSync and the consuming app get one stable type to branch on
 * instead of sniffing DOMException names (DAB-650). Everything else rejects unchanged.
 */
function requestThatErrorsWith(error: unknown) {
  return () => {
    const request: { onsuccess: (() => void) | null; onerror: (() => void) | null; error: unknown } = {
      onsuccess: null,
      onerror: null,
      error,
    };
    // Fire onerror after the wrapper has assigned its handler (next microtask).
    void Promise.resolve().then(() => request.onerror?.());
    return request;
  };
}

const storeThatErrorsWith = (error: unknown) =>
  ({ put: requestThatErrorsWith(error), get: requestThatErrorsWith(error) }) as unknown as IDBObjectStore;

describe('IndexedDB store-error wrapping', () => {
  it('wraps a WebKit UnknownError from a put() into a StorageError (message + cause preserved)', async () => {
    const raw = new DOMException('Unable to store record in object store', 'UnknownError');
    const wrapper = new IDBStoreWrapper(storeThatErrorsWith(raw));
    const err = await wrapper.put({ id: 'x' }).then(
      () => {
        throw new Error('put() should have rejected');
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(StorageError);
    expect(isStorageError(err)).toBe(true);
    expect((err as StorageError).message).toBe('Unable to store record in object store');
    expect((err as StorageError).cause).toBe(raw);
  });

  it('wraps a get() failure the same way', async () => {
    const raw = new DOMException(
      'Attempt to get records from database without an in-progress transaction',
      'UnknownError'
    );
    const wrapper = new IDBStoreWrapper(storeThatErrorsWith(raw));
    await expect(wrapper.get('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('wraps a transaction-level storage fault into a StorageError', async () => {
    const raw = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    const fakeTx = { oncomplete: null, onerror: null, error: raw } as unknown as IDBTransaction;
    const wrapper = new IDBTransactionWrapper(fakeTx);
    void Promise.resolve().then(() => (fakeTx as unknown as { onerror: () => void }).onerror());
    await expect(wrapper.complete()).rejects.toBeInstanceOf(StorageError);
  });

  it('leaves a non-storage request error unchanged (e.g. AbortError)', async () => {
    const raw = new DOMException('The transaction was aborted.', 'AbortError');
    const wrapper = new IDBStoreWrapper(storeThatErrorsWith(raw));
    await expect(wrapper.put({ id: 'x' })).rejects.toBe(raw);
  });
});
