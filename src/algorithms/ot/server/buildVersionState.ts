import { jsonReadable, parseVersionState } from '../../../server/jsonReadable.js';
import type { OTStoreBackend } from '../../../server/types.js';
import type { Change, PatchesState, VersionMetadata } from '../../../types.js';
import { applyChanges } from '../shared/applyChanges.js';

/**
 * Computes the document state at `version.startRev - 1`: the state just before
 * this version's changes begin.
 *
 * Uses `version.parentId` (via `store.loadVersion`) when available for
 * an efficient cached lookup. After loading the parent state, bridges any gap
 * between the parent's `endRev` and `version.startRev` by applying intermediate
 * changes. When no parentId exists (first version ever), builds from scratch.
 *
 * @param store - The store backend.
 * @param docId - The document ID.
 * @param version - The version whose pre-state to compute.
 * @returns `{ state, rev }` at `version.startRev - 1`.
 */
export async function getBaseStateBeforeVersion(
  store: OTStoreBackend,
  docId: string,
  version: VersionMetadata
): Promise<PatchesState> {
  let baseState: any = null;
  let baseRev = 0;

  if (version.parentId) {
    const [rawState, parentMeta] = await Promise.all([
      store.loadVersionState(docId, version.parentId),
      store.loadVersion(docId, version.parentId),
    ]);
    if (parentMeta && rawState !== undefined) {
      baseState = await parseVersionState(rawState);
      baseRev = parentMeta.endRev;
    }
  }

  // Bridge any gap between baseRev and version.startRev.
  if (baseRev < version.startRev - 1) {
    const gapChanges = await store.listChanges(docId, {
      startAfter: baseRev,
      endBefore: version.startRev,
    });
    if (gapChanges.length > 0) {
      baseState = applyChanges(baseState, gapChanges);
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
 * @returns A ReadableStream of the JSON state at `version.startRev - 1`.
 */
export async function getStateBeforeVersionAsStream(
  store: OTStoreBackend,
  docId: string,
  version: VersionMetadata
): Promise<ReadableStream<string>> {
  if (version.parentId) {
    const [rawState, parentMeta] = await Promise.all([
      store.loadVersionState(docId, version.parentId),
      store.loadVersion(docId, version.parentId),
    ]);

    if (parentMeta && rawState !== undefined) {
      const baseRev = parentMeta.endRev;

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
      const state = gapChanges.length > 0 ? applyChanges(baseState, gapChanges) : baseState;
      return jsonReadable(JSON.stringify(state));
    }
  }

  // No parentId (first version ever) — build from scratch via gap changes.
  if (version.startRev > 1) {
    const gapChanges = await store.listChanges(docId, {
      startAfter: 0,
      endBefore: version.startRev,
    });
    if (gapChanges.length > 0) {
      return jsonReadable(JSON.stringify(applyChanges(null, gapChanges)));
    }
  }

  return jsonReadable('null');
}

/**
 * Builds the document state for a version by computing the base state
 * (via `getBaseStateBeforeVersion`) and applying the version's changes on top.
 *
 * @param store - The store backend to load previous version state from.
 * @param docId - The document ID.
 * @param version - The version metadata.
 * @param changes - The changes included in this version.
 * @returns The built state for the version.
 */
export async function buildVersionState(
  store: OTStoreBackend,
  docId: string,
  version: VersionMetadata,
  changes: Change[]
): Promise<any> {
  const { state: baseState } = await getBaseStateBeforeVersion(store, docId, version);
  return applyChanges(baseState, changes);
}
