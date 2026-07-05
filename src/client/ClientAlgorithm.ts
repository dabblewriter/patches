import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot, QuarantinedChange } from '../types.js';
import type { PatchesDoc } from './PatchesDoc.js';
import type { PatchesStore, TrackedDoc } from './PatchesStore.js';

/**
 * Algorithm interface for client-side sync algorithms (OT or LWW).
 *
 * The ClientAlgorithm owns its store and provides methods for:
 * - Creating appropriate doc types
 * - Packaging ops for persistence
 * - Getting pending changes to send
 * - Applying server changes
 * - Confirming sent changes
 *
 * Patches owns docs and coordinates between doc/algorithm/sync.
 *
 * This interface enables Worker-Tab architectures where a TabAlgorithm
 * can proxy to a WorkerAlgorithm that holds the real store and sync connection.
 * Key design decisions for Worker-Tab support:
 * - `handleDocChange` and `applyServerChanges` return `Change[]` for broadcast
 * - `doc` parameter can be undefined (Worker has no docs)
 */
export interface ClientAlgorithm {
  /** Algorithm identifier: 'ot' or 'lww' */
  readonly name: string;

  /** Algorithm owns its store */
  readonly store: PatchesStore;

  /**
   * Creates a doc instance appropriate for this algorithm.
   * OT creates OTDoc, LWW creates LWWDoc.
   *
   * @param docId The unique identifier for the document.
   * @param snapshot Optional snapshot to initialize the doc with.
   */
  createDoc<T extends object>(docId: string, snapshot?: PatchesSnapshot<T>): PatchesDoc<T>;

  /**
   * Loads initial state for a document from the store.
   * Returns undefined if the document doesn't exist.
   */
  loadDoc(docId: string): Promise<PatchesSnapshot | undefined>;

