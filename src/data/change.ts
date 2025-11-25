import { inc } from 'alphacounter';
import { createId } from 'crypto-id';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change, ChangeInput } from '../types.js';

/**
 * Create a change id for a given revision. Uses a random 4 character id, prefixed with a revision number string.
 * @param rev - The revision number.
 * @returns The change id.
 */
function createChangeId(rev: number) {
  return inc.from(rev) + createId(4);
}

export function createChange(ops: JSONPatchOp[], metadata?: Record<string, any>): ChangeInput;
export function createChange(baseRev: number, rev: number, ops: JSONPatchOp[], metadata?: Record<string, any>): Change;
export function createChange(
  baseRev: number | JSONPatchOp[],
  rev?: number | Record<string, any>,
  ops?: JSONPatchOp[],
  metadata?: Record<string, any>
) {
  if (typeof baseRev !== 'number' && typeof rev !== 'number') {
    return {
      id: createId(8),
      ops: baseRev,
      created: Date.now(),
      ...rev,
    };
  } else {
    return {
      id: createChangeId(rev as number),
      baseRev,
      rev,
      ops,
      created: Date.now(),
      ...metadata,
    };
  }
}
