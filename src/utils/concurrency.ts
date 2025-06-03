/**
 * Wrap a function to only return the result of the first call.
 *
 * ### Examples:
 * ```ts
 * const getFromStorage = oneResult(async (key: string) => {
 *   ...
 * });
 */
export function oneResult<T extends (...args: any[]) => Promise<any>>(target: T): T;
export function oneResult<T extends (...args: any[]) => Promise<any>>(matchOnFirstArg: boolean): (target: T) => T;
export function oneResult<T extends (...args: any[]) => Promise<any>>(matchOnFirstArgOrTarget: boolean | T) {
  if (typeof matchOnFirstArgOrTarget === 'function') {
    return oneResult(false)(matchOnFirstArgOrTarget);
  }
  return function (target: T) {
    const promises = new Map<any, Promise<any>>();
    return function (this: any, ...args: any[]) {
      const key = matchOnFirstArgOrTarget ? args[0] : 1;
      if (promises.has(key)) return promises.get(key);
      const promise = target.apply(this, args);
      promises.set(key, promise);
      promise.finally(() => {
        promises.delete(key);
      });
      return promise;
    } as unknown as T;
  };
}