  /**
   * Packages ops from doc.onChange into algorithm-specific format for persistence.
   * - OT: Creates a Change with baseRev, stores in pending
   * - LWW: Extracts fields with timestamps, merges into pendingFields
   *
   * Also updates the doc's state (if provided) after processing.
   *
   * @param docId Document identifier
   * @param ops The JSON Patch ops to process
   * @param doc The open doc instance, or undefined if in Worker (no docs)
   * @param metadata Metadata to attach to the change
   * @param id Optional caller-supplied stable change id. Lets an upstream caller (e.g. a
   *   spoke, before a hub RPC) mint the id once so a retried submit reuses it. OT mints with
   *   this id; combined with `isRetry` it makes the submit idempotent.
   * @param isRetry When true, this is a re-submission of a previously-attempted change (its
   *   first attempt may have timed out after the hub already accepted it). With `id`, OT
   *   returns the already-accepted change instead of minting a duplicate.
   * @returns The changes created (for broadcast to other tabs)
   */
  handleDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T> | undefined,
    metadata: Record<string, any>,
    id?: string,
    isRetry?: boolean
  ): Promise<Change[]>;

  /**
   * Lists all changes (committed + pending) for a document.
   * Used by PatchesBranchClient for client-side offline merge to read branch changes.
   * Optional — only OT algorithms with IndexedDB stores support this.
   *
   * @param docId Document identifier
   * @param options.startAfter Only return changes with rev > startAfter
   * @returns Changes sorted by rev
   */
  listChanges?(docId: string, options?: { startAfter?: number }): Promise<Change[]>;

  /**
   * Read-only check for whether a document has any pending local data.
   * - OT: Checks pendingChanges
   * - LWW: Checks both pendingOps and sendingChange
   *
   * Unlike getPendingToSend, this has no side effects.
   */
  hasPending(docId: string): Promise<boolean>;

  /**
   * Gets pending data to send to the server.
   * - OT: Returns all pending changes (may batch)
   * - LWW: Creates single Change from pendingFields (or returns existing)
   *
   * Returns null if nothing to send.
   */
  getPendingToSend(docId: string): Promise<Change[] | null>;

  /**
   * Applies server changes and updates the doc (if provided).
   * - OT: Calls applyCommittedChanges algorithm, rebases pending
   * - LWW: Applies with LWW merge, filters old pending fields
   *
   * @param docId Document identifier
   * @param serverChanges Changes from the server
   * @param doc The open doc instance, or undefined if in Worker (no docs)
   * @returns Changes to broadcast to tabs (OT: serverChanges + rebasedPending, LWW: serverChanges)
   */
  applyServerChanges<T extends object>(
    docId: string,
    serverChanges: Change[],
    doc: PatchesDoc<T> | undefined
  ): Promise<Change[]>;

  /**
   * Confirms that changes were acknowledged by the server.
   * Called after successful server commit.
   *
   * LWW returns the LOCAL corrections its guarded promotion produced: the resolved rows
   * for sent paths where a newer committed row (or a delta fold) beat the raw sent op.
   * A non-empty result means the open doc's optimistic values for those paths are stale
   * and the caller must re-sync the doc from the store — the commit response carries the
   * same corrections, but its apply is a separate store transaction and may never land
   * (the ack-persist crash window). OT returns nothing (its commit echo is the sole
   * confirmation mechanism).
   */
  confirmSent(docId: string, changes: Change[]): Promise<JSONPatchOp[] | void>;

  /**
   * After a commit, drop pending changes that were sent but did not come back as
   * committed — the server rebased them away to a no-op. The normal rebase clears
   * a pending change only when its id is echoed in the server changes; a change
   * the server dropped (e.g. a root-level replace re-asserting already-committed
   * state) is never echoed and never reduces to empty under rebase, so it would be
   * resent forever. Returns the number of pending changes dropped.
   *
   * Optional — only OT needs it (LWW resolves its single in-flight change directly
   * in {@link confirmSent}).
   *
   * @param docId Document identifier
   * @param sentChanges The changes just submitted to the server
   * @param committedChanges The changes the server returned (catchup + accepted)
   */
  dropResolvedPending?(docId: string, sentChanges: Change[], committedChanges: Change[]): Promise<number>;

  /**
   * Replaces pending changes with a re-split version of themselves (same content, different
   * change boundaries/ids/revs). Sync calls this when flush-time batching had to split an
   * oversized change: the store must hold exactly what is sent, or the commit echo can't clear
   * the stored original by id and its content is duplicated. Changes minted after `oldChanges`
   * was read are preserved (renumbered after the new queue).
   *
   * Optional — only OT splits changes.
   *
   * @param docId Document identifier
   * @param oldChanges The pending changes the split was computed from
   * @param newChanges The split replacement queue
   */
  replacePendingChanges?(docId: string, oldChanges: Change[], newChanges: Change[]): Promise<void>;

  /**
   * Reconciles stored pending changes against a committed server tail WITHOUT applying that
   * tail to local state: pending changes the server has already committed (matched by change
   * id) are dropped, and the survivors are transformed into the tail's frame.
   *
   * Used by snapshot-reload recovery (`PatchesSync._reloadDocFromServer`): when a committed
   * change fails to apply, the local committed state has diverged, so the tail can't be
   * *applied* — the authoritative snapshot replaces local state instead — but pending must
   * still be reconciled against it. Without this, a pending change the server already
   * committed (e.g. a flush that succeeded on the wire but whose echo failed to apply
   * locally) is re-applied on top of a snapshot whose state already contains it (doubled
   * content), then re-sent with a re-stamped baseRev past the server's idempotency window —
   * committing the same edits a second time for every collaborator.
   *
   * Optional — only OT needs it. LWW pending fields are keyed by path and timestamp-resolved,
   * so re-sending an already-committed field is idempotent.
   *
   * @param docId Document identifier
   * @param committedChanges The committed server tail from the pending changes' base revision
   *   up to the reloaded snapshot's revision, in order
   */
  reconcilePending?(docId: string, committedChanges: Change[]): Promise<void>;

  /**
   * Local strict-apply probe corroborating a server rejection of a pending change: does
   * the named change apply cleanly against the committed-only local state? Returns true
   * when it applies cleanly or when no pending change matches the id. Optional; only LWW
   * implements it today (see docs/quarantine.md).
   */
  verifyPendingChange?(docId: string, changeId: string): Promise<boolean>;

  /**
   * Atomically move the named pending change from the outgoing queue into quarantine,
   * then bring the open doc (if provided) back in line with the store. Optional; only
   * LWW implements it today (see docs/quarantine.md).
   *
   * @returns The quarantined entry, or null when docId/changeId don't match a pending change.
   */
  ejectPendingChange?(
    docId: string,
    changeId: string,
    reason: string,
    doc?: PatchesDoc<any>
  ): Promise<QuarantinedChange | null>;

  /** Lists quarantined changes for one doc, or all docs when docId is omitted. */
  listQuarantinedChanges?(docId?: string): Promise<QuarantinedChange[]>;

  /** Permanently removes a quarantined change. The app's decision, never automatic. */
  discardQuarantinedChange?(docId: string, changeId: string): Promise<void>;

  // --- Store forwarding methods ---

  /** Registers documents for local tracking with the algorithm for this instance. */
  trackDocs(docIds: string[]): Promise<void>;

  /** Removes documents from local tracking. */
  untrackDocs(docIds: string[]): Promise<void>;

  /** Lists all tracked documents. */
  listDocs(includeDeleted?: boolean): Promise<TrackedDoc[]>;

  /** Gets the committed revision for a document. */
  getCommittedRev(docId: string): Promise<number>;

  /** Marks a document for deletion. */
  deleteDoc(docId: string): Promise<void>;

  /** Confirms server-side deletion. */
  confirmDeleteDoc(docId: string): Promise<void>;

  /** Closes the algorithm and its store. */
  close(): Promise<void>;
}
