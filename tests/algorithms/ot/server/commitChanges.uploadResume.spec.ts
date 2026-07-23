import { describe, expect, it } from 'vitest';
import { commitChanges } from '../../../../src/algorithms/ot/server/commitChanges';
import { applyChanges } from '../../../../src/algorithms/ot/shared/applyChanges';
import type { Change, ChangeInput } from '../../../../src/types';
import { OTFuzzBackend } from '../../../fuzz/otFuzzBackend';

/**
 * DAB-837 regression: an interrupted multi-batch base-0 upload must be able to RESUME.
 *
 * The failure it pins: a large upload's first batch commits but the response is lost (the
 * normal failure mode for a multi-MB create), so the whole queue stays pending client-side.
 * Every retry used to re-mint its batchId (`breakChangesIntoBatches`), so the server's
 * own-upload exemption — matched by batchId against the doc's oldest change — could never
 * recognize the resend. The root-op guard then 400'd every attempt forever, latching the
 * client in permanent retry while the upload's tail (real user data) stayed marooned in
 * IndexedDB.
 *
 * The fix recognizes the upload by its CREATING CHANGE'S ID arriving again in the batch,
 * keeps baseRev 0 so the read-side dedup sees the committed prefix, and lets the prefix
 * echoes match across connections (a resume is a new connection by definition).
 *
 * These tests run the real commitChanges against a real in-memory backend (no mocks).
 */

const DOC = 'doc1';
const sessionTimeoutMillis = 5 * 60_000;

const change = (id: string, rev: number, ops: Change['ops'], extra?: Partial<ChangeInput>): ChangeInput => ({
  id,
  baseRev: 0,
  rev,
  ops,
  createdAt: Date.now(),
  ...extra,
});

/** The upload queue: c1 creates the doc, c2-c4 build on it. Non-idempotent array ops so any double-apply shows. */
const uploadQueue = (extra?: Partial<ChangeInput>): ChangeInput[] => [
  change('c1', 1, [{ op: 'add', path: '', value: { tags: ['a'] } }], extra),
  change('c2', 2, [{ op: 'add', path: '/tags/1', value: 'b' }], extra),
  change('c3', 3, [{ op: 'add', path: '/tags/2', value: 'c' }], extra),
  change('c4', 4, [{ op: 'add', path: '/tags/3', value: 'd' }], extra),
];

const headState = (backend: OTFuzzBackend) => applyChanges(null, backend.log(DOC)) as any;

/** Record every saveChanges payload so a test can prove the read-side dedup did the work
 * (a store-guard rescue would show the echoes in a rejected save attempt). */
function spySaves(backend: OTFuzzBackend): Change[][] {
  const calls: Change[][] = [];
  const orig = backend.saveChanges.bind(backend);
  backend.saveChanges = async (docId: string, changes: Change[]) => {
    calls.push(changes);
    return orig(docId, changes);
  };
  return calls;
}

