import { createId } from 'crypto-id';
import { applyPatch } from '../../json-patch/applyPatch.js';
import { transformPatch } from '../../json-patch/transformPatch.js';
import type {
  Change,
  ListVersionsOptions,
  PatchSnapshot,
  PatchState,
  PatchStoreBackend,
  VersionMetadata,
} from '../types.js';
import { applyChanges } from '../utils.js';

/**
 * Configuration options for the PatchServer.
 */
export interface PatchServerOptions {
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
export class PatchServer {
  private readonly sessionTimeoutMillis: number;

  constructor(
    private readonly store: PatchStoreBackend,
    options: PatchServerOptions = {}
  ) {
    this.sessionTimeoutMillis = (options.sessionTimeoutMinutes ?? 30) * 60 * 1000;
  }

  // --- Patches API Methods ---

  // === Subscription Operations ===
  /**
   * Subscribes the connected client to one or more documents.
   * @param ids Document ID(s) to subscribe to.
   * @returns A list of document IDs the client is now successfully subscribed to.
   */
  subscribe(clientId: string, ids: string | string[]): Promise<string[]> {
    return this.store.addSubscription(clientId, Array.isArray(ids) ? ids : [ids]);
  }

  /**
   * Unsubscribes the connected client from one or more documents.
   * @param ids Document ID(s) to unsubscribe from.
   */
  unsubscribe(clientId: string, ids: string | string[]): Promise<string[]> {
    return this.store.removeSubscription(clientId, Array.isArray(ids) ? ids : [ids]);
  }

  // === Document Operations ===

  /**
   * Get the latest version of a document and changes since the last version.
   * @param docId - The ID of the document.
   * @returns The latest version of the document and changes since the last version.
   */
  async getDoc(docId: string, atRev?: number): Promise<PatchSnapshot> {
    return this._getSnapshotAtRevision(docId, atRev);
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
   * Receives a batch of changes from a client, handles offline session versioning,
   * transforms changes against concurrent server history, applies them,
   * and persists the results.
   *
   * @param docId - The ID of the document to apply the changes to.
   * @param changes - An array of change objects received from the client. Should be sorted by client timestamp/sequence.
   * @returns An array containing the single committed server change representing the batch outcome.
   * @throws Error if the batch's baseRev is inconsistent or transformation fails.
   */
  async patchDoc(docId: string, changes: Change[]): Promise<Change[]> {
    if (changes.length === 0) {
      return [];
    }

    // Assume all changes share the same baseRev. Client ensures this.
    const baseRev = changes[0].baseRev;
    if (baseRev === undefined) {
      throw new Error(`Client changes must include baseRev for doc ${docId}.`);
    }

    // Add check for inconsistent baseRev within the batch if needed
    if (changes.some(c => c.baseRev !== baseRev)) {
      throw new Error(`Client changes must have consistent baseRev for doc ${docId}.`);
    }

    // 1. Load server state details (assuming store methods exist)
    let { state: currentState, rev: currentRev, changes: currentChanges } = await this._getSnapshotAtRevision(docId);
    currentState = applyChanges(currentState, currentChanges);

    // Basic validation
    if (baseRev > currentRev) {
      throw new Error(
        `Client baseRev (${baseRev}) is ahead of server revision (${currentRev}) for doc ${docId}. Client needs to reload the document.`
      );
    }

    if (baseRev === 0 && currentRev > 0) {
      throw new Error(
        `Client baseRev is 0 but server has already been created for doc ${docId}. Client needs to load the existing document.`
      );
    }

    // Ensure all new changes’ `created` field is in the past
    changes.forEach(c => (c.created = Math.min(c.created, Date.now())));

    // 2. Check if we need to create a new version - if the last change was created more than a session ago
    const lastChange = currentChanges[currentChanges.length - 1];
    if (lastChange && lastChange.created < Date.now() - this.sessionTimeoutMillis) {
      await this._createVersion(docId, currentState, currentChanges);
    }

    // 3. Load committed changes to check idempotency (and later for transformation
    const committedChanges = await this.store.listChanges(docId, {
      // Load the base change too to get at least 1 change to check if we need to create a new version
      startAfter: baseRev,
    });

    const commitedIds = new Set(committedChanges.map(c => c.id));
    changes = changes.filter(c => !commitedIds.has(c.id));

    // If all changes were committed, return an empty array
    if (changes.length === 0) {
      return [];
    }

    // If the first change was longer than a session ago, it's an offline session
    const isOffline = changes[0].created < Date.now() - this.sessionTimeoutMillis;

    // 4. Handle offline session versioning, creating a new version for each session
    if (isOffline) {
      // Group all offline changes into sessions as there may be multiple
      let currentSessionState = (await this._getStateAtRevision(docId, baseRev)).state; // State to apply original ops onto
      let parentId: string | undefined; // Track parent for linking offline versions (first version has no parent)

      let sessionStartIndex = 0;
      const groupId = createId(); // Single groupId for all offline versions from this batch

      for (let i = 1; i <= changes.length; i++) {
        const isLastChange = i === changes.length;
        const timeDiff = isLastChange ? Infinity : changes[i].created - changes[i - 1].created;

        // Session ends if timeout exceeded OR it's the last change in the batch
        if (timeDiff > this.sessionTimeoutMillis || isLastChange) {
          const sessionChanges = changes.slice(sessionStartIndex, i);
          if (sessionChanges.length > 0) {
            currentSessionState = applyChanges(currentSessionState, sessionChanges); // Apply *original* ops
            const versionId = createId();
            const sessionMetadata: VersionMetadata = {
              id: versionId,
              parentId,
              groupId,
              origin: 'offline',
              startDate: sessionChanges[0].created,
              endDate: sessionChanges[sessionChanges.length - 1].created,
              rev: sessionChanges[sessionChanges.length - 1].rev,
              baseRev: baseRev, // Server rev the *batch* was based on
            };
            await this.store.createVersion(docId, sessionMetadata, currentSessionState, sessionChanges);

            parentId = versionId; // Update parent for the next potential session
            sessionStartIndex = i; // Move index for next slice
          }
        }
      }

      // Once versions are saved, offline changes are collapsed into one change
      changes = [
        changes.reduce((firstChange, nextChange) => {
          firstChange.ops = [...firstChange.ops, ...nextChange.ops];
          return firstChange;
        }),
      ];
    }

    // 5. Transform the *entire batch* of incoming changes against committed changes
    const committedOps = committedChanges.flatMap(c => c.ops);

    const transformedChanges = changes
      .map(change => {
        change.ops = transformPatch(currentState, change.ops, committedOps);
        if (change.ops.length === 0) {
          return null;
        }
        try {
          currentState = applyPatch(currentState, change.ops, { strict: true });
        } catch (error) {
          console.error(`Error applying change ${change.id} to state:`, error);
          return null;
        }
        return change;
      })
      .filter(Boolean) as Change[];

    return [...committedChanges, ...transformedChanges];
  }

  /**
   * Deletes a document.
   * @param docId The document ID.
   */
  deleteDoc(docId: string): Promise<void> {
    return this.store.deleteDoc(docId);
  }

  // === Version Operations ===

  /**
   * Create a new named version snapshot of a document's current state.
   * @param docId The document ID.
   * @param name The name of the version.
   * @returns The ID of the created version.
   */
  async createVersion(docId: string, name: string): Promise<string> {
    let { state, changes } = await this._getSnapshotAtRevision(docId);
    state = applyChanges(state, changes);
    const version = await this._createVersion(docId, state, changes, name);
    if (!version) {
      throw new Error(`No changes to create a version for doc ${docId}.`);
    }
    return version.id;
  }

  /**
   * Lists version metadata for a document, supporting various filters.
   * @param docId The document ID.
   * @param options Filtering and sorting options.
   * @returns A list of version metadata objects.
   */
  listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]> {
    if (!options.orderBy) {
      options.orderBy = 'startDate';
    }
    return this.store.listVersions(docId, options);
  }

