import { applyChanges } from '../algorithms/ot/shared/applyChanges.js';
import type { Change, PatchesSnapshot, PatchesState, QuarantinedChange } from '../types.js';
import { blockable } from '../utils/concurrency.js';
import { IndexedDBStore } from './IndexedDBStore.js';
import type { OTClientStore } from './OTClientStore.js';
import type { TrackedDoc } from './PatchesStore.js';

const SNAPSHOT_INTERVAL = 200;

interface Snapshot {
  docId: string;
  state: any;
  rev: number;
}

interface StoredChange extends Change {
  docId: string;
}

/**
 * IndexedDB store implementation for Operational Transformation (OT) sync algorithm.
 *
 * Creates stores:
 * - snapshots<{ docId: string; rev: number; state: any }> (primary key: docId) [shared]
 * - committedChanges<Change & { docId: string; }> (primary key: [docId, rev])
 * - pendingChanges<Change & { docId: string; }> (primary key: [docId, rev])
 * - docs<{ docId: string; committedRev: number; deleted?: boolean }> (primary key: docId) [shared]
 *
 * Under the hood, this class stores snapshots of the document only for committed state.
 * It does not update the committed state on *every* received committed change as this
 * can cause issues with IndexedDB with many small updates.
 *
 * After every 200 committed changes (SNAPSHOT_INTERVAL), the class saves the current
 * state to the snapshot store and deletes the committed changes that went into it.
 * A snapshot will not be created if there are pending changes based on revisions older
 * than the 200th committed change until those pending changes are committed.
 */
export class OTIndexedDBStore implements OTClientStore {
  public db: IndexedDBStore;

  constructor(db?: string | IndexedDBStore) {
    this.db = !db || typeof db === 'string' ? new IndexedDBStore(db) : db;

    // Subscribe to upgrade event to create OT-specific stores
    this.db.requireStores('committedChanges', 'pendingChanges');
    this.db.onUpgrade((db, _oldVersion, transaction) => {
      OTIndexedDBStore.upgradeStores(db, transaction);
    });
  }

  /**
   * Creates OT-specific object stores during database upgrade.
   */
  static upgradeStores(db: IDBDatabase, _transaction: IDBTransaction): void {
    if (!db.objectStoreNames.contains('committedChanges')) {
      db.createObjectStore('committedChanges', { keyPath: ['docId', 'rev'] });
    }
    if (!db.objectStoreNames.contains('pendingChanges')) {
      db.createObjectStore('pendingChanges', { keyPath: ['docId', 'rev'] });
    }
  }

  /**
   * List documents for the OT algorithm.
   * Uses the algorithm index for efficient querying.
   */
  async listDocs(includeDeleted = false): Promise<TrackedDoc[]> {
    return this.db.listDocs(includeDeleted, 'ot');
  }

  /**
   * Track documents using the OT algorithm.
   */
  async trackDocs(docIds: string[]): Promise<void> {
    return this.db.trackDocs(docIds, 'ot');
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    return this.db.close();
  }

  /**
   * Delete the database.
   */
  async deleteDB(): Promise<void> {
    return this.db.deleteDB();
  }

  /**
   * Set the database name.
   */
  setName(dbName: string): void {
    return this.db.setName(dbName);
  }

  /**
   * Confirm the deletion of a document.
   */
  async confirmDeleteDoc(docId: string): Promise<void> {
    return this.db.confirmDeleteDoc(docId);
  }

  /**
   * Get the committed revision for a document.
   */
  async getCommittedRev(docId: string): Promise<number> {
    return this.db.getCommittedRev(docId);
  }

