import { combineBitmasks } from '../../json-patch/ops/bitmask.js';
import type { JSONPatchOp } from '../../json-patch/types.js';

/**
 * Combiner for consolidating same-type ops on the same path.
 */
type Combiner = (a: any, b: any) => any;

/**
 * Combinable operations - ops that can be merged rather than replaced.
 */
const combinableOps: Record<string, Combiner> = {
  '@inc': (a, b) => a + b,
  '@bit': combineBitmasks,
  '@max': (a, b) => (a > b ? a : b),
  '@min': (a, b) => (a < b ? a : b),
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
  if (combiner && existing.op === incoming.op) {
    const value = combiner(existing.value ?? 0, incoming.value ?? 0);
    if (value === existing.value) {
      return null;
    }
    return { ...incoming, value };
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
): { opsToSave: JSONPatchOp[]; pathsToDelete: string[] } {
  const opsToSave: JSONPatchOp[] = [];
  const pathsToDelete: string[] = [];
  const existingByPath = new Map<string, JSONPatchOp>();

  for (const op of existingOps) {
    existingByPath.set(op.path, op);
  }

  for (const newOp of newOps) {
    const existing = existingByPath.get(newOp.path);

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
          pathsToDelete.push(existingPath);
        }
      }
      opsToSave.push(newOp);
    }
  }

  return { opsToSave, pathsToDelete };
}
