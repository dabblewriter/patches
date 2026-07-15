import { isStatusError } from '../../../net/error.js';
import { jsonReadable, parseVersionState } from '../../../server/jsonReadable.js';
import type { OTStoreBackend } from '../../../server/types.js';
import { isMissingVersionState } from '../../../server/utils.js';
import type { Change, PatchesState, VersionMetadata } from '../../../types.js';
import { applyChanges, applyChangesForReconstruction, type ReplayOptions } from '../shared/applyChanges.js';
import { findLatestMainVersion } from './getSnapshotAtRevision.js';

/**
 * Applies committed changes per the caller's replay options: strict by default,
 * skip-and-continue when the caller explicitly opted into reconstruction mode.
 */
function replayChanges<T>(state: T, changes: Change[], options?: ReplayOptions): T {
  return options?.reconstruction
    ? applyChangesForReconstruction(state, changes, options.reconstruction)
    : applyChanges(state, changes);
}

/**
 * How far up the parent chain to look for an ancestor with state before giving up and
 * replaying from rev 1: keeps a poisoned or unbuilt chain a bounded read.
 */
export const MAX_ANCESTOR_HOPS = 10;

/**
 * Resolves the version a build of `version` will chain from: the recorded `parentId`, else the
 * latest main version ending before `startRev` (bounded by the committed change log — see
 * {@link findLatestMainVersion}, so an orphan version stamped past the log is never selected).
 * A recorded parent whose snapshot overlaps the version's own range (`endRev` past
 * `startRev - 1`) already contains revs the build must exclude, so it is unusable and resolves
 * to `undefined` — the build replays from rev 1 instead.
 *
 * Metadata only, no state reads — cheap enough for dependency walks. Exported for
 * deferred-build backends: a builder draining pending versions must order builds with the same
 * resolution the build itself uses (see `loadParentState`), or the drain order and the built
 * states diverge.
 */
export async function resolveBuildParent(
  store: OTStoreBackend,
  docId: string,
  version: VersionMetadata
): Promise<VersionMetadata | undefined> {
  if (version.parentId) {
    const parent = await store.loadVersion(docId, version.parentId);
    if (parent && parent.endRev > version.startRev - 1) {
      console.warn(
        `Version ${version.id} of doc ${docId} has parent ${parent.id} whose endRev ${parent.endRev} overlaps its startRev ${version.startRev}; ignoring the parent.`
      );
      return undefined;
    }
    return parent;
  }
  if (version.startRev > 1) return findLatestMainVersion(store, docId, version.startRev - 1);
  return undefined;
}

/**
 * Loads the state of the version `version` chains from, and the rev it ends at.
 *
 * A version that starts past rev 1 with no recorded `parentId` is a bug in whatever wrote it:
 * every base state below is bridged from `parent.endRev`, so without a parent the bridge runs
 * from rev 0 and replays the document's *entire* history (unbounded, and on a large document
 * expensive enough to fail the read outright). Rather than do that silently, resolve the parent
 * the writer should have recorded. The state it yields is identical; the read is bounded.
 * A parent whose metadata exists but whose state is missing (a lost blob, or a deferred build
 * that hasn't landed) gets the same treatment through its own `parentId` chain, bounded by
 * {@link MAX_ANCESTOR_HOPS}.
 *
 * Returns undefined when there is no usable parent to chain from, leaving the caller to build
 * the base by replaying from rev 1; on a version past rev 1 that warns, since the replay is
 * the unbounded read chaining exists to avoid.
 */