  /**
   * Rebuilds a document snapshot + pending queue *without* loading
   * the full PatchesDoc into memory.
   *
   * 1. load the last snapshot (state + rev)
   * 2. load committedChanges[rev > snapshot.rev]
   * 3. load pendingChanges
   * 4. apply committed changes, rebase pending
   * 5. return { state, rev, changes: pending }
   */
  @blockable
  async getDoc(docId: string): Promise<PatchesSnapshot | undefined> {
    const [tx, docsStore, snapshots, committedChanges, pendingChanges] = await this.db.transaction(
      ['docs', 'snapshots', 'committedChanges', 'pendingChanges'],
      'readonly'
    );

    const docMeta = await docsStore.get<TrackedDoc>(docId);
    if (docMeta?.deleted) {
      await tx.complete();
      return undefined;
    }

    const snapshot = await snapshots.get<Snapshot>(docId);
    // Lower bound excludes the snapshot rev — a change at rev == snapshot.rev is already
    // baked into the snapshot state and would double-apply
    const committed = await committedChanges.getAll<StoredChange>([docId, (snapshot?.rev ?? 0) + 1], [docId, Infinity]);
    const pending = await pendingChanges.getAll<StoredChange>([docId, 0], [docId, Infinity]);

    if (!snapshot && !committed.length && !pending.length) return undefined;

    // Apply any committed changes to the snapshot state
    const state = applyChanges(snapshot?.state, committed);

    await tx.complete();
    return {
      state,
      rev: committed[committed.length - 1]?.rev ?? snapshot?.rev ?? 0,
      changes: pending,
    };
  }

  /**
   * Completely remove all data for this docId and mark it as deleted (tombstone).
   */
  @blockable
  async deleteDoc(docId: string): Promise<void> {
    // quarantinedChanges may be absent on an external-mode database whose host hasn't
    // bumped its version yet; deletion must keep working there.
    const withQuarantine = await this.db.hasStore('quarantinedChanges');
    const storeNames = ['snapshots', 'committedChanges', 'pendingChanges', 'docs'];
    if (withQuarantine) storeNames.push('quarantinedChanges');
    const [tx, snapshots, committedChanges, pendingChanges, docsStore, quarantined] = await this.db.transaction(
      storeNames,
      'readwrite'
    );

    const docMeta = (await docsStore.get<TrackedDoc>(docId)) ?? { docId, committedRev: 0, algorithm: 'ot' as const };
    await docsStore.put({ ...docMeta, deleted: true });

    await Promise.all([
      snapshots.delete(docId),
      committedChanges.delete([docId, 0], [docId, Infinity]),
      pendingChanges.delete([docId, 0], [docId, Infinity]),
      ...(quarantined ? [quarantined.delete([docId, ''], [docId, '￿'])] : []),
    ]);

    await tx.complete();
  }

  /**
   * Save a document's state to the store.
   * @param docId - The ID of the document to save.
   * @param docState - The state of the document to save.
   */
  @blockable
  async saveDoc(docId: string, docState: PatchesState): Promise<void> {
    const [tx, snapshots, committedChanges, , docsStore] = await this.db.transaction(
      ['snapshots', 'committedChanges', 'pendingChanges', 'docs'],
      'readwrite'
    );

    const { rev, state } = docState;
    const changes = (docState as PatchesSnapshot).changes;
    const committedRev = changes?.length ? changes[changes.length - 1].rev : rev;

    await committedChanges.delete([docId, 0], [docId, Infinity]);

    await Promise.all([
      docsStore.put<TrackedDoc>({ docId, committedRev, algorithm: 'ot' }),
      snapshots.put<Snapshot>({ docId, state, rev }),
      ...(changes?.map((change: Change) => committedChanges.put<StoredChange>({ ...change, docId })) ?? []),
    ]);

    await tx.complete();
  }

  /**
   * Append an array of local changes to the pending queue.
   * Called *before* you attempt to send them to the server.
   */
  @blockable
  async savePendingChanges(docId: string, changes: Change[]): Promise<void> {
    const [tx, pendingChanges, docsStore] = await this.db.transaction(['pendingChanges', 'docs'], 'readwrite');

    let docMeta = await docsStore.get<TrackedDoc>(docId);
    if (!docMeta) {
      docMeta = { docId, committedRev: 0, algorithm: 'ot' };
      await docsStore.put(docMeta);
    } else if (docMeta.deleted) {
      delete docMeta.deleted;
      await docsStore.put(docMeta);
      console.warn(`Revived document ${docId} by saving pending changes.`);
    }

    await Promise.all(changes.map(change => pendingChanges.put<StoredChange>({ ...change, docId })));
    await tx.complete();
  }

