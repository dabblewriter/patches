import type { PatchesBranchManager } from '../../server/PatchesBranchManager.js';
import type { PatchesHistoryManager } from '../../server/PatchesHistoryManager.js';
import type { PatchesServer } from '../../server/PatchesServer.js';
import type { Change, EditableVersionMetadata, ListVersionsOptions } from '../../types.js';
import { JSONRPCServer } from '../protocol/JSONRPCServer.js';
import type { ServerTransport } from '../protocol/types.js';
import type { AuthorizationProvider } from './AuthorizationProvider.js';
import { allowAll } from './AuthorizationProvider.js';

/**
 * High-level client for the Patches real-time collaboration service.
 * This class provides document subscription, patch notification handling,
 * versioning, and other OT-specific functionality
 * over a WebSocket connection.
 */
export interface WebSocketServerOptions {
  transport: ServerTransport;
  patches: PatchesServer;
  history?: PatchesHistoryManager;
  branches?: PatchesBranchManager;
  auth?: AuthorizationProvider;
}

export class WebSocketServer {
  protected transport: ServerTransport;
  protected rpc: JSONRPCServer;
  protected patches: PatchesServer;
  protected history?: PatchesHistoryManager;
  protected branches?: PatchesBranchManager;
  protected auth: AuthorizationProvider;

  /**
   * Creates a new Patches WebSocket client instance.
   * @param transport - The transport layer implementation that will be used for sending/receiving messages
   * @param patches - The patches server instance to handle document operations
   * @param auth - (Optional) Authorization provider implementation. Defaults to a permissive provider.
   */
  constructor({ transport, patches, history, branches, auth = allowAll }: WebSocketServerOptions) {
    this.transport = transport;
    this.rpc = new JSONRPCServer(this.transport);
    this.patches = patches;
    this.history = history;
    this.branches = branches;
    this.auth = auth;

    // Subscription operations
    this.rpc.registerMethod('subscribe', this.subscribe.bind(this));
    this.rpc.registerMethod('unsubscribe', this.unsubscribe.bind(this));

    // Document operations
    this.rpc.registerMethod('getDoc', this.getDoc.bind(this));
    this.rpc.registerMethod('getChangesSince', this.getChangesSince.bind(this));
    this.rpc.registerMethod('commitChanges', this.commitChanges.bind(this));
    this.rpc.registerMethod('deleteDoc', this.deleteDoc.bind(this));

    // History manager operations (if provided)
    if (this.history) {
      this.rpc.registerMethod('listVersions', this.listVersions.bind(this));
      this.rpc.registerMethod('createVersion', this.createVersion.bind(this));
      this.rpc.registerMethod('updateVersion', this.updateVersion.bind(this));
      this.rpc.registerMethod('getVersionState', this.getStateAtVersion.bind(this));
      this.rpc.registerMethod('getVersionChanges', this.getChangesForVersion.bind(this));
      this.rpc.registerMethod('listServerChanges', this.listServerChanges.bind(this));
    }

    // Branch manager operations (if provided)
    if (this.branches) {
      this.rpc.registerMethod('listBranches', this.listBranches.bind(this));
      this.rpc.registerMethod('createBranch', this.createBranch.bind(this));
      this.rpc.registerMethod('closeBranch', this.closeBranch.bind(this));
      this.rpc.registerMethod('mergeBranch', this.mergeBranch.bind(this));
    }
  }

  // ---------------------------------------------------------------------------
  // Authorization helpers
  // ---------------------------------------------------------------------------

  protected async assertAccess(
    connectionId: string,
    docId: string,
    kind: 'read' | 'write',
    method: string,
    params?: Record<string, any>
  ): Promise<void> {
    const ok = await this.auth.canAccess(connectionId, docId, kind, method, params);
    if (!ok) {
      throw new Error(`${kind.toUpperCase()}_FORBIDDEN:${docId}`);
    }
  }

  protected assertRead(
    connectionId: string,
    docId: string,
    method: string,
    params?: Record<string, any>
  ): Promise<void> {
    return this.assertAccess(connectionId, docId, 'read', method, params);
  }

