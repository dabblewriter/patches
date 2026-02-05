import { createChange } from '../data/change.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot, PatchesState } from '../types.js';
import type { LWWClientStore } from './LWWClientStore.js';
import type { TrackedDoc } from './PatchesStore.js';

interface LWWDocBuffers {
  snapshot?: { state: any; rev: number };
  committedFields: Map<string, any>;
  pendingOps: Map<string, JSONPatchOp>;
  sendingChange: Change | null;
  committedRev: number;
  deleted?: true;
}

/**
 * In-memory implementation of LWWClientStore for LWW (Last-Write-Wins) sync algorithm.
 *
 * Uses field-level storage for LWW conflict resolution:
 * - committedFields: Server-confirmed field values
 * - pendingOps: Local changes waiting to be sent (keyed by path)
 * - sendingChange: In-flight change being sent to server
 *
 * Useful for unit tests or when you want stateless realtime behavior with LWW semantics.
 */
export class LWWInMemoryStore implements LWWClientStore {
  private docs: Map<string, LWWDocBuffers> = new Map();

  // ─── Document Operations ─────────────────────────────────────────────────

  /**
   * Rebuilds a document state from snapshot + committed fields + sending + pending.
   */
  async getDoc(docId: string): Promise<PatchesSnapshot | undefined> {
    const buf = this.docs.get(docId);
    if (!buf || buf.deleted) return undefined;

    // Start with snapshot state
    let state = buf.snapshot?.state ? { ...buf.snapshot.state } : {};

    // Apply committed fields (these are resolved values stored as replace ops)
    const committedOps: JSONPatchOp[] = Array.from(buf.committedFields.entries()).map(([path, value]) => ({
      op: 'replace',
      path,
      value,
    }));
    if (committedOps.length > 0) {
      state = applyPatch(state, committedOps, { partial: true });
    }

    // Apply sending change ops (if in-flight)
    if (buf.sendingChange?.ops?.length) {
      state = applyPatch(state, buf.sendingChange.ops, { partial: true });
    }

    // Apply pending ops
    const pendingOps = Array.from(buf.pendingOps.values());
    if (pendingOps.length > 0) {
      state = applyPatch(state, pendingOps, { partial: true });
    }

    // Build changes array for snapshot
    const pendingChanges = this.pendingOpsToChanges(buf.pendingOps, buf.committedRev);

    return {
      state,
      rev: buf.committedRev,
      changes: buf.sendingChange ? [buf.sendingChange, ...pendingChanges] : pendingChanges,
    };
  }

  /**
   * Returns the last committed revision for a document.
   */
  async getCommittedRev(docId: string): Promise<number> {
    return this.docs.get(docId)?.committedRev ?? 0;
  }

  /**
   * List all documents in the store.
   */
  async listDocs(includeDeleted = false): Promise<TrackedDoc[]> {
    return Array.from(this.docs.entries())
      .filter(([, buf]) => includeDeleted || !buf.deleted)
      .map(([docId, buf]) => ({
        docId,
        committedRev: buf.committedRev,
        deleted: buf.deleted,
      }));
  }

  /**
   * Saves the current document state to storage.
   * Clears all committed fields, pending ops, and sending change.
   */
  async saveDoc(docId: string, docState: PatchesState): Promise<void> {
    this.docs.set(docId, {
      snapshot: { state: docState.state, rev: docState.rev },
      committedFields: new Map(),
      pendingOps: new Map(),
      sendingChange: null,
      committedRev: docState.rev,
    });
  }

  // ─── Tracking ────────────────────────────────────────────────────────────

  /**
   * Track documents.
   */
  async trackDocs(docIds: string[]): Promise<void> {
    for (const docId of docIds) {
      const buf = this.getOrCreateBuffer(docId);
      delete buf.deleted;
    }
  }

  /**
   * Untrack documents by removing all their data.
   */
  async untrackDocs(docIds: string[]): Promise<void> {
    for (const docId of docIds) {
      this.docs.delete(docId);
    }
  }

  // ─── Deletion ────────────────────────────────────────────────────────────

  /**
   * Marks a document as deleted and clears all associated data.
   */
  async deleteDoc(docId: string): Promise<void> {
    const buf = this.getOrCreateBuffer(docId);
    buf.deleted = true;
    buf.snapshot = undefined;
    buf.committedFields.clear();
    buf.pendingOps.clear();
    buf.sendingChange = null;
  }

