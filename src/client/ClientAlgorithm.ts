import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, PatchesSnapshot } from '../types.js';
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
   * @returns The changes created (for broadcast to other tabs)
   */
  handleDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T> | undefined,
    metadata: Record<string, any>
  ): Promise<Change[]>;

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
   */
  confirmSent(docId: string, changes: Change[]): Promise<void>;

  // --- Store forwarding methods ---

  /** Registers documents for local tracking. */
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

/** Available algorithm names */
export type AlgorithmName = 'ot' | 'lww';
