import { applyBitmask, combineBitmasks } from '../../json-patch/ops/bitmask.js';
import type { JSONPatchOp } from '../../json-patch/types.js';

/**
 * Combiner for consolidating same-type ops on the same path.
 */
type Combiner = {
  apply: (a: any, b: any) => any;
  combine: (a: any, b: any) => any;
};

/**
 * Combinable operations - ops that can be merged rather than replaced.
 */
const combinableOps: Record<string, Combiner> = {
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
 * - @inc: sums values
 * - @bit: combines bitmasks
 * - @max: keeps maximum
 * - @min: keeps minimum
 * - replace/remove/other: incoming wins
 *
 * Returns null if existing wins (incoming should be dropped).
 */
export function consolidateFieldOp(existing: JSONPatchOp, incoming: JSONPatchOp): JSONPatchOp | null {
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
 * Any delta ops that aren't combined in consolidateOps need to be converted to replace ops.
 */
export function convertDeltaOps(ops: JSONPatchOp[]): JSONPatchOp[] {
  return ops.map(op => {
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
 * Check if a value is an object (or array).
 */
function isObject(value: any): boolean {
  return value !== null && typeof value === 'object';
}
