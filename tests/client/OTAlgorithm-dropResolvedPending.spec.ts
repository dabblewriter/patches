import { beforeEach, describe, expect, it } from 'vitest';
import { createChange } from '../../src/data/change';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';

/**
 * Regression coverage for the client retry-storm fix: a change the server rebased
 * away to a no-op (never echoed back as committed) must be dropped from pending,
 * otherwise it is resent on every flush forever. A root-level replace is the worst
 * case — it never reduces to empty under rebase, so the normal rebase-by-id removal
 * can't clear it.
 */
describe('OTAlgorithm.dropResolvedPending', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
  });

  it('drops a sent change the server did not echo back (rebased to a no-op)', async () => {
    const sent = createChange(0, 1, [{ op: 'replace', path: '', value: { title: 'x' } }]);
    await store.savePendingChanges('doc1', [sent]);

    // Server returned only an unrelated catchup change — `sent` rebased away.
    const catchup = createChange(1, 2, [{ op: 'add', path: '/other', value: 1 }]);
    const dropped = await algorithm.dropResolvedPending('doc1', [sent], [catchup]);

    expect(dropped).toBe(1);
    expect(await store.getPendingChanges('doc1')).toEqual([]);
  });

  it('keeps a sent change the server echoed back as committed', async () => {
    const sent = createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }]);
    await store.savePendingChanges('doc1', [sent]);

    // Same change id comes back (with a server-assigned rev) → it survived.
    const dropped = await algorithm.dropResolvedPending('doc1', [sent], [{ ...sent, rev: 6 }]);

    expect(dropped).toBe(0);
    expect(await store.getPendingChanges('doc1')).toEqual([sent]);
  });

  it('drops only the rebased-away change, leaving other pending intact', async () => {
    const sent = createChange(0, 1, [{ op: 'replace', path: '', value: {} }]);
    const other = createChange(1, 2, [{ op: 'add', path: '/b', value: 2 }]);
    await store.savePendingChanges('doc1', [sent, other]);

    // `sent` absent from committed (rebased away); `other` was not part of this submission.
    const dropped = await algorithm.dropResolvedPending('doc1', [sent], []);

    expect(dropped).toBe(1);
    expect((await store.getPendingChanges('doc1')).map(c => c.id)).toEqual([other.id]);
  });

  it('is a no-op when every sent change survived', async () => {
    const sent = createChange(0, 1, [{ op: 'add', path: '/a', value: 1 }]);
    await store.savePendingChanges('doc1', [sent]);

    const dropped = await algorithm.dropResolvedPending('doc1', [sent], [sent]);

    expect(dropped).toBe(0);
    expect(await store.getPendingChanges('doc1')).toEqual([sent]);
  });
});