  /**
   * Read back all pending changes for this docId (in order).
   * @param docId - The ID of the document to get the pending changes for.
   * @returns The pending changes.
   */
  @blockable
  async getPendingChanges(docId: string): Promise<Change[]> {
    const [tx, pendingChanges] = await this.db.transaction(['pendingChanges'], 'readonly');
    const result = await pendingChanges.getAll<Change>([docId, 0], [docId, Infinity]);
    await tx.complete();
    return result;
  }

  /**
   * Remove specific pending changes by change id. Pending changes are keyed by
   * `[docId, rev]`, so we load the doc's pending, match on `id`, and delete the
   * matching keys. Used to clear changes the server rebased away to a no-op.
   */
  @blockable
  async dropPendingChanges(docId: string, changeIds: string[]): Promise<void> {
    if (changeIds.length === 0) return;
    const ids = new Set(changeIds);
    const [tx, pendingChanges] = await this.db.transaction(['pendingChanges'], 'readwrite');
    const pending = await pendingChanges.getAll<StoredChange>([docId, 0], [docId, Infinity]);
    await Promise.all(
      pending.filter(change => ids.has(change.id)).map(change => pendingChanges.delete([docId, change.rev]))
    );
    await tx.complete();
  }

  /**
   * Lists all changes (committed + pending) for a document, sorted by rev.
   * @param docId - The document ID.
   * @param options.startAfter - Only return changes with rev > startAfter.
   */
  @blockable
  async listChanges(docId: string, options?: { startAfter?: number }): Promise<Change[]> {
    const startRev = (options?.startAfter ?? -1) + 1;
    const [tx, committedChanges, pendingChanges] = await this.db.transaction(
      ['committedChanges', 'pendingChanges'],
      'readonly'
    );
    const committed = await committedChanges.getAll<Change>([docId, startRev], [docId, Infinity]);
    const pending = await pendingChanges.getAll<Change>([docId, startRev], [docId, Infinity]);
    await tx.complete();
    return [...committed, ...pending].sort((a, b) => a.rev - b.rev);
  }

  // ─── Quarantine ─────────────────────────────────────────────────────────

  /**
   * Atomically move one pending change into quarantine and replace the pending queue with
   * its rebased remainder. The quarantine write and the pending swap share one transaction,
   * so a crash between them can neither lose the change nor leave the queue half-rebased.
   *
   * Guards on the poison still being pending: returns null without mutating anything when it
   * isn't (already committed / already ejected). Throws when the shared quarantine store is
   * absent on an external-mode database whose host hasn't bumped its version — matching LWW
   * (whose transaction raises on the same condition) and the eject contract: null means
   * "nothing to eject", and a consent-path caller reading null as resolved while the doc is
   * still wedged is exactly the conflation the throw exists to prevent. Auto-eject callers
   * catch and latch, same as any eject failure.
   */
  @blockable
  async quarantinePendingChange(
    docId: string,
    poison: Change,
    reason: string,
    rebasedPending: Change[]
  ): Promise<QuarantinedChange | null> {
    if (!(await this.db.hasStore('quarantinedChanges'))) {
      throw new Error(
        `Cannot eject change ${poison.id} from doc ${docId}: the 'quarantinedChanges' store is missing ` +
          `(external-mode database whose host hasn't upgraded its DB version). Nothing was mutated.`
      );
    }

    const [tx, pendingChanges, quarantined] = await this.db.transaction(
      ['pendingChanges', 'quarantinedChanges'],
      'readwrite'
    );

    const pending = await pendingChanges.getAll<StoredChange>([docId, 0], [docId, Infinity]);
    if (!pending.some(change => change.id === poison.id)) {
      await tx.complete();
      return null;
    }

    const entry: QuarantinedChange = {
      docId,
      changeId: poison.id,
      change: poison,
      reason,
      quarantinedAt: Date.now(),
    };
    await quarantined.put<QuarantinedChange>(entry);
    await pendingChanges.delete([docId, 0], [docId, Infinity]);
    await Promise.all(rebasedPending.map(change => pendingChanges.put<StoredChange>({ ...change, docId })));
    await tx.complete();
    return entry;
  }

