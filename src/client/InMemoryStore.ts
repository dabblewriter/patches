import { transformPatch } from '../json-patch/transformPatch.js';
import type { Change, PatchesSnapshot, PatchesState } from '../types.js';
import { applyChanges } from '../utils.js';
import type { PatchesStore, TrackedDoc } from './PatchesStore.js';

interface DocBuffers {
  snapshot?: PatchesState;
  committed: Change[];
  pending: Change[];
  deleted?: true;
}

/**
 * A trivial in‑memory implementation of OfflineStore (soon PatchesStore).
 * All data lives in JS objects – nothing survives a page reload.
 * Useful for unit tests or when you want the old 'stateless realtime' behaviour.
 */
export class InMemoryStore implements PatchesStore {
  private docs: Map<string, DocBuffers> = new Map();

  // ─── Reconstruction ────────────────────────────────────────────────────
  async getDoc(docId: string): Promise<PatchesSnapshot | undefined> {
    const buf = this.docs.get(docId);
    if (!buf || buf.deleted) return undefined;

    const state = applyChanges(buf.snapshot?.state ?? null, buf.committed);
    const committedRev = buf.committed.at(-1)?.rev ?? buf.snapshot?.rev ?? 0;

    // Rebase pending if they are stale w.r.t committed
    if (buf.pending.length && buf.pending[0].baseRev! < committedRev) {
      const patch = buf.committed.filter(c => c.rev > buf.pending[0].baseRev!).flatMap(c => c.ops);
      const offset = committedRev - buf.pending[0].baseRev!;
      buf.pending.forEach(ch => {
        ch.rev += offset;
        ch.ops = transformPatch(state, patch, ch.ops);
      });
    }

    return {
      state,
      rev: committedRev,
      changes: [...buf.pending],
    };
  }

  async getPendingChanges(docId: string): Promise<Change[]> {
    return this.docs.get(docId)?.pending.slice() ?? [];
  }

  async getLastRevs(docId: string): Promise<[number, number]> {
    const buf = this.docs.get(docId);
    if (!buf) return [0, 0];
    const committedRev = buf.committed.at(-1)?.rev ?? buf.snapshot?.rev ?? 0;
    const pendingRev = buf.pending.at(-1)?.rev ?? committedRev;
    return [committedRev, pendingRev];
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
    this.docs.set(docId, { snapshot, committed: [], pending: [] });
  }
  async savePendingChange(docId: string, change: Change): Promise<void> {
    const buf = this.docs.get(docId) ?? ({ committed: [], pending: [] } as DocBuffers);
    if (!this.docs.has(docId)) this.docs.set(docId, buf);
    buf.pending.push(change);
  }

  async saveCommittedChanges(docId: string, changes: Change[], sentPendingRange?: [number, number]): Promise<void> {
    const buf = this.docs.get(docId) ?? ({ committed: [], pending: [] } as DocBuffers);
    if (!this.docs.has(docId)) this.docs.set(docId, buf);

    buf.committed.push(...changes);

    if (sentPendingRange) {
      const [min, max] = sentPendingRange;
      buf.pending = buf.pending.filter(p => p.rev < min || p.rev > max);
    }
  }

  async replacePendingChanges(docId: string, changes: Change[]): Promise<void> {
    const buf = this.docs.get(docId) ?? ({ committed: [], pending: [] } as DocBuffers);
    if (!this.docs.has(docId)) this.docs.set(docId, buf);
    buf.pending = [...changes];
  }

  // ─── Metadata / Tracking ───────────────────────────────────────────
  async trackDocs(docIds: string[]): Promise<void> {
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
  }

  async confirmDeleteDoc(docId: string): Promise<void> {
    this.docs.delete(docId);
  }

  async close(): Promise<void> {
    this.docs.clear();
  }
}
