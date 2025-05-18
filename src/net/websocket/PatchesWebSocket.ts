import { signal, type Signal } from '../../event-signal.js';
import type {
  Change,
  EditableVersionMetadata,
  ListVersionsOptions,
  PatchesSnapshot,
  PatchesState,
  VersionMetadata,
} from '../../types.js';
import { JSONRPCClient } from '../protocol/JSONRPCClient.js';
import type { ConnectionState, PatchesAPI, PatchesNotificationParams } from '../protocol/types.js';
import { WebSocketTransport, type WebSocketOptions } from './WebSocketTransport.js';

/**
 * High-level client for the Patches real-time collaboration service.
 * This class provides document subscription, patch notification handling,
 * versioning, and other OT-specific functionality
 * over a WebSocket connection.
 */
export class PatchesWebSocket implements PatchesAPI {
  private rpc: JSONRPCClient;
  private transport: WebSocketTransport;

  // --- Public Signals ---

  /** Signal emitted when the underlying WebSocket connection state changes. */
  public readonly onStateChange: Signal<(state: ConnectionState) => void>;

  /** Signal emitted when the server pushes document changes. */
  public readonly onChangesCommitted = signal<(params: PatchesNotificationParams) => void>();

  /**
   * Creates a new Patches WebSocket client instance.
   * @param url - The WebSocket server URL to connect to
   * @param wsOptions - Optional configuration for the underlying WebSocket connection
   */
  constructor(url: string, wsOptions?: WebSocketOptions) {
    this.transport = new WebSocketTransport(url, wsOptions);
    this.rpc = new JSONRPCClient(this.transport);
    this.onStateChange = this.transport.onStateChange;

    // Register handlers for server-sent notifications
    // Note: Type assertions might be needed if rpc.on doesn't infer strongly enough
    this.rpc.on('changesCommitted', (params /*: PatchesNotificationParams */) => {
      this.onChangesCommitted.emit(params as PatchesNotificationParams);
    });
  }

  // --- Connection Management ---

  /**
   * Establishes a connection to the Patches server.
   * @returns A promise that resolves when the connection is established
   */
  async connect(): Promise<void> {
    await this.transport.connect();
  }

  /**
   * Terminates the connection to the Patches server.
   */
  disconnect(): void {
    // Unsubscribe rpc listeners? JSONRPCClient should handle this if transport disconnects.
    this.transport.disconnect();
    // Consider clearing signal listeners here if needed, though they are instance-based.
  }

  // --- Patches API Methods ---

  // === Subscription Operations ===
  /**
   * Subscribes the client to one or more documents to receive real-time updates.
   * @param ids - Document ID or IDs to subscribe to.
   * @returns A promise resolving with the list of successfully subscribed document IDs.
   */
  async subscribe(ids: string | string[]): Promise<string[]> {
    return this.rpc.request('subscribe', { ids });
  }

  /**
   * Unsubscribes the client from one or more documents.
   * @param ids - Document ID or IDs to unsubscribe from.
   * @returns A promise resolving when the unsubscription is confirmed.
   */
  async unsubscribe(ids: string | string[]): Promise<void> {
    return this.rpc.request('unsubscribe', { ids });
  }

  // === Document Operations ===
  /**
   * Gets the latest state (content and revision) of a document.
   * @param docId - The ID of the document.
   * @returns A promise resolving with the document snapshot.
   */
  async getDoc(docId: string, atRev?: number): Promise<PatchesState> {
    return this.rpc.request('getDoc', { docId, atRev });
  }

  /**
   * Gets changes that occurred for a document after a specific revision number.
   * @param docId - The ID of the document.
   * @param rev - The revision number after which to fetch changes.
   * @returns A promise resolving with an array of changes.
   */
  async getChangesSince(docId: string, rev: number): Promise<Change[]> {
    return this.rpc.request('getChangesSince', { docId, rev });
  }

  /**
   * Applies a set of client-generated changes to a document on the server.
   * @param docId - The ID of the document.
   * @param changes - An array of changes to apply.
   * @returns A promise resolving with the changes as committed by the server (potentially transformed).
   */
  async commitChanges(docId: string, changes: Change[]): Promise<Change[]> {
    return this.rpc.request('commitChanges', { docId, changes });
  }

  /**
   * Deletes a document on the server.
   * @param docId - The ID of the document to delete.
   * @returns A promise resolving when the deletion is confirmed.
   */
  async deleteDoc(docId: string): Promise<void> {
    return this.rpc.request('deleteDoc', { docId });
  }

  // === Version Operations ===
  /**
   * Creates a named version snapshot of a document's current state on the server.
   * @param docId - The ID of the document.
   * @param name - A descriptive name for the version.
   * @returns A promise resolving with the unique ID of the newly created version.
   */
  async createVersion(docId: string, metadata: EditableVersionMetadata): Promise<string> {
    return this.rpc.request('createVersion', { docId, metadata });
  }

  /**
   * Lists metadata for saved versions of a document.
   * @param docId - The ID of the document.
   * @param options - Options for filtering or pagination (e.g., limit, offset).
   * @returns A promise resolving with an array of version metadata objects.
   */
  async listVersions(docId: string, options?: ListVersionsOptions): Promise<VersionMetadata[]> {
    return this.rpc.request('listVersions', { docId, options });
  }

  /**
   * Gets the document state snapshot corresponding to a specific version ID.
   * @param docId - The ID of the document.
   * @param versionId - The ID of the version to retrieve.
   * @returns A promise resolving with the document snapshot for that version.
   */
  async getVersionState(docId: string, versionId: string): Promise<PatchesSnapshot> {
    return this.rpc.request('getVersionState', { docId, versionId });
  }

  /**
   * Gets the original changes associated with a specific version ID.
   * @param docId - The ID of the document.
   * @param versionId - The ID of the version.
   * @returns A promise resolving with an array of changes that constitute that version.
   */
  async getVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    return this.rpc.request('getVersionChanges', { docId, versionId });
  }

  /**
   * Updates the name of a specific version.
   * @param docId - The ID of the document.
   * @param versionId - The ID of the version to update.
   * @param name - The new name for the version.
   * @returns A promise resolving when the update is confirmed.
   */
  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    return this.rpc.request('updateVersion', { docId, versionId, metadata });
  }

  // === Branch Operations ===

  /**
   * Lists all branches for a document.
   * @param docId - The ID of the document.
   * @returns A promise resolving with an array of branch metadata objects.
   */
  async listBranches(docId: string): Promise<VersionMetadata[]> {
    return this.rpc.request('listBranches', { docId });
  }

  /**
   * Creates a new branch for a document.
   * @param docId - The ID of the document.
   * @param rev - The revision number to base the new branch on.
   * @param metadata - Optional metadata for the new branch.
   * @returns A promise resolving with the unique ID of the newly created branch.
   */
  async createBranch(docId: string, rev: number, metadata?: EditableVersionMetadata): Promise<string> {
    return this.rpc.request('createBranch', { docId, rev, metadata });
  }

  /**
   * Closes a branch on the server.
   * @param branchId - The ID of the branch to close.
   * @returns A promise resolving when the branch is closed.
   */
  async closeBranch(branchId: string): Promise<void> {
    return this.rpc.request('closeBranch', { branchId });
  }

  /**
   * Merges a branch on the server.
   * @param branchId - The ID of the branch to merge.
   * @returns A promise resolving when the merge is confirmed.
   */
  async mergeBranch(branchId: string): Promise<void> {
    return this.rpc.request('mergeBranch', { branchId });
  }
}
