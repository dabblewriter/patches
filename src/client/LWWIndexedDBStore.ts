import { consolidateFieldOp } from '../algorithms/lww/consolidateOps.js';
import { createChange } from '../data/change.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot, PatchesState, QuarantinedChange } from '../types.js';
import { blockable } from '../utils/concurrency.js';
import { IDBStoreWrapper, IndexedDBStore } from './IndexedDBStore.js';
import type { LWWClientStore } from './LWWClientStore.js';
import type { TrackedDoc } from './PatchesStore.js';

const SNAPSHOT_INTERVAL = 200;

/** Sort ops in commit (rev) order, ts as tiebreak — mirrors the server's ordering. */
function sortOpsByCommitOrder(ops: JSONPatchOp[]): JSONPatchOp[] {
  return [...ops].sort((a, b) => (a.rev ?? 0) - (b.rev ?? 0) || (a.ts ?? 0) - (b.ts ?? 0));
}

/** A committed op stored after server confirmation (JSONPatchOp fields with docId, without ts/rev) */
interface CommittedOp extends JSONPatchOp {
  docId: string;
}

/** A pending operation waiting to be sent */
interface PendingOp {
  docId: string;
  path: string;
  op: string;
  ts: number;
  value: any;
  soft?: boolean;
}

/** A change being sent to the server */
interface SendingChange {
  docId: string;
  change: Change;
}

/** Snapshot stored in IndexedDB */
interface Snapshot {
  docId: string;
  state: any;
  rev: number;
}

/**
 * IndexedDB store implementation for Last-Writer-Wins (LWW) sync algorithm.
 *
 * Creates stores:
 * - docs<{ docId: string; committedRev: number; deleted?: boolean }> (primary key: docId) [shared with OT]
 * - snapshots<{ docId: string; rev: number; state: any }> (primary key: docId) [shared with OT]
 * - committedOps<{ docId: string; op: string; path: string; from?: string; value?: any }> (primary key: [docId, path])
 * - pendingOps<{ docId: string; path: string; op: string; ts: number; value: any; soft?: boolean }> (primary key: [docId, path])
 * - sendingChanges<{ docId: string; change: Change }> (primary key: docId)
 * - quarantinedChanges<QuarantinedChange> (primary key: [docId, changeId]) [shared with OT]
 *
 * This store manages field-level operations for LWW conflict resolution:
 * - Committed ops represent confirmed server state
 * - Pending ops are local changes waiting to be sent
 * - Sending changes are in-flight operations
 *
 * Every 200 ops, committed ops are compacted into the snapshot.
 */
export class LWWIndexedDBStore implements LWWClientStore {
  public db: IndexedDBStore;

  constructor(db?: string | IndexedDBStore) {
    this.db = !db || typeof db === 'string' ? new IndexedDBStore(db) : db;

    // Subscribe to upgrade event to create LWW-specific stores
    this.db.requireStores('committedOps', 'pendingOps', 'sendingChanges');
    this.db.onUpgrade((db, _oldVersion, transaction) => {
      LWWIndexedDBStore.upgradeStores(db, transaction);
    });
  }

  /**
   * Creates LWW-specific object stores during database upgrade.
   */
  static upgradeStores(db: IDBDatabase, _transaction: IDBTransaction): void {
    if (!db.objectStoreNames.contains('committedOps')) {
      db.createObjectStore('committedOps', { keyPath: ['docId', 'path'] });
    }
    if (!db.objectStoreNames.contains('pendingOps')) {
      db.createObjectStore('pendingOps', { keyPath: ['docId', 'path'] });
    }
    if (!db.objectStoreNames.contains('sendingChanges')) {
      db.createObjectStore('sendingChanges', { keyPath: 'docId' });
    }
  }

  /**
   * List documents for the LWW algorithm.
   * Uses the algorithm index for efficient querying.
   */
  async listDocs(includeDeleted = false): Promise<TrackedDoc[]> {
    return this.db.listDocs(includeDeleted, 'lww');
  }

