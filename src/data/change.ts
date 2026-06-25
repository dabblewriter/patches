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
export function createChange(
  baseRev: number,
  rev: number,
  ops: JSONPatchOp[],
  metadata?: Record<string, any>,
  id?: string
): Change;
export function createChange(
  baseRev: number | JSONPatchOp[],
  rev?: number | Record<string, any>,
  ops?: JSONPatchOp[],
  metadata?: Record<string, any>,
  id?: string
): ChangeInput | Change {
  if (typeof baseRev !== 'number' && typeof rev !== 'number') {
    return {
      id: createId(8),
      ops: baseRev,
      createdAt: Date.now(),
      ...rev,
    } as ChangeInput;
  } else {
    return {
      // An explicit `id` lets a caller mint a stable id upstream (e.g. on a spoke,
      // before a hub RPC) so a retried submit reuses the same id and the server's
      // id-based dedup makes it idempotent. Falls back to the rev-derived id.
      id: id ?? createChangeId(rev as number),
      baseRev,
      rev,
      ops,
      createdAt: Date.now(),
      committedAt: 0, // Set to 0 for uncommitted changes; server sets actual timestamp on commit
      ...metadata,
    } as Change;
  }
}
