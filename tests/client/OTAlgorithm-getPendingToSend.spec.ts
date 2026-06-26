import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';

/**
 * The send choke point enforces the OT pending invariant: every pending change must share
 * `baseRev === committedRev`, since pending is a contiguous sequence applied on top of the
 * committed revision. A receive-rebase racing a local mint could persist one change with a
 * stale baseRev among rebased siblings (mixed `baseRev`), and the server rejects that batch
 * ("Client changes must have consistent baseRev"), wedging sync forever. getPendingToSend
 * re-stamps the batch to the current committedRev so an already-corrupted queue still flushes.
 */
describe('OTAlgorithm.getPendingToSend baseRev normalization', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    // Committed through rev 1794 (mirrors the reported wedge).
    await store.saveDoc('doc1', { state: {}, rev: 1794 });
  });

  it('re-stamps a stale baseRev in the pending queue to committedRev', async () => {
    await store.savePendingChanges('doc1', [
      createChange(1794, 1795, [{ op: 'replace', path: '/docs/oHNA/title', value: 'a' }]),
      createChange(1794, 1796, [{ op: 'replace', path: '/docs/oHNA/title', value: 'ab' }]),
      // The straggler the race left behind: rev fits the sequence, baseRev is stale.
      createChange(1791, 1797, [{ op: 'replace', path: '/docs/oHNA/title', value: 'Drop by Home ' }]),
      createChange(1794, 1798, [{ op: 'replace', path: '/docs/oHNA/title', value: 'abc' }]),
    ]);

    const pending = await algorithm.getPendingToSend('doc1');

    expect(pending).not.toBeNull();
    expect(new Set(pending!.map(c => c.baseRev))).toEqual(new Set([1794]));
    // Order, revs, ids and ops are untouched — only baseRev is healed.
    expect(pending!.map(c => c.rev)).toEqual([1795, 1796, 1797, 1798]);
    expect(pending![2].ops).toEqual([{ op: 'replace', path: '/docs/oHNA/title', value: 'Drop by Home ' }]);
  });

  it('returns the queue untouched when every baseRev already matches', async () => {
    const changes = [
      createChange(1794, 1795, [{ op: 'add', path: '/a', value: 1 }]),
      createChange(1794, 1796, [{ op: 'add', path: '/b', value: 2 }]),
    ];
    await store.savePendingChanges('doc1', changes);

    const pending = await algorithm.getPendingToSend('doc1');

    expect(pending).toEqual(changes);
  });

  it('returns null when there is nothing pending', async () => {
    expect(await algorithm.getPendingToSend('doc1')).toBeNull();
  });
});
