import { commitChanges, type CommitChangesOptions } from '../algorithms/server/commitChanges.js';
import { createVersion } from '../algorithms/server/createVersion.js';
import { getSnapshotAtRevision } from '../algorithms/server/getSnapshotAtRevision.js';
import { getStateAtRevision } from '../algorithms/server/getStateAtRevision.js';
import { applyChanges } from '../algorithms/shared/applyChanges.js';
import { createChange } from '../data/change.js';
import { signal } from '../event-signal.js';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import { getClientId } from '../net/serverContext.js';
import type {
  Change,
  ChangeInput,
  ChangeMutator,
  DeleteDocOptions,
  EditableVersionMetadata,
  PatchesState,
} from '../types.js';
import type { PatchesServer } from './PatchesServer.js';
import type { OTStoreBackend } from './types.js';
import { createTombstoneIfSupported, removeTombstoneIfExists } from './tombstone.js';
import { assertVersionMetadata } from './utils.js';
export type { CommitChangesOptions } from '../algorithms/server/commitChanges.js';

/**
 * Configuration options for the OTServer.
 */
export interface OTServerOptions {
  /**
   * The maximum time difference in minutes between consecutive changes
   * to be considered part of the same editing session for versioning.
   * Defaults to 30 minutes.
   */
  sessionTimeoutMinutes?: number;
  /**
   * Maximum size in bytes for a single change's storage representation.
   * Useful for databases with row size limits.
   */
  maxStorageBytes?: number;
}

/**
 * Handles the server-side Operational Transformation (OT) logic,
 * coordinating batches of changes, managing versioning based on sessions (including offline),
 * and persisting data using a backend store.
 *
 * For compression support, wrap your store with CompressedStoreBackend before passing it:
 * @example
 * import { OTServer, CompressedStoreBackend } from '@dabble/patches/server';
 * import { base64Compressor } from '@dabble/patches/compression';
 *
 * const compressedStore = new CompressedStoreBackend(store, base64Compressor);
 * const server = new OTServer(compressedStore);
 */
export class OTServer implements PatchesServer {
  /**
   * Static API definition for use with JSONRPCServer.register().
   * Maps method names to required access levels.
   */
  static api: ApiDefinition = {
    getDoc: 'read',
    getChangesSince: 'read',
    commitChanges: 'write',
    deleteDoc: 'write',
    undeleteDoc: 'write',
  } as const;

  private readonly sessionTimeoutMillis: number;
  private readonly maxStorageBytes?: number;
  readonly store: OTStoreBackend;

  /** Notifies listeners whenever a batch of changes is *successfully* committed. */
  public readonly onChangesCommitted = signal<(docId: string, changes: Change[], originClientId?: string) => void>();

  /** Notifies listeners when a document is deleted. */
  public readonly onDocDeleted = signal<(docId: string, options?: DeleteDocOptions, originClientId?: string) => void>();

  constructor(store: OTStoreBackend, options: OTServerOptions = {}) {
    this.sessionTimeoutMillis = (options.sessionTimeoutMinutes ?? 30) * 60 * 1000;
    this.maxStorageBytes = options.maxStorageBytes;
    this.store = store;
  }

  /**
   * Get the current state of a document.
   * @param docId - The ID of the document.
   * @returns The current state of the document.
   */
  async getDoc(docId: string): Promise<PatchesState> {
    return getStateAtRevision(this.store, docId);
  }

  /**
   * Get changes that occurred after a specific revision.
   * @param docId - The ID of the document.
   * @param rev - The revision number.
   * @returns The changes that occurred after the specified revision.
   */
  getChangesSince(docId: string, rev: number): Promise<Change[]> {
    return this.store.listChanges(docId, { startAfter: rev });
  }

  /**
   * Commits a set of changes to a document, applying operational transformation as needed.
   *
   * Returns all changes the client needs to apply: both catchup changes (from other
   * clients) and the client's own transformed changes. Only the new changes are
   * broadcast to other clients.
   *
   * @param docId - The ID of the document.
   * @param changes - The changes to commit.
   * @param options - Optional commit settings (e.g., forceCommit for migrations).
   * @returns Combined array of catchup changes followed by the client's committed changes.
   */
  async commitChanges(docId: string, changes: ChangeInput[], options?: CommitChangesOptions): Promise<Change[]> {
    const { catchupChanges, newChanges } = await commitChanges(
      this.store,
      docId,
      changes,
      this.sessionTimeoutMillis,
      options,
      this.maxStorageBytes
    );

    // Notify about newly committed changes (broadcast to other clients)
    if (newChanges.length > 0) {
      try {
        // Fire event for realtime transports (WebSocket, etc.)
        // Use clientId from request context for broadcast filtering
        await this.onChangesCommitted.emit(docId, newChanges, getClientId());
      } catch (error) {
        // If notification fails after saving, log error but don't fail the operation
        // The changes are already committed to storage, so we can't roll back
        console.error(`Failed to notify clients about committed changes for doc ${docId}:`, error);
      }
    }

    // Return combined changes: catchup first, then new changes
    return [...catchupChanges, ...newChanges];
  }

  /**
   * Make a server-side change to a document.
   * @param mutator
   * @returns
   */
  async change<T = Record<string, any>>(
    docId: string,
    mutator: ChangeMutator<T>,
    metadata?: Record<string, any>
  ): Promise<Change | null> {
    const { state, rev } = await this.getDoc(docId);
    const patch = createJSONPatch<T>(mutator);
    if (patch.ops.length === 0) {
      return null;
    }

    // It's the baseRev that matters for sending.
    const change = createChange(rev, rev + 1, patch.ops, metadata);

    // Apply to local state to ensure no errors are thrown
    patch.apply(state);
    await this.commitChanges(docId, [change]);
    return change;
  }

  /**
   * Deletes a document.
   * @param docId The document ID.
   * @param options - Optional deletion settings (e.g., skipTombstone for testing).
   */
  async deleteDoc(docId: string, options?: DeleteDocOptions): Promise<void> {
    const clientId = getClientId();
    const { rev } = await this.getDoc(docId);
    await createTombstoneIfSupported(this.store, docId, rev, clientId, options?.skipTombstone);
    await this.store.deleteDoc(docId);
    await this.onDocDeleted.emit(docId, options, clientId);
  }

  /**
   * Removes the tombstone for a deleted document, allowing it to be recreated.
   * @param docId The document ID.
   * @returns True if tombstone was found and removed, false if no tombstone existed.
   */
  async undeleteDoc(docId: string): Promise<boolean> {
    return removeTombstoneIfExists(this.store, docId);
  }

  // === Version Operations ===

  /**
   * Captures the current state of a document as a new version.
   * @param docId The document ID.
   * @param metadata Optional metadata for the version.
   * @returns The ID of the created version.
   */
  async captureCurrentVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string | null> {
    assertVersionMetadata(metadata);
    const { state: initialState, changes } = await getSnapshotAtRevision(this.store, docId);
    let state = initialState;
    state = applyChanges(state, changes);
    const version = await createVersion(this.store, docId, state, changes, metadata);
    if (!version) {
      return null;
    }
    return version.id;
  }
}
