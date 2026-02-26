import { Delta } from '@dabble/delta';
import { applyBitmask, combineBitmasks } from '../../json-patch/ops/bitmask.js';
import type { JSONPatchOp } from '../../json-patch/types.js';
import { isEmptyContainer } from '../../json-patch/utils/softWrites.js';

/**
 * Combiner for consolidating same-type ops on the same path.
 */
export type Combiner = {
  apply: (a: any, b: any) => any;
  combine: (a: any, b: any) => any;
};

/**
 * Combinable operations - ops that can be merged rather than replaced.
 * Exported for use by mergeServerWithLocal.
 */
export const combinableOps: Record<string, Combiner> = {
  '@inc': {
    apply: (a: number, b: number) => a + b,
    combine: (a: number, b: number) => a + b,
  },
  '@bit': {
    apply: applyBitmask,
    combine: combineBitmasks,
  },
  '@max': {
    apply: (a: number, b: number) => (a > b ? a : b),
    combine: (a: number, b: number) => (a > b ? a : b),
  },
  '@min': {
    apply: (a: number, b: number) => (a < b ? a : b),
    combine: (a: number, b: number) => (a < b ? a : b),
  },
};

/**
 * Determines if the existing operation is newer than the incoming one based on timestamp.
 * Priority order:
 * 1. incoming.ts undefined → incoming wins (including when both are undefined)
 * 2. existing.ts undefined → existing wins
 * 3. Both defined: higher wins, ties go to incoming
 */
function isExistingNewer(existingTs: number | undefined, incomingTs: number | undefined): boolean {
  if (incomingTs === undefined) return false;
  if (existingTs === undefined) return true;
  return existingTs > incomingTs;
}

/**
 * Consolidates two ops on the same path.
 * - @txt: composes Delta values (rich text merge)
 * - @inc: sums values
 * - @bit: combines bitmasks
 * - @max: keeps maximum
 * - @min: keeps minimum
 * - replace/remove/other: incoming wins
 *
 * Returns null if existing wins (incoming should be dropped).
 */
export function consolidateFieldOp(existing: JSONPatchOp, incoming: JSONPatchOp): JSONPatchOp | null {
  // @txt ops compose using Delta.compose() — always merge, never replace
  if (incoming.op === '@txt' && existing.op === '@txt') {
    const composed = new Delta(existing.value).compose(new Delta(incoming.value));
    return { ...incoming, value: composed.ops };
  }

  // If a non-@txt op overwrites a @txt field (or vice versa), use LWW timestamp rules
  // (e.g., replace on a text field means the field is being replaced entirely)

  const combiner = combinableOps[incoming.op];

  // If incoming is combinable AND existing has same op type, combine
  if (combiner) {
    const op = existing.op === incoming.op ? incoming.op : existing.op;
    const value =
      existing.op === incoming.op
        ? combiner.combine(existing.value ?? 0, incoming.value ?? 0)
        : combiner.apply(existing.value ?? 0, incoming.value ?? 0);
    if (value === existing.value) {
      return null;
    }
    return { ...incoming, op, value };
  }

  // Soft ops never overwrite existing data
  if (isSoftOp(incoming)) {
    return null;
  }

  // For non-combinable ops: existing wins if newer
  if (isExistingNewer(existing.ts, incoming.ts)) {
    return null;
  }
  return incoming;
}

/**
 * Consolidates new ops with existing pending ops.
 * Returns ops to save and child paths to delete (when parent overwrites).
 */
