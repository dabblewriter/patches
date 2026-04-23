import type { JSONPatchOp } from '../types.js';
import { log } from './log.js';
import { mapAndFilterOps } from './ops.js';
import { toKeys } from './toKeys.js';

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

/**
 * Returns true when an op carries soft semantics — either an explicit
 * `soft: true` flag, or an empty-container `add` (treated as initialization
 * by convention). Mirrors the check used by the LWW consolidation algorithm.
 */
export function isSoftOp(op: JSONPatchOp): boolean {
  return op.soft === true || (op.op === 'add' && isEmptyContainer(op.value));
}

/**
 * Filters out soft writes that would overwrite existing data in state.
 * Used when baseRev: 0 is jumped forward, bypassing normal transformation.
 */
export function filterSoftWritesAgainstState(ops: JSONPatchOp[], state: any): JSONPatchOp[] {
  return ops.filter(op => {
    if (!isSoftOp(op)) return true;
    // Keep op only when path doesn't already exist in state
    return !pathExistsInState(state, op.path);
  });
}

export function pathExistsInState(state: any, path: string): boolean {
  if (!path) return state !== undefined;
  const keys = toKeys(path);
  let current = state;
  // Start at 1 to skip the leading empty string from the path's leading '/'
  for (let i = 1; i < keys.length; i++) {
    if (current == null || typeof current !== 'object') return false;
    if (!(keys[i] in current)) return false;
    current = current[keys[i]];
  }
  return true;
}
