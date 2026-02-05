import type { JSONPatchOp } from '../../json-patch/types.js';
import type { Change } from '../../types.js';
import { combinableOps } from './consolidateOps.js';

/**
 * Merges server changes with local ops (sending + pending) for doc display.
 *
 * For paths that server touched:
 * - If local has a delta op (@inc, @bit, @max, @min), apply it to server value
 * - If local has a non-delta op, keep server value (already committed)
 *
 * For paths server didn't touch:
 * - Keep local ops so they still apply to doc state
 *
 * @param serverChanges Changes received from server
 * @param localOps Local ops (sendingChange.ops + pendingOps) from the store
 * @returns Changes to apply to the doc
 */
export function mergeServerWithLocal(serverChanges: Change[], localOps: JSONPatchOp[]): Change[] {
  if (localOps.length === 0) return serverChanges;

  const localByPath = new Map(localOps.map(op => [op.path, op]));
  const serverPaths = new Set<string>();

  // Process server changes, merging with local delta ops
  const mergedChanges = serverChanges.map(change => {
    const mergedOps = change.ops.map(serverOp => {
      serverPaths.add(serverOp.path);
      const local = localByPath.get(serverOp.path);
      if (!local) return serverOp;

      const combiner = combinableOps[local.op];
      if (!combiner) return serverOp; // Non-delta local op - server value already committed

      // Apply local delta to server value
      const mergedValue = combiner.apply(serverOp.value ?? 0, local.value ?? 0);

      // If server sent a remove but local has a delta, convert to replace
      // (delta ops can work on undefined, starting from 0)
      const mergedOp = serverOp.op === 'remove' ? 'replace' : serverOp.op;
      return { ...serverOp, op: mergedOp, value: mergedValue };
    });

    return { ...change, ops: mergedOps };
  });

  // Add local ops for paths not touched by server (they still need to apply)
  const untouchedLocalOps = localOps.filter(op => !serverPaths.has(op.path));
  if (untouchedLocalOps.length > 0 && mergedChanges.length > 0) {
    // Add to last change's ops
    const lastChange = mergedChanges[mergedChanges.length - 1];
    mergedChanges[mergedChanges.length - 1] = {
      ...lastChange,
      ops: [...lastChange.ops, ...untouchedLocalOps],
    };
  }

  return mergedChanges;
}
