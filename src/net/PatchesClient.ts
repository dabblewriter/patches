import { signal } from '../event-signal.js';
import type {
  Change,
  ChangeInput,
  EditableVersionMetadata,
  ListVersionsOptions,
  PatchesSnapshot,
  PatchesState,
  VersionMetadata,
} from '../types.js';
import { JSONRPCClient } from './protocol/JSONRPCClient.js';
import type { ClientTransport, PatchesAPI, PatchesNotificationParams } from './protocol/types.js';

/**
 * High-level client for the Patches real-time collaboration service.
 * This class provides document subscription, patch notification handling,
 * versioning, and other OT-specific functionality
 * over a WebSocket connection.
 */
export class PatchesClient implements PatchesAPI {
  rpc: JSONRPCClient;
  transport: ClientTransport;

  // --- Public Signals ---

  /** Signal emitted when the server pushes document changes. */
  public readonly onChangesCommitted = signal<(docId: string, changes: Change[]) => void>();

  /**
   * Creates a new Patches WebSocket client instance.
   * @param url - The WebSocket server URL to connect to
   * @param wsOptions - Optional configuration for the underlying WebSocket connection
   */
  constructor(transport: ClientTransport) {
    this.transport = transport;
    this.rpc = new JSONRPCClient(transport);

    // Register handlers for server-sent notifications
    // Note: Type assertions might be needed if rpc.on doesn't infer strongly enough
    this.rpc.on('changesCommitted', (params: PatchesNotificationParams) => {
      const { docId, changes } = params;
      this.onChangesCommitted.emit(docId, changes);
    });
  }

  // --- Patches API Methods ---

  // === Subscription Operations ===
  /**
   * Subscribes the client to one or more documents to receive real-time updates.
   * @param ids - Document ID or IDs to subscribe to.
   * @returns A promise resolving with the list of successfully subscribed document IDs.
   */
  async subscribe(ids: string | string[]): Promise<string[]> {
    return this.rpc.call('subscribe', { ids });
  }

  /**
   * Unsubscribes the client from one or more documents.
   * @param ids - Document ID or IDs to unsubscribe from.
   * @returns A promise resolving when the unsubscription is confirmed.
   */
  async unsubscribe(ids: string | string[]): Promise<void> {
    return this.rpc.call('unsubscribe', { ids });
  }

  // === Document Operations ===
  /**
   * Gets the latest state (content and revision) of a document.
   * @param docId - The ID of the document.
   * @returns A promise resolving with the document snapshot.
   */
  async getDoc(docId: string, atRev?: number): Promise<PatchesState> {
    return this.rpc.call('getDoc', { docId, atRev });
  }

  /**
   * Gets changes that occurred for a document after a specific revision number.
   * @param docId - The ID of the document.
   * @param rev - The revision number after which to fetch changes.
   * @returns A promise resolving with an array of changes.
   */
  async getChangesSince(docId: string, rev: number): Promise<Change[]> {
    return this.rpc.call('getChangesSince', { docId, rev });
  }

  /**
   * Applies a set of client-generated changes to a document on the server.
   * @param docId - The ID of the document.
   * @param changes - An array of changes to apply.
   * @returns A promise resolving with the changes as committed by the server (potentially transformed).
   */
  async commitChanges(docId: string, changes: ChangeInput[]): Promise<Change[]> {
    return this.rpc.call('commitChanges', { docId, changes });
  }

  /**
   * Deletes a document on the server.
   * @param docId - The ID of the document to delete.
   * @returns A promise resolving when the deletion is confirmed.
   */
  async deleteDoc(docId: string): Promise<void> {
    return this.rpc.call('deleteDoc', { docId });
  }

  // === Version Operations ===
  /**
   * Creates a named version snapshot of a document's current state on the server.
   * @param docId - The ID of the document.
   * @param name - A descriptive name for the version.
   * @returns A promise resolving with the unique ID of the newly created version.
   */
  async createVersion(docId: string, metadata: EditableVersionMetadata): Promise<string> {
    return this.rpc.call('createVersion', { docId, metadata });
  }

  /**
   * Lists metadata for saved versions of a document.
   * @param docId - The ID of the document.
   * @param options - Options for filtering or pagination (e.g., limit, offset).
   * @returns A promise resolving with an array of version metadata objects.
   */
  async listVersions(docId: string, options?: ListVersionsOptions): Promise<VersionMetadata[]> {
    return this.rpc.call('listVersions', { docId, options });
  }

  /**
   * Gets the document state snapshot corresponding to a specific version ID.
   * @param docId - The ID of the document.
   * @param versionId - The ID of the version to retrieve.
   * @returns A promise resolving with the document snapshot for that version.
   */
  async getVersionState(docId: string, versionId: string): Promise<PatchesSnapshot> {
    return this.rpc.call('getVersionState', { docId, versionId });
  }

  /**
   * Gets the original changes associated with a specific version ID.
   * @param docId - The ID of the document.
   * @param versionId - The ID of the version.
   * @returns A promise resolving with an array of changes that constitute that version.
   */
  async getVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    return this.rpc.call('getVersionChanges', { docId, versionId });
  }

  /**
   * Updates the name of a specific version.
   * @param docId - The ID of the document.
   * @param versionId - The ID of the version to update.
   * @param name - The new name for the version.
   * @returns A promise resolving when the update is confirmed.
   */
  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    return this.rpc.call('updateVersion', { docId, versionId, metadata });
  }

  // === Branch Operations ===

  /**
   * Lists all branches for a document.
   * @param docId - The ID of the document.
   * @returns A promise resolving with an array of branch metadata objects.
   */
  async listBranches(docId: string): Promise<VersionMetadata[]> {
    return this.rpc.call('listBranches', { docId });
  }

  /**
   * Creates a new branch for a document.
   * @param docId - The ID of the document.
   * @param rev - The revision number to base the new branch on.
   * @param metadata - Optional metadata for the new branch.
   * @returns A promise resolving with the unique ID of the newly created branch.
   */
  async createBranch(docId: string, rev: number, metadata?: EditableVersionMetadata): Promise<string> {
    return this.rpc.call('createBranch', { docId, rev, metadata });
  }

  /**
   * Closes a branch on the server.
   * @param branchId - The ID of the branch to close.
   * @returns A promise resolving when the branch is closed.
   */
  async closeBranch(branchId: string): Promise<void> {
    return this.rpc.call('closeBranch', { branchId });
  }

  /**
   * Merges a branch on the server.
   * @param branchId - The ID of the branch to merge.
   * @returns A promise resolving when the merge is confirmed.
   */
  async mergeBranch(branchId: string): Promise<void> {
    return this.rpc.call('mergeBranch', { branchId });
  }
}
