import { applyChanges } from '../algorithms/shared/applyChanges.js';
import type { Change, PatchesSnapshot, PatchesState } from '../types.js';
import type { PatchesStore, TrackedDoc } from './PatchesStore.js';

interface DocBuffers {
  snapshot?: PatchesState;
  committed: Change[];
  pending: Change[];
  deleted?: true;
  lastAttemptedSubmissionRev?: number;
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

    return {
      state,
      rev: committedRev,
      changes: [...buf.pending],
    };
  }

  async getPendingChanges(docId: string): Promise<Change[]> {
    return this.docs.get(docId)?.pending.slice() ?? [];
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
    this.docs.set(docId, { snapshot, committed: [], pending: [] });
  }

  async savePendingChanges(docId: string, changes: Change[]): Promise<void> {
    const buf = this.docs.get(docId) ?? ({ committed: [], pending: [] } as DocBuffers);
    if (!this.docs.has(docId)) this.docs.set(docId, buf);
    buf.pending.push(...changes);
  }

  async applyServerChanges(docId: string, serverChanges: Change[], rebasedPendingChanges: Change[]): Promise<void> {
    const buf = this.docs.get(docId) ?? ({ committed: [], pending: [] } as DocBuffers);
    if (!this.docs.has(docId)) this.docs.set(docId, buf);

    buf.committed.push(...serverChanges);
    buf.pending = [...rebasedPendingChanges];
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

  // ─── Submission Bookmark ───────────────────────────────────────────────
  async getLastAttemptedSubmissionRev(docId: string): Promise<number | undefined> {
    return this.docs.get(docId)?.lastAttemptedSubmissionRev;
  }

  async setLastAttemptedSubmissionRev(docId: string, rev: number): Promise<void> {
    const buf = this.docs.get(docId);
    if (buf) {
      buf.lastAttemptedSubmissionRev = rev;
    }
  }
}