  /**
   * Get the state snapshot for a specific version ID.
   * @param docId The document ID.
   * @param versionId The ID of the version.
   * @returns The state snapshot for the specified version.
   */
  getVersionState(docId: string, versionId: string): Promise<PatchState> {
    return this.store.loadVersionState(docId, versionId);
  }

  /**
   * Get the original Change objects associated with a specific version ID.
   * @param docId The document ID.
   * @param versionId The ID of the version.
   * @returns The original Change objects for the specified version.
   */
  getVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    return this.store.loadVersionChanges(docId, versionId);
  }

  /**
   * Update the name of a specific version.
   * @param docId The document ID.
   * @param versionId The ID of the version.
   * @param name The new name for the version.
   */
  updateVersion(docId: string, versionId: string, name: string): Promise<void> {
    return this.store.updateVersion(docId, versionId, { name });
  }

  /**
   * Retrieves the document state of the version before the given revision and changes after up to that revision or all
   * changes since that version.
   * @param docId The document ID.
   * @param rev The revision number.
   * @returns The document state and changes at the specified revision.
   */
  async _getSnapshotAtRevision(docId: string, rev?: number): Promise<PatchSnapshot> {
    const versions = await this.store.listVersions(docId, {
      limit: 1,
      reverse: true,
      startAfter: rev ? rev + 1 : undefined,
      origin: 'main',
      orderBy: 'rev',
    });
    const version = versions[0];
    const state = (version && (await this.store.loadVersionState(docId, version.id))) || null;
    const versionRev = version?.rev || 0;
    const changes = await this.store.listChanges(docId, {
      startAfter: versionRev,
      endBefore: rev ? rev + 1 : undefined,
    });
    return {
      state,
      rev: versionRev,
      changes,
    };
  }

  async _getStateAtRevision(docId: string, rev?: number): Promise<PatchState> {
    const { state, rev: currentRev, changes } = await this._getSnapshotAtRevision(docId, rev);
    return {
      state: applyChanges(state, changes),
      rev: changes.at(-1)?.rev ?? currentRev,
    };
  }

  async _createVersion(docId: string, state: any, changes: Change[], name?: string) {
    if (changes.length === 0) return;
    const baseRev = changes[0].baseRev;
    if (!baseRev) {
      throw new Error(`Client changes must include baseRev for doc ${docId}.`);
    }
    const versionId = createId();
    const sessionMetadata: VersionMetadata = {
      id: versionId,
      name,
      origin: 'main',
      startDate: changes[0].created,
      endDate: changes[changes.length - 1].created,
      rev: changes[changes.length - 1].rev,
      baseRev,
    };
    await this.store.createVersion(docId, sessionMetadata, state, changes);
    return sessionMetadata;
  }
}
