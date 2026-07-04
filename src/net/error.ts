export class StatusError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: Record<string, any>
  ) {
    super(message);
  }
}

/**
 * Standard error codes for Patches operations.
 *
 * Patches is permission-agnostic; these codes are surfaced verbatim from
 * `StatusError.code` so consuming apps can branch on the HTTP status without
 * reaching for string matching. Permission *policy* (what to do with a 403)
 * lives in the consuming app.
 */
export const ErrorCodes = {
  /** Document was deleted (tombstone exists). */
  DOC_DELETED: 410,
  /** Document not found (never existed). */
  DOC_NOT_FOUND: 404,
  /** Caller is not authenticated (no/invalid credentials). */
  DOC_UNAUTHORIZED: 401,
  /** Caller is authenticated but not authorized for this doc. */
  DOC_FORBIDDEN: 403,
} as const;

/**
 * StatusError codes that are a definitive, authoritative verdict on a submission —
 * auth (401), payment (402), permission (403), not-found (404), gone (410). A
 * failure carrying one of these will not succeed by retrying; every other failure
 * (timeout, abort, network-level death, 5xx, plain Error) is transient or
 * *ambiguous* — the server may have processed the request even though the caller
 * never saw the response.
 */
export const TERMINAL_STATUS_CODES: ReadonlySet<number> = new Set([401, 402, 403, 404, 410]);

/**
 * True when a failure is an authoritative rejection ({@link TERMINAL_STATUS_CODES}):
 * the server (or store layer) definitively refused the work, so retrying is
 * pointless and discarding the work it carried is correct. Matches any Error
 * carrying a numeric `code` — not just live {@link StatusError} instances — so an
 * error rehydrated across an RPC/worker boundary that preserved `code` classifies
 * the same. Everything else (timeouts, aborts, network failures, plain Errors)
 * must be treated as transient/ambiguous: the request MAY have been processed.
 */
export function isRejectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && TERMINAL_STATUS_CODES.has(code);
}

/**
 * Error for a request that died at the network level, without ever producing an
 * HTTP response or status code: a fetch rejection (DNS/TCP/TLS failure or a
 * CORS-opaque rejection — both surface as a status-less `TypeError`), a request
 * timeout, or a transport that knew it had no live connection.
 *
 * The distinction matters to consumers: a {@link StatusError} is the server's
 * verdict on ONE document, while a NetworkError says nothing about the doc it was
 * for — it is evidence of CONNECTION trouble. PatchesSync treats it accordingly
 * (waiting-for-connection posture + connection-level recovery) instead of latching
 * the doc at a terminal per-doc 'error'. Custom `PatchesConnection`
 * implementations should throw this (or an error named `NetworkError`) for their
 * own status-less network failures to get the same handling.
 */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

/**
 * True for failures that never carried an HTTP status because the request died at
 * the network level — see {@link NetworkError}. Matches by name as well as
 * instance so errors from a duplicated module copy or a structured-clone boundary
 * (which preserves only name/message/stack) classify the same, and recognizes the
 * platform's raw timeout shape (`AbortSignal.timeout` firing mid body-read
 * surfaces a `TimeoutError` DOMException past any transport wrapping). Cancelled
 * requests/transactions are a sibling class — see {@link isAbortError}.
 */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'NetworkError' || err.name === 'TimeoutError';
}

/**
 * True for a cancelled request or storage transaction — a DOMException named
 * `AbortError` (legacy `code` 20, `DOMException.ABORT_ERR`). Fetches abort when
 * their context is torn down mid-flight (page navigation, app quit, worker
 * termination) or an `AbortController` fires; IndexedDB transactions abort
 * under storage pressure (quota, eviction, browser shutdown). Either way the
 * error describes the *environment*, not the document or the server — so sync
 * treats it as an interruption to recover from, never a per-doc failure to
 * latch. Name-based (not `instanceof DOMException`) so errors that crossed a
 * structured-clone/worker boundary still classify.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Error rejected by the JSON-RPC client for protocol-level errors (negative
 * JSON-RPC codes like -32601). HTTP-style positive codes are rehydrated into
 * {@link StatusError} instead so callers can branch on `err.code` uniformly.
 */
export class JSONRPCError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: any
  ) {
    super(message);
    this.name = 'JSONRPCError';
  }
}

/**
 * Error thrown when the JSON-RPC client receives a message that cannot be parsed as JSON.
 * This typically indicates a server-side error (HTTP 500, load balancer timeout, etc.)
 * that returned plain text instead of a JSON-RPC response.
 */
export class JSONRPCParseError extends Error {
  public readonly rawMessage: string;
  public readonly parseError: Error;

  constructor(rawMessage: string, parseError: Error) {
    const truncated = rawMessage.slice(0, 200) + (rawMessage.length > 200 ? '...' : '');
    super(`Failed to parse JSON-RPC response: ${truncated}`);
    this.name = 'JSONRPCParseError';
    this.rawMessage = rawMessage;
    this.parseError = parseError;
  }
}