export function consolidateOps(
  existingOps: JSONPatchOp[],
  newOps: JSONPatchOp[]
): { opsToSave: JSONPatchOp[]; pathsToDelete: string[]; opsToReturn: JSONPatchOp[] } {
  const opsToSave: JSONPatchOp[] = [];
  const pathsToDelete = new Set<string>();
  const existingByPath = new Map(existingOps.map(op => [op.path, op]));
  const opsToReturnMap = new Map<string, JSONPatchOp>();

  for (const newOp of newOps) {
    const existing = existingByPath.get(newOp.path);

    // Check if parent is primitive (invalid hierarchy)
    const fix = parentFixes(newOp.path, existingByPath);
    if (!Array.isArray(fix)) {
      if (!opsToReturnMap.has(fix.path)) opsToReturnMap.set(fix.path, fix);
      continue; // Skip this op, will send correction
    } else if (fix.length > 0) {
      fix.forEach(path => pathsToDelete.add(path));
    }

    if (existing) {
      // Consolidate with existing op
      const consolidated = consolidateFieldOp(existing, newOp);
      if (consolidated !== null) {
        opsToSave.push(consolidated);
      }
      // If null, existing wins - no change needed
    } else {
      // Soft ops should not overwrite when data already exists at this path
      if (isSoftOp(newOp)) {
        // Check if child paths exist in the map
        let dataExists = false;
        for (const existingPath of existingByPath.keys()) {
          if (existingPath.startsWith(newOp.path + '/')) {
            dataExists = true;
            break;
          }
        }
        // Check if a parent op's nested value covers this path
        if (!dataExists) {
          dataExists = pathExistsInParentOp(newOp.path, existingByPath);
        }
        if (dataExists) continue;
      }

      // Check if this op overwrites child paths (parent write deletes children)
      for (const existingPath of existingByPath.keys()) {
        if (existingPath.startsWith(newOp.path + '/')) {
          pathsToDelete.add(existingPath);
        }
      }
      opsToSave.push(newOp);
    }
  }

  return { opsToSave, pathsToDelete: Array.from(pathsToDelete), opsToReturn: Array.from(opsToReturnMap.values()) };
}

/**
 * Any delta ops that aren't combined in consolidateOps need to be converted to replace/remove ops.
 */
export function convertDeltaOps(ops: JSONPatchOp[]): JSONPatchOp[] {
  return ops.map(op => {
    if (op.op === 'remove') return op;
    const combiner = combinableOps[op.op];
    const value = typeof op.value === 'string' ? '' : 0;
    if (combiner) return { ...op, op: 'replace', value: combiner.apply(value, op.value) };
    return { ...op, op: 'replace', value: op.value };
  });
}

/**
 * Find if any parent of this path is a primitive value.
 * Returns the path of the primitive parent, or null if hierarchy is valid.
 */
function parentFixes(path: string, existing: Map<string, JSONPatchOp>): JSONPatchOp | string[] {
  let parent = path;
  const pathsToDelete: string[] = [];
  while (parent.lastIndexOf('/') > 0) {
    parent = parent.substring(0, parent.lastIndexOf('/'));
    const parentOp = existing.get(parent);
    if (parentOp) {
      if (parentOp.value === undefined || parentOp.op === 'remove') {
        pathsToDelete.push(parent);
      } else if (!isObject(parentOp.value)) {
        return parentOp;
      }
    }
  }
  return pathsToDelete;
}

/**
 * Walk up the path hierarchy checking if any parent op's nested value
 * contains data at the given path. For example, if path is '/person/name'
 * and there's an op at '/person' with value { name: { first: 'Bob' } },
 * this returns true because '/name' exists within that value.
 */
function pathExistsInParentOp(path: string, existingByPath: Map<string, JSONPatchOp>): boolean {
  let parent = path;
  while (parent.lastIndexOf('/') > 0) {
    parent = parent.substring(0, parent.lastIndexOf('/'));
    const parentOp = existingByPath.get(parent);
    if (parentOp && isObject(parentOp.value)) {
      const remainingKeys = path.substring(parent.length + 1).split('/');
      let current: any = parentOp.value;
      let found = true;
      for (const key of remainingKeys) {
        if (!isObject(current) || !(key in current)) {
          found = false;
          break;
        }
        current = current[key];
      }
      if (found) return true;
    }
  }
  return false;
}

/**
 * Check if an op is a soft write (explicit soft flag or implicit empty container add).
 * Soft ops should not overwrite existing data.
 */
function isSoftOp(op: JSONPatchOp): boolean {
  return op.soft === true || (op.op === 'add' && isEmptyContainer(op.value));
}

/**
 * Check if a value is an object (or array).
 */
function isObject(value: any): boolean {
  return value !== null && typeof value === 'object';
}
