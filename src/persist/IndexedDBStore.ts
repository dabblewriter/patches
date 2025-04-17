import { signal } from '../event-signal.js';
import type { Change, PatchSnapshot } from '../ot/types.js';

export interface LastRevs {
  committed: number;
  pending: number;
}

/**
 * Creates a new IndexedDB database with stores:
 * - snapshots<{ docId: string; rev: number; state: any }> (primary key: docId)
 * - committedChanges<Change & { docId: string; }> (primary key: [docId, rev])
 * - pendingChanges<Change & { docId: string; }> (primary key: [docId, rev])
 * - deleted<{ docId: string; }> (primary key: docId)
 *
 * Under the hood, this class will store snapshots of the document only for committed state. It will not update the
 * committed state on *every* received committed change as this can cause issues with IndexedDB with many large updates.
 * After every 200 committed changes, the class will save the current state to the snapshot store and delete the committed changes that went into it.
 * A snapshot will not be created if there are pending changes based on revisions older than the 200th committed change until those pending changes are committed.
 */
export class IndexedDBStore {
  /** Subscribe to be notified after local state changes are saved to the database. */
  readonly onPendingChanges = signal<(docId: string, changes: Change[]) => void>();

  /**
   * @param dbName Name of the IndexedDB database to open/create
   */
  constructor(dbName: string);

  // ─── Snapshots + Reconstruction ────────────────────────────────────────────

  /**
   * Rebuilds a document snapshot + pending queue *without* loading
   * the full PatchDoc into memory.
   *
   * 1. load the last snapshot (state + rev)
   * 2. load committedChanges[rev > snapshot.rev]
   * 3. load pendingChanges
   * 4. apply committed, rebase pending
   * 5. return { state, rev, changes: pending }
   */
  getDoc(docId: string): Promise<PatchSnapshot | undefined>;

  /**
   * Completely remove all data for this docId and mark it
   * as deleted (tombstone).  Provider will call `patchAPI.deleteDoc`
   * on reconnect.
   */
  deleteDoc(docId: string): Promise<void>;

  // ─── Pending Changes ────────────────────────────────────────────────────────

  /**
   * Append an array of local changes to the pending queue.
   * Called *before* you attempt to send them to the server.
   */
  savePendingChanges(docId: string, changes: Change[]): Promise<void>;

  /** Read back all pending changes for this docId (in order). */
  getPendingChanges(docId: string): Promise<Change[]>;

  // ─── Committed Changes ─────────────────────────────────────────────────────

  /**
   * Store server‐confirmed changes.  Will:
   * - persist them in the committedChanges store
   * - remove any pending changes whose rev falls within `sentPendingRange`
   * - optionally compact a new snapshot after N changes (hidden internally)
   */
  saveCommittedChanges(docId: string, changes: Change[], sentPendingRange?: [number, number]): Promise<void>;

  // ─── Revision Tracking ─────────────────────────────────────────────────────

  /**
   * Tell me the last committed revision you have *and* the highest
   * rev of any pending change.  Use these to drive:
   *   - fetch changes:   api.getChangesSince(docId, committedRev)
   *   - build new patch: newChange.rev = pendingRev; baseRev = committedRev
   */
  getLastRevs(docId: string): Promise<LastRevs>;
}
