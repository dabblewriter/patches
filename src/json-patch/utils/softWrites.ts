import type { JSONPatchOp } from '../types.js';
import { log } from './log.js';
import { mapAndFilterOps } from './ops.js';

export function isEmptyContainer(value: any) {
  if (!value || typeof value !== 'object') return false;
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

/**
 * If other empty objects or arrays were added to this same path, assume they are maps/hashes/lookups/collections
 * and don't overwrite, allow subsequent ops to merge onto the first container created. `soft` will also do this
 * for any value that already exists.
 */
export function updateSoftWrites(overPath: string, ops: JSONPatchOp[], originalValue: any) {
  const originalIsArray = Array.isArray(originalValue);
  return mapAndFilterOps(ops, op => {
    // Only filter if same container type (both arrays or both objects)
    if (
      op.op === 'add' &&
      op.path === overPath &&
      isEmptyContainer(op.value) &&
      Array.isArray(op.value) === originalIsArray
    ) {
      log('Removing empty container', op);
      return null as any as JSONPatchOp;
    }
    return op;
  });
}
