import { jsonReadable, parseVersionState } from '../../../server/jsonReadable.js';
import type { OTStoreBackend } from '../../../server/types.js';
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
 * Loads the state of the version `version` chains from, and the rev it ends at.
 *
 * A version that starts past rev 1 with no recorded `parentId` is a bug in whatever wrote it:
 * every base state below is bridged from `parent.endRev`, so without a parent the bridge runs
 * from rev 0 and replays the document's *entire* history — unbounded, and on a large document
 * expensive enough to fail the read outright. Rather than do that silently, resolve the parent
 * the writer should have recorded. The state it yields is identical; the read is bounded.
 *
 * Returns undefined when there is no usable parent to chain from — no earlier version exists,
 * the parent (recorded or resolved) can't be loaded, or the parent's snapshot overlaps this
 * version's range — leaving the caller to build the base by replaying from rev 1. Any of those
 * on a version past rev 1 warns, since that replay is the unbounded read chaining exists to avoid.
 */
async function loadParentState(
  store: OTStoreBackend,
  docId: string,
  version: VersionMetadata
): Promise<{ rawState: string | ReadableStream<string>; endRev: number } | undefined> {
  const recordedParentId = version.parentId;
  let parentMeta: VersionMetadata | undefined;
  let rawState: string | ReadableStream<string> | undefined;

  if (recordedParentId) {
    [rawState, parentMeta] = await Promise.all([
      store.loadVersionState(docId, recordedParentId),
      store.loadVersion(docId, recordedParentId),
    ]);
  } else if (version.startRev > 1) {
    // Resolve the parent the writer should have recorded. The resolved metadata is already in
    // hand, so only the state needs loading — no re-fetch that a transient miss could fail.
    parentMeta = await findLatestMainVersion(store, docId, version.startRev - 1);
    if (parentMeta) rawState = await store.loadVersionState(docId, parentMeta.id);
  }

  if (parentMeta && rawState !== undefined) {
    // A parent whose snapshot extends into this version's own range can't be chained from: its
    // state already contains revs at or past startRev, so bridging (or fast-path streaming)
    // from it would serve too-new state. Resolved parents can't overlap — findLatestMainVersion
    // caps endRev at startRev - 1 — so this only catches bad recorded parentIds.
    if (parentMeta.endRev > version.startRev - 1) {
      console.warn(
        `Version ${version.id} of doc ${docId} has parent ${parentMeta.id} whose endRev ${parentMeta.endRev} overlaps its startRev ${version.startRev}; ignoring the parent and replaying from rev 1.`
      );
      return;
    }
    if (!recordedParentId) {
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
