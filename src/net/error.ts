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
 */
export const ErrorCodes = {
  /** Document was deleted (tombstone exists). */
  DOC_DELETED: 410,
  /** Document not found (never existed). */
  DOC_NOT_FOUND: 404,
} as const;

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
