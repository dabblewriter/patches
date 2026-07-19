import type { AuthContext } from './websocket/AuthorizationProvider.js';

/**
 * Server-side context storage for the current request.
 *
 * This module provides synchronous access to the authentication context
 * during request handling. The context is set before a handler is invoked
 * and cleared after it completes.
 *
 * IMPORTANT: Context must be captured synchronously at the start of a handler,
 * before any await statements. After an await, the context may have been
 * cleared or changed by another concurrent request.
 *
 * @example
 * ```typescript
 * import { getAuthContext } from '@dabble/patches/net';
 *
 * async function myHandler(docId: string) {
 *   const ctx = getAuthContext(); // Capture immediately
 *   await someAsyncOperation();
 *   // Use captured ctx, not getAuthContext() again
 * }
 * ```
 */

let _ctx: AuthContext | undefined;

/**
 * Get the current auth context for the active request.
 * Must be called synchronously at the start of a handler, before any await.
 *
 * @returns The auth context, or undefined if not in a request context
 */
export function getAuthContext(): AuthContext | undefined {
  return _ctx;
}

/**
 * Set the auth context for the current request.
 *
 * The WebSocket RPC server calls this automatically before invoking a handler.
 * REST servers call it themselves to bind a mutation to its origin (e.g. the
 * `clientId` query parameter sent by `PatchesREST`): set the context
 * synchronously — after all awaits — immediately before invoking the
 * `OTServer`/`LWWServer` method, which captures it as its first synchronous
 * statement, then call `clearAuthContext()` once the call settles.
 *
 * @param ctx - The auth context to set
 */
export function setAuthContext(ctx: AuthContext | undefined): void {
  _ctx = ctx;
}

/**
 * Clear the auth context after request handling completes.
 * The WebSocket RPC server calls this automatically after a handler returns;
 * REST servers pair it with `setAuthContext`.
 */
export function clearAuthContext(): void {
  _ctx = undefined;
}

/**
 * Get the client ID from the current auth context.
 * Convenience helper for the common case of needing just the client ID.
 *
 * @returns The client ID, or undefined if not in a request context
 */
export function getClientId(): string | undefined {
  return _ctx?.clientId;
}
