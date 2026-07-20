import { applyChanges } from '../algorithms/ot/shared/applyChanges.js';
import type { Change, PatchesSnapshot, PatchesState, QuarantinedChange } from '../types.js';
import type { OTClientStore } from './OTClientStore.js';
import type { TrackedDoc } from './PatchesStore.js';

interface DocBuffers {
  snapshot?: PatchesState;
  committed: Change[];
  pending: Change[];
  deleted?: true;
}

/**
 * A trivial in‑memory implementation of OTClientStore.
 * All data lives in JS objects – nothing survives a page reload.
 * Useful for unit tests or when you want the old 'stateless realtime' behaviour.
 */
export class OTInMemoryStore implements OTClientStore {
  private docs: Map<string, DocBuffers> = new Map();
  // Kept outside the per-doc buffers so untracking (cache eviction) preserves quarantine —
  // only an explicit delete or discard removes an entry (see docs/quarantine.md).
  private quarantined: Map<string, Map<string, QuarantinedChange>> = new Map();

  // ─── Reconstruction ────────────────────────────────────────────────────
  async getDoc(docId: string): Promise<PatchesSnapshot | undefined> {
    const buf = this.docs.get(docId);
    if (!buf || buf.deleted) return undefined;

    const state = applyChanges(buf.snapshot?.state ?? null, buf.committed);
    const committedRev = buf.committed.at(-1)?.rev ?? buf.snapshot?.rev ?? 0;

    return {
      state,
      rev: committedRev,
      changes: [...buf.pending],
    };
  }

  async getPendingChanges(docId: string, options?: { startAfterRev?: number }): Promise<Change[]> {
    const pending = this.docs.get(docId)?.pending ?? [];
    const startAfter = options?.startAfterRev ?? -1;
    return pending.filter(change => change.rev > startAfter);
  }

  async getCommittedRev(docId: string): Promise<number> {
    const buf = this.docs.get(docId);
    if (!buf) return 0;
    return buf.committed.at(-1)?.rev ?? buf.snapshot?.rev ?? 0;
  }

  async listDocs(includeDeleted = false): Promise<TrackedDoc[]> {
    return Array.from(this.docs.entries())
      .filter(([, b]) => includeDeleted || !b.deleted)
      .map(([docId, buf]) => ({
        docId,
        committedRev: buf.snapshot?.rev ?? buf.committed.at(-1)?.rev ?? 0,
        deleted: buf.deleted,
      }));
  }

  // ─── Writes ────────────────────────────────────────────────────────────
  async saveDoc(docId: string, snapshot: PatchesState): Promise<void> {
    const existing = this.docs.get(docId);
    const changes = (snapshot as PatchesSnapshot).changes;
    this.docs.set(docId, {
      snapshot,
      committed: changes ? [...changes] : [],
      pending: existing?.pending ?? [],
    });
  }

  // rev is assigned from the doc's stored tail (committedRev or max pending rev) and re-stamped
  // in place, mirroring OTIndexedDBStore's in-transaction mint — rev is only the ordering key.
  async savePendingChanges(docId: string, changes: Change[]): Promise<void> {
    const buf = this.docs.get(docId) ?? ({ committed: [], pending: [] } as DocBuffers);
    if (!this.docs.has(docId)) this.docs.set(docId, buf);
    let tail = buf.committed.at(-1)?.rev ?? buf.snapshot?.rev ?? 0;
    for (const change of buf.pending) if (change.rev > tail) tail = change.rev;
    for (let i = 0; i < changes.length; i++) changes[i].rev = tail + 1 + i;
    buf.pending.push(...changes);
  }

