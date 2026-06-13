import { concatStreams, parseVersionState } from '../../../server/jsonReadable.js';
import type { OTStoreBackend } from '../../../server/types.js';
import type { PatchesSnapshot } from '../../../types.js';

/**
 * Finds the latest main version at or before the given revision and loads its raw state.
 *
 * The search is bounded by `getCurrentRev`: a version can never legitimately sit
 * ahead of the committed change log. Without this bound an orphan version — e.g.
 * one left behind by a no-op offline commit, stamped at a rev that never actually
 * persisted — would be selected as the latest snapshot, making the snapshot report
 * a phantom rev and drop the real tail of changes (so `getDoc` would lie about the
 * document's head). When a target `beforeRev` is given we also clamp to it so a
 * caller asking for a past state never gets a version from beyond that point.
 */
async function getLatestMainVersion(store: OTStoreBackend, docId: string, beforeRev?: number) {
  const currentRev = await store.getCurrentRev(docId);
  const upperBound = beforeRev != null ? Math.min(beforeRev, currentRev) : currentRev;
  const versions = await store.listVersions(docId, {
    limit: 1,
    reverse: true,
    endBefore: upperBound + 1,
    origin: 'main',
    orderBy: 'endRev',
  });
  const version = versions[0];
  return {
    rawState: version ? await store.loadVersionState(docId, version.id) : undefined,
    versionRev: version?.endRev ?? 0,
  };
}

/**
 * Retrieves the document state of the version before the given revision and changes after up to that revision or all
 * changes since that version.
 *
 * Note: This is NOT used in the hot path (commitChanges). It's used by explicit operations
 * like captureCurrentVersion and createBranch that need the parsed state.
 *
 * @param docId The document ID.
 * @param rev The revision number. If not provided, the latest state, its revision, and all changes since are returned.
 * @returns The document state at the last version before the revision, its revision number, and all changes up to the specified revision (or all changes if no revision is provided).
 */
export async function getSnapshotAtRevision(
  store: OTStoreBackend,
  docId: string,
  rev?: number
): Promise<PatchesSnapshot> {
  const { rawState, versionRev } = await getLatestMainVersion(store, docId, rev);
  const versionState = rawState ? await parseVersionState(rawState) : null;

  // Get *all* changes since that version up to the target revision (if specified)
  const changesSinceVersion = await store.listChanges(docId, {
    startAfter: versionRev,
    endBefore: rev != null ? rev + 1 : undefined,
  });

  return {
    state: versionState,
    rev: versionRev,
    changes: changesSinceVersion,
  };
}

/**
 * Returns a ReadableStream that streams the snapshot JSON envelope piece-by-piece:
 * `{"state":...,"rev":N,"changes":[...]}`.
 *
 * The version state (typically the largest payload) flows through as a raw
 * string from the store without parsing. Changes are stringified from the array.
 *
 * When `rev` is given, the snapshot reflects the document as of that revision:
 * the latest version at or before `rev`, plus the changes from there up to `rev`.
 * Omitted, it streams the current state with all changes since the latest version.
 */
export async function getSnapshotStream(
  store: OTStoreBackend,
  docId: string,
  rev?: number
): Promise<ReadableStream<string>> {
  const { rawState, versionRev } = await getLatestMainVersion(store, docId, rev);
  const statePayload: string | ReadableStream<string> = rawState ?? 'null';
  const changes = await store.listChanges(docId, {
    startAfter: versionRev,
    endBefore: rev != null ? rev + 1 : undefined,
  });

  return concatStreams(`{"state":`, statePayload, `,"rev":${versionRev},"changes":`, JSON.stringify(changes), '}');
}
