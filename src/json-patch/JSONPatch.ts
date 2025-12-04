/*!
 * Based on work from
 * https://github.com/mohayonao/json-touch-patch
 * (c) 2018 mohayonao
 *
 * MIT license
 * (c) 2022 Jacob Wright
 *
 *
 * WARNING: using /array/- syntax to indicate the end of the array makes it impossible to transform arrays correctly in
 * all situaions. Please avoid using this syntax when using Operational Transformations.
 */

import { Delta } from '@dabble/delta';
import { applyPatch } from './applyPatch.js';
import { composePatch } from './composePatch.js';
import { invertPatch } from './invertPatch.js';
import { bitmask } from './ops/bitmask.js';
import { transformPatch } from './transformPatch.js';
import type { ApplyJSONPatchOptions, JSONPatchOp, JSONPatchOpHandlerMap } from './types.js';

export type PathLike = string | { toString(): string };
export interface WriteOptions {
  soft?: boolean;
}

/**
 * A JSONPatch helps with creating and applying one or more "JSON patches". It can track one or more changes
 * together which may form a single operation or transaction.
 */
export class JSONPatch {
  ops: JSONPatchOp[];
  custom: JSONPatchOpHandlerMap;

  /**
   * Create a new JSONPatch, optionally with an existing array of operations.
   */
  constructor(ops: JSONPatchOp[] = [], custom: JSONPatchOpHandlerMap = {}) {
    this.ops = ops;
    this.custom = custom;
  }

  op(op: string, path: PathLike, value?: any, from?: PathLike, soft?: boolean) {
    path = checkPath(path);
    if (from !== undefined) {
      from = checkPath(from);
    }
    const patchOp = (from ? { op, from, path } : { op, path }) as JSONPatchOp;
    if (value !== undefined) patchOp.value = value;
    if (soft) patchOp.soft = soft;
    this.ops.push(patchOp);
    return this;
  }

  /**
   * Tests a value exists. If it doesn't, the patch is not applied.
   */
  test(path: PathLike, value: any) {
    return this.op('test', path, value);
  }

  /**
   * Adds the value to an object or array, inserted before the given index.
   */
  add(path: PathLike, value: any, options?: WriteOptions) {
    if (value && value.toJSON) value = value.toJSON();
    return this.op('add', path, value, undefined, options?.soft);
  }

  /**
   * Deletes the value at the given path or removes it from an array.
   */
  remove(path: PathLike) {
    return this.op('remove', path);
  }

  /**
   * Replaces a value (same as remove+add).
   */
  replace(path: PathLike, value: any, options?: WriteOptions) {
    if (value && value.toJSON) value = value.toJSON();
    if (value === undefined) return this.remove(path);
    return this.op('replace', path, value, undefined, options?.soft);
  }

  /**
   * Copies the value at `from` to `path`.
   */
  copy(from: PathLike, to: PathLike, options?: WriteOptions) {
    return this.op('copy', to, undefined, from, options?.soft);
  }

  /**
   * Moves the value at `from` to `path`.
   */
  move(from: PathLike, to: PathLike) {
    if (from === to) return this;
    return this.op('move', to, undefined, from);
  }

  /**
   * Increments a numeric value by 1 or the given amount.
   */
  increment(path: PathLike, value: number = 1) {
    return this.op('@inc', path, value);
  }

  /**
   * Decrements a numeric value by 1 or the given amount.
   */
  decrement(path: PathLike, value: number = 1) {
    return this.op('@inc', path, -value);
  }

  /**
   * Flips a bit at the given index in a bitmask to the given value.
   */
  bit(path: PathLike, index: number, on: boolean) {
    return this.op('@bit', path, bitmask(index, on));
  }

  /**
   * Applies a delta to a text document.
   */
  text(path: PathLike, value: Delta | Delta['ops']) {
    if (Array.isArray(value)) {
      value = new Delta(value);
    } else if (!(value instanceof Delta) && Array.isArray((value as any)?.ops)) {
      value = new Delta((value as any).ops);
    } else if (!(value instanceof Delta)) {
      throw new Error('Invalid Delta');
    }
    return this.op('@txt', path, value);
  }

  /**
   * Creates a patch from an object partial, updating each field. Set a field to undefined to delete it.
   */
  addUpdates(updates: { [key: string]: any }, path: PathLike = '/') {
    path = checkPath(path);
    if ((path as string)[(path as string).length - 1] !== '/') path += '/';
    Object.keys(updates).forEach(key => {
      const value = updates[key];
      if (value == undefined) {
        this.remove(path + key);
      } else {
        this.replace(path + key, value);
      }
    });
    return this;
  }

  /**
   * Apply this patch to an object, returning a new object with the applied changes (or the same object if nothing
   * changed in the patch). Optionally apply the page at the given path prefix.
   */
  apply<T>(obj: T, options?: ApplyJSONPatchOptions): T {
    return applyPatch(obj, this.ops, options, this.custom);
  }

  /**
   * Transform the given patch against this one. This patch is considered to have happened first. Optionally provide
   * the object these operations are being applied to if available to know for sure if a numerical path is an array
   * index or object key. Otherwise, all numerical paths are treated as array indexes.
   */
  transform(patch: JSONPatch | JSONPatchOp[], obj?: any): this {
    const JSONPatch = this.constructor as any;
    return new JSONPatch(
      transformPatch(obj, this.ops, Array.isArray(patch) ? patch : patch.ops, this.custom),
      this.custom
    );
  }

  /**
   * Create a patch which can reverse what this patch does. Because JSON Patches do not store previous values, you
   * must provide the previous object to create a reverse patch.
   */
  invert(obj: any): this {
    const JSONPatch = this.constructor as any;
    return new JSONPatch(invertPatch(obj, this.ops, this.custom), this.custom);
  }

  /**
   * Compose/collapse patches into fewer operations.
   */
  compose(patch?: JSONPatch | JSONPatchOp[]): this {
    const JSONPatch = this.constructor as any;
    let ops = this.ops;
    if (patch) ops = ops.concat(Array.isArray(patch) ? patch : patch.ops);
    return new JSONPatch(composePatch(ops), this.custom);
  }

  /**
   * Add two patches together.
   */
  concat(patch: JSONPatch | JSONPatchOp[]): this {
    const JSONPatch = this.constructor as any;
    return new JSONPatch(this.ops.concat(Array.isArray(patch) ? patch : patch.ops), this.custom);
  }

  /**
   * Returns an array of patch operations.
   */
  toJSON() {
    return this.ops.slice();
  }

  /**
   * Create a new JSONPatch with the provided JSON patch operations.
   */
  static fromJSON<T>(
    this: { new (ops?: JSONPatchOp[], types?: JSONPatchOpHandlerMap): T },
    ops?: JSONPatchOp[],
    types?: JSONPatchOpHandlerMap
  ): T {
    return new this(ops, types);
  }
}

function checkPath(path: PathLike): string {
  path = path.toString();
  if ((path as string).length && (path as string)[0] !== '/') path = `/${path}`;
  return path as string;
}
