/**
 * Access level requested for an operation.
 *
 * "read"  – non-mutating operations (subscribe, getDoc, listVersions, …)
 * "write" – mutating operations (commitChanges, deleteDoc, …)
 */
export type Access = 'read' | 'write';

/**
 * Context object for authorization providers.
 * @property {string} clientId - The ID of the client making the request.
 * @property {any} [data] - Additional data associated with the request.
 */
export interface AuthContext {
  clientId?: string;
  [k: string]: any;
}

/**
 * Allows the host application to decide whether a given connection can perform
 * a certain action on a document.  Implementations are entirely application-
 * specific – they may look at a JWT decoded during the WebSocket handshake,
 * consult an ACL service, inspect the actual RPC method, etc.
 */
export interface AuthorizationProvider<T extends AuthContext = AuthContext> {
  /**
   * General-purpose hook executed for every JSON-RPC call that targets a
   * document. Implementations are free to look only at the first three
   * arguments (connection, docId, kind) or also inspect the method name and
   * original params for fine-grained rules (e.g. suggestion-only commits,
   * owner-only deletes, branch permissions, …).
   *
   * Returning `true` (or a resolved promise with `true`) permits the action.
   * Returning `false` or throwing will cause the RPC to fail with an error.
   *
   * @param ctx           Context object containing client ID and additional data
   * @param docId         Logical document to be accessed (branch IDs count)
   * @param kind          High-level access category – `'read' | 'write'`
   * @param method        JSON-RPC method name (e.g. `getDoc`, `branch.merge`)
   * @param params        The exact parameter object supplied by the client
   */
  canAccess(
    ctx: T | undefined,
    docId: string,
    kind: Access,
    method: string,
    params?: Record<string, any>
  ): boolean | Promise<boolean>;
}

/**
 * A permissive provider that authorises every action.  Used as the default so
 * existing callers that don't care about auth continue to work unchanged.
 */
export const allowAll: AuthorizationProvider = {
  canAccess: () => true,
};