async function loadParentState(
  store: OTStoreBackend,
  docId: string,
  version: VersionMetadata
): Promise<{ rawState: string | ReadableStream<string>; endRev: number } | undefined> {
  const loadPair = (id: string) => Promise.all([store.loadVersionState(docId, id), store.loadVersion(docId, id)]);
  const recordedParentId = version.parentId;
  let parentMeta = await resolveBuildParent(store, docId, version);
  let rawState: string | ReadableStream<string> | undefined;
  if (parentMeta) rawState = await store.loadVersionState(docId, parentMeta.id);

  // Parent metadata without state: walk the ancestor chain to the nearest version with state.
  // Missing is any falsy read (a zero-byte blob comes back '', never a valid state — see
  // isMissingVersionState). Each hop prefers the recorded parentId, but an ancestor that never
  // recorded one (startRev > 1) is resolved the same way the entry branch resolves the version's
  // own missing parent — otherwise a single stateless link with no parentId would drop straight
  // to full-history replay even with an intact earlier version right below it. A hop that fails
  // transiently degrades to the replay fallback (the replay runs off the change log, a separate
  // subsystem from the state blobs); a StatusError from the store is an authoritative retry
  // signal and propagates instead, so a deferred backend's "build in progress" reaches the client.
  const statelessParentId = parentMeta && isMissingVersionState(rawState) ? parentMeta.id : undefined;
  try {
    for (let hops = 0; parentMeta && isMissingVersionState(rawState) && hops < MAX_ANCESTOR_HOPS; hops++) {
      if (parentMeta.parentId) {
        [rawState, parentMeta] = await loadPair(parentMeta.parentId);
      } else if (parentMeta.startRev > 1) {
        // Resolved metadata is already in hand, so only its state needs loading — no re-fetch.
        const resolved = await findLatestMainVersion(store, docId, parentMeta.startRev - 1);
        if (!resolved) break;
        parentMeta = resolved;
        rawState = await store.loadVersionState(docId, resolved.id);
      } else {
        break; // reached the rev-1 origin with no state; fall through to the replay fallback
      }
    }
  } catch (error) {
    if (isStatusError(error)) throw error;
    console.warn(`Ancestor walk failed for version ${version.id} of doc ${docId}; replaying from rev 1.`, error);
    return;
  }

  if (parentMeta && !isMissingVersionState(rawState)) {
    // A parent whose snapshot extends into this version's own range can't be chained from: its
    // state already contains revs at or past startRev, so bridging (or fast-path streaming)
    // from it would serve too-new state. resolveBuildParent rejects a direct overlapping parent
    // and findLatestMainVersion caps endRev at startRev - 1, so this only catches ancestors
    // reached through the walk's recorded parentIds.
    if (parentMeta.endRev > version.startRev - 1) {
      console.warn(
        `Version ${version.id} of doc ${docId} has parent ${parentMeta.id} whose endRev ${parentMeta.endRev} overlaps its startRev ${version.startRev}; ignoring the parent and replaying from rev 1.`
      );
      return;
    }
    if (statelessParentId) {
      console.warn(
        `Version ${version.id} of doc ${docId} has parent ${statelessParentId} with no state; chaining to ancestor ${parentMeta.id} instead.`
      );
    } else if (!recordedParentId) {
      console.warn(
        `Version ${version.id} of doc ${docId} starts at rev ${version.startRev} with no parentId; chaining to ${parentMeta.id} rather than replaying from rev 1.`
      );
    }
    return { rawState, endRev: parentMeta.endRev };
  }

  if (version.startRev > 1) {
    console.warn(
      `Version ${version.id} of doc ${docId} (startRev ${version.startRev}) has no usable parent; building its state will replay the full history from rev 1.`
    );
  }
}

/**
 * Computes the document state at `version.startRev - 1`: the state just before
 * this version's changes begin.
 *
 * Loads the parent version's state (see {@link loadParentState}), then bridges any gap
 * between the parent's `endRev` and `version.startRev` by applying intermediate changes.
 * With no earlier version to chain from (first version ever), builds from scratch.
 *
 * @param store - The store backend.
 * @param docId - The document ID.
 * @param version - The version whose pre-state to compute.
 * @param options - Optional replay options; pass `{ reconstruction }` only when
 *   reconstructing settled history (see `applyChangesForReconstruction`).
 * @returns `{ state, rev }` at `version.startRev - 1`.
 */
