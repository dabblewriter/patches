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
 * Release the concurrency entry for a document, freeing memory.
 * Call when a document is untracked or deleted.
 */
export function releaseConcurrency(docId: string): void {
  docIds.delete(docId);
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
 * Wraps a function so that only one invocation per key runs at a time.
 * While in-flight, any additional calls for the same key are collapsed into
 * exactly one queued follow-up. When the in-flight call finishes, the follow-up
 * runs once (picking up all work that accumulated in the window). Further calls
 * while the follow-up is itself in-flight queue another single follow-up, and
 * so on — naturally serialising all work without ever dropping it.
 *
 * Contrast with `singleInvocation(true)`, which collapses concurrent calls but
 * does not schedule a follow-up, so work that arrives mid-flight is lost until
 * the next external trigger.
 *
 * ### Example
 * ```ts
 * const syncDoc = serialGate(async (docId: string) => {
 *   const pending = await store.getPending(docId);
 *   await server.commit(docId, pending);
 * });
 *
 * // Three rapid calls: only one commitChanges in-flight at a time,
 * // one follow-up picks up everything that arrived during the window.
 * syncDoc('doc1');
 * syncDoc('doc1');
 * syncDoc('doc1');
 * ```
 */
export function serialGate<T extends (key: string, ...args: any[]) => Promise<void>>(target: T): T {
  // Per-instance state so the decorator is safe when applied to prototype methods
  // and correct when multiple instances exist. WeakMap allows GC of unused instances.
  type State = { inFlight: Map<string, Promise<void>>; queued: Set<string> };
  const instances = new WeakMap<object, State>();

  function getState(thisArg: object): State {
    let state = instances.get(thisArg);
    if (!state) {
      state = { inFlight: new Map(), queued: new Set() };
      instances.set(thisArg, state);
    }
    return state;
  }

  function run(thisArg: object, key: string, args: any[]): Promise<void> {
    const { inFlight, queued } = getState(thisArg);
    const promise = (target.apply(thisArg, [key, ...args]) as Promise<void>).finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
        if (queued.has(key)) {
          queued.delete(key);
          run(thisArg, key, args);
        }
      }
    });
    inFlight.set(key, promise);
    return promise;
  }

  return function (this: object, key: string, ...args: any[]) {
    const { inFlight, queued } = getState(this);
    if (inFlight.has(key)) {
      queued.add(key);
      return inFlight.get(key)!;
    }
    return run(this, key, args);
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
