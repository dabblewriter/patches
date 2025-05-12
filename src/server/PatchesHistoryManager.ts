import type { Change, ListVersionsOptions, VersionMetadata } from '../types.js';
import type { PatchesStoreBackend } from './types.js';

/**
 * Helps retrieve historical information (versions, changes) for a document
 * using the new versioning model based on IDs and metadata.
 */
export class PatchesHistoryManager {
  constructor(private readonly store: PatchesStoreBackend) {}

  /**
   * Lists version metadata for the document, supporting various filters.
   * @param docId - The ID of the document.
   * @param options Filtering and sorting options (e.g., limit, reverse, origin, groupId, date range).
   * @returns A list of version metadata objects.
   */
  async listVersions(docId: string, options: ListVersionsOptions = {}): Promise<VersionMetadata[]> {
    return await this.store.listVersions(docId, options);
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
  async listServerChanges(
    docId: string,
    options: {
      limit?: number;
      startAfterRev?: number;
      endBeforeRev?: number;
      reverse?: boolean;
    } = {}
  ): Promise<Change[]> {
    // Added return type
    return await this.store.listChanges(docId, options);
  }
}