export async function getBaseStateBeforeVersion(
  store: OTStoreBackend,
  docId: string,
  version: VersionMetadata,
  options?: ReplayOptions
): Promise<PatchesState> {
  const parent = await loadParentState(store, docId, version);
  let baseState: any = parent ? await parseVersionState(parent.rawState) : null;
  const baseRev = parent?.endRev ?? 0;

  // Bridge any gap between baseRev and version.startRev.
  if (baseRev < version.startRev - 1) {
    const gapChanges = await store.listChanges(docId, {
      startAfter: baseRev,
      endBefore: version.startRev,
    });
    if (gapChanges.length > 0) {
      baseState = replayChanges(baseState, gapChanges, options);
    }
  }

  return { state: baseState, rev: version.startRev - 1 };
}

/**
 * Returns the document state immediately before a version's changes begin,
 * as a ReadableStream.
 *
 * Fast path: when the parent state needs no modification (no gap between the
 * parent's `endRev` and `version.startRev`), the raw bytes are streamed
 * directly from the store without parsing.
 *
 * Slow path: when there is a gap, the parent state is parsed, intermediate
 * changes are applied, and the result is re-serialized.
 *
 * @param store - The store backend.
 * @param docId - The document ID.
 * @param version - The version whose pre-state to compute.
 * @param options - Optional replay options; pass `{ reconstruction }` only when
 *   reconstructing settled history (see `applyChangesForReconstruction`).
 * @returns A ReadableStream of the JSON state at `version.startRev - 1`.
 */
export async function getStateBeforeVersionAsStream(
  store: OTStoreBackend,
  docId: string,
  version: VersionMetadata,
  options?: ReplayOptions
): Promise<ReadableStream<string>> {
  const parent = await loadParentState(store, docId, version);

  if (parent) {
    const { rawState, endRev: baseRev } = parent;

    if (baseRev >= version.startRev - 1) {
      // No gap — stream raw bytes directly without parsing.
      return typeof rawState === 'string' ? jsonReadable(rawState) : rawState;
    }

    // Has gap — parse, apply changes, re-serialize.
    const baseState = await parseVersionState(rawState);
    const gapChanges = await store.listChanges(docId, {
      startAfter: baseRev,
      endBefore: version.startRev,
    });
    const state = gapChanges.length > 0 ? replayChanges(baseState, gapChanges, options) : baseState;
    return jsonReadable(JSON.stringify(state));
  }

  // No earlier version (first version ever) — build from scratch via gap changes.
  if (version.startRev > 1) {
    const gapChanges = await store.listChanges(docId, {
      startAfter: 0,
      endBefore: version.startRev,
    });
    if (gapChanges.length > 0) {
      return jsonReadable(JSON.stringify(replayChanges(null, gapChanges, options)));
    }
  }

  return jsonReadable('null');
}

/**
 * Builds the document state for a version by computing the base state
 * (via `getBaseStateBeforeVersion`) and applying the version's changes on top.
 *
 * Version builds replay committed history whose effects are already settled —
 * the committed head is the truth. Stores that must never fail a version build
 * over a historically-invalid op (committed long ago under lenient semantics)
 * should pass `{ reconstruction }` so such ops are skipped with telemetry
 * instead of aborting the build; the default remains strict.
 *
 * @param store - The store backend to load previous version state from.
 * @param docId - The document ID.
 * @param version - The version metadata.
 * @param changes - The changes included in this version.
 * @param options - Optional replay options; pass `{ reconstruction }` only when
 *   reconstructing settled history (see `applyChangesForReconstruction`).
 * @returns The built state for the version.
 */
export async function buildVersionState(
  store: OTStoreBackend,
  docId: string,
  version: VersionMetadata,
  changes: Change[],
  options?: ReplayOptions
): Promise<any> {
  const { state: baseState } = await getBaseStateBeforeVersion(store, docId, version, options);
  return replayChanges(baseState, changes, options);
}
