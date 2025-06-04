import { getSnapshotAtRevision } from '../algorithms/server/getSnapshotAtRevision.js';
import { getStateAtRevision } from '../algorithms/server/getStateAtRevision.js';
import { handleOfflineSessionsAndBatches } from '../algorithms/server/handleOfflineSessionsAndBatches.js';
import { applyChanges } from '../algorithms/shared/applyChanges.js';
import { createChange } from '../data/change.js';
import { createVersion } from '../data/version.js';
import { signal } from '../event-signal.js';
import type { JSONPatch } from '../json-patch/JSONPatch.js';
import { applyPatch } from '../json-patch/applyPatch.js';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import { transformPatch } from '../json-patch/transformPatch.js';
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
    let {
      state: currentState,
      rev: currentRev,
      changes: currentChanges,
    } = await getSnapshotAtRevision(this.store, docId);
    currentState = applyChanges(currentState, currentChanges);
    currentRev = currentChanges.at(-1)?.rev ?? currentRev;

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
      await this._createVersion(docId, currentState, currentChanges);
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
    let stateAtBaseRev = (await getStateAtRevision(this.store, docId, baseRev)).state;
    let rev = currentRev + 1;
    const committedOps = committedChanges.flatMap(c => c.ops);

    // Apply transformation based on state at baseRev
    const transformedChanges = changes
      .map(change => {
        // Transform the incoming change's ops against the ops committed since baseRev
        const transformedOps = transformPatch(stateAtBaseRev, committedOps, change.ops);
        if (transformedOps.length === 0) {
          return null; // Change is obsolete after transformation
        }
        try {
          const previous = stateAtBaseRev;
          stateAtBaseRev = applyPatch(stateAtBaseRev, transformedOps, { strict: true });
          if (previous === stateAtBaseRev) {
            // Changes were no-ops, we can skip this change
            return null;
          }
        } catch (error) {
          console.error(`Error applying change ${change.id} to state:`, error);
          return null;
        }
        // Return a new change object with transformed ops and original metadata
        return { ...change, rev: rev++, ops: transformedOps };
      })
      .filter(Boolean) as Change[];

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
   * Create a new named version snapshot of a document's current state.
   * @param docId The document ID.
   * @param name The name of the version.
   * @returns The ID of the created version.
   */
  async createVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string> {
    assertVersionMetadata(metadata);
    let { state, changes } = await getSnapshotAtRevision(this.store, docId);
    state = applyChanges(state, changes);
    const version = await this._createVersion(docId, state, changes, metadata);
    if (!version) {
      throw new Error(`No changes to create a version for doc ${docId}.`);
    }
    return version.id;
  }

  /**
   * Creates a new version snapshot of a document's current state.
   * @param docId The document ID.
   * @param state The document state at the time of the version.
   * @param changes The changes since the last version that created the state (the last change's rev is the state's rev and will be the version's rev).
   * @param metadata The metadata of the version.
   * @returns The ID of the created version.
   */
  protected async _createVersion(docId: string, state: any, changes: Change[], metadata?: EditableVersionMetadata) {
    if (changes.length === 0) return;
    const baseRev = changes[0].baseRev;
    if (baseRev === undefined) {
      throw new Error(`Client changes must include baseRev for doc ${docId}.`);
    }

    const sessionMetadata = createVersion({
      origin: 'main',
      startDate: changes[0].created,
      endDate: changes[changes.length - 1].created,
      rev: changes[changes.length - 1].rev,
      baseRev,
      ...metadata,
    });

    await this.store.createVersion(docId, sessionMetadata, state, changes);
    return sessionMetadata;
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
