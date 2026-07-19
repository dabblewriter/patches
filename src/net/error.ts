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
 * True when a failure carries an HTTP-style numeric `code` — this package's {@link StatusError},
 * a *consuming* package's own StatusError class (pup's `FirestoreStore` throws its own, with a
 * numeric `code`), or an error rehydrated across an RPC/worker boundary that preserved `code`.
 * Duck-typed on the numeric `code` rather than `instanceof StatusError`, for the same
 * cross-package hazard {@link isRejectionError} guards against — but across ANY status code, a
 * retryable 503 included, not just the terminal rejections.
 *
 * Use it where a store-thrown status signal must propagate verbatim instead of being wrapped
 * into a generic, code-less error (which would strip the retryable/authoritative verdict the
 * code carries). Node system errors use *string* codes (`'ENOENT'`), so they stay unmatched.
 */
export function isStatusError(err: unknown): err is Error & { code: number } {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'number';
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
 * The fixed, non-localized messages browser fetch implementations put on the
 * status-less `TypeError` they throw when a request dies before producing a
 * response — offline, a DNS/TCP/TLS failure, a dropped connection, or a CORS-opaque
 * rejection. Chromium: "Failed to fetch"; WebKit: "Load failed"; Gecko:
 * "NetworkError when attempting to fetch resource". Compared lower-cased and with
 * any trailing period stripped (Gecko's carries one), matched EXACTLY — a substring
 * match would sweep in near-misses like "Upload failed" / "Download failed".
 */
const RAW_FETCH_FAILURE_MESSAGES = ['failed to fetch', 'load failed', 'networkerror when attempting to fetch resource'];

/**
 * True for failures that never carried an HTTP status because the request died at
 * the network level — see {@link NetworkError}. Matches by name as well as
 * instance so errors from a duplicated module copy or a structured-clone boundary
 * (which preserves only name/message/stack) classify the same, and recognizes the
 * platform's raw timeout shape (`AbortSignal.timeout` firing mid body-read
 * surfaces a `TimeoutError` DOMException past any transport wrapping).
 *
 * Also recognizes a raw fetch rejection that escaped transport wrapping: a
 * status-less `TypeError` whose message is one of the browsers' fixed fetch-failure
 * strings ({@link RAW_FETCH_FAILURE_MESSAGES}). `PatchesREST` wraps these into a
 * {@link NetworkError}, but a fetch on any unwrapped path (or one re-thrown across a
 * worker boundary as a bare `TypeError`) would otherwise be misread as a doc-level
 * failure and latch the doc at a terminal 'error' — so match it here by name+message.
 * A `TypeError` with any other message (a genuine programming error) stays unmatched.
 * Cancelled requests/transactions are a sibling class — see {@link isAbortError}.
 */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'NetworkError' || err.name === 'TimeoutError') return true;
  if (err.name === 'TypeError') {
    return RAW_FETCH_FAILURE_MESSAGES.includes(err.message.toLowerCase().replace(/\.$/, ''));
  }
  return false;
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
 * The DOMException names a browser puts on a genuine STORAGE-layer IndexedDB failure —
 * the store could not read or persist a record even though the transaction opened. WebKit
 * is the frequent offender: it throws `UnknownError` for "Unable to store record in object
 * store" / "Failed to delete record from object store" / "Attempt to get records from
 * database without an in-progress transaction" (storage pressure, eviction, or a corrupted
 * store), and `QuotaExceededError` when the origin's storage is full.
 *
 * These are deliberately NOT included:
 * - `InvalidStateError` — the connection was closing; {@link IndexedDBStore} already
 *   reopen-retries that transparently (see `isConnectionClosingError`).
 * - `AbortError` — a cancelled transaction/request; {@link isAbortError} classifies it as an
 *   interruption to recover from, not a storage fault.
 * - `ConstraintError` / `DataError` — key/shape programming errors, not storage degradation.
 */
const STORAGE_FAULT_NAMES: ReadonlySet<string> = new Set(['UnknownError', 'QuotaExceededError']);

