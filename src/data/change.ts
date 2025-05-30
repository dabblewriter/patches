import { inc } from 'alphacounter';
import { createId } from 'crypto-id';
import type { JSONPatchOp } from '../json-patch/types';
import type { Change } from '../types';

/**
 * Create a change id for a given revision. Uses a random 4 character id, prefixed with a revision number string.
 * @param rev - The revision number.
 * @returns The change id.
 */
function createChangeId(rev: number) {
  return inc.from(rev) + createId(4);
}

export function createChange(baseRev: number, rev: number, ops: JSONPatchOp[], metadata?: Record<string, any>): Change {
  return {
    id: createChangeId(rev),
    baseRev,
    rev,
    ops,
    created: Date.now(),
    ...metadata,
  };
}
