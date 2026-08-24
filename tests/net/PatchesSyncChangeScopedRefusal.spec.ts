/**
 * A 4xx the server scopes to ONE change (`data: { changeId, scope: 'change' }`) is a
 * deterministic verdict on that change's bytes — resending the identical request collects
 * the identical refusal. PatchesSync must latch the doc instead of feeding the refusal to
 * the retry ladder.
 *
 * The motivating member of the class is the root-replace 400 from `commitChanges`
 * ("Document already exists… Cannot apply root-level replace"): it applies cleanly locally,
 * so the corroborated auto-eject declines it, and before this latch existed the ladder
 * re-flushed it forever — wedging the client silently for weeks (DAB-832 / DAB-1071).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { createChange } from '../../src/data/change.js';
import { StatusError } from '../../src/net/error.js';
import type { PatchesConnection } from '../../src/net/PatchesConnection.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import { makeConnection } from './connectionMock.js';

const DOC_ID = 'doc1';

async function setup(overrides: Record<string, any> = {}) {
  const store = new OTInMemoryStore();
  const algorithm = new OTAlgorithm(store);
  const patches = new Patches({ algorithms: { ot: algorithm } });
  const connection = makeConnection(overrides);
  const sync = new PatchesSync(patches, connection as unknown as PatchesConnection);
  await patches.trackDocs([DOC_ID]);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  sync['updateState']({ connected: true });
  return { store, algorithm, patches, connection, sync };
}

describe('PatchesSync latches a change-scoped 4xx refusal', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => ctx?.sync.disconnect());

  it('latches the root-replace 400 instead of retrying it forever (DAB-832)', async () => {
    // The wedge shape on the wire: the server names the refused change and scopes the
    // refusal to it, exactly as `commitChanges` does for a root replace on an existing doc.
    const commitChanges = vi.fn(async (_docId: string, changes: any[]) => {
      throw new StatusError(
        400,
        `Document ${DOC_ID} already exists (rev 5). Cannot apply root-level replace (path: '')`,
        { changeId: changes[0].id, scope: 'change' }
      );
    });
    ctx = await setup({ commitChanges });
    // A root replace applies cleanly locally, so the corroborated auto-eject must decline
    // it — the latch below is the only thing standing between this doc and an endless flush.
    await ctx.store.savePendingChanges(DOC_ID, [
      createChange(0, 1, [{ op: 'replace', path: '', value: { text: 'restored' } }]),
    ]);

    await ctx.sync['syncDoc'](DOC_ID);

    expect(commitChanges).toHaveBeenCalledTimes(1);
    const state = ctx.sync.docStates.state[DOC_ID];
    expect(state.syncStatus).toBe('error');
    expect(state.syncError).toBeInstanceOf(StatusError);
    expect((state.syncError as StatusError).code).toBe(400);
    expect((state.syncError as StatusError).data?.scope).toBe('change');
    // The classification itself: deterministic on these bytes, never retryable.
    expect(ctx.sync['_isRetryableSyncError'](state.syncError)).toBe(false);
    // The pending queue is untouched — latched, not drained; recovery is the app's call.
    expect(await ctx.store.getPendingChanges(DOC_ID)).toHaveLength(1);
  });

  it('keeps an unscoped 400 retryable — only the change-scoped verdict is deterministic', () => {
    // Direct classification check (no ladder run): a bare 400 from a proxy or a malformed
    // envelope carries no attribution and keeps the pre-existing ambiguous/transient handling.
    const sync = new PatchesSync(
      new Patches({ algorithms: { ot: new OTAlgorithm(new OTInMemoryStore()) } }),
      makeConnection() as unknown as PatchesConnection
    );
    expect(sync['_isRetryableSyncError'](new StatusError(400, 'Invalid JSON body'))).toBe(true);
    expect(sync['_isRetryableSyncError'](new StatusError(400, 'bad', { scope: 'doc' }))).toBe(true);
    expect(sync['_isRetryableSyncError'](new StatusError(422, 'bad shape', { scope: 'change', changeId: 'c1' }))).toBe(
      false
    );
  });
});
