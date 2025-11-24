import type { PathProxy } from '../types.js';

// We use a function as the target so that `push` and other array methods can be called without error.
const proxyFodder = {} as any;

/**
 * Creates a path proxy for generating JSON Pointer paths in a type-safe way.
 * This proxy should ONLY be used for path creation with JSONPatch methods.
 *
 * Usage:
 * ```ts
 * const patch = new JSONPatch();
 * const path = createPathProxy<MyType>();
 * patch.replace(path.content, 'new text');      // Path is '/content'
 * patch.increment(path.counter, 5);             // Path is '/counter'
 * patch.add(path.items[0], newItem);            // Path is '/items/0'
 * ```
 *
 * The proxy will throw errors if you attempt to set properties or delete properties.
 * This prevents accidental mutation and ensures explicit patch operations are used.
 *
 * @template T The type of the object to create paths for.
 * @returns A path proxy object.
 */
export const createPathProxy = pathProxy as <T = any>() => PathProxy<T>;

// Internal implementation with the path parameter
export function pathProxy<T>(path = ''): PathProxy<T> {
  // Always use an empty function as the proxy target
  // This allows us to proxy any type of value, including primitives and undefined,
  // and enables calling array methods like push/splice directly on array proxies.
  return new Proxy(proxyFodder, {
    get(_, prop: string) {
      // Handle toString specially to make properties work as PathLike
      if (prop === 'toString') {
        return function () {
          return path;
        };
      }

      // Create a proxy for the property to continue path building
      return pathProxy(`${path}/${prop}`);
    },

    set(_, prop: string): boolean {
      throw new Error(
        `Cannot set property '${prop}' on path proxy. ` +
          `Path proxies are for generating JSON Pointer paths only. ` +
          `Use JSONPatch methods instead: patch.replace(path.${prop}, value)`
      );
    },

    deleteProperty(_, prop: string): boolean {
      throw new Error(
        `Cannot delete property '${prop}' on path proxy. ` +
          `Path proxies are for generating JSON Pointer paths only. ` +
          `Use JSONPatch methods instead: patch.remove(path.${prop})`
      );
    },
  }) as PathProxy<T>;
}
