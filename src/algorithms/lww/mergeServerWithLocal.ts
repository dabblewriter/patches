import { Delta } from '@dabble/delta';
import type { JSONPatchOp } from '../../json-patch/types.js';
import type { Change } from '../../types.js';
import { combinableOps } from './consolidateOps.js';

/**
 * Result of merging server changes with local ops.
 *
 * @property changes - The merged changes to apply to the doc.
 * @property updatedLocalOps - Local ops updated after merge (e.g., @txt deltas transformed
 *   against server deltas). Null if no local ops were modified (callers can skip updating the store).
 */
export interface MergeResult {
  changes: Change[];
  updatedLocalOps: JSONPatchOp[] | null;
}

/**
 * Merges server changes with local ops (sending + pending) for doc display.
 *
 * For paths that server touched:
 * - If local has a @txt op, use bidirectional Delta.transform() to merge.
 *   The server delta is transformed to apply on top of local pending, and
 *   the local pending is transformed to account for the server change.
 * - If local has a combinable delta op (@inc, @bit, @max, @min), apply it to server value
 * - If local has a non-delta op, keep server value (already committed)
 *
 * For paths server didn't touch:
 * - Keep local ops so they still apply to doc state
 *
 * @param serverChanges Changes received from server
 * @param localOps Local ops (sendingChange.ops + pendingOps) from the store
 * @returns MergeResult with changes to apply and optionally updated local ops
 */
export function mergeServerWithLocal(serverChanges: Change[], localOps: JSONPatchOp[]): MergeResult {
  if (localOps.length === 0) return { changes: serverChanges, updatedLocalOps: null };

  const localByPath = new Map(localOps.map(op => [op.path, op]));
  const serverPaths = new Set<string>();
  let localOpsModified = false;

  // Process server changes, merging with local delta ops
  const mergedChanges = serverChanges.map(change => {
    const mergedOps = change.ops.map(serverOp => {
      serverPaths.add(serverOp.path);
      const local = localByPath.get(serverOp.path);
      if (!local) return serverOp;

      // @txt: bidirectional Delta.transform()
      if (serverOp.op === '@txt' && local.op === '@txt') {
        const serverDelta = new Delta(serverOp.value);
        const localDelta = new Delta(local.value);

        // Transform server delta to apply on top of our pending local state
        const transformedServer = localDelta.transform(serverDelta, true);
        // Transform local pending to account for server's change
        const transformedLocal = serverDelta.transform(localDelta, false);

        // Update the local op with the transformed delta
        localByPath.set(serverOp.path, { ...local, value: transformedLocal.ops });
        localOpsModified = true;

        return { ...serverOp, value: transformedServer.ops };
      }

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

  // Build updated local ops if any were modified (e.g., @txt transforms)
  const updatedLocalOps = localOpsModified ? Array.from(localByPath.values()) : null;

  return { changes: mergedChanges, updatedLocalOps };
}
