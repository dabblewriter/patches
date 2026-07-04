import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesState, QuarantinedChange } from '../types.js';
import type { PatchesStore } from './PatchesStore.js';

/**
 * LWW-specific client store interface.
 * Extends PatchesStore with field-level operations and sending change lifecycle.
 *
 * State reconstruction in getDoc:
 * snapshot -> apply committedFields -> apply sendingChange.ops -> apply pendingOps -> return {state, rev}
 *
 * Idempotency: sendingChange stays until acked. No cancel - just retry until success.
 */
export interface LWWClientStore extends PatchesStore {
  /**
   * Get pending ops, optionally filtered by path prefixes for efficiency.
   *
   * When pathPrefixes is provided, returns all ops where the path starts with
   * any of the given prefixes. For example, getPendingOps(docId, ['/user/name'])
   * returns ops at '/user/name' or '/user/name/first', etc.
   *
   * @param docId Document identifier
   * @param pathPrefixes Optional array of path prefixes to filter by
   * @returns Array of pending JSONPatchOps
   */
  getPendingOps(docId: string, pathPrefixes?: string[]): Promise<JSONPatchOp[]>;

  /**
   * Save pending ops, optionally deleting paths.
   *
   * Used for consolidation when a parent path overwrites children. For example,
   * when saving replace('/user/name', {first: 'Bob'}) we may need to delete
   * the existing '/user/name/first' op.
   *
   * @param docId Document identifier
   * @param ops Array of JSONPatchOps to save
   * @param pathsToDelete Optional array of paths to delete (for consolidation)
   */
  savePendingOps(docId: string, ops: JSONPatchOp[], pathsToDelete?: string[]): Promise<void>;

  /**
   * Get the in-flight change for retry/reconnect scenarios.
   *
   * @param docId Document identifier
   * @returns The sending change, or null if none
   */
  getSendingChange(docId: string): Promise<Change | null>;

  /**
   * Atomically save sending change AND clear all pending ops.
   *
   * This creates the in-flight change from pending ops. The pending ops
   * are cleared because they are now encapsulated in the sending change.
   *
   * @param docId Document identifier
   * @param change The change to save as sending
   */
  saveSendingChange(docId: string, change: Change): Promise<void>;

  /**
   * Clear sendingChange after server ack, move ops to committed.
   *
   * Promotion into committed state is LWW-guarded per path (the same rule the server's
   * consolidation applies): a sent op that loses to a newer committed row is not promoted,
   * and a delta op folds into the stored value. Returns those locally-resolved rows — the
   * corrections — so the caller can roll the open doc's optimistic values back without
   * depending on the commit response's echo (whose apply is a separate transaction that
   * may never land). Empty when every sent op won verbatim.
   *
   * @param docId Document identifier
   * @param ops When the sending change was split across wire batches, the ops the server just
   *   confirmed. Only these move to committed; the sending slot is kept until all its ops are
   *   confirmed, so a disconnect between batches leaves the remainder to be resent. Omitted =
   *   confirm the whole sending change.
   */
  confirmSendingChange(docId: string, ops?: JSONPatchOp[]): Promise<JSONPatchOp[]>;

  /**
   * Apply server changes using LWW timestamp resolution.
   *
   * @param docId Document identifier
   * @param serverChanges Changes from the server
   */
  applyServerChanges(docId: string, serverChanges: Change[]): Promise<void>;

  /**
   * Rebuild the committed-only state (snapshot + committed ops, no sending/pending
   * layers), the base for `ClientAlgorithm.verifyPendingChange`'s strict-apply probe.
   */
  getCommittedState(docId: string): Promise<PatchesState>;

  /**
   * Move the sending change into quarantine, preserving pendingOps (unlike
   * `saveSendingChange`, which clears them). The quarantine write and the sending-slot
   * clear must be one transaction; a crash between them must not drop the change.
   *
   * @returns The quarantined entry, or null when the slot is empty or holds a
   *   different change id (nothing is mutated in that case).
   */
  quarantineSendingChange(docId: string, changeId: string, reason: string): Promise<QuarantinedChange | null>;

  /** List quarantined changes for one doc, or all docs when docId is omitted. */
  listQuarantinedChanges(docId?: string): Promise<QuarantinedChange[]>;

  /** Permanently remove a quarantined change. The app's decision, never automatic. */
  discardQuarantinedChange(docId: string, changeId: string): Promise<void>;
}
