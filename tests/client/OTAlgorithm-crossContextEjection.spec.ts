import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import type { OTDoc } from '../../src/client/OTDoc';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { createChange } from '../../src/data/change';
import type { Change } from '../../src/types';

/**
 * An ejection performed in ONE context over a shared store, with a SECOND context holding the
 * same doc open (dw3 DAB-1296). `ejectPendingChange` rebuilds only the doc it is handed; the
 * other tab's open copy keeps the ejected change in memory, and nothing on its import path can
 * remove one pending row — an ejection never advances the committed rev, so every rev-gated
 * import declines, and the pending guards decline precisely because the ejected row is what is
 * pending.
 *
 * Two things must then hold, and both are tested here over two `OTIndexedDBStore` instances on
 * one fake-indexeddb database (the DAB-783 two-tab shape):
 *
 * 1. The follower's torn-write merge (`_collectPending`) must NOT fold the quarantined row back
 *    into the store on its next receive — that is the resurrection: the sending tab re-sends
 *    it, the server refuses it again, and the app's ejection budget caps the doc.
 * 2. `dropQuarantinedPending` brings the follower's open doc in line with the store, and only
 *    when the doc holds a quarantined row — a genuine torn-write row is left for
 *    `getPendingToSend` to report.
 */
let dbSeq = 0;
const DOC = 'shared-doc';

