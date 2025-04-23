import type { Change, PatchesSnapshot } from '../types.js';
/** Represents metadata for a document tracked by the store. */
export interface TrackedDoc {
  docId: string;
  /** The last revision number confirmed by the server. */
  committedRev: number;
  /** Optional flag indicating the document has been locally deleted. */
  deleted?: true;
}

/**
 * Pluggable persistence layer contract used by Patches + PatchesSync.
 * It is *not* strictly offline; an in‑memory implementation fulfils the same contract.
 */
export interface PatchesStore {
  // ─── Metadata / Tracking ───────────────────────────────────────────

  /**
   * Ensure these docs exist in the local index (or undelete them).
   * Called by `trackDocs` before syncing begins.
   */
  trackDocs(docIds: string[]): Promise<void>;

  /**
   * Drop all local data for these docs without creating a delete tombstone.
   * Called by `untrackDocs` when the user no longer cares about a doc locally.
   */
  untrackDocs(docIds: string[]): Promise<void>;

  /** List currently tracked docs (optionally including deleted). */
  listDocs(includeDeleted?: boolean): Promise<TrackedDoc[]>;

  // ─── Reconstruction helpers ────────────────────────────────────────
  getDoc(docId: string): Promise<PatchesSnapshot | undefined>;
  getPendingChanges(docId: string): Promise<Change[]>;
  getLastRevs(docId: string): Promise<[committedRev: number, pendingRev: number]>;

  // ─── Writes ────────────────────────────────────────────────────────
  savePendingChanges(docId: string, changes: Change[]): Promise<void>;
  saveCommittedChanges(docId: string, changes: Change[], sentPendingRange?: [number, number]): Promise<void>;

  // ─── Lifecycle ──────────────────────────────────────────────────────
  /** Permanently delete document (writes tombstone so server delete happens later). */
  deleteDoc(docId: string): Promise<void>;

  /** Confirm that a doc has been deleted (e.g., after a tombstone has been written). */
  confirmDeleteDoc(docId: string): Promise<void>;

  /** Close the store */
  close(): Promise<void>;
}