  protected assertWrite(
    connectionId: string,
    docId: string,
    method: string,
    params?: Record<string, any>
  ): Promise<void> {
    return this.assertAccess(connectionId, docId, 'write', method, params);
  }

  protected assertHistoryEnabled() {
    if (!this.history) {
      throw new Error('History is not enabled');
    }
  }

  protected assertBranchingEnabled() {
    if (!this.branches) {
      throw new Error('Branching is not enabled');
    }
  }

  // --- Patches API Methods ---

  // === Subscription Operations ===
  /**
   * Subscribes the client to one or more documents to receive real-time updates.
   * @param connectionId - The ID of the connection making the request
   * @param params - The subscription parameters
   * @param params.ids - Document ID or IDs to subscribe to
   */
  async subscribe(connectionId: string, params: { ids: string | string[] }) {
    const { ids } = params;
    const allIds = Array.isArray(ids) ? ids : [ids];
    const allowed: string[] = [];

    await Promise.all(
      allIds.map(async id => {
        try {
          if (await this.auth.canAccess(connectionId, id, 'read', 'subscribe', params)) {
            allowed.push(id);
          }
        } catch {
          // Treat exceptions from the provider as a denial for this doc
        }
      })
    );

    if (allowed.length === 0) {
      return [];
    }

    // retain original input shape for call but we only pass allowed
    const input = Array.isArray(ids) ? allowed : allowed[0];
    return this.patches.subscribe(connectionId, input);
  }

  /**
   * Unsubscribes the client from one or more documents.
   * @param connectionId - The ID of the connection making the request
   * @param params - The unsubscription parameters
   * @param params.ids - Document ID or IDs to unsubscribe from
   */
  async unsubscribe(connectionId: string, params: { ids: string | string[] }) {
    const { ids } = params;
    // We deliberately do **not** enforce authorization here –
    // removing a subscription doesn't leak information and helps
    // clean up server-side state if a client has lost access mid-session.
    return this.patches.unsubscribe(connectionId, ids);
  }

  // === Document Operations ===
  /**
   * Gets the latest state (content and revision) of a document.
   * @param _connectionId - The ID of the connection making the request
   * @param params - The document parameters
   * @param params.docId - The ID of the document
   * @param params.atRev - Optional revision number to get document state at
   */
  async getDoc(_connectionId: string, params: { docId: string; atRev?: number }) {
    const { docId, atRev } = params;
    await this.assertRead(_connectionId, docId, 'getDoc', params);
    return this.patches.getDoc(docId, atRev);
  }

  /**
   * Gets changes that occurred for a document after a specific revision number.
   * @param _connectionId - The ID of the connection making the request
   * @param params - The change request parameters
   * @param params.docId - The ID of the document
   * @param params.rev - The revision number after which to fetch changes
   */
  async getChangesSince(_connectionId: string, params: { docId: string; rev: number }) {
    const { docId, rev } = params;
    await this.assertRead(_connectionId, docId, 'getChangesSince', params);
    return this.patches.getChangesSince(docId, rev);
  }

  /**
   * Applies a set of client-generated changes to a document on the server.
   * @param connectionId - The ID of the connection making the request
   * @param params - The change parameters
   * @param params.docId - The ID of the document
   * @param params.changes - An array of changes to apply
   */
  async commitChanges(connectionId: string, params: { docId: string; changes: Change[] }) {
    const { docId, changes } = params;
    await this.assertWrite(connectionId, docId, 'commitChanges', params);
    const [priorChanges, newChanges] = await this.patches.commitChanges(docId, changes);

    // Notify other clients that the new changes have been committed
    const connectionIds = this.transport.getConnectionIds().filter(id => id !== connectionId);
    if (connectionIds.length > 0) {
      this.rpc.notify(connectionIds, 'changesCommitted', { docId, changes: newChanges });
    }

    return [...priorChanges, ...newChanges];
  }