  /**
   * Track documents using the LWW algorithm.
   */
  async trackDocs(docIds: string[]): Promise<void> {
    return this.db.trackDocs(docIds, 'lww');
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

  // ─── Document Operations ─────────────────────────────────────────────────

  /**
   * Rebuilds a document state from snapshot + committed ops + sending + pending.
   *
   * 1. Load the snapshot (base state + rev)
   * 2. Apply all committedOps for docId
   * 3. Check sendingChanges - if exists, apply its ops
   * 4. Apply all pendingOps
   * 5. Return reconstructed state
   */
  @blockable
  async getDoc(docId: string): Promise<PatchesSnapshot | undefined> {
    const [tx, docsStore, snapshots, committedOps, pendingOps, sendingChanges] = await this.db.transaction(
      ['docs', 'snapshots', 'committedOps', 'pendingOps', 'sendingChanges'],
      'readonly'
    );

    const docMeta = await docsStore.get<TrackedDoc>(docId);
    if (docMeta?.deleted) {
      await tx.complete();
      return undefined;
    }

    const snapshot = await snapshots.get<Snapshot>(docId);
    const committed = await committedOps.getAll<CommittedOp>([docId, ''], [docId, '\uffff']);
    const sending = await sendingChanges.get<SendingChange>(docId);
    const pending = await pendingOps.getAll<PendingOp>([docId, ''], [docId, '\uffff']);

    if (!snapshot && !committed.length && !pending.length && !sending) {
      await tx.complete();
      return undefined;
    }

    // Start with snapshot state
    let state = snapshot?.state ? { ...snapshot.state } : {};

    // Apply committed ops
    if (committed.length > 0) {
      const ops: JSONPatchOp[] = committed.map(({ docId: _docId, ...op }) => op);
      state = applyPatch(state, ops, { partial: true });
    }

    // Apply sending change ops (if in-flight)
    if (sending?.change?.ops?.length) {
      state = applyPatch(state, sending.change.ops, { partial: true });
    }

    // Apply pending ops
    if (pending.length > 0) {
      const pendingOps: JSONPatchOp[] = pending.map(op => ({
        op: op.op,
        path: op.path,
        value: op.value,
        ts: op.ts,
        ...(op.soft ? { soft: true } : undefined),
      }));
      state = applyPatch(state, pendingOps, { partial: true });
    }

    // Convert pending ops to Change format for the snapshot
    const pendingChanges = this.pendingOpsToChanges(docId, pending, snapshot?.rev ?? 0);

    await tx.complete();
    return {
      state,
      rev: docMeta?.committedRev ?? snapshot?.rev ?? 0,
      changes: sending?.change ? [sending.change, ...pendingChanges] : pendingChanges,
    };
  }

  /**
   * Saves the current document state to storage.
   * Clears committed fields (subsumed by the snapshot) but preserves pending ops
   * and the in-flight sending change — those represent local edits not yet
   * accepted by the server and would otherwise be silently dropped when
   * PatchesSync re-saves a freshly-fetched snapshot.
   */
  @blockable
  async saveDoc(docId: string, docState: PatchesState): Promise<void> {
    const [tx, snapshots, committedOps, docsStore] = await this.db.transaction(
      ['snapshots', 'committedOps', 'docs'],
      'readwrite'
    );

    const { rev, state } = docState;

    await Promise.all([
      docsStore.put<TrackedDoc>({ docId, committedRev: rev, algorithm: 'lww' }),
      snapshots.put<Snapshot>({ docId, state, rev }),
      this.deleteFieldsForDoc(committedOps, docId),
    ]);

    // A server getDoc envelope carries uncompacted ops in `changes` — its `rev` is the head
    // revision but its `state` excludes those ops. Persist them or a fresh client stores an
    // empty snapshot at the head rev and never re-fetches the missing fields.
    const changes = (docState as PatchesSnapshot).changes ?? [];
    await Promise.all(changes.flatMap(change => change.ops.map(op => committedOps.put<CommittedOp>({ ...op, docId }))));

    await tx.complete();
  }

  /**
   * Marks a document as deleted and clears all associated data.
   */
  @blockable
  async deleteDoc(docId: string): Promise<void> {
    // quarantinedChanges may be absent on an external-mode database whose host hasn't
    // bumped its version yet; deletion must keep working there.
    const withQuarantine = await this.db.hasStore('quarantinedChanges');
    const storeNames = ['snapshots', 'committedOps', 'pendingOps', 'sendingChanges', 'docs'];
    if (withQuarantine) storeNames.push('quarantinedChanges');
    const [tx, snapshots, committedOps, pendingOps, sendingChanges, docsStore, quarantined] = await this.db.transaction(
      storeNames,
      'readwrite'
    );

    const docMeta = (await docsStore.get<TrackedDoc>(docId)) ?? { docId, committedRev: 0, algorithm: 'lww' as const };
    await docsStore.put({ ...docMeta, deleted: true });

    await Promise.all([
      snapshots.delete(docId),
      this.deleteFieldsForDoc(committedOps, docId),
      this.deleteFieldsForDoc(pendingOps, docId),
      sendingChanges.delete(docId),
      ...(quarantined ? [quarantined.delete([docId, ''], [docId, '￿'])] : []),
    ]);

    await tx.complete();
  }

  /**
   * Untracks documents by removing all their data. Quarantined changes are preserved:
   * untracking is local cache management, not the discard decision quarantine reserves
   * for the app (see `discardQuarantinedChange`).
   */
  async untrackDocs(docIds: string[]): Promise<void> {
    const [tx, docsStore, snapshots, committedOps, pendingOps, sendingChanges] = await this.db.transaction(
      ['docs', 'snapshots', 'committedOps', 'pendingOps', 'sendingChanges'],
      'readwrite'
    );

    await Promise.all(
      docIds.map(docId =>
        Promise.all([
          docsStore.delete(docId),
          snapshots.delete(docId),
          this.deleteFieldsForDoc(committedOps, docId),
          this.deleteFieldsForDoc(pendingOps, docId),
          sendingChanges.delete(docId),
        ])
      )
    );

    await tx.complete();
  }

  // ─── LWWClientStore Methods ─────────────────────────────────────────────

  /**
   * Get pending ops, optionally filtered by path prefixes.
   */
  @blockable
  async getPendingOps(docId: string, pathPrefixes?: string[]): Promise<JSONPatchOp[]> {
    const [tx, pendingOpsStore] = await this.db.transaction(['pendingOps'], 'readonly');

    let pending: PendingOp[];

    if (!pathPrefixes || pathPrefixes.length === 0) {
      pending = await pendingOpsStore.getAll<PendingOp>([docId, ''], [docId, '\uffff']);
    } else {
      // Fetch all and filter - IndexedDB doesn't support OR queries
      const allPending = await pendingOpsStore.getAll<PendingOp>([docId, ''], [docId, '\uffff']);
      pending = allPending.filter(op =>
        pathPrefixes.some(prefix => op.path === prefix || op.path.startsWith(prefix + '/'))
      );
    }

    await tx.complete();

    return pending.map(op => ({
      op: op.op,
      path: op.path,
      value: op.value,
      ts: op.ts,
      ...(op.soft ? { soft: true } : undefined),
    }));
  }

  /**
   * Save pending ops, optionally deleting paths.
   */
  @blockable
  async savePendingOps(docId: string, ops: JSONPatchOp[], pathsToDelete?: string[]): Promise<void> {
    const [tx, pendingOpsStore, docsStore] = await this.db.transaction(['pendingOps', 'docs'], 'readwrite');

    let docMeta = await docsStore.get<TrackedDoc>(docId);
    if (!docMeta) {
      docMeta = { docId, committedRev: 0, algorithm: 'lww' };
      await docsStore.put(docMeta);
    } else if (docMeta.deleted) {
      delete docMeta.deleted;
      await docsStore.put(docMeta);
    }

    // Delete specified paths first
    if (pathsToDelete) {
      await Promise.all(pathsToDelete.map(path => pendingOpsStore.delete([docId, path])));
    }

    // Save new ops (keyed by path, newer ops overwrite)
    await Promise.all(
      ops.map(op =>
        pendingOpsStore.put<PendingOp>({
          docId,
          path: op.path,
          op: op.op,
          ts: op.ts ?? Date.now(),
          value: op.value,
          ...(op.soft ? { soft: true } : undefined),
        })
      )
    );

    await tx.complete();
  }

  /**
   * Get the in-flight change for retry/reconnect scenarios.
   */
  @blockable
  async getSendingChange(docId: string): Promise<Change | null> {
    const [tx, sendingChanges] = await this.db.transaction(['sendingChanges'], 'readonly');
    const sending = await sendingChanges.get<SendingChange>(docId);
    await tx.complete();
    return sending?.change ?? null;
  }

  /**
   * Atomically save sending change AND clear all pending ops.
   */
  @blockable
  async saveSendingChange(docId: string, change: Change): Promise<void> {
    const [tx, pendingOpsStore, sendingChanges] = await this.db.transaction(
      ['pendingOps', 'sendingChanges'],
      'readwrite'
    );

    // Save to sending
    await sendingChanges.put<SendingChange>({ docId, change });

    // Clear all pending ops
    await this.deleteFieldsForDoc(pendingOpsStore, docId);

    await tx.complete();
  }

  /**
   * Move sending ops to committed, then clear the sending slot.
   * committedRev is NOT updated here — applyServerChanges owns that using the
   * server's actual rev. Updating it here would bump the rev above the server's
   * real value for noop changes (where the server doesn't create a new rev).
   *
   * Call this BEFORE applyServerChanges so that server corrections (which run
   * after) overwrite any stale ops for fields the server won via LWW.
   */
  @blockable
  async confirmSendingChange(docId: string, ops?: JSONPatchOp[]): Promise<void> {
    const [tx, sendingChanges, committedOps] = await this.db.transaction(
      ['sendingChanges', 'committedOps'],
      'readwrite'
    );

    const sending = await sendingChanges.get<SendingChange>(docId);
    if (!sending) {
      await tx.complete();
      return;
    }

    const confirmedPaths = ops && new Set(ops.map(op => op.path));
    const confirmed = confirmedPaths
      ? sending.change.ops.filter(op => confirmedPaths.has(op.path))
      : sending.change.ops;

    // Move ops to committed, deleting child-path ops to match server saveOps behavior.
    // Without this, a parent write (e.g. replace /trash {}) would leave stale child ops
    // (e.g. /trash/collectionId/name) that re-create nested structure on doc rebuild.
    //
    // Promotion is LWW-guarded through the SAME per-path rule the server applies
    // (consolidateFieldOp): a sent op that loses to a newer committed row must not be
    // promoted, and must not prune that row's children. The unguarded put() relied on
    // the commit response's correction ops (applied right after) to repair the fields
    // the server resolved differently \u2014 but the response apply is a separate IDB
    // transaction, and if it dies (the ack-persist crash window) the losing value is
    // baked into committed state with committedRev already past the winner's rev, where
    // no catch-up ever redelivers it. Silent, permanent divergence (fuzz seed 1000374).
    await Promise.all(
      confirmed.map(async op => {
        const existing = await committedOps.get<CommittedOp>([docId, op.path]);
        const resolved = existing ? consolidateFieldOp(existing, op) : op;
        if (!resolved) return; // committed row is newer \u2014 the server resolves the same way
        await committedOps.delete([docId, op.path + '/'], [docId, op.path + '/\uffff']);
        await committedOps.put<CommittedOp>({ ...resolved, docId });
      })
    );

    // Keep the unconfirmed remainder in the sending slot (a change split across wire batches)
    // so a disconnect between batches resends it
    const remaining = confirmedPaths ? sending.change.ops.filter(op => !confirmedPaths.has(op.path)) : [];
    if (remaining.length > 0) {
      await sendingChanges.put<SendingChange>({ docId, change: { ...sending.change, ops: remaining } });
      await tx.complete();
      return;
    }

    await sendingChanges.delete(docId);
    await tx.complete();
  }

  /**
   * Apply server changes using LWW timestamp resolution.
   */
  @blockable
  async applyServerChanges(docId: string, serverChanges: Change[]): Promise<void> {
    const [tx, committedOps, snapshots, docsStore] = await this.db.transaction(
      ['committedOps', 'snapshots', 'docs'],
      'readwrite'
    );

    // Store server ops, deleting child-path ops to match server saveOps behavior.
    // Without this, a parent write (e.g. replace /trash {}) would leave stale child ops
    // (e.g. /trash/collectionId/name) that re-create nested structure on doc rebuild.
    // Apply sequentially in commit order: a flush response can carry corrections ahead
    // of catchup ops (child@rev3 before parent@rev2), and an out-of-order parent write
    // would prune the newer child value.
    for (const op of sortOpsByCommitOrder(serverChanges.flatMap(change => change.ops))) {
      await committedOps.delete([docId, op.path + '/'], [docId, op.path + '/\uffff']);
      await committedOps.put<CommittedOp>({ ...op, docId });
    }

    // Note: Don't clear sendingChange here - these are changes from other clients,
    // not confirmation of our own change. Only confirmSendingChange should clear it.

    // Update committedRev
    const lastCommittedRev = serverChanges.at(-1)?.rev;
    if (lastCommittedRev !== undefined) {
      const docMeta = (await docsStore.get<TrackedDoc>(docId)) ?? { docId, committedRev: 0, algorithm: 'lww' as const };
      if (lastCommittedRev > docMeta.committedRev) {
        await docsStore.put({ ...docMeta, committedRev: lastCommittedRev });
      }
    }

    // Check for compaction
    const fieldCount = await committedOps.count([docId, ''], [docId, '\uffff']);
    if (fieldCount >= SNAPSHOT_INTERVAL) {
      await this.compactSnapshot(docId, snapshots, committedOps, docsStore);
    }

    await tx.complete();
  }

  /**
   * Rebuild the committed-only state (snapshot + committed ops), the base for the
   * local strict-apply probe corroborating a server rejection of the sending change.
   */
  @blockable
  async getCommittedState(docId: string): Promise<PatchesState> {
    const [tx, docsStore, snapshots, committedOps] = await this.db.transaction(
      ['docs', 'snapshots', 'committedOps'],
      'readonly'
    );
    const docMeta = await docsStore.get<TrackedDoc>(docId);
    const snapshot = await snapshots.get<Snapshot>(docId);
    const committed = await committedOps.getAll<CommittedOp>([docId, ''], [docId, '￿']);
    await tx.complete();

    let state = snapshot?.state ? { ...snapshot.state } : {};
    if (committed.length > 0) {
      const ops: JSONPatchOp[] = committed.map(({ docId: _docId, ...op }) => op);
      state = applyPatch(state, ops, { partial: true });
    }
    return { state, rev: docMeta?.committedRev ?? snapshot?.rev ?? 0 };
  }

  /**
   * Atomically move the sending change into quarantine, preserving pendingOps (unlike
   * saveSendingChange, which clears them). One transaction; a crash between the
   * quarantine write and the sending-slot clear must not drop the change.
   */
  @blockable
  async quarantineSendingChange(docId: string, changeId: string, reason: string): Promise<QuarantinedChange | null> {
    const [tx, sendingChanges, quarantined] = await this.db.transaction(
      ['sendingChanges', 'quarantinedChanges'],
      'readwrite'
    );

    const sending = await sendingChanges.get<SendingChange>(docId);
    if (!sending || sending.change.id !== changeId) {
      await tx.complete();
      return null;
    }

    const entry: QuarantinedChange = {
      docId,
      changeId,
      change: sending.change,
      reason,
      quarantinedAt: Date.now(),
    };
    await quarantined.put<QuarantinedChange>(entry);
    await sendingChanges.delete(docId);
    await tx.complete();
    return entry;
  }

  /**
   * List quarantined changes for one doc, or all docs when docId is omitted.
   */
  async listQuarantinedChanges(docId?: string): Promise<QuarantinedChange[]> {
    if (!(await this.db.hasStore('quarantinedChanges'))) return [];
    const [tx, quarantined] = await this.db.transaction(['quarantinedChanges'], 'readonly');
    const entries =
      docId !== undefined
        ? await quarantined.getAll<QuarantinedChange>([docId, ''], [docId, '￿'])
        : await quarantined.getAll<QuarantinedChange>();
    await tx.complete();
    return entries;
  }

  /**
   * Permanently remove a quarantined change.
   */
  @blockable
  async discardQuarantinedChange(docId: string, changeId: string): Promise<void> {
    const [tx, quarantined] = await this.db.transaction(['quarantinedChanges'], 'readwrite');
    await quarantined.delete([docId, changeId]);
    await tx.complete();
  }

  // ─── Helper Methods ──────────────────────────────────────────────────────

  /**
   * Converts pending ops to an array of Change objects.
   */
  private pendingOpsToChanges(_docId: string, ops: PendingOp[], baseRev: number): Change[] {
    if (ops.length === 0) {
      return [];
    }

    const opsArray: JSONPatchOp[] = ops.map(op => ({
      op: op.op,
      path: op.path,
      value: op.value,
      ts: op.ts,
      ...(op.soft ? { soft: true } : undefined),
    }));

    return [createChange(baseRev, baseRev + 1, opsArray)];
  }

  /**
   * Deletes all entries for a document from a store.
   */
  private async deleteFieldsForDoc(store: IDBStoreWrapper, docId: string): Promise<void> {
    const entries = await store.getAll<{ docId: string; path: string }>([docId, ''], [docId, '\uffff']);
    await Promise.all(entries.map(e => store.delete([e.docId, e.path])));
  }

  /**
   * Compacts committed ops into the snapshot.
   */
  private async compactSnapshot(
    docId: string,
    snapshots: IDBStoreWrapper,
    committedOps: IDBStoreWrapper,
    docsStore: IDBStoreWrapper
  ): Promise<void> {
    const snapshot = await snapshots.get<Snapshot>(docId);
    const committed = await committedOps.getAll<CommittedOp>([docId, ''], [docId, '\uffff']);

    if (committed.length === 0) {
      return;
    }

    // Build new state from snapshot + committed ops
    let state = snapshot?.state ? { ...snapshot.state } : {};
    state = applyPatch(state, committed, { partial: true });

    // Get current committed rev
    const docMeta = await docsStore.get<TrackedDoc>(docId);
    const rev = docMeta?.committedRev ?? snapshot?.rev ?? 0;

    // Save new snapshot and clear committed ops
    await snapshots.put({ docId, state, rev });
    await this.deleteFieldsForDoc(committedOps, docId);
  }
}
