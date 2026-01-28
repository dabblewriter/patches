import type { PatchesBranchManager } from '../../server/PatchesBranchManager.js';
import type { PatchesHistoryManager } from '../../server/PatchesHistoryManager.js';
import type { PatchesServer } from '../../server/PatchesServer.js';
import type { Change, DeleteDocOptions, EditableVersionMetadata, ListChangesOptions, ListVersionsOptions } from '../../types.js';
import { StatusError } from '../error.js';
import { JSONRPCServer } from '../protocol/JSONRPCServer.js';
import type { CommitChangesOptions } from '../protocol/types.js';
import { denyAll, type AuthContext, type AuthorizationProvider } from './AuthorizationProvider.js';

/**
 * High-level client for the Patches real-time collaboration service.
 * This class provides document subscription, patch notification handling,
 * versioning, and other OT-specific functionality over a JSON RPC interface.
 */
export interface RPCServerOptions {
  patches: PatchesServer;
  history?: PatchesHistoryManager;
  branches?: PatchesBranchManager;
  auth?: AuthorizationProvider;
}

export class RPCServer {
  rpc: JSONRPCServer;
  auth: AuthorizationProvider;
  protected patches: PatchesServer;
  protected history?: PatchesHistoryManager;
  protected branches?: PatchesBranchManager;

  /**
   * Creates a new Patches WebSocket client instance.
   * @param patches - The patches server instance to handle document operations
   * @param history - (Optional) History manager instance to handle versioning operations
   * @param branches - (Optional) Branch manager instance to handle branching operations
   * @param auth - (Optional) Authorization provider implementation. Defaults to deny-all for security.
   */
  constructor({ patches, history, branches, auth = denyAll }: RPCServerOptions) {
    this.rpc = new JSONRPCServer();
    this.patches = patches;
    this.history = history;
    this.branches = branches;
    this.auth = auth;

    // Document operations
    this.rpc.registerMethod('getDoc', this.getDoc.bind(this));
    this.rpc.registerMethod('getChangesSince', this.getChangesSince.bind(this));
    this.rpc.registerMethod('commitChanges', this.commitChanges.bind(this));
    this.rpc.registerMethod('deleteDoc', this.deleteDoc.bind(this));
    this.rpc.registerMethod('undeleteDoc', this.undeleteDoc.bind(this));

    // History manager operations (if provided)
    if (this.history) {
      this.rpc.registerMethod('listVersions', this.listVersions.bind(this));
      this.rpc.registerMethod('createVersion', this.createVersion.bind(this));
      this.rpc.registerMethod('updateVersion', this.updateVersion.bind(this));
      this.rpc.registerMethod('getVersionState', this.getVersionState.bind(this));
      this.rpc.registerMethod('getVersionChanges', this.getVersionChanges.bind(this));
      this.rpc.registerMethod('listServerChanges', this.listServerChanges.bind(this));
    }

    // Branch manager operations (if provided)
    if (this.branches) {
      this.rpc.registerMethod('listBranches', this.listBranches.bind(this));
      this.rpc.registerMethod('createBranch', this.createBranch.bind(this));
      this.rpc.registerMethod('closeBranch', this.closeBranch.bind(this));
      this.rpc.registerMethod('mergeBranch', this.mergeBranch.bind(this));
    }

    // -------------------------------------------------------------------------
    // Listen to core server events and forward as JSON-RPC notifications
    // -------------------------------------------------------------------------

    this.patches.onChangesCommitted((docId, changes, originClientId) => {
      this.rpc.notify('changesCommitted', { docId, changes }, originClientId);
    });

    this.patches.onDocDeleted((docId, options, originClientId) => {
      this.rpc.notify('docDeleted', { docId }, originClientId);
    });
  }

  /**
   * Gets the latest state (content and revision) of a document.
   * @param connectionId - The ID of the connection making the request
   * @param params - The document parameters
   * @param params.docId - The ID of the document
   * @param params.atRev - Optional revision number to get document state at
   */
  async getDoc(params: { docId: string; atRev?: number }, ctx?: AuthContext) {
    const { docId, atRev } = params;
    await this.assertRead(ctx, docId, 'getDoc', params);
    return this.patches.getDoc(docId, atRev);
  }

  /**
   * Gets changes that occurred for a document after a specific revision number.
   * @param connectionId - The ID of the connection making the request
   * @param params - The change request parameters
   * @param params.docId - The ID of the document
   * @param params.rev - The revision number after which to fetch changes
   */
  async getChangesSince(params: { docId: string; rev: number }, ctx?: AuthContext) {
    const { docId, rev } = params;
    await this.assertRead(ctx, docId, 'getChangesSince', params);
    return this.patches.getChangesSince(docId, rev);
  }

  /**
   * Applies a set of client-generated changes to a document on the server.
   * @param connectionId - The ID of the connection making the request
   * @param params - The change parameters
   * @param params.docId - The ID of the document
   * @param params.changes - An array of changes to apply
   * @param params.options - Optional commit settings (e.g., forceCommit for migrations)
   */
  async commitChanges(params: { docId: string; changes: Change[]; options?: CommitChangesOptions }, ctx?: AuthContext) {
    const { docId, changes, options } = params;
    await this.assertWrite(ctx, docId, 'commitChanges', params);
    const [priorChanges, newChanges] = await this.patches.commitChanges(docId, changes, options, ctx?.clientId);

    return [...priorChanges, ...newChanges];
  }