  /**
   * Deletes a document on the server.
   * @param connectionId - The ID of the connection making the request
   * @param params - The deletion parameters
   * @param params.docId - The ID of the document to delete
   */
  async deleteDoc(connectionId: string, params: { docId: string }) {
    const { docId } = params;
    await this.assertWrite(connectionId, docId, 'deleteDoc', params);
    await this.patches.deleteDoc(docId);

    // Notify other clients that the document has been deleted
    const connectionIds = this.transport.getConnectionIds().filter(id => id !== connectionId);
    if (connectionIds.length > 0) {
      this.rpc.notify(connectionIds, 'docDeleted', { docId });
    }
  }

  // ---------------------------------------------------------------------------
  // History Manager wrappers
  // ---------------------------------------------------------------------------

  async listVersions(connectionId: string, params: { docId: string; options?: ListVersionsOptions }) {
    this.assertHistoryEnabled();
    const { docId, options } = params;
    await this.assertRead(connectionId, docId, 'listVersions', params);
    return this.history!.listVersions(docId, options ?? {});
  }

  async createVersion(connectionId: string, params: { docId: string; metadata: EditableVersionMetadata }) {
    this.assertHistoryEnabled();
    const { docId, metadata } = params;
    await this.assertWrite(connectionId, docId, 'createVersion', params);
    return this.history!.createVersion(docId, metadata);
  }

  async updateVersion(
    connectionId: string,
    params: { docId: string; versionId: string; metadata: EditableVersionMetadata }
  ) {
    this.assertHistoryEnabled();
    const { docId, versionId, metadata } = params;
    await this.assertWrite(connectionId, docId, 'updateVersion', params);
    return this.history!.updateVersion(docId, versionId, metadata);
  }

  async getStateAtVersion(connectionId: string, params: { docId: string; versionId: string }) {
    this.assertHistoryEnabled();
    const { docId, versionId } = params;
    await this.assertRead(connectionId, docId, 'getStateAtVersion', params);
    return this.history!.getStateAtVersion(docId, versionId);
  }

  async getChangesForVersion(connectionId: string, params: { docId: string; versionId: string }) {
    this.assertHistoryEnabled();
    const { docId, versionId } = params;
    await this.assertRead(connectionId, docId, 'getChangesForVersion', params);
    return this.history!.getChangesForVersion(docId, versionId);
  }

  async listServerChanges(
    connectionId: string,
    params: {
      docId: string;
      options?: { limit?: number; startAfterRev?: number; endBeforeRev?: number; reverse?: boolean };
    }
  ) {
    this.assertHistoryEnabled();
    const { docId, options } = params;
    await this.assertRead(connectionId, docId, 'listServerChanges', params);
    return this.history!.listServerChanges(docId, options ?? {});
  }

  // ---------------------------------------------------------------------------
  // Branch Manager wrappers
  // ---------------------------------------------------------------------------

  async listBranches(connectionId: string, params: { docId: string }) {
    this.assertBranchingEnabled();
    const { docId } = params;
    await this.assertRead(connectionId, docId, 'listBranches', params);
    return this.branches!.listBranches(docId);
  }

  async createBranch(connectionId: string, params: { docId: string; rev: number; metadata?: EditableVersionMetadata }) {
    this.assertBranchingEnabled();
    const { docId, rev, metadata } = params;
    await this.assertWrite(connectionId, docId, 'createBranch', params);
    return this.branches!.createBranch(docId, rev, metadata);
  }

  async closeBranch(connectionId: string, params: { branchId: string }) {
    this.assertBranchingEnabled();
    const { branchId } = params;
    await this.assertWrite(connectionId, branchId, 'closeBranch', params);
    return this.branches!.closeBranch(branchId, 'closed');
  }

  async mergeBranch(connectionId: string, params: { branchId: string }) {
    this.assertBranchingEnabled();
    const { branchId } = params;
    await this.assertWrite(connectionId, branchId, 'mergeBranch', params);
    return this.branches!.mergeBranch(branchId);
  }
}