  /**
   * Confirm the deletion of a document.
   */
  async confirmDeleteDoc(docId: string): Promise<void> {
    this.docs.delete(docId);
  }

  /**
   * Closes the store and releases resources.
   */
  async close(): Promise<void> {
    this.docs.clear();
  }

  // ─── LWWClientStore Methods ─────────────────────────────────────────────

  /**
   * Get pending ops, optionally filtered by path prefixes.
   */
  async getPendingOps(docId: string, pathPrefixes?: string[]): Promise<JSONPatchOp[]> {
    const buf = this.docs.get(docId);
    if (!buf) return [];

    const ops = Array.from(buf.pendingOps.values());

    if (!pathPrefixes || pathPrefixes.length === 0) {
      return ops;
    }

    return ops.filter(op => pathPrefixes.some(prefix => op.path === prefix || op.path.startsWith(prefix + '/')));
  }

  /**
   * Save pending ops, optionally deleting paths.
   */
  async savePendingOps(docId: string, ops: JSONPatchOp[], pathsToDelete?: string[]): Promise<void> {
    const buf = this.getOrCreateBuffer(docId);

    // Ensure doc is not deleted
    if (buf.deleted) {
      delete buf.deleted;
    }

    // Delete specified paths first
    if (pathsToDelete) {
      for (const path of pathsToDelete) {
        buf.pendingOps.delete(path);
      }
    }

    // Save new ops (keyed by path, newer ops overwrite)
    for (const op of ops) {
      buf.pendingOps.set(op.path, op);
    }
  }

  /**
   * Get the in-flight change for retry/reconnect scenarios.
   */
  async getSendingChange(docId: string): Promise<Change | null> {
    return this.docs.get(docId)?.sendingChange ?? null;
  }

  /**
   * Atomically save sending change AND clear all pending ops.
   */
  async saveSendingChange(docId: string, change: Change): Promise<void> {
    const buf = this.docs.get(docId);
    if (!buf) return;

    buf.sendingChange = change;
    buf.pendingOps.clear();
  }

  /**
   * Clear sendingChange after server ack, move ops to committed.
   */
  async confirmSendingChange(docId: string): Promise<void> {
    const buf = this.docs.get(docId);
    if (!buf?.sendingChange) return;

    // Move ops to committed fields (store the value directly)
    for (const op of buf.sendingChange.ops) {
      buf.committedFields.set(op.path, op.value);
    }

    // Update committed rev
    if (buf.sendingChange.rev > buf.committedRev) {
      buf.committedRev = buf.sendingChange.rev;
    }

    buf.sendingChange = null;
  }

  /**
   * Apply server changes using LWW timestamp resolution.
   */
  async applyServerChanges(docId: string, serverChanges: Change[]): Promise<void> {
    const buf = this.getOrCreateBuffer(docId);

    // Convert server changes to committed fields (store values directly)
    for (const change of serverChanges) {
      for (const op of change.ops) {
        buf.committedFields.set(op.path, op.value);
      }
    }

    // Note: Don't clear sendingChange here - these are changes from other clients,
    // not confirmation of our own change. Only confirmSendingChange should clear it.

    // Update committedRev
    const lastRev = serverChanges.at(-1)?.rev;
    if (lastRev !== undefined && lastRev > buf.committedRev) {
      buf.committedRev = lastRev;
    }
  }

  // ─── Helper Methods ──────────────────────────────────────────────────────

  private getOrCreateBuffer(docId: string): LWWDocBuffers {
    let buf = this.docs.get(docId);
    if (!buf) {
      buf = {
        committedFields: new Map(),
        pendingOps: new Map(),
        sendingChange: null,
        committedRev: 0,
      };
      this.docs.set(docId, buf);
    }
    return buf;
  }

  /**
   * Converts pending ops to an array of Change objects.
   */
  private pendingOpsToChanges(ops: Map<string, JSONPatchOp>, baseRev: number): Change[] {
    if (ops.size === 0) {
      return [];
    }

    const opsArray = Array.from(ops.values());
    return [createChange(baseRev, baseRev + 1, opsArray)];
  }
}
