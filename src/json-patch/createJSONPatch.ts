import type { ChangeMutator } from '../types.js';
import { JSONPatch } from './JSONPatch.js';
import { createPathProxy } from './pathProxy.js';

/**
 * Creates a `JSONPatch` instance using a path-only proxy for type-safe operation generation.
 *
 * The mutator function receives a JSONPatch instance and a PathProxy for creating
 * type-safe JSON Pointer paths. All modifications must be done through explicit
 * JSONPatch methods - the path proxy will throw errors if mutation is attempted.
 *
 * @template T The type of the target object.
 * @param target The initial state of the object (used for type inference only).
 * @param mutator A function that receives a JSONPatch instance and a PathProxy.
 * @returns A `JSONPatch` instance containing the operations generated within the mutator.
 *
 * @example
 * ```ts
 * const myObj = { name: { first: 'Alice' }, age: 30, tags: ['a'] };
 *
 * const patch = createJSONPatch(myObj, (patch, path) => {
 *   patch.replace(path.name.first, 'Bob');  // Type-safe path creation
 *   patch.increment(path.age, 1);           // Explicit operations only
 *   patch.add(path.tags[1], 'b');           // Array path handling
 * });
 *
 * console.log(patch.ops);
 * // [
 * //   { op: 'replace', path: '/name/first', value: 'Bob' },
 * //   { op: 'increment', path: '/age', value: 1 },
 * //   { op: 'add', path: '/tags/1', value: 'b' }
 * // ]
 * ```
 */
export function createJSONPatch<T>(mutator: ChangeMutator<T>): JSONPatch {
  const patch = new JSONPatch();
  // Create path-only proxy for type-safe path generation
  const pathProxy = createPathProxy<T>();
  mutator(patch, pathProxy);
  return patch;
}
