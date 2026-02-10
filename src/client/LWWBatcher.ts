import { consolidateOps } from '../algorithms/lww/consolidateOps.js';
import { createChange } from '../data/change.js';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { JSONPatch } from '../json-patch/JSONPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { ChangeInput, ChangeMutator } from '../types.js';

/**
 * A utility for batching LWW operations before sending them to the server.
 *
 * Accumulates operations, consolidates them using LWW rules (@inc merging,
 * last-write-wins for replace ops, etc.), and produces a ChangeInput when flushed.
 *
 * Useful for migration scripts and batch operations where you want to accumulate
 * many changes efficiently without creating wasteful Change objects for each operation.
 *
 * @template T The type of the document being modified
 *
 * @example
 * ```ts
 * const batcher = new LWWBatcher<MyDocType>();
 *
 * // Option 1: Add ops directly
 * batcher.add([
 *   { op: '@inc', path: '/counter', value: 5 },
 *   { op: '@inc', path: '/counter', value: 3 }
 * ]);
 *
 * // Option 2: Use change() like LWWDoc
 * batcher.change((patch, doc) => {
 *   patch.increment(doc.counter, 5);
 *   patch.replace(doc.name, 'Alice');
 * });
 *
 * // Get consolidated change to send
 * const changeInput = batcher.flush();
 * // Returns: { id: '...', ops: [...consolidated...], createdAt: 123456789 }
 * ```
 */
export class LWWBatcher<T extends object = object> {
  private ops: Map<string, JSONPatchOp> = new Map();

  /**
   * Adds operations to the batch.
   * Operations are consolidated with existing ops using LWW rules.
   *
   * @param newOps Array of JSON Patch operations to add (timestamps optional)
   */
  add(newOps: JSONPatchOp[] | JSONPatch): void {
    if (!Array.isArray(newOps)) {
      newOps = newOps.ops;
    }
    if (newOps.length === 0) {
      return;
    }
    // Add timestamps if not present
    const timestamp = Date.now();
    const timedOps = newOps.map((op) => (op.ts ? op : { ...op, ts: timestamp }));

    // Get existing ops that might need consolidation
    const existingOps = Array.from(this.ops.values());

    // Consolidate
    const { opsToSave, pathsToDelete } = consolidateOps(existingOps, timedOps);

    // Remove deleted paths
    for (const path of pathsToDelete) {
      this.ops.delete(path);
    }

    // Save consolidated ops
    for (const op of opsToSave) {
      this.ops.set(op.path, op);
    }
  }

  /**
   * Captures operations using a mutator function (like LWWDoc.change).
   * The mutator receives a JSONPatch instance and a type-safe path proxy.
   *
   * @param mutator Function that uses JSONPatch methods with type-safe paths
   *
   * @example
   * ```ts
   * batcher.change((patch, doc) => {
   *   patch.increment(doc.counter, 5);
   *   patch.replace(doc.user.name, 'Alice');
   *   patch.bitSet(doc.flags, 0b0010);
   * });
   * ```
   */
  change(mutator: ChangeMutator<T>): void {
    const patch = createJSONPatch(mutator);
    if (patch.ops.length > 0) {
      this.add(patch.ops);
    }
  }

  /**
   * Returns the consolidated operations as a ChangeInput object and clears the batch.
   *
   * @param metadata Optional metadata to include in the ChangeInput
   * @returns A ChangeInput with id, ops, and createdAt (no rev/baseRev)
   */
  flush(metadata?: Record<string, any>): ChangeInput {
    const ops = Array.from(this.ops.values());
    const change = createChange(ops, metadata);
    this.clear();
    return change;
  }

  /**
   * Clears all batched operations without creating a ChangeInput.
   */
  clear(): void {
    this.ops.clear();
  }

  /**
   * Returns true if the batch has no pending operations.
   */
  isEmpty(): boolean {
    return this.ops.size === 0;
  }

  /**
   * Returns the current number of batched operations.
   */
  get size(): number {
    return this.ops.size;
  }
}
