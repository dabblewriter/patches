import { describe, expect, it } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change } from '../../src/types';

/**
 * Cross-batch ordering guards in LWWAlgorithm.applyServerChanges (fuzz FINDING-2):
 * - a STALE batch (rev already covered by committedRev) is skipped wholesale, so a broadcast
 *   that was queued/in-flight when a newer commit response applied can't regress fields;
 * - the client's own commit response (ids recorded by confirmSent) is exempt:
 *   its corrections legitimately carry revs at or behind the client's committedRev.
 */
describe('LWWAlgorithm applyServerChanges guards', () => {
  const DOC = 'guard-doc';

  function committed(baseRev: number, rev: number, ops: JSONPatchOp[], id?: string): Change {
    return createChange(baseRev, rev, ops, { committedAt: 1000 + rev }, id);
  }

  function setup() {
    const store = new LWWInMemoryStore();
    const algorithm = new LWWAlgorithm(store);
    return { store, algorithm };
  }

  async function docState(algorithm: LWWAlgorithm): Promise<any> {
    return (await algorithm.loadDoc(DOC))!.state;
  }

  it('skips a stale broadcast whose rev is already covered by committedRev', async () => {
    const { algorithm } = setup();
    await algorithm.applyServerChanges(
      DOC,
      [committed(0, 1, [{ op: 'replace', path: '/a', value: 'old', ts: 1, rev: 1 }])],
      undefined
    );
    await algorithm.applyServerChanges(
      DOC,
      [committed(1, 2, [{ op: 'replace', path: '/a', value: 'new', ts: 2, rev: 2 }])],
      undefined
    );

    // The rev-1 broadcast redelivered late (e.g. it was in flight while the rev-2 commit
    // response applied). Applying it would regress /a to 'old' with no later heal.
    const applied = await algorithm.applyServerChanges(
      DOC,
      [committed(0, 1, [{ op: 'replace', path: '/a', value: 'old', ts: 1, rev: 1 }])],
      undefined
    );

    expect(applied).toEqual([]);
    expect(await docState(algorithm)).toEqual({ a: 'new' });
    expect(await algorithm.getCommittedRev(DOC)).toBe(2);
  });

  it('applies a commit response carrying old-rev corrections after confirmSent', async () => {
    const { algorithm } = setup();
    await algorithm.applyServerChanges(
      DOC,
      [committed(0, 3, [{ op: 'replace', path: '/a', value: 'base', ts: 1, rev: 3 }])],
      undefined
    );

    // Mint a local write at committedRev 3 and capture it as the sending change.
    await algorithm.handleDocChange(DOC, [{ op: 'replace', path: '/a', value: 'mine' }], undefined, {});
    const [sending] = (await algorithm.getPendingToSend(DOC))!;

    // Broadcasts advance committedRev past the sending change's baseRev (a retry window).
    await algorithm.applyServerChanges(
      DOC,
      [committed(3, 4, [{ op: 'replace', path: '/b', value: 4, ts: 4, rev: 4 }])],
      undefined
    );
    await algorithm.applyServerChanges(
      DOC,
      [committed(4, 5, [{ op: 'replace', path: '/c', value: 5, ts: 5, rev: 5 }])],
      undefined
    );

    // The send loses by LWW; the response echoes the stored winner. Its shape (baseRev 3,
    // rev 5) looks exactly like a stale batch — only the confirmSent id exempts it.
    await algorithm.confirmSent(DOC, [sending]);
    const response = committed(3, 5, [{ op: 'replace', path: '/a', value: 'server-won', ts: 9, rev: 3 }], sending.id);
    const applied = await algorithm.applyServerChanges(DOC, [response], undefined);

    expect(applied).toHaveLength(1);
    expect((await docState(algorithm)).a).toBe('server-won');
  });

  it('still skips a stale foreign batch while a response is expected', async () => {
    const { algorithm } = setup();
    await algorithm.applyServerChanges(
      DOC,
      [committed(0, 3, [{ op: 'replace', path: '/a', value: 'base', ts: 1, rev: 3 }])],
      undefined
    );
    await algorithm.handleDocChange(DOC, [{ op: 'replace', path: '/b', value: 'mine' }], undefined, {});
    const [sending] = (await algorithm.getPendingToSend(DOC))!;
    await algorithm.confirmSent(DOC, [sending]);

    // A foreign redelivery (different id, stale revs) is not the expected response.
    const applied = await algorithm.applyServerChanges(
      DOC,
      [committed(0, 2, [{ op: 'replace', path: '/a', value: 'regressed', ts: 0, rev: 2 }])],
      undefined
    );

    expect(applied).toEqual([]);
    expect((await docState(algorithm)).a).toBe('base');
  });
});
