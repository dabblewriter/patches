import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTDoc } from '../../src/client/OTDoc';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { MissingChangesError } from '../../src/algorithms/ot/client/applyCommittedChanges';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';

/**
 * Batch contiguity: server committed revs are dense per doc, so an interior hole in a delivered
 * committed batch (e.g. [101, 104] with 102/103 dropped by a partial fan / self-echo exclusion)
 * is a delivery defect — never a legitimate sparse batch. Before this guard, such a batch applied
 * the present ops and advanced committedRev to the LAST rev, silently skipping the missing
 * content: an in-memory doc that read as caught up (committedRev == store rev) while its state was
 * behind, which the reconciliation audit could not heal (it gates on the store being a strictly
 * higher rev). These tests pin the three layers that close it.
 */
const committed = (c: Change, at = 1_700_000_000_000): Change => ({ ...c, committedAt: at });

describe('OTDoc.applyChanges — interior-gap invariant', () => {
  it('throws on an interior-gapped committed batch and does not mutate', () => {
    const doc = new OTDoc<Record<string, unknown>>('doc-1', { state: { base: true }, rev: 100, changes: [] });
    const batch = [
      committed(createChange(100, 101, [{ op: 'add', path: '/a', value: 1 }])),
      // 102, 103 missing — the hole
      committed(createChange(103, 104, [{ op: 'add', path: '/d', value: 4 }])),
    ];
    expect(() => doc.applyChanges(batch)).toThrow(/gap at rev 101 . 104/);
    // Watermark and state untouched — no silent skip.
    expect(doc.committedRev).toBe(100);
    expect(doc.state).toEqual({ base: true });
  });

  it('applies a contiguous committed batch normally (regression)', () => {
    const doc = new OTDoc<Record<string, unknown>>('doc-1', { state: { base: true }, rev: 100, changes: [] });
    doc.applyChanges([
      committed(createChange(100, 101, [{ op: 'add', path: '/a', value: 1 }])),
      committed(createChange(101, 102, [{ op: 'add', path: '/b', value: 2 }])),
      committed(createChange(102, 103, [{ op: 'add', path: '/c', value: 3 }])),
    ]);
    expect(doc.committedRev).toBe(103);
    expect(doc.state).toEqual({ base: true, a: 1, b: 2, c: 3 });
  });
});

describe('OTAlgorithm.applyServerChanges — interior-gap handling', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: { base: true }, rev: 100 });
  });

  it('throws MissingChangesError when the store is also behind (protects the store from gapping)', async () => {
    const batch = [
      committed(createChange(100, 101, [{ op: 'add', path: '/a', value: 1 }])),
      committed(createChange(103, 104, [{ op: 'add', path: '/d', value: 4 }])),
    ];
    await expect(algorithm.applyServerChanges('doc1', batch, undefined)).rejects.toBeInstanceOf(MissingChangesError);
    // The store must not have been advanced past the hole.
    expect(await store.getCommittedRev('doc1')).toBe(100);
  });

  it('rebuilds the open doc from the complete store instead of skipping content (the observed case)', async () => {
    // Store is complete to rev 104 (a peer/writer persisted the full history).
    await algorithm.applyServerChanges(
      'doc1',
      [
        committed(createChange(100, 101, [{ op: 'add', path: '/a', value: 1 }])),
        committed(createChange(101, 102, [{ op: 'add', path: '/b', value: 2 }])),
        committed(createChange(102, 103, [{ op: 'add', path: '/c', value: 3 }])),
        committed(createChange(103, 104, [{ op: 'add', path: '/d', value: 4 }])),
      ],
      undefined
    );
    expect(await store.getCommittedRev('doc1')).toBe(104);

    // A follower doc is still at rev 100 and receives an interior-gapped fan [101, 104].
    const doc = new OTDoc<Record<string, unknown>>('doc1', { state: { base: true }, rev: 100, changes: [] });
    const gappedFan = [
      committed(createChange(100, 101, [{ op: 'add', path: '/a', value: 1 }])),
      committed(createChange(103, 104, [{ op: 'add', path: '/d', value: 4 }])),
    ];
    await algorithm.applyServerChanges('doc1', gappedFan, doc);

    // Healed from the store: caught up to 104 with the SKIPPED content (b, c) present.
    expect(doc.committedRev).toBe(104);
    expect(doc.state).toEqual({ base: true, a: 1, b: 2, c: 3, d: 4 });
  });

  it('applies a contiguous fan incrementally (regression)', async () => {
    const doc = new OTDoc<Record<string, unknown>>('doc1', { state: { base: true }, rev: 100, changes: [] });
    await algorithm.applyServerChanges(
      'doc1',
      [
        committed(createChange(100, 101, [{ op: 'add', path: '/a', value: 1 }])),
        committed(createChange(101, 102, [{ op: 'add', path: '/b', value: 2 }])),
      ],
      doc
    );
    expect(doc.committedRev).toBe(102);
    expect(doc.state).toEqual({ base: true, a: 1, b: 2 });
  });
});
