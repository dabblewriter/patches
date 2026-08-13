/**
 * The follow-up flush pass used to fire at most once per flush (only after a mid-flush reload).
 * A mixed-baseRev queue now flushes one frame per pass and leaves the rest behind by design, so
 * the pass has to re-arm on an ordinary successful drain too — which means it needs a progress
 * check. Without one, any state where a pass commits but the queue does not shrink is an
 * unbounded commit + IndexedDB cycle with no error and nothing user-visible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change } from '../../src/types.js';
import { makeConnection } from './connectionMock.js';

/** A store whose pending replace silently no-ops — one way a pass commits and drains nothing. */
class StubbornStore extends OTInMemoryStore {
  async applyServerChanges(
    docId: string,
    serverChanges: Change[],
    _rebased: Change[],
    pendingTailRev?: number
  ): Promise<void | 'conflict'> {
    const keep = await this.getPendingChanges(docId);
    return super.applyServerChanges(docId, serverChanges, keep, pendingTailRev);
  }
}

const pendingChange = (rev: number, baseRev: number): Change =>
  ({
    id: `p${rev}`,
    rev,
    baseRev,
    ops: [{ op: 'add', path: `/c${rev}`, value: rev }],
    createdAt: rev,
  }) as unknown as Change;

describe('PatchesSync.flushDoc follow-up pass', () => {
  let sync: PatchesSync | undefined;

  afterEach(() => {
    sync?.disconnect();
    sync = undefined;
  });

  it('stops re-arming when a pass commits without draining the queue', async () => {
    const store = new StubbornStore();
    const algorithm = new OTAlgorithm(store);
    const patches = new Patches({ algorithms: { ot: algorithm } });
    await patches.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: {}, rev: 1 });
    // Mixed baseRev, so the flush slices and legitimately leaves a row behind — exactly the
    // shape that now re-arms the follow-up pass.
    await store.savePendingChanges('doc1', [pendingChange(2, 1), pendingChange(3, 0)]);

    const commitChanges = vi.fn(async (_docId: string, changes: Change[]) => {
      // A backstop, not part of the contract: keeps a regression from hanging the run.
      if (commitChanges.mock.calls.length > 4) throw new Error('flushDoc is spinning');
      return { changes: changes.map(c => ({ ...c, committedAt: 1 })) };
    });
    sync = new PatchesSync(patches, makeConnection({ commitChanges }) as any);
    sync['updateState']({ connected: true });

    await (sync as any).syncDoc('doc1');
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));

    // One pass only. The queue head never moved, so the doc parks with work still pending
    // instead of burning commits forever; the next mint or reconnect retries it.
    expect(commitChanges).toHaveBeenCalledTimes(1);
    expect(sync.docStates.state['doc1'].hasPending).toBe(true);
  });

  it('still re-arms while the queue is actually draining, one frame per pass', async () => {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    const patches = new Patches({ algorithms: { ot: algorithm } });
    await patches.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: {}, rev: 1 });
    await store.savePendingChanges('doc1', [pendingChange(2, 1), pendingChange(3, 0), pendingChange(4, 0)]);

    const commitChanges = vi.fn(async (_docId: string, changes: Change[]) => ({
      changes: changes.map((c, i) => ({ ...c, rev: commitChanges.mock.calls.length + 1 + i, committedAt: 1 })),
    }));
    sync = new PatchesSync(patches, makeConnection({ commitChanges }) as any);
    sync['updateState']({ connected: true });

    await (sync as any).syncDoc('doc1');
    await vi.waitFor(() => expect(sync!.docStates.state['doc1'].hasPending).toBe(false));

    // Two frames in the queue (baseRev 1, then baseRev 0) — two passes, each at its true baseRev,
    // driven entirely by the follow-up rather than waiting for the next mint.
    const sent = commitChanges.mock.calls.map(([, batch]: [string, Change[]]) => batch);
    expect(sent.map(batch => batch.map(c => c.id))).toEqual([['p2'], ['p3', 'p4']]);
    expect(sent.map(batch => batch[0].baseRev)).toEqual([1, 0]);
    expect(await store.getPendingChanges('doc1')).toEqual([]);
  });
});
