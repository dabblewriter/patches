/**
 * A never-synced client (local rev 0) flushes a pending queue big enough to split into batches.
 * The server answers the first batch with `docReloadRequired`, which makes the client install the
 * server's head and rebase what is left of the queue against the real history.
 *
 * The batches were computed before all that. Sending the rest of them would put the pre-rebase,
 * still-baseRev-0 copies of those changes on the wire, and the server has no way to transform
 * them onto a head they never saw: it either stacks them verbatim (overwriting whatever paths
 * they touch) or reads the entire change log to rebase them (unbounded, and fatal on a large
 * doc). The queue must be re-derived from the store instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { StatusError } from '../../src/net/error.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change } from '../../src/types.js';
import { makeConnection } from './connectionMock.js';

/** The server's existing content, committed long before this client ever opened the doc. */
const serverChange = (rev: number): Change => ({
  id: `s${rev}`,
  rev,
  baseRev: rev - 1,
  ops: [{ op: 'add', path: `/docs/d${rev}`, value: { text: `SERVER-${rev}` } }],
  createdAt: rev,
  committedAt: rev,
});

/**
 * Minted on a store with no committed state, so baseRev 0. Distinct paths, so the reload's
 * rebase keeps them and the flush really does have more to send afterwards.
 */
const pendingChange = (rev: number): Change =>
  ({
    id: `p${rev}`,
    rev,
    baseRev: 0,
    ops: [{ op: 'add', path: `/docs/c${rev}`, value: { text: `CLIENT-${rev}` } }],
    createdAt: rev,
  }) as unknown as Change;

describe('PatchesSync.flushDoc: batches computed before a reload are stale', () => {
  let sync: PatchesSync | undefined;

  afterEach(() => {
    sync?.disconnect();
    sync = undefined;
  });

  it('re-derives the queue after docReloadRequired instead of sending the pre-computed batches', async () => {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    const patches = new Patches({ algorithms: { ot: algorithm } });
    await patches.trackDocs(['doc1']);
    await store.savePendingChanges('doc1', [pendingChange(1), pendingChange(2), pendingChange(3)]);

    const history = [serverChange(1), serverChange(2), serverChange(3)];
    const connection = makeConnection({
      getDoc: vi.fn(async () => ({ state: null, rev: 0, changes: history })),
      getChangesSince: vi.fn(async (_id: string, rev: number) => history.filter(c => c.rev > rev)),
      // The server's baseRev-0 heal: the batch is committed onto the tip and the client is told
      // its local state is stale.
      commitChanges: vi.fn(async (_docId: string, changes: Change[]) => ({
        changes,
        ...(changes[0].baseRev === 0 ? { docReloadRequired: true as const } : {}),
      })),
    });
    // One change per batch, so the queue is guaranteed to split.
    sync = new PatchesSync(patches, connection as any, { maxPayloadBytes: 1 });
    sync['updateState']({ connected: true });

    await (sync as any).syncDoc('doc1');
    // The reload's follow-up pass is queued on the sync gate, not awaited by the flush.
    await vi.waitFor(() => expect(sync!.docStates.state['doc1'].hasPending).toBe(false));

    const sent = connection.commitChanges.mock.calls.map(([, batch]: [string, Change[]]) => batch);

    // Only the batch that triggered the heal may carry baseRev 0. The rest of the queue still has
    // to be delivered, and every change in it must ride the reloaded baseRev, never the stale 0
    // that makes the server either overwrite the doc or replay its whole change log.
    expect(sent[0].map(c => c.id)).toEqual(['p1']);
    expect(sent[0][0].baseRev).toBe(0);
    const rest = sent.slice(1).flat();
    expect(rest.map(c => c.id)).toEqual(['p2', 'p3']);
    for (const change of rest) expect(change.baseRev).toBe(3);
  });

  it('reloads and re-derives the queue when the server refuses a stale continuation (409)', async () => {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    const patches = new Patches({ algorithms: { ot: algorithm } });
    await patches.trackDocs(['doc1']);
    // The crash window this recovers from: an earlier flush's first batch was committed and
    // dropped from pending, but the reload that should have followed never landed. The store
    // reopens at committedRev 0 with a queue whose head sits past rev 1, still at baseRev 0 —
    // the shape the server refuses rather than rebases.
    await store.savePendingChanges('doc1', [pendingChange(2), pendingChange(3)]);

    const history = [serverChange(1), serverChange(2), serverChange(3)];
    const connection = makeConnection({
      getDoc: vi.fn(async () => ({ state: null, rev: 0, changes: history })),
      getChangesSince: vi.fn(async (_id: string, rev: number) => history.filter(c => c.rev > rev)),
      commitChanges: vi.fn(async (_docId: string, changes: Change[]) => {
        // The server's refusal: a baseRev-0 continuation onto a doc this upload did not create.
        if (changes[0].baseRev === 0) throw new StatusError(409, 'stale continuation', { scope: 'doc' });
        return { changes };
      }),
    });
    sync = new PatchesSync(patches, connection as any, { maxPayloadBytes: 1 });
    sync['updateState']({ connected: true });

    await (sync as any).syncDoc('doc1');
    // The reload's follow-up pass is queued on the sync gate, not awaited by the flush.
    await vi.waitFor(() => expect(sync!.docStates.state['doc1'].hasPending).toBe(false));

    // The refusal committed nothing and dropped nothing: the reload rebases the whole queue —
    // refused batch included — onto the server head, and the follow-up delivers all of it there.
    expect(connection.getDoc).toHaveBeenCalled();
    const sent = connection.commitChanges.mock.calls.map(([, batch]: [string, Change[]]) => batch);
    const committed = sent.filter(batch => batch[0].baseRev !== 0).flat();
    expect(committed.map(c => c.id)).toEqual(['p2', 'p3']);
    for (const change of committed) expect(change.baseRev).toBe(3);
  });
});
