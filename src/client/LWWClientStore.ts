import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change } from '../types.js';
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
   * @param docId Document identifier
   */
  confirmSendingChange(docId: string): Promise<void>;

  /**
   * Apply server changes using LWW timestamp resolution.
   *
   * @param docId Document identifier
   * @param serverChanges Changes from the server
   */
  applyServerChanges(docId: string, serverChanges: Change[]): Promise<void>;
}
