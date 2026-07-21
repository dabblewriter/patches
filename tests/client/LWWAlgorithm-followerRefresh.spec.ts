import { describe, expect, it, vi } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import { LWWDoc } from '../../src/client/LWWDoc';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change } from '../../src/types';

/**
 * Follower fan-blindness heal in LWWAlgorithm.applyServerChanges.
 *
 * Two contexts share one store (the shared IndexedDB in the app; a shared LWWInMemoryStore
 * here). The writer context persists a commit BEFORE it fans the same batch to followers, so
 * by the time a follower applies the fan its store watermark is already past the batch's rev
 * and every op stale-skips. Before the fix, the follower's OPEN doc — an in-memory object the
 * store advance never touched — was left behind forever. Now the empty-batch path refreshes the
 * open doc from the store instead of returning empty-handed.
 */
describe('LWWAlgorithm follower fan-blindness heal', () => {
  const DOC = 'follower-doc';

  function committed(baseRev: number, rev: number, ops: JSONPatchOp[], id?: string): Change {
    return createChange(baseRev, rev, ops, { committedAt: 1000 + rev }, id);
  }

  it('refreshes an open follower doc when the shared store already advanced past the fan', async () => {
    const store = new LWWInMemoryStore();
    const writer = new LWWAlgorithm(store);
    const follower = new LWWAlgorithm(store);

    // The follower holds the doc open at rev 0.
    const doc = new LWWDoc(DOC);
    expect(doc.committedRev).toBe(0);

    const batch = committed(0, 1, [{ op: 'replace', path: '/foreign', value: 'x', ts: 1, rev: 1 }]);

    // Writer persists the commit to the shared store first (no open doc of its own).
    await writer.applyServerChanges(DOC, [batch], undefined);
    expect(await store.getCommittedRev(DOC)).toBe(1);

    // The same commit is fanned to the follower, whose store watermark is already at rev 1, so
    // the batch stale-skips wholesale. Without the heal the open doc never sees /foreign.
    const applied = await follower.applyServerChanges(DOC, [batch], doc);

    expect(applied).toEqual([]);
    expect(doc.state).toEqual({ foreign: 'x' });
    expect(doc.committedRev).toBe(1);
  });

  it('does not rebuild an already-current doc on an own-echo re-delivery', async () => {
    const store = new LWWInMemoryStore();
    const algorithm = new LWWAlgorithm(store);
    const doc = new LWWDoc(DOC);

    const batch = committed(0, 1, [{ op: 'replace', path: '/a', value: 'v', ts: 1, rev: 1 }]);

    // First delivery advances both the doc and the store together.
    await algorithm.applyServerChanges(DOC, [batch], doc);
    expect(doc.committedRev).toBe(1);
    expect(doc.state).toEqual({ a: 'v' });

    // The same batch redelivered to a doc that is already current must not trigger a
    // full-state rebuild (getDoc is only reached by the refresh path).
    const getDocSpy = vi.spyOn(store, 'getDoc');
    const applied = await algorithm.applyServerChanges(DOC, [batch], doc);

    expect(applied).toEqual([]);
    expect(getDocSpy).not.toHaveBeenCalled();
    expect(doc.state).toEqual({ a: 'v' });
  });

  it('folds a pending delta op exactly once when healing (no double-apply through the echo)', async () => {
    const store = new LWWInMemoryStore();
    const writer = new LWWAlgorithm(store);
    const follower = new LWWAlgorithm(store);
    const doc = new LWWDoc<{ count?: number; foreign?: string }>(DOC);

    // Follower mints a pending combinable op on the open doc (doc shows 5).
    await follower.handleDocChange(DOC, [{ op: '@inc', path: '/count', value: 5 }], doc, {});
    expect(doc.state).toEqual({ count: 5 });

    // A foreign commit advances the shared store past the doc.
    const foreign = committed(0, 1, [{ op: 'replace', path: '/foreign', value: 'x', ts: 1, rev: 1 }]);
    await writer.applyServerChanges(DOC, [foreign], undefined);

    // The fanned foreign commit stale-skips; the heal must apply the pending @inc once, not twice.
    await follower.applyServerChanges(DOC, [foreign], doc);
    expect(doc.state).toEqual({ foreign: 'x', count: 5 });
    expect(doc.state).toEqual((await store.getDoc(DOC))!.state);

    // Send the pending op, confirm it, then replay the server's echo of the same op. The echo
    // pure-matches the in-flight key, so a doubled base state would silently persist here.
    const toSend = await follower.getPendingToSend(DOC);
    expect(toSend).toHaveLength(1);
    const sent = toSend![0];
    await follower.confirmSent(DOC, [sent]);
    const echo = committed(
      1,
      2,
      sent.ops.map(op => ({ ...op, rev: 2 })),
      sent.id
    );
    await follower.applyServerChanges(DOC, [echo], doc);

    expect(doc.state).toEqual({ foreign: 'x', count: 5 });
    expect(doc.state).toEqual((await store.getDoc(DOC))!.state);
  });

  it('preserves a local optimistic edit while healing in the foreign field', async () => {
    const store = new LWWInMemoryStore();
    const writer = new LWWAlgorithm(store);
    const follower = new LWWAlgorithm(store);
    const doc = new LWWDoc(DOC);

    // Follower mints a local edit on the open doc (pending in the shared store).
    await follower.handleDocChange(DOC, [{ op: 'replace', path: '/local', value: 'mine' }], doc, {});
    expect(doc.state).toEqual({ local: 'mine' });
    expect(doc.committedRev).toBe(0);

    // A foreign commit lands via the writer and advances the shared store past the doc.
    const foreign = committed(0, 1, [{ op: 'replace', path: '/foreign', value: 'x', ts: 1, rev: 1 }]);
    await writer.applyServerChanges(DOC, [foreign], undefined);
    expect(await store.getCommittedRev(DOC)).toBe(1);

    // The fanned foreign commit stale-skips; the refresh folds committed + pending, so the
    // local optimistic value survives alongside the newly-applied foreign field.
    await follower.applyServerChanges(DOC, [foreign], doc);

    expect(doc.state).toEqual({ foreign: 'x', local: 'mine' });
    expect(doc.committedRev).toBe(1);
  });
});