describe('commitChanges — resuming an interrupted base-0 upload (DAB-837)', () => {
  it('completes a lost-ack resend whose batchId was re-minted', async () => {
    const backend = new OTFuzzBackend();
    const queue = uploadQueue({ batchId: 'attempt-1' });

    // Batch 1 commits (revs 1-2); the response is lost, so the client still holds c1-c4.
    await commitChanges(backend, DOC, queue.slice(0, 2), sessionTimeoutMillis);
    expect(headState(backend).tags).toEqual(['a', 'b']);

    // The retry re-splits the queue and presents a different batchId.
    const saves = spySaves(backend);
    const result = await commitChanges(backend, DOC, uploadQueue({ batchId: 'attempt-2' }), sessionTimeoutMillis);

    // The committed prefix echoes back for confirmation; only the tail commits, in order.
    expect(result.catchupChanges.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(result.newChanges.map(c => c.id)).toEqual(['c3', 'c4']);
    expect(result.newChanges.map(c => c.rev)).toEqual([3, 4]);
    // No rebase heal: that would tell the client to drop the batch from pending and reload.
    expect(result.docReloadRequired).toBeUndefined();
    // The dedup was read-side: the save carried only the tail, no store-guard rescue.
    expect(saves).toHaveLength(1);
    expect(saves[0].map(c => c.id)).toEqual(['c3', 'c4']);
    expect(headState(backend).tags).toEqual(['a', 'b', 'c', 'd']);
    expect(backend.log(DOC).map(c => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('completes a resend that carries no batchId at all', async () => {
    // A queue that fits one wire batch is sent without a batchId — interrupted, it resends
    // the same way. Only the creating change's id can identify the upload.
    const backend = new OTFuzzBackend();
    await commitChanges(backend, DOC, uploadQueue().slice(0, 2), sessionTimeoutMillis);

    const result = await commitChanges(backend, DOC, uploadQueue(), sessionTimeoutMillis);

    expect(result.catchupChanges.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(result.newChanges.map(c => c.id)).toEqual(['c3', 'c4']);
    expect(result.docReloadRequired).toBeUndefined();
    expect(headState(backend).tags).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not let connection identity disown the prefix (resume is a new connection)', async () => {
    const backend = new OTFuzzBackend();
    await commitChanges(
      backend,
      DOC,
      uploadQueue({ batchId: 'attempt-1', clientId: 'conn-A' }).slice(0, 2),
      sessionTimeoutMillis
    );

    // The resume comes from a NEW connection: same change ids, different clientId. Treating
    // the committed prefix as foreign would transform c3/c4 against their own head's echoes
    // (double-shifting the array inserts) and re-save c1/c2.
    const saves = spySaves(backend);
    const result = await commitChanges(
      backend,
      DOC,
      uploadQueue({ batchId: 'attempt-2', clientId: 'conn-B' }),
      sessionTimeoutMillis
    );

    expect(result.catchupChanges.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(result.newChanges.map(c => c.id)).toEqual(['c3', 'c4']);
    expect(saves).toHaveLength(1);
    expect(saves[0].map(c => c.id)).toEqual(['c3', 'c4']);
    expect(headState(backend).tags).toEqual(['a', 'b', 'c', 'd']);
  });

  it('transforms the tail against a foreign change that landed mid-upload', async () => {
    const backend = new OTFuzzBackend();
    await commitChanges(backend, DOC, uploadQueue({ batchId: 'attempt-1' }).slice(0, 2), sessionTimeoutMillis);

    // Another device pulled the partial doc and prepended a tag before the resume arrived.
    await commitChanges(
      backend,
      DOC,
      [{ id: 'F', baseRev: 2, ops: [{ op: 'add', path: '/tags/0', value: 'f' }], createdAt: Date.now() }],
      sessionTimeoutMillis
    );
    expect(headState(backend).tags).toEqual(['f', 'a', 'b']);

    const result = await commitChanges(backend, DOC, uploadQueue({ batchId: 'attempt-2' }), sessionTimeoutMillis);

    // c3/c4 were minted on the prefix frame ([a, b]) and must transform through F, keeping
    // their appends at the tail rather than landing one slot early. Catchup comes back in
    // rev order: the echoes (revs 1-2), then F (rev 3).
    expect(result.catchupChanges.map(c => c.id)).toEqual(['c1', 'c2', 'F']);
    expect(result.newChanges.map(c => c.id)).toEqual(['c3', 'c4']);
    expect(headState(backend).tags).toEqual(['f', 'a', 'b', 'c', 'd']);
  });

  it('still refuses a foreign baseRev-0 root replace on an existing doc', async () => {
    const backend = new OTFuzzBackend();
    await commitChanges(backend, DOC, uploadQueue({ batchId: 'attempt-1' }).slice(0, 2), sessionTimeoutMillis);

    // Fresh ids, fresh batch — not the creating upload. The guard must hold.
    const err = await commitChanges(
      backend,
      DOC,
      [change('x1', 1, [{ op: 'replace', path: '', value: { wiped: true } }], { batchId: 'other' })],
      sessionTimeoutMillis
    ).catch(e => e);

    expect(err.code).toBe(400);
    expect(String(err.message)).toMatch(/Cannot apply root-level replace/);
    expect(headState(backend).tags).toEqual(['a', 'b']);
  });
});