describe('OTAlgorithm cross-context ejection (DAB-1296)', () => {
  let storeW: OTIndexedDBStore; // the writer tab — the one that sees the refusal and ejects
  let storeF: OTIndexedDBStore; // the follower tab — the one that minted the refused change
  let algW: OTAlgorithm;
  let algF: OTAlgorithm;
  let docF: OTDoc<any>;

  beforeEach(async () => {
    const dbName = `cross-context-ejection-${dbSeq++}`;
    storeW = new OTIndexedDBStore(dbName);
    storeF = new OTIndexedDBStore(dbName);
    algW = new OTAlgorithm(storeW);
    algF = new OTAlgorithm(storeF);
    await storeW.saveDoc(DOC, { state: { a: 0 }, rev: 1 });
    await algW.trackDocs([DOC]);
    // The follower opens the doc from the shared store, then mints the change the server will
    // refuse — so it is pending in the store AND in the follower's memory.
    docF = algF.createDoc(DOC, (await algF.loadDoc(DOC))!) as OTDoc<any>;
  });

  /** Mint `ops` in the follower's open doc. */
  async function mintInFollower(ops: Change['ops']): Promise<Change> {
    const [change] = await algF.handleDocChange(DOC, ops, docF, {});
    return change;
  }

  /** The store's pending queue, read through either instance (they share the database). */
  const storePending = () => storeW.getPendingChanges(DOC);

  it('setup: the ejection removes the change from the store but not from the follower doc', async () => {
    const poison = await mintInFollower([{ op: 'add', path: '/x', value: 'refused' }]);

    // The writer sees the server's refusal and ejects; it has no open doc of its own.
    const quarantined = await algW.ejectPendingChange(DOC, poison.id, 'server-refused-change', undefined);

    expect(quarantined?.changeId).toBe(poison.id);
    expect(await storePending()).toEqual([]);
    // The follower's copy is untouched — the row and its effect are still there.
    expect(docF.getPendingChanges().map(c => c.id)).toEqual([poison.id]);
    expect(docF.state).toEqual({ a: 0, x: 'refused' });
  });

  describe('the follower receive must not resurrect the quarantined row', () => {
    it('leaves the quarantined row out of the store when the follower applies a later commit', async () => {
      const poison = await mintInFollower([{ op: 'add', path: '/x', value: 'refused' }]);
      await algW.ejectPendingChange(DOC, poison.id, 'server-refused-change', undefined);

      // The user keeps typing in the follower: a successor is minted on top of the poison's
      // frame, the writer sends it and the server commits it — the poison's rev is now below
      // nothing in the store (the store's queue is empty), which is exactly the window the
      // rev guard alone cannot close.
      const successor = await mintInFollower([{ op: 'replace', path: '/a', value: 1 }]);
      const committed = { ...(await storePending())[0], rev: 2, committedAt: Date.now() };
      expect(committed.id).toBe(successor.id);
      await algW.applyServerChanges(DOC, [committed], undefined);
      expect(await storePending()).toEqual([]);

      // The writer fans the commit out; the follower applies it with its open doc.
      await algF.applyServerChanges(DOC, [committed], docF);

      // Pre-fix: the poison rode `_collectPending`'s torn-write merge back into the store here,
      // to be re-sent, re-refused and re-ejected until the doc's budget capped.
      expect((await storePending()).map(c => c.id)).not.toContain(poison.id);
      expect(await storePending()).toEqual([]);
      expect(await storeW.getCommittedRev(DOC)).toBe(2);
      // And the receive itself put the follower doc on the store's queue: the poison left its
      // memory without anyone calling dropQuarantinedPending.
      expect(docF.getPendingChanges()).toEqual([]);
      expect(docF.state).toEqual({ a: 1 });
    });

    it('never reads the quarantine for an ordinary own echo (the two-tab typing hot path)', async () => {
      let quarantineReads = 0;
      const real = storeF.listQuarantinedChanges.bind(storeF);
      storeF.listQuarantinedChanges = async (docId?: string) => {
        quarantineReads++;
        return real(docId);
      };
      // The follower mints; the writer commits it. Between the writer retiring the store row
      // and the follower hearing the echo, the row is in the follower's memory and NOT in the
      // store — the torn-write shape — on every commit of a follower-minted change.
      const typed = await mintInFollower([{ op: 'replace', path: '/a', value: 1 }]);
      const committed = { ...(await storePending())[0], rev: 2, committedAt: Date.now() };
      expect(committed.id).toBe(typed.id);
      await algW.applyServerChanges(DOC, [committed], undefined);
      expect(await storePending()).toEqual([]);

      await algF.applyServerChanges(DOC, [committed], docF);

      expect(quarantineReads).toBe(0);
      expect(docF.getPendingChanges()).toEqual([]);
      expect(docF.committedRev).toBe(2);
    });

    it('still carries a genuine torn-write row (doc-only, not quarantined) through the receive', async () => {
      // A row the store never accepted — persisted only to the open doc. This is the case the
      // torn-write merge exists for, and the quarantine guard must not touch it.
      const torn = createChange(1, 2, [{ op: 'add', path: '/torn', value: true }]);
      docF.applyChanges([torn]);
      expect(await storePending()).toEqual([]);

      const foreign = createChange(1, 2, [{ op: 'replace', path: '/a', value: 5 }]);
      const committed = { ...foreign, committedAt: Date.now() };
      await algW.applyServerChanges(DOC, [committed], undefined);
      await algF.applyServerChanges(DOC, [committed], docF);

      expect((await storePending()).map(c => c.id)).toEqual([torn.id]);
    });

    it('keeps a quarantined row out of the doc-only merge inside a second ejection too', async () => {
      const poison = await mintInFollower([{ op: 'add', path: '/x', value: 'refused' }]);
      await algW.ejectPendingChange(DOC, poison.id, 'server-refused-change', undefined);
      // A second refused change, minted while the follower still holds the first in memory.
      const second = await mintInFollower([{ op: 'add', path: '/y', value: 'also refused' }]);
      // Put the follower's stale poison ABOVE the store tail, where the rev guard alone would
      // carry it — the shape a rebase leaves behind (the guard covers a copy at or below the
      // tail by itself, which is why this is set up by hand).
      const stale = docF.getPendingChanges().find(c => c.id === poison.id)!;
      docF.import({ state: { a: 0 }, rev: 1, changes: [{ ...stale, rev: 9 }, { ...second }] });
      expect(docF.state).toEqual({ a: 0, x: 'refused', y: 'also refused' });

      // This time the ejecting context IS the follower, handing over its open doc — whose
      // in-memory queue still holds the first poison as a doc-only row above the tail.
      const quarantined = await algF.ejectPendingChange(DOC, second.id, 'server-refused-change', docF);

      expect(quarantined?.changeId).toBe(second.id);
      expect(await storePending()).toEqual([]);
      // The rebuild put the doc on the store's queue: neither poison survives in memory.
      expect(docF.getPendingChanges()).toEqual([]);
      expect(docF.state).toEqual({ a: 0 });
    });
  });

  describe('dropQuarantinedPending', () => {
    it('rebuilds the follower doc from the store and reports the dropped id', async () => {
      const poison = await mintInFollower([{ op: 'add', path: '/x', value: 'refused' }]);
      await algW.ejectPendingChange(DOC, poison.id, 'server-refused-change', undefined);

      expect(await algF.dropQuarantinedPending(DOC, docF)).toEqual([poison.id]);

      expect(docF.getPendingChanges()).toEqual([]);
      expect(docF.hasPending).toBe(false);
      expect(docF.state).toEqual({ a: 0 });
      expect(docF.committedRev).toBe(1);
    });

    it("keeps the store's surviving queue in the rebuilt doc", async () => {
      const poison = await mintInFollower([{ op: 'add', path: '/x', value: 'refused' }]);
      const survivor = await mintInFollower([{ op: 'replace', path: '/a', value: 1 }]);
      await algW.ejectPendingChange(DOC, poison.id, 'server-refused-change', undefined);

      expect(await algF.dropQuarantinedPending(DOC, docF)).toEqual([poison.id]);

      // The successor was rebased past the poison and renumbered by the ejection; the doc now
      // mirrors that queue exactly.
      const stored = await storePending();
      expect(stored.map(c => c.id)).toEqual([survivor.id]);
      expect(docF.getPendingChanges()).toEqual(stored);
      expect(docF.state).toEqual({ a: 1 });
    });

    it('after the drop, a follower receive no longer has anything to resurrect', async () => {
      const poison = await mintInFollower([{ op: 'add', path: '/x', value: 'refused' }]);
      await algW.ejectPendingChange(DOC, poison.id, 'server-refused-change', undefined);
      await algF.dropQuarantinedPending(DOC, docF);

      const foreign = createChange(1, 2, [{ op: 'replace', path: '/a', value: 5 }]);
      const committed = { ...foreign, committedAt: Date.now() };
      await algW.applyServerChanges(DOC, [committed], undefined);
      await algF.applyServerChanges(DOC, [committed], docF);

      expect(await storePending()).toEqual([]);
      expect(docF.getPendingChanges()).toEqual([]);
      expect(docF.state).toEqual({ a: 5 });
    });

    it('is a no-op when the doc holds nothing quarantined', async () => {
      const kept = await mintInFollower([{ op: 'replace', path: '/a', value: 1 }]);

      expect(await algF.dropQuarantinedPending(DOC, docF)).toEqual([]);
      expect(docF.getPendingChanges().map(c => c.id)).toEqual([kept.id]);
      expect(docF.state).toEqual({ a: 1 });
    });

    it('leaves a genuine torn-write row alone — the store lacking it is not an ejection', async () => {
      const torn = createChange(1, 2, [{ op: 'add', path: '/torn', value: true }]);
      docF.applyChanges([torn]);

      expect(await algF.dropQuarantinedPending(DOC, docF)).toEqual([]);
      expect(docF.getPendingChanges().map(c => c.id)).toEqual([torn.id]);
      expect(docF.state).toEqual({ a: 0, torn: true });
    });

    it('carries a torn-write row held ALONGSIDE the poison through the rebuild', async () => {
      const poison = await mintInFollower([{ op: 'add', path: '/x', value: 'refused' }]);
      await algW.ejectPendingChange(DOC, poison.id, 'server-refused-change', undefined);
      // A later mint whose store write failed: in the doc's queue, nowhere else.
      const torn = createChange(1, 3, [{ op: 'add', path: '/torn', value: true }]);
      docF.applyChanges([torn]);
      expect(docF.state).toEqual({ a: 0, x: 'refused', torn: true });

      expect(await algF.dropQuarantinedPending(DOC, docF)).toEqual([poison.id]);

      // The poison is gone; the torn row rode the rebuild as a successor, as it does through
      // ejectPendingChange, and still waits for the send path to report it.
      expect(docF.getPendingChanges().map(c => c.id)).toEqual([torn.id]);
      expect(docF.state).toEqual({ a: 0, torn: true });
      expect(await storePending()).toEqual([]);
    });

    it('reports only the ids the rebuild actually removed', async () => {
      const poison = await mintInFollower([{ op: 'add', path: '/x', value: 'refused' }]);
      await algW.ejectPendingChange(DOC, poison.id, 'server-refused-change', undefined);
      // A quarantine entry whose id the store's queue STILL holds (a stable-id re-drive can
      // recreate the row): the rebuild re-imports it, so it must not read as dropped.
      const redriven = await mintInFollower([{ op: 'replace', path: '/a', value: 7 }]);
      await storeW.quarantinePendingChange(DOC, { ...redriven }, 'stale entry', await storePending());
      expect((await storePending()).map(c => c.id)).toEqual([redriven.id]);

      expect(await algF.dropQuarantinedPending(DOC, docF)).toEqual([poison.id]);

      expect(docF.getPendingChanges().map(c => c.id)).toEqual([redriven.id]);
      expect(docF.state).toEqual({ a: 7 });
    });

    it('is a no-op on a doc with no pending at all, without reading the quarantine', async () => {
      let quarantineReads = 0;
      const real = storeF.listQuarantinedChanges.bind(storeF);
      storeF.listQuarantinedChanges = async (docId?: string) => {
        quarantineReads++;
        return real(docId);
      };

      expect(await algF.dropQuarantinedPending(DOC, docF)).toEqual([]);
      expect(quarantineReads).toBe(0);
    });
  });
});
