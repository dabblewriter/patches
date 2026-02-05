import { createChange } from '../data/change.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot, PatchesState } from '../types.js';
import { blockable } from '../utils/concurrency.js';
import { IDBStoreWrapper, IndexedDBStore } from './IndexedDBStore.js';
import type { LWWClientStore } from './LWWClientStore.js';
import type { TrackedDoc } from './PatchesStore.js';

const DB_VERSION = 1;
const SNAPSHOT_INTERVAL = 200;

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
 * IndexedDB store implementation for Last-Writer-Wins (LWW) sync strategy.
 *
 * Creates stores:
 * - docs<{ docId: string; committedRev: number; deleted?: boolean }> (primary key: docId) [shared with OT]
 * - snapshots<{ docId: string; rev: number; state: any }> (primary key: docId) [shared with OT]
 * - committedOps<{ docId: string; op: string; path: string; from?: string; value?: any }> (primary key: [docId, path])
 * - pendingOps<{ docId: string; path: string; op: string; ts: number; value: any }> (primary key: [docId, path])
 * - sendingChanges<{ docId: string; change: Change }> (primary key: docId)
 *
 * This store manages field-level operations for LWW conflict resolution:
 * - Committed ops represent confirmed server state
 * - Pending ops are local changes waiting to be sent
 * - Sending changes are in-flight operations
 *
 * Every 200 ops, committed ops are compacted into the snapshot.
 */
export class LWWIndexedDBStore extends IndexedDBStore implements LWWClientStore {
  protected getDBVersion(): number {
    return DB_VERSION;
  }

  protected onUpgrade(db: IDBDatabase, _oldVersion: number): void {
    // Create LWW-specific stores
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
    const [tx, docsStore, snapshots, committedOps, pendingOps, sendingChanges] = await this.transaction(
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
   * Clears all committed fields and pending ops.
   */
  @blockable
  async saveDoc(docId: string, docState: PatchesState): Promise<void> {
    const [tx, snapshots, committedOps, pendingOps, sendingChanges, docsStore] = await this.transaction(
      ['snapshots', 'committedOps', 'pendingOps', 'sendingChanges', 'docs'],
      'readwrite'
    );

    const { rev, state } = docState;

    await Promise.all([
      docsStore.put<TrackedDoc>({ docId, committedRev: rev }),
      snapshots.put<Snapshot>({ docId, state, rev }),
      this.deleteFieldsForDoc(committedOps, docId),
      this.deleteFieldsForDoc(pendingOps, docId),
      sendingChanges.delete(docId),
    ]);

    await tx.complete();
  }

  /**
   * Marks a document as deleted and clears all associated data.
   */
  @blockable
  async deleteDoc(docId: string): Promise<void> {
    const [tx, snapshots, committedOps, pendingOps, sendingChanges, docsStore] = await this.transaction(
      ['snapshots', 'committedOps', 'pendingOps', 'sendingChanges', 'docs'],
      'readwrite'
    );

    const docMeta = (await docsStore.get<TrackedDoc>(docId)) ?? { docId, committedRev: 0 };
    await docsStore.put({ ...docMeta, deleted: true });

    await Promise.all([
      snapshots.delete(docId),
      this.deleteFieldsForDoc(committedOps, docId),
      this.deleteFieldsForDoc(pendingOps, docId),
      sendingChanges.delete(docId),
    ]);

    await tx.complete();
  }

  /**
   * Untracks documents by removing all their data.
   */
  async untrackDocs(docIds: string[]): Promise<void> {
    const [tx, docsStore, snapshots, committedOps, pendingOps, sendingChanges] = await this.transaction(
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
    const [tx, pendingOpsStore] = await this.transaction(['pendingOps'], 'readonly');

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
    }));
  }

  /**
   * Save pending ops, optionally deleting paths.
   */
  @blockable
  async savePendingOps(docId: string, ops: JSONPatchOp[], pathsToDelete?: string[]): Promise<void> {
    const [tx, pendingOpsStore, docsStore] = await this.transaction(['pendingOps', 'docs'], 'readwrite');

    let docMeta = await docsStore.get<TrackedDoc>(docId);
    if (!docMeta) {
      docMeta = { docId, committedRev: 0 };
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
    const [tx, sendingChanges] = await this.transaction(['sendingChanges'], 'readonly');
    const sending = await sendingChanges.get<SendingChange>(docId);
    await tx.complete();
    return sending?.change ?? null;
  }

  /**
   * Atomically save sending change AND clear all pending ops.
   */
  @blockable
  async saveSendingChange(docId: string, change: Change): Promise<void> {
    const [tx, pendingOpsStore, sendingChanges] = await this.transaction(['pendingOps', 'sendingChanges'], 'readwrite');

    // Save to sending
    await sendingChanges.put<SendingChange>({ docId, change });

    // Clear all pending ops
    await this.deleteFieldsForDoc(pendingOpsStore, docId);

    await tx.complete();
  }

  /**
   * Clear sendingChange after server ack, move ops to committed.
   */
  @blockable
  async confirmSendingChange(docId: string): Promise<void> {
    const [tx, sendingChanges, committedOps, docsStore] = await this.transaction(
      ['sendingChanges', 'committedOps', 'docs'],
      'readwrite'
    );

    const sending = await sendingChanges.get<SendingChange>(docId);
    if (!sending) {
      await tx.complete();
      return;
    }

    // Move ops to committed (store op directly, strip ts/rev)
    for (const op of sending.change.ops) {
      await committedOps.put<CommittedOp>({ docId, op: op.op, path: op.path, value: op.value });
    }

    // Update committed rev
    const docMeta = (await docsStore.get<TrackedDoc>(docId)) ?? { docId, committedRev: 0 };
    if (sending.change.rev > docMeta.committedRev) {
      await docsStore.put({ ...docMeta, committedRev: sending.change.rev });
    }

    await sendingChanges.delete(docId);
    await tx.complete();
  }

  /**
   * Apply server changes using LWW timestamp resolution.
   */
  @blockable
  async applyServerChanges(docId: string, serverChanges: Change[]): Promise<void> {
    const [tx, committedOps, snapshots, docsStore] = await this.transaction(
      ['committedOps', 'snapshots', 'docs'],
      'readwrite'
    );

    // Store server ops directly (strip ts/rev)
    for (const change of serverChanges) {
      for (const op of change.ops) {
        await committedOps.put<CommittedOp>({ docId, op: op.op, path: op.path, value: op.value });
      }
    }

    // Note: Don't clear sendingChange here - these are changes from other clients,
    // not confirmation of our own change. Only confirmSendingChange should clear it.

    // Update committedRev
    const lastCommittedRev = serverChanges.at(-1)?.rev;
    if (lastCommittedRev !== undefined) {
      const docMeta = (await docsStore.get<TrackedDoc>(docId)) ?? { docId, committedRev: 0 };
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