  /**
   * Deletes a document on the server.
   * @param connectionId - The ID of the connection making the request
   * @param params - The deletion parameters
   * @param params.docId - The ID of the document to delete
   * @param params.options - Optional deletion settings (e.g., skipTombstone)
   */
  async deleteDoc(params: { docId: string; options?: DeleteDocOptions }, ctx?: AuthContext) {
    const { docId, options } = params;
    await this.assertWrite(ctx, docId, 'deleteDoc', params);
    await this.patches.deleteDoc(docId, options, ctx?.clientId);
  }

  /**
   * Removes the tombstone for a deleted document, allowing it to be recreated.
   * @param params - The undelete parameters
   * @param params.docId - The ID of the document to undelete
   */
  async undeleteDoc(params: { docId: string }, ctx?: AuthContext) {
    const { docId } = params;
    await this.assertWrite(ctx, docId, 'undeleteDoc', params);
    return this.patches.undeleteDoc(docId);
  }

  // ---------------------------------------------------------------------------
  // History Manager wrappers
  // ---------------------------------------------------------------------------

  async listVersions(params: { docId: string; options?: ListVersionsOptions }, ctx?: AuthContext) {
    this.assertHistoryEnabled();
    const { docId, options } = params;
    await this.assertRead(ctx, docId, 'listVersions', params);
    return this.history!.listVersions(docId, options ?? {});
  }

  async createVersion(params: { docId: string; metadata: EditableVersionMetadata }, ctx?: AuthContext) {
    this.assertHistoryEnabled();
    const { docId, metadata } = params;
    await this.assertWrite(ctx, docId, 'createVersion', params);
    return this.history!.createVersion(docId, metadata);
  }

  async updateVersion(
    params: { docId: string; versionId: string; metadata: EditableVersionMetadata },
    ctx?: AuthContext
  ) {
    this.assertHistoryEnabled();
    const { docId, versionId, metadata } = params;
    await this.assertWrite(ctx, docId, 'updateVersion', params);
    return this.history!.updateVersion(docId, versionId, metadata);
  }

  async getVersionState(params: { docId: string; versionId: string }, ctx?: AuthContext) {
    this.assertHistoryEnabled();
    const { docId, versionId } = params;
    await this.assertRead(ctx, docId, 'getStateAtVersion', params);
    return this.history!.getStateAtVersion(docId, versionId);
  }

  async getVersionChanges(params: { docId: string; versionId: string }, ctx?: AuthContext) {
    this.assertHistoryEnabled();
    const { docId, versionId } = params;
    await this.assertRead(ctx, docId, 'getChangesForVersion', params);
    return this.history!.getChangesForVersion(docId, versionId);
  }

  async listServerChanges(params: { docId: string; options?: ListChangesOptions }, ctx?: AuthContext) {
    this.assertHistoryEnabled();
    const { docId, options } = params;
    await this.assertRead(ctx, docId, 'listServerChanges', params);
    return this.history!.listServerChanges(docId, options ?? {});
  }

  // ---------------------------------------------------------------------------
  // Branch Manager wrappers
  // ---------------------------------------------------------------------------

  async listBranches(params: { docId: string }, ctx?: AuthContext) {
    this.assertBranchingEnabled();
    const { docId } = params;
    await this.assertRead(ctx, docId, 'listBranches', params);
    return this.branches!.listBranches(docId);
  }

  async createBranch(params: { docId: string; rev: number; metadata?: EditableVersionMetadata }, ctx?: AuthContext) {
    this.assertBranchingEnabled();
    const { docId, rev, metadata } = params;
    await this.assertWrite(ctx, docId, 'createBranch', params);
    return this.branches!.createBranch(docId, rev, metadata);
  }

  async closeBranch(params: { branchId: string }, ctx?: AuthContext) {
    this.assertBranchingEnabled();
    const { branchId } = params;
    await this.assertWrite(ctx, branchId, 'closeBranch', params);
    return this.branches!.closeBranch(branchId, 'closed');
  }

  async mergeBranch(params: { branchId: string }, ctx?: AuthContext) {
    this.assertBranchingEnabled();
    const { branchId } = params;
    await this.assertWrite(ctx, branchId, 'mergeBranch', params);
    return this.branches!.mergeBranch(branchId);
  }

  // ---------------------------------------------------------------------------
  // Authorization helpers
  // ---------------------------------------------------------------------------

  protected async assertAccess(
    ctx: AuthContext | undefined,
    docId: string,
    kind: 'read' | 'write',
    method: string,
    params?: Record<string, any>
  ): Promise<void> {
    const ok = await this.auth.canAccess(ctx, docId, kind, method, params);
    if (!ok) {
      throw new StatusError(401, `${kind.toUpperCase()}_FORBIDDEN:${docId}`);
    }
  }

  assertRead(ctx: AuthContext | undefined, docId: string, method: string, params?: Record<string, any>): Promise<void> {
    return this.assertAccess(ctx, docId, 'read', method, params);
  }

  assertWrite(
    ctx: AuthContext | undefined,
    docId: string,
    method: string,
    params?: Record<string, any>
  ): Promise<void> {
    return this.assertAccess(ctx, docId, 'write', method, params);
  }

  protected assertHistoryEnabled() {
    if (!this.history) {
      throw new StatusError(404, 'History is not enabled');
    }
  }

  protected assertBranchingEnabled() {
    if (!this.branches) {
      throw new StatusError(404, 'Branching is not enabled');
    }
  }
}
