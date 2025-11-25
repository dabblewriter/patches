import { commitChanges } from '../algorithms/server/commitChanges.js';
import { createVersion } from '../algorithms/server/createVersion.js';
import { getSnapshotAtRevision } from '../algorithms/server/getSnapshotAtRevision.js';
import { getStateAtRevision } from '../algorithms/server/getStateAtRevision.js';
import { applyChanges } from '../algorithms/shared/applyChanges.js';
import { createChange } from '../data/change.js';
import { signal } from '../event-signal.js';
import type { JSONPatch } from '../json-patch/JSONPatch.js';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { Change, ChangeInput, EditableVersionMetadata, PatchesState, PathProxy } from '../types.js';
import type { PatchesStoreBackend } from './types.js';

/**
 * Configuration options for the PatchesServer.
 */
export interface PatchesServerOptions {
  /**
   * The maximum time difference in minutes between consecutive changes
   * to be considered part of the same editing session for versioning.
   * Defaults to 30 minutes.
   */
  sessionTimeoutMinutes?: number;
}

/**
 * Handles the server-side Operational Transformation (OT) logic,
 * coordinating batches of changes, managing versioning based on sessions (including offline),
 * and persisting data using a backend store.
 */
export class PatchesServer {
  private readonly sessionTimeoutMillis: number;

  /** Notifies listeners whenever a batch of changes is *successfully* committed. */
  public readonly onChangesCommitted = signal<(docId: string, changes: Change[], originClientId?: string) => void>();

  /** Notifies listeners when a document is deleted. */
  public readonly onDocDeleted = signal<(docId: string, originClientId?: string) => void>();

  constructor(
    readonly store: PatchesStoreBackend,
    options: PatchesServerOptions = {}
  ) {
    this.sessionTimeoutMillis = (options.sessionTimeoutMinutes ?? 30) * 60 * 1000;
  }

  /**
   * Get the state of a document at a specific revision (or the latest state if no revision is provided).
   * @param docId - The ID of the document.
   * @param rev - The revision number.
   * @returns The state of the document at the specified revision.
   */
  async getDoc(docId: string, atRev?: number): Promise<PatchesState> {
    return getStateAtRevision(this.store, docId, atRev);
  }

  /**
   * Get the state of a document at a specific revision.
   * @param docId - The ID of the document.
   * @param rev - The revision number.
   * @returns The state of the document at the specified revision.
   */
  async getStateAtRevision(docId: string, atRev?: number): Promise<PatchesState> {
    return getStateAtRevision(this.store, docId, atRev);
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
   * @param docId - The ID of the document.
   * @param changes - The changes to commit.
   * @param originClientId - The ID of the client that initiated the commit.
   * @returns A tuple of [committedChanges, transformedChanges] where:
   *   - committedChanges: Changes that were already committed to the server after the client's base revision
   *   - transformedChanges: The client's changes after being transformed against concurrent changes
   */
  async commitChanges(docId: string, changes: ChangeInput[], originClientId?: string): Promise<[Change[], Change[]]> {
    const [committedChanges, transformedChanges] = await commitChanges(
      this.store,
      docId,
      changes,
      this.sessionTimeoutMillis
    );

    // Persist and notify about newly transformed changes atomically
    if (transformedChanges.length > 0) {
      try {
        // Fire event for realtime transports (WebSocket, etc.)
        await this.onChangesCommitted.emit(docId, transformedChanges, originClientId);
      } catch (error) {
        // If notification fails after saving, log error but don't fail the operation
        // The changes are already committed to storage, so we can't roll back
        console.error(`Failed to notify clients about committed changes for doc ${docId}:`, error);
        // Consider implementing a retry mechanism or dead letter queue here
      }
    }

    // Return committed changes and newly transformed changes separately
    return [committedChanges, transformedChanges];
  }

  /**
   * Make a server-side change to a document.
   * @param mutator
   * @returns
   */
  async change<T = Record<string, any>>(
    docId: string,
    mutator: (patch: JSONPatch, root: PathProxy<T>) => void,
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
   * @param originClientId - The ID of the client that initiated the delete operation.
   */
  async deleteDoc(docId: string, originClientId?: string): Promise<void> {
    await this.store.deleteDoc(docId);
    await this.onDocDeleted.emit(docId, originClientId);
  }

  // === Version Operations ===

  /**
   * Captures the current state of a document as a new version.
   * @param docId The document ID.
   * @param metadata Optional metadata for the version.
   * @returns The ID of the created version.
   */
  async captureCurrentVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string> {
    assertVersionMetadata(metadata);
    const { state: initialState, changes } = await getSnapshotAtRevision(this.store, docId);
    let state = initialState;
    state = applyChanges(state, changes);
    const version = await createVersion(this.store, docId, state, changes, metadata);
    if (!version) {
      throw new Error(`No changes to create a version for doc ${docId}.`);
    }
    return version.id;
  }
}

const nonModifiableMetadataFields = new Set([
  'id',
  'parentId',
  'groupId',
  'origin',
  'branchName',
  'startDate',
  'endDate',
  'rev',
  'baseRev',
]);

export function assertVersionMetadata(metadata?: EditableVersionMetadata) {
  if (!metadata) return;
  for (const key in metadata) {
    if (nonModifiableMetadataFields.has(key)) {
      throw new Error(`Cannot modify version field ${key}`);
    }
  }
}
