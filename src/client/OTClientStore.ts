import type { Change, QuarantinedChange } from '../types.js';
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
   * Removes specific pending changes by change id.
   *
   * Used after a commit when the server rebased some sent changes away to a
   * no-op: they never come back as committed changes, so the normal
   * rebase-by-id removal in {@link applyServerChanges} can't clear them, and a
   * change like a root-level replace never reduces to empty under rebase. Without
   * this the client resends them forever.
   *
   * @param docId Document identifier
   * @param changeIds Ids of the pending changes to remove (matched on `Change.id`)
   */
  dropPendingChanges(docId: string, changeIds: string[]): Promise<void>;

  /**
   * Lists all changes (committed + pending) for a document, sorted by rev.
   * Used by PatchesBranchClient for client-side offline merge to read branch changes.
   *
   * @param docId Document identifier
   * @param options.startAfter Only return changes with rev > startAfter
   * @returns Changes sorted by rev
   */
  listChanges?(docId: string, options?: { startAfter?: number }): Promise<Change[]>;

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

  /**
   * Atomically move one pending change into quarantine and replace the pending queue with
   * its rebased remainder.
   *
   * The caller (OTAlgorithm) computes `rebasedPending` — the queue with `poison` removed and
   * its successors transformed as though it had never been minted. This method only persists
   * the result: it writes the quarantine entry and swaps the pending queue in ONE transaction,
   * so a crash between the two can neither lose the change nor leave the queue half-rebased.
   *
   * Guards on the poison still being pending: returns null without mutating anything when
   * `poison.id` isn't in the current pending queue (already committed, already ejected, or a
   * store without the quarantine object store), so a duplicate ejection is a safe no-op.
   *
   * @param docId          Document identifier
   * @param poison         The change to quarantine (removed from pending)
   * @param reason         Human-readable rejection reason, stored on the quarantine entry
   * @param rebasedPending The replacement pending queue (poison gone, successors rebased)
   * @returns The quarantined entry, or null when `poison.id` no longer matches a pending change.
   */
  quarantinePendingChange(
    docId: string,
    poison: Change,
    reason: string,
    rebasedPending: Change[]
  ): Promise<QuarantinedChange | null>;

  /** List quarantined changes for one doc, or all docs when docId is omitted. */
  listQuarantinedChanges(docId?: string): Promise<QuarantinedChange[]>;

  /** Permanently remove a quarantined change. The app's decision, never automatic. */
  discardQuarantinedChange(docId: string, changeId: string): Promise<void>;
}
