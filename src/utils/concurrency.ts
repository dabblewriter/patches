import { simplifiedConcurrency } from 'simplified-concurrency';

type Concurrency = ReturnType<typeof simplifiedConcurrency>;
const docIds = new Map<string, Concurrency>();

/**
 * Make the concurrency be per-path to allow multiple records to be loaded and updated at the same time, keeping only
 * the record's operations sequential with respect to other operations on the same record.
 */
function concurrency(docId: string): Concurrency {
  let concurrency = docIds.get(docId);
  if (!concurrency) {
    concurrency = simplifiedConcurrency();
    docIds.set(docId, concurrency);
  }
  return concurrency;
}

/**
 * Wrap a function which is blockable for a document.
 * Also, a Typescript decorator for functions which are blockable.
 */
export function blockable<T extends (docId: string, ...args: any[]) => Promise<any>>(target: T): T {
  return function (this: any, ...args: any[]) {
    return concurrency(args[0]).blockFunction(target, args, this);
  } as T;
}

/**
 * Wrap a function which blocks on a document.
 * Also, a Typescript decorator for functions which block.
 */
export function blocking<T extends (docId: string, ...args: any[]) => Promise<any>>(target: T): T {
  return function (this: any, ...args: any[]) {
    return concurrency(args[0]).blockWhile(target.apply(this, args as any));
  } as T;
}

/**
 * Wrap a function which returns a response which is blockable for a document (e.g. fetch).
 * Also, a Typescript decorator for functions whose response should be blocked when needed.
 */
export function blockableResponse<T extends (docId: string, ...args: any[]) => Promise<any>>(target: T): T {
  return function (this: any, ...args: any[]) {
    return concurrency(args[0]).blockResponse(target.apply(this, args as any));
  } as T;
}

/**
 * Wrap a function to only return the result of the first call.
 *
 * ### Examples:
 * ```ts
 * const getFromStorage = oneResult(async (key: string) => {
 *   ...
 * });
 */
export function singleInvocation<T extends (...args: any[]) => Promise<any>>(target: T): T;
export function singleInvocation<T extends (...args: any[]) => Promise<any>>(
  matchOnFirstArg: boolean
): (target: T) => T;
export function singleInvocation<T extends (...args: any[]) => Promise<any>>(matchOnFirstArgOrTarget: boolean | T) {
  if (typeof matchOnFirstArgOrTarget === 'function') {
    return singleInvocation(false)(matchOnFirstArgOrTarget);
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