  async applyServerChanges(
    docId: string,
    serverChanges: Change[],
    rebasedPendingChanges: Change[],
    pendingTailRev?: number
  ): Promise<void | 'conflict'> {
    const buf = this.docs.get(docId) ?? ({ committed: [], pending: [] } as DocBuffers);
    if (!this.docs.has(docId)) this.docs.set(docId, buf);

    // A foreign mint landing since the caller's rebase read would be wiped by the replace below.
    if (pendingTailRev !== undefined && buf.pending.some(change => change.rev > pendingTailRev)) {
      return 'conflict';
    }

    // Drop already-stored revs — duplicated deliveries (echo, re-broadcast, catchup
    // overlapping a broadcast) would otherwise double-apply on every getDoc rebuild
    const lastRev = buf.committed.at(-1)?.rev ?? buf.snapshot?.rev ?? 0;
    buf.committed.push(...serverChanges.filter(change => change.rev > lastRev));
    buf.pending = [...rebasedPendingChanges];
  }

  async listChanges(docId: string, options?: { startAfter?: number }): Promise<Change[]> {
    const buf = this.docs.get(docId);
    if (!buf || buf.deleted) return [];
    const startAfter = options?.startAfter ?? -1;
    return [...buf.committed, ...buf.pending].filter(change => change.rev > startAfter).sort((a, b) => a.rev - b.rev);
  }

  async dropPendingChanges(docId: string, changeIds: string[]): Promise<void> {
    const buf = this.docs.get(docId);
    if (!buf || changeIds.length === 0) return;
    const ids = new Set(changeIds);
    buf.pending = buf.pending.filter(change => !ids.has(change.id));
  }

  // ─── Quarantine ────────────────────────────────────────────────────────
  async quarantinePendingChange(
    docId: string,
    poison: Change,
    reason: string,
    rebasedPending: Change[],
    pendingTailRev?: number
  ): Promise<QuarantinedChange | null | 'conflict'> {
    const buf = this.docs.get(docId);
    if (!buf) return null;
    if (pendingTailRev !== undefined && buf.pending.some(change => change.rev > pendingTailRev)) return 'conflict';
    if (!buf.pending.some(change => change.id === poison.id)) return null;

    const entry: QuarantinedChange = {
      docId,
      changeId: poison.id,
      change: poison,
      reason,
      quarantinedAt: Date.now(),
    };
    let docQuarantine = this.quarantined.get(docId);
    if (!docQuarantine) this.quarantined.set(docId, (docQuarantine = new Map()));
    docQuarantine.set(poison.id, entry);
    buf.pending = [...rebasedPending];
    return entry;
  }

  async listQuarantinedChanges(docId?: string): Promise<QuarantinedChange[]> {
    if (docId !== undefined) {
      return Array.from(this.quarantined.get(docId)?.values() ?? []);
    }
    return Array.from(this.quarantined.values()).flatMap(entries => Array.from(entries.values()));
  }

  async discardQuarantinedChange(docId: string, changeId: string): Promise<void> {
    this.quarantined.get(docId)?.delete(changeId);
  }

  // ─── Metadata / Tracking ───────────────────────────────────────────
  async trackDocs(docIds: string[], _algorithm?: 'ot' | 'lww'): Promise<void> {
    for (const docId of docIds) {
      const buf = this.docs.get(docId) ?? ({ committed: [], pending: [] } as DocBuffers);
      buf.deleted = undefined; // Ensure not marked as deleted
      if (!this.docs.has(docId)) {
        this.docs.set(docId, buf);
      }
    }
  }

  async untrackDocs(docIds: string[]): Promise<void> {
    docIds.forEach(this.docs.delete, this.docs);
  }

  // ─── Misc / Lifecycle ────────────────────────────────────────────────
  async deleteDoc(docId: string): Promise<void> {
    const buf = this.docs.get(docId) ?? ({ committed: [], pending: [] } as DocBuffers);
    buf.deleted = true;
    buf.committed = [];
    buf.pending = [];
    buf.snapshot = undefined;
    this.docs.set(docId, buf);
    // Deleting a doc discards its quarantine too — the change has nowhere left to recover to.
    this.quarantined.delete(docId);
  }

  async confirmDeleteDoc(docId: string): Promise<void> {
    this.docs.delete(docId);
    this.quarantined.delete(docId);
  }

  async close(): Promise<void> {
    this.docs.clear();
    this.quarantined.clear();
  }
}
