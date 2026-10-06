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

let changeClientVersion: string | undefined;

/**
 * Record the version of this client on every change minted from now on, as `change.clientVersion`.
 *
 * Call it once during startup, before any document is opened — a change minted before the call
 * carries no version, and an unstamped change is indistinguishable from one written before the
 * field existed. Pass `undefined` to stop stamping.
 *
 * Patches treats the string as opaque: it stores it and hands it back. The point is that a
 * change's correct replay can depend on what its author's build did, and the log otherwise has
 * no record of that — see `ChangeInput.clientVersion` and
 * {@link padTextOverrunsFromClients}.
 */
export function setChangeClientVersion(version: string | undefined): void {
  changeClientVersion = version;
}

/** The version currently stamped on new changes, or `undefined` if none was set. */
export function getChangeClientVersion(): string | undefined {
  return changeClientVersion;
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
      // Spread last, so a caller re-minting an existing change (deriveNewChange) keeps the
      // original author's version rather than stamping this process's.
      ...(changeClientVersion !== undefined && { clientVersion: changeClientVersion }),
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
      ...(changeClientVersion !== undefined && { clientVersion: changeClientVersion }),
      ...metadata,
    } as Change;
  }
}
