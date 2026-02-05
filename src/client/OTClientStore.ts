import type { Change } from '../types.js';
import type { PatchesStore } from './PatchesStore.js';

/**
 * OT-specific client store interface.
 * Extends PatchesStore with methods for managing pending change lists
 * and applying server changes with rebasing.
 */
export interface OTClientStore extends PatchesStore {
  /**
   * Retrieves all pending (unconfirmed) changes for a document.
   *
   * Pending changes are local edits that haven't been confirmed by the server yet.
   * Returns changes in chronological order as they were created locally.
   * Used during sync to resend unconfirmed operations.
   *
   * @param docId Document identifier
   * @returns Array of pending changes in chronological order
   */
  getPendingChanges(docId: string): Promise<Change[]>;

  /**
   * Appends new pending changes to the document's local change queue.
   *
   * Adds changes to the end of the pending changes list without replacing existing ones.
   * Called when the user makes local edits that haven't been sent to the server yet.
   * Changes should have sequential revision numbers starting after the last pending change.
   *
   * @param docId Document identifier
   * @param changes Array of new changes to append
   */
  savePendingChanges(docId: string, changes: Change[]): Promise<void>;

  /**
   * Atomically applies server-confirmed changes and updates pending changes.
   *
   * This is the core sync operation that must be atomic: server changes become
   * committed history, and pending changes are replaced with their rebased versions.
   * Implementations must ensure both operations complete together (single transaction
   * for databases) to prevent inconsistent state if the app crashes mid-operation.
   *
   * @param docId Document identifier
   * @param serverChanges Changes confirmed by the server to add to committed history
   * @param rebasedPendingChanges Pending changes after OT rebasing (replaces all existing pending)
   */
  applyServerChanges(docId: string, serverChanges: Change[], rebasedPendingChanges: Change[]): Promise<void>;
}
