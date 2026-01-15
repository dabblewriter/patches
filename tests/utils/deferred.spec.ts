import { describe, it, expect } from 'vitest';
import { deferred } from '../../src/utils/deferred';

describe('deferred', () => {
  it('should create a deferred object with promise, resolve, reject, and status', () => {
    const def = deferred<string>();

    expect(def).toHaveProperty('promise');
    expect(def).toHaveProperty('resolve');
    expect(def).toHaveProperty('reject');
    expect(def).toHaveProperty('status');
    expect(def.promise).toBeInstanceOf(Promise);
    expect(typeof def.resolve).toBe('function');
    expect(typeof def.reject).toBe('function');
    expect(def.status).toBe('pending');
  });

  it('should start with pending status', () => {
    const def = deferred();
    expect(def.status).toBe('pending');
  });

  it('should resolve the promise and update status to fulfilled', async () => {
    const def = deferred<string>();
    const testValue = 'test value';

    def.resolve(testValue);

    expect(def.status).toBe('fulfilled');
    const result = await def.promise;
    expect(result).toBe(testValue);
  });

  it('should reject the promise and update status to rejected', async () => {
    const def = deferred<string>();
    const testError = new Error('test error');

    def.reject(testError);

    expect(def.status).toBe('rejected');
    await expect(def.promise).rejects.toBe(testError);
  });

  it('should handle resolve with undefined for void type', async () => {
    const def = deferred<void>();

    def.resolve(undefined);

    expect(def.status).toBe('fulfilled');
    const result = await def.promise;
    expect(result).toBeUndefined();
  });

  it('should handle reject without reason', async () => {
    const def = deferred();

    def.reject();

    expect(def.status).toBe('rejected');
    await expect(def.promise).rejects.toBeUndefined();
  });

  it('should handle multiple resolve calls (first one wins)', async () => {
    const def = deferred<string>();

    def.resolve('first');
    def.resolve('second'); // Should be ignored

    expect(def.status).toBe('fulfilled');
    const result = await def.promise;
    expect(result).toBe('first');
  });

  it('should handle multiple reject calls (first one wins)', async () => {
    const def = deferred<string>();
    const firstError = new Error('first error');
    const secondError = new Error('second error');

    def.reject(firstError);
    def.reject(secondError); // Should be ignored

    expect(def.status).toBe('rejected');
    await expect(def.promise).rejects.toBe(firstError);
  });

  it('should handle resolve then reject (first one wins)', async () => {
    const def = deferred<string>();

    def.resolve('success');
    def.reject(new Error('should be ignored'));

    expect(def.status).toBe('rejected'); // Status changes, but promise result doesn't
    const result = await def.promise;
    expect(result).toBe('success'); // Promise still resolves with first value
  });

  it('should handle reject then resolve (first one wins)', async () => {
    const def = deferred<string>();
    const testError = new Error('test error');

    def.reject(testError);
    def.resolve('should be ignored');

    expect(def.status).toBe('fulfilled'); // Status changes, but promise result doesn't
    await expect(def.promise).rejects.toBe(testError); // Promise still rejects with first error
  });

  it('should work with complex types', async () => {
    interface TestData {
      id: number;
      name: string;
      items: string[];
    }

    const def = deferred<TestData>();
    const testData: TestData = {
      id: 1,
      name: 'test',
      items: ['a', 'b', 'c'],
    };

    def.resolve(testData);

    expect(def.status).toBe('fulfilled');
    const result = await def.promise;
    expect(result).toEqual(testData);
  });

  it('should work with null and boolean values', async () => {
    const defNull = deferred<null>();
    const defBoolean = deferred<boolean>();

    defNull.resolve(null);
    defBoolean.resolve(false);

    expect(defNull.status).toBe('fulfilled');
    expect(defBoolean.status).toBe('fulfilled');

    const nullResult = await defNull.promise;
    const booleanResult = await defBoolean.promise;

    expect(nullResult).toBeNull();
    expect(booleanResult).toBe(false);
  });

  it('should work with number zero', async () => {
    const def = deferred<number>();

    def.resolve(0);

    expect(def.status).toBe('fulfilled');
    const result = await def.promise;
    expect(result).toBe(0);
  });

  it('should handle promise chaining', async () => {
    const def = deferred<string>();

    const chainedPromise = def.promise.then(value => value.toUpperCase());

    def.resolve('hello');

    const result = await chainedPromise;
    expect(result).toBe('HELLO');
  });

  it('should handle async/await properly', async () => {
    const def = deferred<number>();

    // Simulate async operation
    setTimeout(() => {
      def.resolve(42);
    }, 10);

    const result = await def.promise;
    expect(result).toBe(42);
  });
});
