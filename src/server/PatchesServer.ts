import { getSnapshotAtRevision } from '../algorithms/server/getSnapshotAtRevision.js';
import { getStateAtRevision } from '../algorithms/server/getStateAtRevision.js';
import { handleOfflineSessionsAndBatches } from '../algorithms/server/handleOfflineSessionsAndBatches.js';
import { transformIncomingChanges } from '../algorithms/server/transformIncomingChanges.js';
import { createVersion } from '../algorithms/server/createVersion.js';
import { applyChanges } from '../algorithms/shared/applyChanges.js';
import { createChange } from '../data/change.js';
import { signal } from '../event-signal.js';
import type { JSONPatch } from '../json-patch/JSONPatch.js';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { Change, EditableVersionMetadata, PatchesState } from '../types.js';
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
  async commitChanges(docId: string, changes: Change[], originClientId?: string): Promise<[Change[], Change[]]> {
    if (changes.length === 0) {
      return [[], []];
    }

    // Assume all changes share the same baseRev. Client ensures this.
    const batchId = changes[0].batchId;
    const baseRev = changes[0].baseRev;
    if (baseRev === undefined) {
      throw new Error(`Client changes must include baseRev for doc ${docId}.`);
    }

    // Add check for inconsistent baseRev within the batch if needed
    if (changes.some(c => c.baseRev !== baseRev)) {
      throw new Error(`Client changes must have consistent baseRev in all changes for doc ${docId}.`);
    }

    // 1. Load server state details (assuming store methods exist)
    const {
      state: initialState,
      rev: initialRev,
      changes: currentChanges,
    } = await getSnapshotAtRevision(this.store, docId);
    const currentState = applyChanges(initialState, currentChanges);
    const currentRev = currentChanges.at(-1)?.rev ?? initialRev;

    // Basic validation
    if (baseRev > currentRev) {
      throw new Error(
        `Client baseRev (${baseRev}) is ahead of server revision (${currentRev}) for doc ${docId}. Client needs to reload the document.`
      );
    }

    const partOfInitialBatch = batchId && changes[0].rev > 1;
    if (baseRev === 0 && currentRev > 0 && !partOfInitialBatch && changes[0].ops[0].path === '') {
      throw new Error(
        `Client baseRev is 0 but server has already been created for doc ${docId}. Client needs to load the existing document.`
      );
    }

    // Ensure all new changes' `created` field is in the past, that each `rev` is correct, and that `baseRev` is set
    changes.forEach(c => {
      c.created = Math.min(c.created, Date.now());
      c.baseRev = baseRev;
    });

    // 2. Check if we need to create a new version - if the last change was created more than a session ago
    const lastChange = currentChanges[currentChanges.length - 1];
    if (lastChange && lastChange.created < Date.now() - this.sessionTimeoutMillis) {
      await createVersion(this.store, docId, currentState, currentChanges);
    }

    // 3. Load committed changes *after* the client's baseRev for transformation and idempotency checks
    const committedChanges = await this.store.listChanges(docId, {
      startAfter: baseRev,
      withoutBatchId: batchId,
    });

    const committedIds = new Set(committedChanges.map(c => c.id));
    changes = changes.filter(c => !committedIds.has(c.id));

    // If all incoming changes were already committed, return the committed changes found
    if (changes.length === 0) {
      return [committedChanges, []];
    }

    // 4. Handle offline-session versioning:
    // - batchId present (multi-batch uploads)
    // - or the first change is older than the session timeout (single-batch offline)
    const isOfflineTimestamp = changes[0].created < Date.now() - this.sessionTimeoutMillis;
    if (isOfflineTimestamp || batchId) {
      changes = await handleOfflineSessionsAndBatches(
        this.store,
        this.sessionTimeoutMillis,
        docId,
        changes,
        baseRev,
        batchId
      );
    }

    // 5. Transform the *entire batch* of incoming (and potentially collapsed offline) changes
    //    against committed changes that happened *after* the client's baseRev.
    //    The state used for transformation should be the server state *at the client's baseRev*.
    const stateAtBaseRev = (await getStateAtRevision(this.store, docId, baseRev)).state;
    const transformedChanges = transformIncomingChanges(changes, stateAtBaseRev, committedChanges, currentRev);

    // Persist and notify about newly transformed changes atomically
    if (transformedChanges.length > 0) {
      await this.store.saveChanges(docId, transformedChanges);

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
    mutator: (draft: T, patch: JSONPatch) => void,
    metadata?: Record<string, any>
  ): Promise<Change | null> {
    const { state, rev } = await this.getDoc(docId);
    const patch = createJSONPatch(state as T, mutator);
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
