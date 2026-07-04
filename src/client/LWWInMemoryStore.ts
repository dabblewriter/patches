import { consolidateFieldOp } from '../algorithms/lww/consolidateOps.js';
import { createChange } from '../data/change.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot, PatchesState, QuarantinedChange } from '../types.js';
import type { LWWClientStore } from './LWWClientStore.js';
import type { TrackedDoc } from './PatchesStore.js';

/** Sort ops in commit (rev) order, ts as tiebreak — mirrors the server's ordering. */
function sortOpsByCommitOrder(ops: JSONPatchOp[]): JSONPatchOp[] {
  return [...ops].sort((a, b) => (a.rev ?? 0) - (b.rev ?? 0) || (a.ts ?? 0) - (b.ts ?? 0));
}

interface LWWDocBuffers {
  snapshot?: { state: any; rev: number };
  committedFields: Map<string, JSONPatchOp>;
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
  // Kept outside the per-doc buffers so untracking (cache eviction) preserves quarantine.
  private quarantined: Map<string, Map<string, QuarantinedChange>> = new Map();

  // ─── Document Operations ─────────────────────────────────────────────────

  /**
   * Rebuilds a document state from snapshot + committed fields + sending + pending.
   */
  async getDoc(docId: string): Promise<PatchesSnapshot | undefined> {
    const buf = this.docs.get(docId);
    if (!buf || buf.deleted) return undefined;

    // Start with snapshot state
    let state = buf.snapshot?.state ? { ...buf.snapshot.state } : {};

    // Apply committed ops with their real op types: a confirmed delta must apply as a delta
    // and a remove as a remove, or reloads diverge from the server
    const committedOps: JSONPatchOp[] = Array.from(buf.committedFields.values());
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
   * Clears committed fields (subsumed by the snapshot) but preserves pending ops
   * and the in-flight sending change — those represent local edits not yet
   * accepted by the server and would otherwise be silently dropped when
   * PatchesSync re-saves a freshly-fetched snapshot.
   */
  async saveDoc(docId: string, docState: PatchesState): Promise<void> {
    const existing = this.docs.get(docId);
    // A server getDoc envelope carries uncompacted ops in `changes` — its `rev` is the head
    // revision but its `state` excludes those ops. Persist them or a fresh client stores an
    // empty snapshot at the head rev and never re-fetches the missing fields.
    const committedFields = new Map<string, JSONPatchOp>();
    for (const change of (docState as PatchesSnapshot).changes ?? []) {
      for (const op of change.ops) {
        committedFields.set(op.path, op);
      }
    }
    this.docs.set(docId, {
      snapshot: { state: docState.state, rev: docState.rev },
      committedFields,
      pendingOps: existing?.pendingOps ?? new Map(),
      sendingChange: existing?.sendingChange ?? null,
      committedRev: docState.rev,
    });
  }

  // ─── Tracking ────────────────────────────────────────────────────────────

  /**
   * Track documents.
   */
  async trackDocs(docIds: string[], _algorithm?: 'ot' | 'lww'): Promise<void> {
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
    this.quarantined.delete(docId);
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
    this.quarantined.clear();
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
   * Move sending ops to committed, then clear the sending slot.
   * committedRev is NOT updated here — applyServerChanges owns that using the
   * server's actual rev. Updating it here would bump the rev above the server's
   * real value for noop changes (where the server doesn't create a new rev).
   *
   * Call this BEFORE applyServerChanges so that server corrections (which run
   * after) overwrite any stale ops for fields the server won via LWW.
   */
  async confirmSendingChange(docId: string, ops?: JSONPatchOp[]): Promise<void> {
    const buf = this.docs.get(docId);
    if (!buf?.sendingChange) return;

    const confirmedPaths = ops && new Set(ops.map(op => op.path));
    const confirmed = confirmedPaths
      ? buf.sendingChange.ops.filter(op => confirmedPaths.has(op.path))
      : buf.sendingChange.ops;

    // Move ops to committed fields, deleting child-path entries to match server
    // saveOps behavior. Without this, a parent write (e.g. replace /trash {}) leaves
    // stale child entries that re-create nested structure on doc rebuild.
    //
    // Promotion is LWW-guarded through the SAME per-path rule the server applies
    // (consolidateFieldOp): a sent op that loses to a newer committed row must not be
    // promoted, and must not prune that row's children. The unguarded set() relied on
    // the commit response's correction ops (applied right after) to repair the fields
    // the server resolved differently — but the response apply is a separate store
    // transaction, and if it dies (the ack-persist crash window) the losing value is
    // baked into committed state with committedRev already past the winner's rev, where
    // no catch-up ever redelivers it. Silent, permanent divergence (fuzz seed 1000374).
    for (const op of confirmed) {
      const existing = buf.committedFields.get(op.path);
      const resolved = existing ? consolidateFieldOp(existing, op) : op;
      if (!resolved) continue; // committed row is newer — the server resolves the same way
      const childPrefix = op.path + '/';
      for (const key of buf.committedFields.keys()) {
        if (key.startsWith(childPrefix)) buf.committedFields.delete(key);
      }
      buf.committedFields.set(op.path, resolved);
    }

    // Keep the unconfirmed remainder in the sending slot (a change split across wire batches)
    // so a disconnect between batches resends it
    const remaining = confirmedPaths ? buf.sendingChange.ops.filter(op => !confirmedPaths.has(op.path)) : [];
    if (remaining.length > 0) {
      buf.sendingChange = { ...buf.sendingChange, ops: remaining };
      return;
    }

    buf.sendingChange = null;
  }

  /**
   * Apply server changes using LWW timestamp resolution.
   */
  async applyServerChanges(docId: string, serverChanges: Change[]): Promise<void> {
    const buf = this.getOrCreateBuffer(docId);

    // Store server ops, deleting child-path entries to match server saveOps behavior.
    // Without this, a parent write (e.g. replace /trash {}) leaves stale child entries
    // that re-create nested structure on doc rebuild.
    // Apply in commit order — a flush response can carry corrections ahead of catchup
    // ops (child@rev3 before parent@rev2), and an out-of-order parent write would prune
    // the newer child value.
    for (const op of sortOpsByCommitOrder(serverChanges.flatMap(change => change.ops))) {
      const childPrefix = op.path + '/';
      for (const key of buf.committedFields.keys()) {
        if (key.startsWith(childPrefix)) buf.committedFields.delete(key);
      }
      buf.committedFields.set(op.path, op);
    }

    // Note: Don't clear sendingChange here - these are changes from other clients,
    // not confirmation of our own change. Only confirmSendingChange should clear it.

    // Update committedRev
    const lastRev = serverChanges.at(-1)?.rev;
    if (lastRev !== undefined && lastRev > buf.committedRev) {
      buf.committedRev = lastRev;
    }
  }

  /**
   * Rebuild the committed-only state (snapshot + committed fields), the base for the
   * local strict-apply probe corroborating a server rejection of the sending change.
   */
  async getCommittedState(docId: string): Promise<PatchesState> {
    const buf = this.docs.get(docId);
    if (!buf) return { state: {}, rev: 0 };
    let state = buf.snapshot?.state ? { ...buf.snapshot.state } : {};
    const committedOps = Array.from(buf.committedFields.values());
    if (committedOps.length > 0) {
      state = applyPatch(state, committedOps, { partial: true });
    }
    return { state, rev: buf.committedRev };
  }

  /**
   * Atomically move the sending change into quarantine, preserving pendingOps.
   */
  async quarantineSendingChange(docId: string, changeId: string, reason: string): Promise<QuarantinedChange | null> {
    const buf = this.docs.get(docId);
    if (!buf?.sendingChange || buf.sendingChange.id !== changeId) return null;
    const quarantined: QuarantinedChange = {
      docId,
      changeId,
      change: buf.sendingChange,
      reason,
      quarantinedAt: Date.now(),
    };
    let docQuarantine = this.quarantined.get(docId);
    if (!docQuarantine) this.quarantined.set(docId, (docQuarantine = new Map()));
    docQuarantine.set(changeId, quarantined);
    buf.sendingChange = null;
    return quarantined;
  }

  /**
   * List quarantined changes for one doc, or all docs when docId is omitted.
   */
  async listQuarantinedChanges(docId?: string): Promise<QuarantinedChange[]> {
    if (docId !== undefined) {
      return Array.from(this.quarantined.get(docId)?.values() ?? []);
    }
    return Array.from(this.quarantined.values()).flatMap(entries => Array.from(entries.values()));
  }

  /**
   * Permanently remove a quarantined change.
   */
  async discardQuarantinedChange(docId: string, changeId: string): Promise<void> {
    this.quarantined.get(docId)?.delete(changeId);
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
