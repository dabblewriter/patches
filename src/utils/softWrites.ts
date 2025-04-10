import { Compact } from '../json-patch/compactPatch.js';
import type { CompactPatchOp } from '../types.js';
import { log } from './log.js';
import { mapAndFilterOps } from './ops.js';

export function isEmptyObject(value: any) {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length === 0);
}

/**
 * If other objects were added to this same path, assume they are maps/hashes/lookups and don't overwrite, allow
 * subsequent ops to merge onto the first map created. `soft` will also do this for any value that already exists.
 */
export function updateSoftWrites(overPath: string, ops: CompactPatchOp[]) {
  return mapAndFilterOps(ops, op => {
    if (Compact.getOp(op) === '+' && Compact.getPath(op) === overPath && isEmptyObject(Compact.getValue(op))) {
      log('Removing empty object', op);
      return null as any as CompactPatchOp;
    }
    return op;
  });
}