/**
 * Error for an IndexedDB operation that failed at the STORAGE layer — the browser could not
 * read or persist the record (WebKit `UnknownError` under storage pressure/eviction, or a
 * `QuotaExceededError` when the origin is out of space). See {@link STORAGE_FAULT_NAMES}.
 *
 * Like {@link NetworkError}, this describes the local ENVIRONMENT, not the document or the
 * server: reconnecting won't fix it and the server never saw the write. {@link IndexedDBStore}
 * wraps the raw DOMException in this at the store boundary (preserving the original as `cause`
 * and its message) so consumers get one stable, engine-independent type to branch on instead
 * of sniffing DOMException names. Per the Patches scope boundary the library only TYPES the
 * failure — the consuming app decides the UX (surface a "your browser couldn't save" banner,
 * prompt a reload, etc.).
 *
 * Scope: this types per-REQUEST and per-TRANSACTION durability faults (put/get/delete/cursor
 * rejects and transaction error/abort). DB-`open` failures are deliberately out of scope —
 * they mean the store is UNAVAILABLE (private mode, blocked storage, a failed upgrade), an
 * init/availability concern the open path and the app's startup persistence probe already own,
 * not a mid-session write that lost just-typed work.
 */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

/** Label shared by the guard's soft warning and {@link StorageTimeoutError} so the two log lines correlate. */
export function storageOpLabel(operation: string, storeNames: string[]): string {
  return `IndexedDB ${operation}${storeNames.length ? ` [${storeNames.join(', ')}]` : ''}`;
}

/**
 * An IndexedDB open, transaction, or database delete that never settled (no success, error,
 * or abort event) within the hard threshold (`storageTimeoutMs`, default 4000ms). Converts
 * an otherwise silent infinite hang into a typed, catchable failure.
 */
export class StorageTimeoutError extends Error {
  constructor(
    public readonly operation: 'open' | 'transaction' | 'delete',
    public readonly storeNames: string[],
    public readonly elapsedMs: number
  ) {
    super(`${storageOpLabel(operation, storeNames)} did not settle within ${elapsedMs}ms`);
    this.name = 'StorageTimeoutError';
  }
}

/**
 * True for a storage-layer IndexedDB failure — see {@link StorageError}. Matches purely by
 * `name`, deliberately WITHOUT an `instanceof Error` gate: it must classify the same after
 * crossing a structured-clone/worker boundary (which keeps only name/message/stack), AND
 * `DOMException` only inherits from `Error` on modern engines — an `instanceof Error` gate
 * would silently fail to classify a raw WebKit `UnknownError` on the exact old-Safari targets
 * this exists for. Recognizes the wrapped `StorageError`, the guard's
 * {@link StorageTimeoutError}, and the raw DOMException shape ({@link STORAGE_FAULT_NAMES})
 * on any path that didn't go through {@link toStorageError}.
 */
export function isStorageError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return (
    typeof name === 'string' &&
    (name === 'StorageError' || name === 'StorageTimeoutError' || STORAGE_FAULT_NAMES.has(name))
  );
}

/**
 * Wrap a raw IndexedDB storage-fault DOMException ({@link STORAGE_FAULT_NAMES}) in a typed
 * {@link StorageError}, keeping its message and the original as `cause`. Any other value
 * (including an already-wrapped `StorageError`, an `AbortError`, or a `null` request error)
 * is returned unchanged, so this is safe to apply at every IndexedDB reject site.
 *
 * Matches by `name` without an `instanceof Error` gate for the same reason as
 * {@link isStorageError} — a pre-Safari-12 `DOMException` is not an `Error`, and gating it out
 * would leave the fault unwrapped and unclassified on exactly the target this exists for.
 */
export function toStorageError(err: unknown): unknown {
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  if (e && typeof e.name === 'string' && e.name !== 'StorageError' && STORAGE_FAULT_NAMES.has(e.name)) {
    return new StorageError(typeof e.message === 'string' ? e.message : e.name, { cause: err });
  }
  return err;
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
