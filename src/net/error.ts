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
