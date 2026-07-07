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

  describe('already-committed stragglers (DAB-607)', () => {
    // A raced pending write can re-queue a change after its echo already advanced
    // committedRev and cleared it. Re-stamping and re-sending it would commit a duplicate:
    // the advanced baseRev is past the original commit, outside the server's
    // `startAfter: baseRev` id dedup. The send choke point must drop it, not heal it.
    const ops = [{ op: 'replace', path: '/title', value: 'a' }] as any;

    it('drops a stranded copy of its own committed change instead of re-sending it', async () => {
      const stranded = createChange(1794, 1795, ops);
      const committedCopy = { ...stranded, committedAt: 1234 };
      // Echo applied (committedRev → 1795) but the stale pending write re-stranded the copy.
      await store.applyServerChanges('doc1', [committedCopy], [stranded]);

      expect(await algorithm.getPendingToSend('doc1')).toBeNull();
      // The strand is gone from the store too, not just the outgoing batch.
      expect(await store.getPendingChanges('doc1')).toEqual([]);
    });

    it('keeps fresh pending changes while dropping the stranded one', async () => {
      const stranded = createChange(1794, 1795, ops);
      const committedCopy = { ...stranded, committedAt: 1234 };
      const fresh = createChange(1795, 1796, [{ op: 'replace', path: '/title', value: 'ab' }]);
      await store.applyServerChanges('doc1', [committedCopy], [stranded, fresh]);

      const pending = await algorithm.getPendingToSend('doc1');

      expect(pending!.map(c => c.id)).toEqual([fresh.id]);
      expect(pending![0].baseRev).toBe(1795);
      expect((await store.getPendingChanges('doc1')).map(c => c.id)).toEqual([fresh.id]);
    });

    it('still re-stamps a stale straggler that was never committed', async () => {
      // Same stale-baseRev signature but no committed copy: not a strand, so the
      // existing heal-and-send path applies.
      const straggler = createChange(1791, 1795, ops);
      await store.savePendingChanges('doc1', [straggler]);

      const pending = await algorithm.getPendingToSend('doc1');

      expect(pending).toHaveLength(1);
      expect(pending![0].id).toBe(straggler.id);
      expect(pending![0].baseRev).toBe(1794);
    });
  });
});
