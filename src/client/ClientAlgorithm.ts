import type { Signal } from 'easy-signal';
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
   * Optional signal for failures the algorithm can report but not resolve — e.g. OT withholding a
   * pending change the open doc holds but the store never persisted. PatchesSync forwards these to
   * its own onError so they reach app telemetry.
   */
  readonly onError?: Signal<(error: Error, context?: { docId?: string }) => void>;

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
   * @param id Optional caller-supplied stable change id. Lets an upstream caller mint the id once
   *   so a retried submit reuses it; the server dedups resubmitted commits by change id. OT mints
   *   with this id.
   * @returns The changes created (for broadcast to other tabs)
   */
  handleDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T> | undefined,
    metadata: Record<string, any>,
    id?: string
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
   * - OT: Returns the pending queue's leading run of same-baseRev changes — usually the whole
   *   queue; a mixed-baseRev queue flushes one frame per call (callers flush repeatedly until
   *   drained, see PatchesSync.flushDoc's follow-up pass)
   * - LWW: Creates single Change from pendingFields (or returns existing)
   *
   * The store's pending rows are the source of truth — it is the sole rev sequencer, so any
   * context sharing it can mint at a rev the open doc's mirror already holds. When `doc` is
   * passed, OT merges its in-memory pending in as a supplement (by change id, above the store
   * tail) for a change persisted only to the doc — no state materialization. LWW ignores it.
   * A doc-only change at or below the store tail is NOT sent — the store is authoritative about
   * what is durable — and OT reports it on {@link onError} rather than withholding it silently.
   * Returns null if nothing to send.
   */
  getPendingToSend(docId: string, doc?: PatchesDoc<any>): Promise<Change[] | null>;

  /**
   * Everything the local tiers still hold that the server does not, for a doc being discarded.
   * The trigger is strictly the 410/`docDeleted` class — a 403 latches the doc at `'error'` and
   * never routes here, so a revoked collaborator reaches this only on a server that signals
   * revocation as a delete. This payload is the app's last chance to shelve that content before
   * the doc closes, so it answers a different question than {@link getPendingToSend}: not "what
   * is safe to put on the wire" but "what would vanish".
   *
   * Scoped to the store's tiers — durable pending, the withheld doc-only rows, quarantine. The
   * un-minted optimistic tier stays out of reach: ops whose mint is still queued live only in the
   * doc's `_optimisticOps`, and draining them first is not an option, since a doc's `flush()`
   * never settles while its write path is latched — which is the one case where the miss is
   * deterministic.
   *
   * A pure read with none of the send path's work or side effects: no batch normalization, no
   * store-integrity reporting (the doc is legitimately vanishing, so the alarm would misfire),
   * no sending-change minting (LWW). It also includes what the send path deliberately withholds
   * — for OT, doc-only rows the store never accepted survive nowhere but the mirror being
   * discarded, making them the one category the shelf exists for.
   *
   * Durable rows first, then withheld, then quarantined; not rev-ordered — revs are informational
   * and may collide across the buckets.
   *
   * Optional, like the rest of the recovery surface: a partial implementation degrades the shelf
   * to empty rather than wedging the doc that raised the delete.
   *
   * @param excludeIds Ids resolved earlier in the flush that raised the delete. The store has
   *   already dropped them but the open doc still mirrors them, so without this they ride as
   *   withheld and inflate the payload's "unsaved changes were lost" count.
   */
  collectUnsyncedForDiscard?(docId: string, doc?: PatchesDoc<any>, excludeIds?: Set<string>): Promise<Change[]>;

  /**
   * The head of the durable pending queue, or null when it is empty. A plain read: callers that
   * need only "what is at the front of the queue now" must not pay {@link getPendingToSend}'s
   * send-path work (building/normalizing a batch, warning on mixed baseRev, reporting rows the
   * store lost), all of which would fire a second time for a status probe.
   *
   * Optional — only OT keeps a durable queue of changes. LWW's outgoing state is pending ops plus
   * at most one in-flight change, so there is no head row to peek.
   */
  peekPendingHead?(docId: string): Promise<Change | null>;

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
   * the named change apply cleanly against the frame it was minted in? That frame is
   * algorithm-specific — committed-only state for LWW, committed state advanced through
   * the change's pending predecessors for OT. Returns true when it applies cleanly, when
   * no pending change matches the id, or when the frame itself can't be reconstructed
   * (can't corroborate → fail toward "don't eject"). Optional (see docs/quarantine.md).
   */
  verifyPendingChange?(docId: string, changeId: string): Promise<boolean>;

  /**
   * Atomically move the named pending change from the outgoing queue into quarantine,
   * then bring the open doc (if provided) back in line with the store. Optional (see
   * docs/quarantine.md).
   *
   * `opts.onlyIfUnappliable` re-runs the verifyPendingChange probe under the same lock
   * the ejection runs in, and ejects only when the change still fails it. Auto-eject
   * callers must pass it: their earlier probe released the lock, and a server rebase in
   * the gap can make the change valid again — ejecting it then would quarantine
   * committable work.
   *
   * @returns The quarantined entry, or null when nothing was ejected (docId/changeId
   *   don't match a pending change, or `opts.onlyIfUnappliable` found it applies cleanly).
   * @throws When the change matched but cannot be safely ejected (the algorithm can't
   *   compute a trustworthy rebase of its successors). Nothing is mutated. Callers must
   *   not treat this as the benign null — the doc is still wedged behind the change.
   */
  ejectPendingChange?(
    docId: string,
    changeId: string,
    reason: string,
    doc?: PatchesDoc<any>,
    opts?: { onlyIfUnappliable?: boolean }
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
