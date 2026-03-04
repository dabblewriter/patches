import { getStateBeforeVersionAsStream } from '../algorithms/ot/server/buildVersionState.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import type { Change, EditableVersionMetadata, ListVersionsOptions, VersionMetadata } from '../types.js';
import { jsonReadable } from './jsonReadable.js';
import type { PatchesServer } from './PatchesServer.js';
import type { OTStoreBackend, VersioningStoreBackend } from './types.js';
import { assertVersionMetadata } from './utils.js';

/**
 * Helps retrieve historical information (versions, changes) for a document
 * using the versioning model based on IDs and metadata.
 *
 * Works with any PatchesServer that implements captureCurrentVersion
 * (both OTServer and LWWServer with VersioningStoreBackend).
 */
export class PatchesHistoryManager {
  static api: ApiDefinition = {
    listVersions: 'read',
    createVersion: 'write',
    updateVersion: 'write',
    getVersionState: 'read',
    getVersionChanges: 'read',
    getStateBeforeVersion: 'read',
  } as const;

  protected readonly store: VersioningStoreBackend;

  constructor(
    protected readonly patches: PatchesServer,
    store: VersioningStoreBackend
  ) {
    this.store = store;
  }

  /**
   * Lists version metadata for the document, supporting various filters.
   * @param docId - The ID of the document.
   * @param options Filtering and sorting options (e.g., limit, reverse, origin, groupId, date range).
   * @returns A list of version metadata objects.
   */
  async listVersions(docId: string, options: ListVersionsOptions = {}): Promise<VersionMetadata[]> {
    if (!options.orderBy) {
      options.orderBy = 'startedAt';
    }
    return await this.store.listVersions(docId, options);
  }

  /**
   * Create a new named version snapshot of a document's current state.
   * @param docId The document ID.
   * @param name The name of the version.
   * @returns The ID of the created version, or null if no changes to capture.
   */
  async createVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string | null> {
    assertVersionMetadata(metadata);
    return await this.patches.captureCurrentVersion(docId, metadata);
  }

  /**
   * Updates the name of a specific version.
   * @param docId - The ID of the document.
   * @param versionId - The ID of the version to update.
   * @param name - The new name for the version.
   */
  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata) {
    assertVersionMetadata(metadata);
    return this.store.updateVersion(docId, versionId, metadata);
  }

  /**
   * Loads the full document state snapshot for a specific version by its ID.
   * Returns a ReadableStream so the state can be streamed to clients via RPC.
   * @param docId - The ID of the document.
   * @param versionId - The unique ID of the version.
   * @returns A ReadableStream of the JSON state, or a stream of 'null' if not found.
   * @throws Error if state loading fails.
   */
  async getVersionState(docId: string, versionId: string): Promise<ReadableStream<string>> {
    try {
      const rawState = await this.store.loadVersionState(docId, versionId);
      if (rawState === undefined) {
        return jsonReadable('null');
      }
      // rawState is already string or ReadableStream<string> — wrap string if needed
      return typeof rawState === 'string' ? jsonReadable(rawState) : rawState;
    } catch (error) {
      console.error(`Failed to load state for version ${versionId} of doc ${docId}.`, error);
      throw new Error(`Could not load state for version ${versionId}.`, { cause: error });
    }
  }

  /**
   * Returns the document state immediately before a version's changes begin.
   *
   * Uses the version's `parentId` chain to find the correct baseline — so
   * offline-branch session 2 returns the state after session 1, not after the
   * last main-timeline version. Bridges any gap between the parent's `endRev`
   * and the version's `startRev` by applying intermediate changes.
   *
   * Use this as the baseline when scrubbing through a version's individual changes.
   *
   * Only available for OT stores.
   *
   * @param docId - The document ID.
   * @param versionId - The version whose pre-state to compute.
   * @returns A ReadableStream of the JSON state at `version.startRev - 1`.
   */
  async getStateBeforeVersion(docId: string, versionId: string): Promise<ReadableStream<string>> {
    if (!('listChanges' in this.store)) {
      throw new Error('getStateBeforeVersion is only supported for OT stores.');
    }
    const otStore = this.store as OTStoreBackend;
    const version = await otStore.loadVersion(docId, versionId);
    if (!version) {
      throw new Error(`Version ${versionId} not found for doc ${docId}.`);
    }
    return getStateBeforeVersionAsStream(otStore, docId, version);
  }

  /**
   * Loads the list of original client changes that were included in a specific version.
   * Useful for replaying/scrubbing through the operations within an offline or online session.
   * @param docId - The ID of the document.
   * @param versionId - The unique ID of the version.
   * @returns An array of Change objects.
   * @throws Error if the version ID is not found or change loading fails.
   */
  async getVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    try {
      return (await this.store.loadVersionChanges?.(docId, versionId)) ?? [];
    } catch (error) {
      console.error(`Failed to load changes for version ${versionId} of doc ${docId}.`, error);
      throw new Error(`Could not load changes for version ${versionId}.`, { cause: error });
    }
  }
}
