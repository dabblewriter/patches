import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import type {
  Change,
  EditableVersionMetadata,
  ListChangesOptions,
  ListVersionsOptions,
  VersionMetadata,
} from '../types.js';
import type { PatchesServer } from './PatchesServer.js';
import { assertVersionMetadata } from './utils.js';
import type { PatchesStoreBackend } from './types.js';

/**
 * Helps retrieve historical information (versions, changes) for a document
 * using the new versioning model based on IDs and metadata.
 */
export class PatchesHistoryManager {
  static api: ApiDefinition = {
    listVersions: 'read',
    createVersion: 'write',
    updateVersion: 'write',
    getVersionState: 'read',
    getVersionChanges: 'read',
    listServerChanges: 'read',
  } as const;

  private readonly store: PatchesStoreBackend;

  constructor(private readonly patches: PatchesServer) {
    this.store = patches.store;
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
   * @param docId - The ID of the document.
   * @param versionId - The unique ID of the version.
   * @returns The document state at that version.
   * @throws Error if the version ID is not found or state loading fails.
   */
  async getStateAtVersion(docId: string, versionId: string): Promise<any> {
    try {
      return await this.store.loadVersionState(docId, versionId);
    } catch (error) {
      console.error(`Failed to load state for version ${versionId} of doc ${docId}.`, error);
      throw new Error(`Could not load state for version ${versionId}.`);
    }
  }

  /**
   * Loads the list of original client changes that were included in a specific version.
   * Useful for replaying/scrubbing through the operations within an offline or online session.
   * @param docId - The ID of the document.
   * @param versionId - The unique ID of the version.
   * @returns An array of Change objects.
   * @throws Error if the version ID is not found or change loading fails.
   */
  async getChangesForVersion(docId: string, versionId: string): Promise<Change[]> {
    try {
      return await this.store.loadVersionChanges(docId, versionId);
    } catch (error) {
      console.error(`Failed to load changes for version ${versionId} of doc ${docId}.`, error);
      throw new Error(`Could not load changes for version ${versionId}.`);
    }
  }

  /**
   * Lists committed server changes for the document, typically used for server-side processing
   * or deep history analysis based on raw revisions.
   * @param docId - The ID of the document.
   * @param options - Options like start/end revision, limit.
   * @returns The list of committed Change objects.
   */
  async listServerChanges(docId: string, options: ListChangesOptions = {}): Promise<Change[]> {
    return await this.store.listChanges(docId, options);
  }

  // ---------------------------------------------------------------------------
  // Alias methods for RPC API compatibility
  // ---------------------------------------------------------------------------

  /**
   * Alias for getStateAtVersion for RPC API compatibility.
   */
  async getVersionState(docId: string, versionId: string): Promise<any> {
    return this.getStateAtVersion(docId, versionId);
  }

  /**
   * Alias for getChangesForVersion for RPC API compatibility.
   */
  async getVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    return this.getChangesForVersion(docId, versionId);
  }
}