  /** List quarantined changes for one doc, or all docs when docId is omitted (shared store; see IndexedDBStore). */
  async listQuarantinedChanges(docId?: string): Promise<QuarantinedChange[]> {
    return this.db.listQuarantinedChanges(docId);
  }

  /** Permanently remove a quarantined change (shared store; see IndexedDBStore). */
  @blockable
  async discardQuarantinedChange(docId: string, changeId: string): Promise<void> {
    return this.db.discardQuarantinedChange(docId, changeId);
  }

  // ─── Server Changes ─────────────────────────────────────────────────────

  /**
   * Atomically applies server-confirmed changes and updates pending changes.
   * This is the core sync operation that must be atomic.
   *
   * Will:
   * - persist server changes in the committedChanges store
   * - replace all pending changes with the rebased versions
   * - optionally compact a new snapshot after N changes (hidden internally)
   *
   * @param docId - The ID of the document
   * @param serverChanges - Changes confirmed by the server
   * @param rebasedPendingChanges - Pending changes after OT rebasing
   */
  @blockable
  async applyServerChanges(docId: string, serverChanges: Change[], rebasedPendingChanges: Change[]): Promise<void> {
    const [tx, committedChangesStore, pendingChangesStore, snapshots, docsStore] = await this.db.transaction(
      ['committedChanges', 'pendingChanges', 'snapshots', 'docs'],
      'readwrite'
    );

    // Save committed changes, dropping already-applied revs — duplicated deliveries
    // (echo, re-broadcast, catchup overlapping a broadcast) would otherwise resurrect
    // compacted rows and double-apply into the snapshot
    const docMeta = await docsStore.get<TrackedDoc>(docId);
    const newChanges = serverChanges.filter(change => change.rev > (docMeta?.committedRev ?? 0));
    await Promise.all(newChanges.map(change => committedChangesStore.put<StoredChange>({ ...change, docId })));

    // Replace all pending changes with rebased versions
    await pendingChangesStore.delete([docId, 0], [docId, Infinity]);
    await Promise.all(rebasedPendingChanges.map(change => pendingChangesStore.put<StoredChange>({ ...change, docId })));

    // Check if we should create a snapshot
    const count = await committedChangesStore.count([docId, 0], [docId, Infinity]);

    if (count >= SNAPSHOT_INTERVAL) {
      // With atomic updates, pending changes are always rebased, so we can safely snapshot
      const [snapshot, committed] = await Promise.all([
        snapshots.get<Snapshot>(docId),
        committedChangesStore.getAll<StoredChange>([docId, 0], [docId, Infinity], SNAPSHOT_INTERVAL),
      ]);

      const lastRev = committed[committed.length - 1]?.rev;
      if (lastRev) {
        const state = applyChanges(snapshot?.state, committed);
        await Promise.all([
          snapshots.put({ docId, rev: lastRev, state }),
          committedChangesStore.delete([docId, 0], [docId, lastRev]),
        ]);
      }
    }

    // Update committedRev in the docs store
    const lastCommittedRev = newChanges.at(-1)?.rev;
    if (lastCommittedRev !== undefined) {
      const meta = docMeta ?? { docId, committedRev: 0, algorithm: 'ot' as const };
      if (lastCommittedRev > meta.committedRev) {
        await docsStore.put({ ...meta, committedRev: lastCommittedRev, deleted: undefined });
      }
    }

    await tx.complete();
  }

  /**
   * Untrack a document.
   * @param docIds - The IDs of the documents to untrack.
   */
  async untrackDocs(docIds: string[]): Promise<void> {
    const [tx, docsStore, snapshots, committedChanges, pendingChanges] = await this.db.transaction(
      ['docs', 'snapshots', 'committedChanges', 'pendingChanges'],
      'readwrite'
    );
    await Promise.all(
      docIds.map(docId => {
        return Promise.all([
          docsStore.delete(docId),
          snapshots.delete(docId),
          committedChanges.delete([docId, 0], [docId, Infinity]),
          pendingChanges.delete([docId, 0], [docId, Infinity]),
        ]);
      })
    );
    await tx.complete();
  }
}
