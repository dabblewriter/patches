import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { createChange } from '../../src/data/change';
import { isDefectiveChangeError, isNonCloneableOpError } from '../../src/net/error';
import type { Change } from '../../src/types';

/**
 * A pending OT change carrying a value the structured-clone algorithm refuses
 * (DABBLE-WRITER-3-PQ). The browser's `DataCloneError` names neither the change
 * nor the path, so the offending call site can't be found. The change must
 * still be refused — only the error improves. Mirrors the LWW store's contract.
 */
let dbSeq = 0;
const docId = 'doc1';

/** A `PathProxy` read off a change mutator's `root` as if it were data. */
const pathProxy = (): any => new Proxy(function () {} as any, { get: () => pathProxy() });

function localChange(ops: Change['ops'], metadata?: Record<string, any>): Change {
  return createChange(0, 1, ops, metadata);
}

describe('OTIndexedDBStore.savePendingChanges with a non-cloneable value', () => {
  let store: OTIndexedDBStore;

  beforeEach(async () => {
    store = new OTIndexedDBStore(`ot-noncloneable-test-${dbSeq++}`);
    await store.saveDoc(docId, { state: { docs: {} }, rev: 0 });
  });

  it('names the offending op path instead of raising a bare DataCloneError', async () => {
    const change = localChange([
      { op: 'replace', path: '/title', value: 'fine' },
      { op: 'replace', path: '/docs/abc/label', value: { text: pathProxy() } },
    ]);

    await expect(store.savePendingChanges(docId, [change])).rejects.toMatchObject({
      name: 'NonCloneableOpError',
      paths: ['/docs/abc/label'],
      docId,
    });
  });

  it('collects paths across every change in the batch', async () => {
    const changes = [
      localChange([{ op: 'replace', path: '/a', value: pathProxy() }]),
      localChange([{ op: 'replace', path: '/b', value: 'fine' }]),
      localChange([{ op: 'add', path: '/c', value: pathProxy() }]),
    ];

    await expect(store.savePendingChanges(docId, changes)).rejects.toMatchObject({ paths: ['/a', '/c'] });
  });

  it('names a poisoned metadata field, which createChange spreads onto the change', async () => {
    const change = localChange([{ op: 'replace', path: '/title', value: 'fine' }], { source: pathProxy() });

    await expect(store.savePendingChanges(docId, [change])).rejects.toMatchObject({
      name: 'NonCloneableOpError',
      paths: ['(metadata:source)'],
    });
  });

  it('still classifies as a defective change and keeps the browser original as the cause', async () => {
    const change = localChange([{ op: 'replace', path: '/body', value: pathProxy() }]);

    const error = await store.savePendingChanges(docId, [change]).catch(e => e);
    expect(isDefectiveChangeError(error)).toBe(true);
    expect(isNonCloneableOpError(error)).toBe(true);
    expect((error as Error).cause).toMatchObject({ name: 'DataCloneError' });
  });

  it('names the changes that carried a refused value', async () => {
    const bad = localChange([{ op: 'replace', path: '/a', value: pathProxy() }]);
    const clean = localChange([{ op: 'replace', path: '/b', value: 'fine' }]);
    const meta = localChange([{ op: 'replace', path: '/c', value: 'fine' }], { source: pathProxy() });

    const error = await store.savePendingChanges(docId, [bad, clean, meta]).catch(e => e);
    expect(error).toMatchObject({ paths: ['/a', '(metadata:source)'], changeIds: [bad.id, meta.id] });
    expect((error as Error).message).toContain('change values');
    expect((error as Error).message).toContain(`(changes ${bad.id}, ${meta.id})`);
  });

  it('passes any error other than DataCloneError through untouched', async () => {
    const original = new DOMException('disk full', 'QuotaExceededError');
    vi.spyOn(store as any, '_savePendingChanges').mockRejectedValueOnce(original);
    const change = localChange([{ op: 'replace', path: '/a', value: pathProxy() }]);

    await expect(store.savePendingChanges(docId, [change])).rejects.toBe(original);
  });

  it('keeps the original DataCloneError when no change field owns it', async () => {
    const original = new DOMException('could not be cloned', 'DataCloneError');
    vi.spyOn(store as any, '_savePendingChanges').mockRejectedValueOnce(original);
    const change = localChange([{ op: 'replace', path: '/a', value: 'fine' }]);

    await expect(store.savePendingChanges(docId, [change])).rejects.toBe(original);
  });

  it('saves clean changes exactly as before', async () => {
    const change = localChange([{ op: 'replace', path: '/title', value: 'fine' }]);
    await store.savePendingChanges(docId, [change]);

    const pending = await store.getPendingChanges(docId);
    expect(pending).toHaveLength(1);
    expect(pending[0].ops).toEqual(change.ops);
  });
});
