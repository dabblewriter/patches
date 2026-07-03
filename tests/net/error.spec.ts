import { describe, it, expect } from 'vitest';
import { isAbortError, isNetworkError, NetworkError, StatusError } from '../../src/net/error';

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
