import { describe, it, expect } from 'vitest';
import {
  isAbortError,
  isDefectiveChangeError,
  isNetworkError,
  isStorageError,
  NetworkError,
  StatusError,
  StorageError,
  StorageTimeoutError,
  toStorageError,
} from '../../src/net/error';

describe('StatusError', () => {
  describe('constructor', () => {
    it('should create error with code and message', () => {
      const error = new StatusError(404, 'Not Found');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(StatusError);
      expect(error.code).toBe(404);
      expect(error.message).toBe('Not Found');
      expect(error.name).toBe('Error');
    });

    it('should create error with zero code', () => {
      const error = new StatusError(0, 'Unknown error');

      expect(error.code).toBe(0);
      expect(error.message).toBe('Unknown error');
    });

    it('should create error with negative code', () => {
      const error = new StatusError(-1, 'Internal error');

      expect(error.code).toBe(-1);
      expect(error.message).toBe('Internal error');
    });

    it('should create error with empty message', () => {
      const error = new StatusError(500, '');

      expect(error.code).toBe(500);
      expect(error.message).toBe('');
    });
  });

  describe('inheritance', () => {
    it('should be instanceof Error', () => {
      const error = new StatusError(400, 'Bad Request');

      expect(error instanceof Error).toBe(true);
      expect(error instanceof StatusError).toBe(true);
    });

    it('should have Error prototype methods', () => {
      const error = new StatusError(401, 'Unauthorized');

      expect(typeof error.toString).toBe('function');
      expect(error.toString()).toContain('Unauthorized');
    });

    it('should have stack trace', () => {
      const error = new StatusError(403, 'Forbidden');

      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
    });
  });

  describe('common HTTP status codes', () => {
    it('should handle 400 Bad Request', () => {
      const error = new StatusError(400, 'Bad Request');
      expect(error.code).toBe(400);
      expect(error.message).toBe('Bad Request');
    });

    it('should handle 401 Unauthorized', () => {
      const error = new StatusError(401, 'Unauthorized');
      expect(error.code).toBe(401);
      expect(error.message).toBe('Unauthorized');
    });

    it('should handle 403 Forbidden', () => {
      const error = new StatusError(403, 'Forbidden');
      expect(error.code).toBe(403);
      expect(error.message).toBe('Forbidden');
    });

    it('should handle 404 Not Found', () => {
      const error = new StatusError(404, 'Not Found');
      expect(error.code).toBe(404);
      expect(error.message).toBe('Not Found');
    });

    it('should handle 500 Internal Server Error', () => {
      const error = new StatusError(500, 'Internal Server Error');
      expect(error.code).toBe(500);
      expect(error.message).toBe('Internal Server Error');
    });

    it('should handle 503 Service Unavailable', () => {
      const error = new StatusError(503, 'Service Unavailable');
      expect(error.code).toBe(503);
      expect(error.message).toBe('Service Unavailable');
    });
  });

  describe('custom status codes', () => {
    it('should handle custom application codes', () => {
      const error = new StatusError(1001, 'Custom application error');
      expect(error.code).toBe(1001);
      expect(error.message).toBe('Custom application error');
    });

    it('should handle WebSocket close codes', () => {
      const error = new StatusError(1006, 'Abnormal closure');
      expect(error.code).toBe(1006);
      expect(error.message).toBe('Abnormal closure');
    });
  });

  describe('error handling', () => {
    it('should be catchable as Error', () => {
      try {
        throw new StatusError(422, 'Unprocessable Entity');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(StatusError);
        if (error instanceof StatusError) {
          expect(error.code).toBe(422);
          expect(error.message).toBe('Unprocessable Entity');
        }
      }
    });

    it('should be catchable as StatusError', () => {
      try {
        throw new StatusError(429, 'Too Many Requests');
      } catch (error) {
        if (error instanceof StatusError) {
          expect(error.code).toBe(429);
          expect(error.message).toBe('Too Many Requests');
        } else {
          throw new Error('Expected StatusError', { cause: error });
        }
      }
    });

    it('should work with Promise rejection', async () => {
      const promise = Promise.reject(new StatusError(502, 'Bad Gateway'));

      try {
        await promise;
        expect.fail('Promise should have rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(StatusError);
        if (error instanceof StatusError) {
          expect(error.code).toBe(502);
          expect(error.message).toBe('Bad Gateway');
        }
      }
    });
  });

  describe('serialization', () => {
    it('should serialize code property correctly', () => {
      const error = new StatusError(418, "I'm a teapot");
      const serialized = JSON.stringify(error);
      const parsed = JSON.parse(serialized);

      // Error properties are not enumerable by default, so only code gets serialized
      expect(parsed.code).toBe(418);
      expect(parsed.message).toBeUndefined(); // message is not enumerable
      expect(parsed.name).toBeUndefined(); // name is not enumerable
    });

    it('should maintain code property in object', () => {
      const error = new StatusError(451, 'Unavailable For Legal Reasons');

      expect(error.code).toBe(451);
      expect(error.message).toBe('Unavailable For Legal Reasons');
      expect(Object.hasOwnProperty.call(error, 'code')).toBe(true);
    });
  });

  describe('NetworkError and isNetworkError', () => {
    it('creates a named error with a preserved cause', () => {
      const cause = new TypeError('Failed to fetch');
      const error = new NetworkError('GET /docs/doc1 failed without a response: Failed to fetch', { cause });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(NetworkError);
      expect(error.name).toBe('NetworkError');
      expect(error.cause).toBe(cause);
    });

    it('classifies NetworkError instances as network errors', () => {
      expect(isNetworkError(new NetworkError('Transport disconnected'))).toBe(true);
    });

    it('classifies by name so errors surviving a structured-clone boundary still match', () => {
      // Structured clone / cross-realm copies keep only name/message/stack.
      const rehydrated = new Error('fetch failed');
      rehydrated.name = 'NetworkError';
      expect(isNetworkError(rehydrated)).toBe(true);
    });

    it('classifies the raw timeout shape that escapes transport wrapping', () => {
      expect(isNetworkError(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(true);
    });

    it('classifies raw status-less fetch TypeErrors that escaped transport wrapping', () => {
      // A fetch on an unwrapped path (or one re-thrown across a worker boundary as a
      // bare TypeError) surfaces the browser's fixed, non-localized failure string.
      expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true); // Chromium
      expect(isNetworkError(new TypeError('Load failed'))).toBe(true); // WebKit
      expect(isNetworkError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true); // Gecko
      // Name survives structured clone even when the TypeError prototype does not.
      const crossed = new Error('Failed to fetch');
      crossed.name = 'TypeError';
      expect(isNetworkError(crossed)).toBe(true);
      // Exact (not substring) match: near-misses that merely contain "load failed"
      // must not be swept into connection recovery.
      expect(isNetworkError(new TypeError('Upload failed'))).toBe(false);
      expect(isNetworkError(new TypeError('Download failed'))).toBe(false);
    });

    it('does not classify coded, generic, aborted, or non-error failures as network errors', () => {
      expect(isNetworkError(new StatusError(403, 'Forbidden'))).toBe(false);
      expect(isNetworkError(new StatusError(500, 'Internal Server Error'))).toBe(false);
      expect(isNetworkError(new Error('some transient failure'))).toBe(false);
      expect(isNetworkError(new TypeError('x is not a function'))).toBe(false);
      // Cancellations are a sibling class with their own predicate (isAbortError).
      expect(isNetworkError(new DOMException('The user aborted a request.', 'AbortError'))).toBe(false);
      expect(isNetworkError('Failed to fetch')).toBe(false);
      expect(isNetworkError(undefined)).toBe(false);
    });
  });

  describe('isAbortError', () => {
    it('matches an aborted fetch (DOMException AbortError — legacy code 20)', () => {
      // Browsers expose legacy `code` 20 (DOMException.ABORT_ERR) on AbortError — the
      // "(20)" that appears in downstream telemetry. Classification is name-based, so it
      // works even in environments (like this test DOM) that omit the legacy code.
      expect(isAbortError(new DOMException('The user aborted a request.', 'AbortError'))).toBe(true);
    });

    it('matches an aborted IndexedDB transaction', () => {
      expect(isAbortError(new DOMException('The transaction was aborted.', 'AbortError'))).toBe(true);
    });

    it('matches a name-preserving copy that crossed a worker boundary', () => {
      // Structured clone / cross-boundary rehydration can yield a plain Error that
      // kept only name/message — classification must not require DOMException.
      const crossed = new Error('The user aborted a request.');
      crossed.name = 'AbortError';
      expect(isAbortError(crossed)).toBe(true);
    });

    it('does not match timeouts, HTTP statuses, or ordinary errors', () => {
      expect(isAbortError(new DOMException('signal timed out', 'TimeoutError'))).toBe(false);
      expect(isAbortError(new StatusError(403, 'Forbidden'))).toBe(false);
      expect(isAbortError(new Error('network blip'))).toBe(false);
      expect(isAbortError('AbortError')).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
    });
  });

  describe('StorageError, isStorageError and toStorageError', () => {
    it('creates a named error with a preserved cause', () => {
      const cause = new DOMException('Unable to store record in object store', 'UnknownError');
      const error = new StorageError(cause.message, { cause });
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(StorageError);
      expect(error.name).toBe('StorageError');
      expect(error.message).toBe('Unable to store record in object store');
      expect(error.cause).toBe(cause);
    });

    it('classifies StorageError instances and name-preserving copies (worker boundary)', () => {
      expect(isStorageError(new StorageError('storage failed'))).toBe(true);
      const crossed = new Error('storage failed');
      crossed.name = 'StorageError';
      expect(isStorageError(crossed)).toBe(true);
    });

    it('classifies the raw WebKit IndexedDB storage-fault DOMExceptions by name', () => {
      // The three WebKit faults from the field, all named UnknownError:
      expect(isStorageError(new DOMException('Unable to store record in object store', 'UnknownError'))).toBe(true);
      expect(isStorageError(new DOMException('Failed to delete record from object store', 'UnknownError'))).toBe(true);
      expect(
        isStorageError(
          new DOMException('Attempt to get records from database without an in-progress transaction', 'UnknownError')
        )
      ).toBe(true);
      // Storage full:
      expect(isStorageError(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))).toBe(true);
    });

    it('classifies StorageTimeoutError so storage-fault branches see guard timeouts too', () => {
      expect(isStorageError(new StorageTimeoutError('transaction', ['docs'], 4000))).toBe(true);
      expect(isStorageError(new StorageTimeoutError('open', [], 4000))).toBe(true);
      // Name-preserving copy across a worker boundary still classifies.
      const crossed = new Error('IndexedDB transaction [docs] did not settle within 4000ms');
      crossed.name = 'StorageTimeoutError';
      expect(isStorageError(crossed)).toBe(true);
      // But it is never wrapped: it is already typed.
      const timeout = new StorageTimeoutError('transaction', ['docs'], 4000);
      expect(toStorageError(timeout)).toBe(timeout);
    });

    it('does NOT classify connection-closing, abort, coded, or ordinary errors as storage errors', () => {
      // InvalidStateError is the connection-closing class handled by the reopen-retry.
      expect(isStorageError(new DOMException('The database connection is closing.', 'InvalidStateError'))).toBe(false);
      // AbortError is the sibling interruption class (isAbortError).
      expect(isStorageError(new DOMException('The transaction was aborted.', 'AbortError'))).toBe(false);
      expect(isStorageError(new StatusError(403, 'Forbidden'))).toBe(false);
      expect(isStorageError(new Error('some transient failure'))).toBe(false);
      expect(isStorageError('UnknownError')).toBe(false);
      expect(isStorageError(undefined)).toBe(false);
    });

    it('wraps raw storage-fault DOMExceptions into a StorageError, preserving message and cause', () => {
      const raw = new DOMException('Failed to delete record from object store', 'UnknownError');
      const wrapped = toStorageError(raw);
      expect(wrapped).toBeInstanceOf(StorageError);
      expect((wrapped as StorageError).message).toBe('Failed to delete record from object store');
      expect((wrapped as StorageError).cause).toBe(raw);
      expect(isStorageError(wrapped)).toBe(true);
    });

    it('returns non-storage errors (and already-wrapped / null) unchanged', () => {
      const already = new StorageError('already wrapped');
      expect(toStorageError(already)).toBe(already);
      const abort = new DOMException('aborted', 'AbortError');
      expect(toStorageError(abort)).toBe(abort);
      const status = new StatusError(403, 'Forbidden');
      expect(toStorageError(status)).toBe(status);
      // IndexedDB request.error can be null; pass it through untouched.
      expect(toStorageError(null)).toBe(null);
    });

    it('classifies and wraps a DOMException-shaped value that is NOT an Error (pre-Safari-12)', () => {
      // On old WebKit a DOMException does not inherit from Error, so an `instanceof Error`
      // gate would silently miss the exact iPad-Safari fault this exists for. Simulate that
      // shape with a plain object carrying only name/message.
      const oldShape = { name: 'UnknownError', message: 'Unable to store record in object store' };
      expect(isStorageError(oldShape)).toBe(true);
      const wrapped = toStorageError(oldShape);
      expect(wrapped).toBeInstanceOf(StorageError);
      expect((wrapped as StorageError).message).toBe('Unable to store record in object store');
      expect((wrapped as StorageError).cause).toBe(oldShape);
    });
  });

  describe('isDefectiveChangeError', () => {
    it('classifies the change-is-un-persistable DOMException names', () => {
      expect(isDefectiveChangeError(new DOMException('could not be cloned', 'DataCloneError'))).toBe(true);
      expect(isDefectiveChangeError(new DOMException('invalid key', 'DataError'))).toBe(true);
      expect(isDefectiveChangeError(new DOMException('key already exists', 'ConstraintError'))).toBe(true);
    });

    it('classifies by name without an instanceof Error gate (cross-realm / structured-clone)', () => {
      // A value that crossed a structured-clone/worker boundary keeps only name/message/stack,
      // and a pre-Safari-12 DOMException is not an Error — a plain shape must still classify.
      expect(isDefectiveChangeError({ name: 'DataCloneError', message: 'x is not cloneable' })).toBe(true);
      const subclassed = new Error('non-cloneable value in change');
      subclassed.name = 'DataCloneError';
      expect(isDefectiveChangeError(subclassed)).toBe(true);
    });

    it('does NOT classify storage faults, rejections, aborts, or ordinary failures', () => {
      // Storage faults are the environment failing to save a well-formed record — retryable,
      // and deliberately disjoint from defective (a malformed record). The two must not overlap.
      expect(isDefectiveChangeError(new DOMException('Unable to store record', 'UnknownError'))).toBe(false);
      expect(isDefectiveChangeError(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))).toBe(
        false
      );
      expect(isStorageError(new DOMException('could not be cloned', 'DataCloneError'))).toBe(false);
      expect(isDefectiveChangeError(new StatusError(403, 'Forbidden'))).toBe(false);
      expect(isDefectiveChangeError(new DOMException('The transaction was aborted.', 'AbortError'))).toBe(false);
      expect(isDefectiveChangeError(new Error('some transient failure'))).toBe(false);
      expect(isDefectiveChangeError('DataCloneError')).toBe(false);
      expect(isDefectiveChangeError(undefined)).toBe(false);
      expect(isDefectiveChangeError(null)).toBe(false);
    });
  });

  describe('comparison and equality', () => {
    it('should compare codes correctly', () => {
      const error1 = new StatusError(400, 'Bad Request');
      const error2 = new StatusError(400, 'Bad Request');
      const error3 = new StatusError(401, 'Unauthorized');

      expect(error1.code === error2.code).toBe(true);
      expect(error1.code === error3.code).toBe(false);
      expect(error1 === error2).toBe(false); // Different instances
    });

    it('should allow code comparison for error handling', () => {
      const handleError = (error: StatusError) => {
        if (error.code >= 400 && error.code < 500) {
          return 'Client Error';
        } else if (error.code >= 500) {
          return 'Server Error';
        }
        return 'Unknown';
      };

      expect(handleError(new StatusError(404, 'Not Found'))).toBe('Client Error');
      expect(handleError(new StatusError(500, 'Server Error'))).toBe('Server Error');
      expect(handleError(new StatusError(200, 'OK'))).toBe('Unknown');
    });
  });
});
