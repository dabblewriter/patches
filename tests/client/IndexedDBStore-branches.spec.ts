import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDBStore } from '../../src/client/IndexedDBStore';
import type { Branch } from '../../src/types';

/**
 * Branch pending-flag lifecycle on the real IndexedDBStore (fake-indexeddb).
 *
 * DAB-1013: `saveBranches` refuses to overwrite a stored row carrying a `pendingOp` with one that
 * doesn't — right for server data, which is stale relative to an un-synced local mutation, but it
 * made every "clear the flag" write a no-op. A branch renamed once carried `pendingOp: 'update'`
 * forever: it was re-sent on every reconnect and never received another remote field update.
 * `confirmPendingBranch` is the honest way to clear the flag; these pin its contract.
 */
let dbSeq = 0;
const docId = 'doc1';

async function pending(store: IndexedDBStore): Promise<Branch[]> {
  return store.listPendingBranches();
}

describe('IndexedDBStore branch pending flags (real store over fake-indexeddb)', () => {
  let store: IndexedDBStore;

  beforeEach(() => {
    store = new IndexedDBStore(`branches-test-${dbSeq++}`);
  });

  it('saveBranches cannot clear a pending flag (the DAB-1013 no-op, kept as the guard)', async () => {
    const id = await store.createBranch(docId, 5, { name: 'Feature' });
    const [row] = await pending(store);
    expect(row.pendingOp).toBe('create');

    const { pendingOp: _po, ...stripped } = row;
    await store.saveBranches(docId, [stripped]);

    // Same row minus the flag is refused: server data never overrides a local mutation.
    expect((await store.loadBranch(id))!.pendingOp).toBe('create');
    expect(await pending(store)).toHaveLength(1);
  });

  it('confirmPendingBranch clears a confirmed create and drops the row from the pending index', async () => {
    const id = await store.createBranch(docId, 5, { name: 'Feature' });
    const [row] = await pending(store);

    await store.confirmPendingBranch(row);

    const stored = await store.loadBranch(id);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('pendingOp');
    expect(stored!.name).toBe('Feature');
    expect(await pending(store)).toEqual([]);
  });

  it('confirmPendingBranch clears a confirmed update, so a renamed branch stops being pending', async () => {
    const id = await store.createBranch(docId, 5, { name: 'Feature' });
    await store.confirmPendingBranch((await pending(store))[0]);

    await store.updateBranch(id, { name: 'Renamed' });
    const [row] = await pending(store);
    expect(row.pendingOp).toBe('update');

    await store.confirmPendingBranch(row);

    const stored = await store.loadBranch(id);
    expect(stored).not.toHaveProperty('pendingOp');
    expect(stored!.name).toBe('Renamed');
    expect(await pending(store)).toEqual([]);
  });

  it('a confirmed row receives remote field updates again', async () => {
    // The consequence that mattered: a stuck flag meant authoritative fields (accessEndedAt,
    // mergedAt, lastMergedRev, finishedReaders) never reached the row again.
    const id = await store.createBranch(docId, 5, { name: 'Feature' });
    await store.confirmPendingBranch((await pending(store))[0]);
    await store.updateBranch(id, { name: 'Renamed' });
    const [sent] = await pending(store);

    // While the rename is pending the same server row is refused — the guard's other half.
    const { pendingOp: _po, ...remote } = { ...sent, accessEndedAt: 123456, lastMergedRev: 9 };
    await store.saveBranches(docId, [remote]);
    expect((await store.loadBranch(id))!.accessEndedAt).toBeUndefined();

    await store.confirmPendingBranch(sent);
    await store.saveBranches(docId, [remote]);

    const stored = await store.loadBranch(id);
    expect(stored!.accessEndedAt).toBe(123456);
    expect(stored!.lastMergedRev).toBe(9);
  });

  it('keeps the flag when the row was edited again while the request was in flight', async () => {
    const id = await store.createBranch(docId, 5, { name: 'Feature' });
    await store.confirmPendingBranch((await pending(store))[0]);

    await store.updateBranch(id, { name: 'First rename' });
    const [sent] = await pending(store);

    // A second rename lands after the sync read `sent` but before the server confirms it.
    await new Promise(r => setTimeout(r, 2));
    await store.updateBranch(id, { name: 'Second rename' });

    await store.confirmPendingBranch(sent);

    // The server has 'First rename'; the second still has to go out.
    const stored = await store.loadBranch(id);
    expect(stored!.pendingOp).toBe('update');
    expect(stored!.name).toBe('Second rename');
    expect(await pending(store)).toHaveLength(1);
  });

  it('downgrades a confirmed create to a pending update when the row was edited in flight', async () => {
    // updateBranch keeps 'create' on a never-synced row. Once the create is confirmed, re-sending
    // it would be an idempotent no-op on the server and the rename would be lost — so what remains
    // to send is an update.
    const id = await store.createBranch(docId, 5, { name: 'Feature' });
    const [sent] = await pending(store);

    await new Promise(r => setTimeout(r, 2));
    await store.updateBranch(id, { name: 'Renamed before the create confirmed' });
    expect((await store.loadBranch(id))!.pendingOp).toBe('create');

    await store.confirmPendingBranch(sent);

    const stored = await store.loadBranch(id);
    expect(stored!.pendingOp).toBe('update');
    expect(stored!.name).toBe('Renamed before the create confirmed');
    expect(await pending(store)).toHaveLength(1);
  });

  it('downgrades on the stored flag alone, not on what the caller passed', async () => {
    // A caller that strips pendingOp before confirming (dw3's flush paths did) must not turn the
    // in-flight rename into a silent loss: the stored 'create' is proof enough of what was sent.
    const id = await store.createBranch(docId, 5, { name: 'Feature' });
    const [sent] = await pending(store);
    const { pendingOp: _po, ...stripped } = sent;

    await new Promise(r => setTimeout(r, 2));
    await store.updateBranch(id, { name: 'Renamed in flight' });

    await store.confirmPendingBranch(stripped);

    expect((await store.loadBranch(id))!.pendingOp).toBe('update');
  });

  it('leaves a delete queued since the read for the delete pass', async () => {
    const id = await store.createBranch(docId, 5, { name: 'Feature' });
    await store.confirmPendingBranch((await pending(store))[0]);
    await store.updateBranch(id, { name: 'Renamed' });
    const [sent] = await pending(store);

    await new Promise(r => setTimeout(r, 2));
    await store.deleteBranch(id);

    await store.confirmPendingBranch(sent);

    const stored = await store.loadBranch(id);
    expect(stored!.pendingOp).toBe('delete');
    expect(stored!.deleted).toBe(true);
    expect(await pending(store)).toHaveLength(1);
  });

  it('is a no-op for a row that is gone or already clean', async () => {
    const id = await store.createBranch(docId, 5, { name: 'Feature' });
    const [sent] = await pending(store);

    await store.removeBranches([id]);
    await expect(store.confirmPendingBranch(sent)).resolves.toBeUndefined();
    expect(await store.loadBranch(id)).toBeUndefined();

    // Confirming twice is harmless.
    const id2 = await store.createBranch(docId, 5, { name: 'Other' });
    const [sent2] = await pending(store);
    await store.confirmPendingBranch(sent2);
    await store.confirmPendingBranch(sent2);
    expect((await store.loadBranch(id2))!).not.toHaveProperty('pendingOp');
    expect(await pending(store)).toEqual([]);
  });

  describe('deleting a row whose create is unconfirmed', () => {
    // The flag cannot tell "never sent" from "in flight". Removing the row outright let a create
    // already on the wire land with nothing left to delete it, and the next full list brought the
    // branch back — so the row is tombstoned like any other, marked so the delete pass knows a 404
    // may be the honest answer.
    it('writes a marked tombstone instead of removing the row', async () => {
      const id = await store.createBranch(docId, 5, { name: 'Feature' });

      await store.deleteBranch(id);

      const stored = await store.loadBranch(id);
      expect(stored).toMatchObject({ pendingOp: 'delete', deleted: true, createUnconfirmed: true });
      expect(await store.listBranches(docId)).toEqual([]);
      expect((await pending(store)).map(b => b.pendingOp)).toEqual(['delete']);
    });

    it('a tombstone for a branch the server has carries no mark', async () => {
      const id = await store.createBranch(docId, 5, { name: 'Feature' });
      await store.confirmPendingBranch((await pending(store))[0]);

      await store.deleteBranch(id);

      const stored = await store.loadBranch(id);
      expect(stored!.pendingOp).toBe('delete');
      expect(stored).not.toHaveProperty('createUnconfirmed');
    });

    it('refuses an edit to a tombstone, so the delete cannot be flipped into an update', async () => {
      // Stale rename dialog after a delete: turning the tombstone into `pendingOp: 'update'` would
      // send the rename, never the delete, and the next full list would bring the branch back.
      const id = await store.createBranch(docId, 5, { name: 'Feature' });
      await store.deleteBranch(id);

      await expect(store.updateBranch(id, { name: 'Renamed after delete' })).rejects.toThrow('not found');

      const stored = await store.loadBranch(id);
      expect(stored).toMatchObject({ pendingOp: 'delete', deleted: true, name: 'Feature' });
    });

    it('a create confirmed after the delete clears the mark and leaves the delete pending', async () => {
      const id = await store.createBranch(docId, 5, { name: 'Feature' });
      const [sent] = await pending(store);

      // The user deletes while the create is on the wire; then the server accepts the create.
      await store.deleteBranch(id);
      await store.confirmPendingBranch(sent);

      const stored = await store.loadBranch(id);
      expect(stored!.pendingOp).toBe('delete');
      expect(stored!.deleted).toBe(true);
      // The server has the branch now: a 404 on the delete would be noise, so the mark comes off.
      expect(stored).not.toHaveProperty('createUnconfirmed');
      expect(await pending(store)).toHaveLength(1);
    });
  });
});
