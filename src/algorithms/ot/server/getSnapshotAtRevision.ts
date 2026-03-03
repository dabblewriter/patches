import { concatStreams, parseVersionState } from '../../../server/jsonReadable.js';
import type { OTStoreBackend } from '../../../server/types.js';
import type { PatchesSnapshot } from '../../../types.js';

/**
 * Finds the latest main version at or before the given revision and loads its raw state.
 */
async function getLatestMainVersion(store: OTStoreBackend, docId: string, beforeRev?: number) {
  const versions = await store.listVersions(docId, {
    limit: 1,
    reverse: true,
    startAfter: beforeRev ? beforeRev + 1 : undefined,
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
    endBefore: rev ? rev + 1 : undefined,
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
 */
export async function getSnapshotStream(store: OTStoreBackend, docId: string): Promise<ReadableStream<string>> {
  const { rawState, versionRev } = await getLatestMainVersion(store, docId);
  const statePayload: string | ReadableStream<string> = rawState ?? 'null';
  const changes = await store.listChanges(docId, { startAfter: versionRev });

  return concatStreams(`{"state":`, statePayload, `,"rev":${versionRev},"changes":`, JSON.stringify(changes), '}');
}
