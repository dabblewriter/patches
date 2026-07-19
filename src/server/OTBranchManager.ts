import type { Op } from '@dabble/delta';
import { findLatestMainVersion } from '../algorithms/ot/server/getSnapshotAtRevision.js';
import { getStateAtRevision } from '../algorithms/ot/server/getStateAtRevision.js';
import { breakChanges } from '../algorithms/ot/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import { toOps } from '../json-patch/ops/text.js';
import { createVersionMetadata } from '../data/version.js';
import type { Branch, Change, CreateBranchMetadata, EditableBranchMetadata, ListBranchesOptions } from '../types.js';
import type { BranchManager } from './BranchManager.js';
import {
  advanceMergeWatermark,
  assertBranchMetadata,
  assertBranchExists,
  assertNotABranch,
  branchManagerApi,
  createBranchRecord,
  generateBranchId,
  stripMergeWatermark,
  wrapMergeCommit,
} from './branchUtils.js';
import type { PatchesServer } from './PatchesServer.js';
import type { BranchingStoreBackend, OTStoreBackend } from './types.js';

/**
 * Combined store backend type for OT branch management.
 * Requires both OT operations and branch metadata operations.
 */
type OTBranchStore = OTStoreBackend & BranchingStoreBackend;

/**
 * Default minimum length in characters for a re-inserted run of existing text (or a doubled
 * field) to count as content *duplication* rather than a legitimate edit. Seed pieces that
 * double a document are storage-limit sized (kilobytes), while short repeated phrases are
 * ordinary prose — the default sits well between the two and is configurable per manager.
 */
const DEFAULT_DUPLICATION_MIN_LENGTH = 64;

/** Object-replacement character standing in for embeds — never matches real text. */
const EMBED_PLACEHOLDER = '￼';

/** Options for the opt-in content-duplication merge guard. */
export interface ContentDuplicationGuardOptions {
  /**
   * What to do when a merge batch matches the duplication signature: `'refuse'` throws
   * {@link MergeContentDuplicationError} before anything is committed; `'warn'` logs and lets
   * the merge proceed.
   */
  action: 'refuse' | 'warn';
  /**
   * Minimum length in characters for a re-inserted run of existing text (or a doubled field)
   * to count as duplication. Shorter matches are treated as ordinary edits. Defaults to 64.
   */
  minLength?: number;
}

/** Options for {@link OTBranchManager}. */
export interface OTBranchManagerOptions {
  /** Per-change payload limit in bytes used to split server-materialized branch seeds. */
  maxPayloadBytes?: number;
  /**
   * Opt-in guard against merges whose net effect would duplicate content the source document
   * already has — the signature of a merge floor (`contentStartRev` / `lastMergedRev`) that
   * undercounts a client-seeded branch's seed, replaying seeded body text onto fields the
   * source already holds. Off by default: whether to refuse or merely log, and how much
   * duplicated text is meaningful, is policy that belongs to the consuming server.
   */
  contentDuplicationGuard?: ContentDuplicationGuardOptions;
}

/** Per-merge options for {@link OTBranchManager.mergeBranch}. */
export interface MergeBranchOptions {
  /**
   * Per-merge override for the content-duplication guard: `'off'` skips the check (e.g. a
   * deliberate re-merge the consumer has inspected and wants through), while `'refuse'` /
   * `'warn'` override the configured action for this merge only. Defaults to the manager's
   * configured guard.
   */
  contentDuplicationGuard?: 'refuse' | 'warn' | 'off';
}

/** The run of text a `@txt` delta prepends at position 0 (empty when it begins with retain/delete). */
function leadingInsertText(value: unknown): string {
  const ops = toOps(value);
  if (!ops) return '';
  let text = '';
  for (const op of ops) {
    const insert = (op as { insert?: unknown }).insert;
    if (typeof insert === 'string') text += insert;
    else if (insert != null)
      text += EMBED_PLACEHOLDER; // embeds prepend content too
    else break; // a retain / delete ends the leading prepend
  }
  return text;
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function escapePointerToken(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Read the value at a JSON-Pointer `path` (e.g. `/docs/<id>/body/content`) in a plain doc state. */
function valueAtPath(root: unknown, path: string): unknown {
  if (path === '') return root;
  let cur: unknown = root;
  // Only the first token (before the leading '/') is dropped: per RFC 6901 a later empty
  // token references the empty-string key, so it must be looked up, not skipped.
  for (const token of path.split('/').slice(1)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[unescapePointerToken(token)];
  }
  return cur;
}

/** Plain text of a run of delta ops: string inserts verbatim, embeds as a placeholder char. */
function plainText(ops: Op[]): string {
  let text = '';
  for (const op of ops) {
    const insert = (op as { insert?: unknown }).insert;
    if (typeof insert === 'string') text += insert;
    else if (insert != null) text += EMBED_PLACEHOLDER;
  }
  return text;
}

/** Plain text of a `@txt` field's current value (`Delta` / `{ ops }` / `Op[]`), or null if not a delta. */
function fieldPlainText(value: unknown): string | null {
  const ops = toOps(value);
  return ops ? plainText(ops) : null;
}

/**
 * Find every text delta at or under `value` (which `replace`/`add` ops carry), returning its
 * field path and plain text. Detection mirrors the change-batching seed splitter: an object
 * with an `ops` array containing inserts. A bare ops array only counts at the top level,
 * where it is the field value itself.
 */
function collectDeltaTexts(value: unknown, basePath: string): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  const visit = (val: unknown, path: string, top: boolean): void => {
    if (!val || typeof val !== 'object') return;
    if (Array.isArray(val)) {
      if (top && val.some(op => (op as { insert?: unknown }).insert !== undefined)) {
        found.push({ path, text: plainText(val as Op[]) });
      }
      return;
    }
    const ops = (val as { ops?: unknown }).ops;
    if (Array.isArray(ops) && ops.some(op => (op as { insert?: unknown }).insert !== undefined)) {
      found.push({ path, text: plainText(ops as Op[]) });
      return;
    }
    for (const [key, sub] of Object.entries(val)) {
      visit(sub, `${path}/${escapePointerToken(key)}`, false);
    }
  };
  visit(value, basePath, true);
  return found;
}

/**
 * A span of a text field's content during the batch walk, tagged with whether it survives
 * from the field's current head (`original`) or was inserted by the batch.
 */
interface TextSegment {
  text: string;
  original: boolean;
}

/** Apply one delta's ops to the segment list, preserving original/inserted provenance. */
function applyDeltaToSegments(segments: TextSegment[], ops: Op[]): TextSegment[] {
  const out: TextSegment[] = [];
  const rest = [...segments];

  // Take up to `n` chars off the front of `rest` as segments (clamped at the end of content).
  const take = (n: number): TextSegment[] => {
    const taken: TextSegment[] = [];
    while (n > 0 && rest.length > 0) {
      const seg = rest[0];
      if (seg.text.length <= n) {
        taken.push(seg);
        rest.shift();
        n -= seg.text.length;
      } else {
        taken.push({ text: seg.text.slice(0, n), original: seg.original });
        rest[0] = { text: seg.text.slice(n), original: seg.original };
        n = 0;
      }
    }
    return taken;
  };

  for (const op of ops) {
    const { retain, insert } = op as { retain?: unknown; insert?: unknown; delete?: unknown };
    if (typeof retain === 'number') {
      out.push(...take(retain)); // formatting-only retains keep the text as-is
    } else if (retain != null) {
      out.push(...take(1)); // embed retain
    } else if (typeof (op as { delete?: unknown }).delete === 'number') {
      take((op as { delete: number }).delete);
    } else if (typeof insert === 'string') {
      out.push({ text: insert, original: false });
    } else if (insert != null) {
      out.push({ text: EMBED_PLACEHOLDER, original: false });
    }
  }
  out.push(...rest); // implicit trailing retain
  return out.filter(s => s.text.length > 0);
}

/** Apply one JSON-Patch op to the tracked field `fieldPath`'s segment list. */
function applyOpToSegments(segments: TextSegment[], op: Change['ops'][number], fieldPath: string): TextSegment[] {
  const path = op.path;
  if (typeof path !== 'string') return segments;
  const atField = path === fieldPath;
  const atAncestor = !atField && fieldPath.startsWith(path === '' ? '/' : `${path}/`);

  if (op.op === '@txt') {
    if (!atField) return segments;
    const ops = toOps(op.value);
    return ops ? applyDeltaToSegments(segments, ops) : segments;
  }
  if (op.op === 'replace' || op.op === 'add') {
    if (!atField && !atAncestor) return segments;
    const value = atField ? op.value : valueAtPath(op.value, fieldPath.slice(path.length));
    const ops = toOps(value);
    // A set replaces the field wholesale: nothing of the head survives it.
    return ops ? [{ text: plainText(ops), original: false }] : [];
  }
  if (op.op === 'remove' && (atField || atAncestor)) return [];
  return segments;
}

/** Count non-overlapping occurrences of `needle` in `haystack` (capped at 2 — all we need). */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 2) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Decide whether the batch's net effect on a field duplicates its existing content, given the
 * field's head text and the segment list after walking the whole batch. Returns the size of
 * the duplicated run, or null when the batch is an ordinary edit.
 */
function findDuplication(beforeText: string, segments: TextSegment[], minLength: number): number | null {
  // A field left containing its entire prior content twice is doubled regardless of how the
  // batch arrived there (e.g. set wholesale to an already-doubled value).
  const afterText = segments.map(s => s.text).join('');
  if (countOccurrences(afterText, beforeText) >= 2) return beforeText.length;

  // The replayed-seed shape: stored seed pieces re-insert body text ahead of the original
  // content, which survives untouched. Flag a substantial inserted run sitting ahead of all
  // surviving original content that duplicates text still present in the surviving spans.
  // Anchoring to the head keeps a mid-document paste of repeated prose out of scope, and
  // requiring the original to survive lets trims, moves, re-pastes and undos net out.
  const originalRetained = segments
    .filter(s => s.original)
    .map(s => s.text)
    .join('');
  if (!originalRetained) return null;
  for (const segment of segments) {
    if (segment.original) break; // only the region ahead of all surviving original content
    if (segment.text.length >= minLength && originalRetained.includes(segment.text)) {
      return segment.text.length;
    }
  }
  return null;
}

/**
 * Thrown by {@link OTBranchManager.mergeBranch} when the content-duplication guard is
 * configured with `action: 'refuse'` and a merge batch would duplicate a field's existing
 * content — the signature of a merge floor that undercounts a client-seeded branch's seed,
 * replaying seeded body text onto a field the source already holds. Refusing keeps the merge
 * from silently doubling the document; merges are idempotent, so a corrected retry can
 * proceed (or the consumer can re-run with the per-merge `'off'` override after inspection).
 */
export class MergeContentDuplicationError extends Error {
  readonly code = 'MERGE_CONTENT_DUPLICATION';
  constructor(
    readonly sourceDocId: string,
    readonly path: string,
    readonly duplicatedChars: number
  ) {
    super(
      `Merge aborted: committing this batch would duplicate ${duplicatedChars} chars of ` +
        `existing content at "${path}" of ${sourceDocId} (content-doubling signature — the ` +
        `merge floor likely undercounts the branch's seed; refusing to corrupt the document).`
    );
    this.name = 'MergeContentDuplicationError';
  }
}

/**
 * OT-specific branch manager implementation.
 *
 * Manages branches for documents using Operational Transformation semantics:
 * - Creates branches at specific revision points
 * - Uses fast-forward merge when possible (no concurrent changes on source)
 * - Transforms individual branch changes against concurrent source changes for divergent histories
 *
 * A branch is a document that originates from another document at a specific revision.
 * Its first version represents the source document's state at that revision.
 * Branches allow parallel development with the ability to merge changes back.
 */
export class OTBranchManager implements BranchManager {
  static api = branchManagerApi;

  private readonly options: OTBranchManagerOptions;

  constructor(
    private readonly store: OTBranchStore,
    private readonly patchesServer: PatchesServer,
    options?: number | OTBranchManagerOptions
  ) {
    // The third parameter was historically just `maxPayloadBytes`; both forms are accepted.
    this.options = typeof options === 'number' ? { maxPayloadBytes: options } : (options ?? {});
  }

  /**
   * Lists all open branches for a document.
   * @param docId - The ID of the document.
   * @param options - Optional filtering options (e.g. `since` for incremental sync).
   * @returns The branches.
   */
  async listBranches(docId: string, options?: ListBranchesOptions): Promise<Branch[]> {
    return await this.store.listBranches(docId, options);
  }

  /**
   * Creates a new branch for a document.
   * @param docId - The ID of the document to branch from.
   * @param rev - The revision of the document to branch from.
   * @returns The ID of the new branch document.
   */
  async createBranch(docId: string, rev: number, metadata?: CreateBranchMetadata): Promise<string> {
    const branchDocId = metadata?.id ?? (await generateBranchId(this.store, docId));

    // Idempotent: if a branch with this ID already exists, return it as a no-op.
    // This handles retry-on-bad-connection scenarios.
    if (metadata?.id) {
      const existing = await this.store.loadBranch(branchDocId);
      if (existing) {
        if (existing.docId !== docId) {
          throw new Error(`Branch ${branchDocId} already exists for a different document`);
        }
        return branchDocId;
      }
    }

    await assertNotABranch(this.store, docId);

    const now = Date.now();

    let contentStartRev: number;

    if (metadata?.contentStartRev) {
      // Client supplied initial content as pending changes through normal sync flow.
      // contentStartRev tells us where user content begins (init changes are below it).
      contentStartRev = metadata.contentStartRev;
    } else {
      // Generate init changes from the source state at the branch point.
      // Materializing the branch point replays settled, committed source history
      // (reconstruction, not live apply): an invalid committed op from a
      // lenient-era commit is skipped — matching what version builds and
      // pre-strict clients computed for the same log — rather than making the
      // source doc permanently un-branchable. Skips log via console.error.
      const { state: stateAtRev } = await getStateAtRevision(this.store, docId, rev, { reconstruction: {} });
      const rootReplace = createChange(0, 1, [{ op: 'replace' as const, path: '', value: stateAtRev }], {
        createdAt: now,
        committedAt: now,
      });
      const { maxPayloadBytes } = this.options;
      const initChanges = maxPayloadBytes ? breakChanges([rootReplace], maxPayloadBytes) : [rootReplace];
      contentStartRev = initChanges[initChanges.length - 1].rev + 1;

      await this.store.saveChanges(branchDocId, initChanges);

      // Create an initial version representing the branch point (metadata + init changes, no state).
      // Stamped with branch-local revs: cold loads pick the latest 'main' version by endRev in the
      // branch's own rev-space (init changes start at rev 1), so stamping the source's rev here
      // would hide the first branch changes once the branch's rev count reaches branchedAtRev.
      const initialVersionMetadata = createVersionMetadata({
        origin: 'main',
        startedAt: now,
        endedAt: now,
        endRev: initChanges[initChanges.length - 1].rev,
        startRev: initChanges[0].rev,
        groupId: branchDocId,
        ...(metadata?.name !== undefined && { name: metadata.name }),
      });
      await this.store.createVersion(branchDocId, initialVersionMetadata, initChanges);
    }

    // Create the branch metadata record
    const branch = createBranchRecord(branchDocId, docId, rev, contentStartRev, metadata);
    await this.store.createBranch(branch);
    return branchDocId;
  }

  /**
   * Updates a branch's metadata.
   * @param branchId - The ID of the branch to update.
   * @param metadata - The metadata to update.
   */
  async updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void> {
    assertBranchMetadata(metadata);
    await this.store.updateBranch(branchId, { ...stripMergeWatermark(metadata), modifiedAt: Date.now() });
  }

  /**
   * Deletes a branch, replacing the record with a tombstone.
   */
  async deleteBranch(branchId: string): Promise<void> {
    await this.store.deleteBranch(branchId);
  }

  /**
   * Merges changes from a branch back into its source document.
   *
   * Supports multiple merges — the branch stays open and `lastMergedRev` tracks
   * which branch revision was last merged. Subsequent merges only pick up new changes.
   *
   * All merge changes use `batchId: branchId` so that `commitChanges` never transforms
   * branch changes against each other (they share the same causal context).
   *
   * ## Retry and concurrency safety
   *
   * The commit and the `lastMergedRev` update are two writes, so a crash or timeout can land
   * between them, and nothing serializes two merges of the same branch. Safety comes from
   * three properties rather than a transaction:
   *
   * 1. **Idempotent commit** — merged changes keep their original branch change ids, and the
   *    merge base (the server's id-dedup window) is stable across attempts (see
   *    {@link resolveMergeBase}), so a retry or concurrent merge re-sending the same changes
   *    dedups to a no-op inside `commitChanges` instead of applying them twice.
   * 2. **Watermark from the merged batch** — `lastMergedRev` is set to the highest branch rev
   *    in the batch actually read and committed, never the branch tip, so an edit landing on
   *    the branch mid-merge stays uncovered and is picked up by the next merge.
   * 3. **Forward-only watermark** — the update is a compare-and-set when the store supports
   *    `updateBranchIf` (see {@link advanceMergeWatermark}), so interleaved merges cannot
   *    regress the watermark; without the capability, legacy max-wins semantics apply.
   *
   * @param branchId - The ID of the branch document to merge.
   * @param options - Optional per-merge options (e.g. a content-duplication guard override).
   * @returns The server commit change(s) applied to the source document.
   * @throws Error if branch not found, already closed/merged, or merge fails.
   */
  async mergeBranch(branchId: string, options?: MergeBranchOptions): Promise<Change[]> {
    // Load and validate branch
    const branch = await this.store.loadBranch(branchId);
    assertBranchExists(branch, branchId);

    const sourceDocId = branch.docId;
    const branchStartRevOnSource = await this.resolveMergeBase(branch);

    // Get only unmerged changes: since lastMergedRev (if previously merged) or contentStartRev
    const startAfter = branch.lastMergedRev ?? (branch.contentStartRev ?? 2) - 1;
    const branchChanges = await this.store.listChanges(branchId, { startAfter });
    if (branchChanges.length === 0) {
      return [];
    }

    const lastBranchRev = branchChanges[branchChanges.length - 1].rev;

    // Re-stamp branch changes for source document context:
    // - baseRev: where the branch diverged from source (for transformation)
    // - batchId: prevents transformation against previously-merged branch changes
    // - Original change IDs preserved: they are the dedup identity that makes a retried or
    //   concurrent re-send of already-committed merge changes a no-op in commitChanges.
    const changesToCommit = branchChanges.map((c, i) => ({
      ...c,
      baseRev: branchStartRevOnSource,
      rev: branchStartRevOnSource + i + 1,
      batchId: branchId,
    }));

    // Opt-in guard: refuse or flag a merge whose net effect would duplicate content the
    // source already has — the signature of a merge floor that undercounts a client-seeded
    // branch's seed. Runs before the version copies below and the commit, so a refused merge
    // leaves no side effects on the source document.
    await this.checkContentDuplication(sourceDocId, changesToCommit, options?.contentDuplicationGuard);

    // Get not-yet-merged versions from the branch doc, using the same cursor as the changes
    // query — repeat merges must not re-copy versions already on the source. This also skips
    // the branch's initial version (the branch point already exists in source history) and
    // offline-branch versions.
    const branchVersions = await this.store.listVersions(branchId, {
      origin: 'main',
      orderBy: 'endRev',
      startAfter,
    });

    // Map branch-local revs onto the claimed source revs of the commit below. Copied versions
    // must live in the source's rev-space: a branch-local endRev past the source tip would
    // become the source's version watermark and leave real source revs un-versioned.
    const toSourceRev = (rev: number) => branchStartRevOnSource + Math.max(0, rev - startAfter);

    // Copy versions with a deterministic identity: the source copy keeps the branch version's
    // id (version ids are namespaced per doc, so there is no collision on the source). A
    // retried merge — the crash window is between the commit below and the watermark update —
    // or a concurrent merge of the same branch finds the existing copy and skips it instead of
    // minting a duplicate. Orphaned copies from a merge whose commit then failed are harmless
    // and are adopted by the retry the same way.
    let lastVersionId: string | undefined;
    for (const v of branchVersions) {
      const alreadyCopied = await this.store.loadVersion(sourceDocId, v.id);
      if (alreadyCopied) {
        lastVersionId = v.id;
        continue;
      }
      const startRev = toSourceRev(v.startRev);
      // The first copy has no earlier copy to chain to, so it anchors to the source's own
      // timeline. Unanchored, building its state replays the source document from rev 1.
      const parentId = lastVersionId ?? (await findLatestMainVersion(this.store, sourceDocId, startRev - 1))?.id;
      const copy = {
        ...v,
        origin: 'branch' as const,
        startRev,
        endRev: toSourceRev(v.endRev),
        groupId: branchId,
        parentId,
      };
      if (copy.parentId === undefined) delete copy.parentId;
      const changes = await this.store.loadVersionChanges?.(branchId, v.id);
      await this.store.createVersion(sourceDocId, copy, changes);
      lastVersionId = copy.id;
    }

    // Commit changes to source doc with error handling
    const committedMergeChanges = await wrapMergeCommit(branchId, sourceDocId, async () => {
      return (await this.patchesServer.commitChanges(sourceDocId, changesToCommit)).changes;
    });

    // Merge succeeded. Advance lastMergedRev to the last branch rev in the batch we actually
    // merged (never the branch tip — a concurrent branch edit past our snapshot must remain
    // mergeable). CAS-guarded against concurrent merges when the store supports it.
    await advanceMergeWatermark(this.store, branchId, branch.lastMergedRev, lastBranchRev);
    return committedMergeChanges;
  }

  /**
   * Opt-in guard against merges whose net effect would duplicate content the source document
   * already has. When a merge floor (`contentStartRev` / `lastMergedRev`) undercounts a
   * client-seeded branch's seed, the merge replays stored seed pieces as retain-less `@txt`
   * inserts, re-inserting each field's body ahead of content the source already holds and
   * doubling it — and it survives "reject all tracked changes", because the duplicated
   * content is the seed, not the tracked edits.
   *
   * Detection walks each affected text field through the whole batch — composing `@txt`
   * deltas and field-level `replace`/`add`/`remove` sets in order — against the source's
   * CURRENT head, tracking which spans of the head survive and which runs the batch inserts.
   * A field is flagged when either:
   *
   * - the final content contains the field's current head content two or more times (a field
   *   set wholesale to an already-doubled value), or
   * - a substantial inserted run sitting ahead of all surviving head content duplicates text
   *   that still survives in the field — the replayed-seed shape.
   *
   * Because retained and deleted spans are tracked through the whole batch, an edit that
   * merely trims, moves, re-pastes or undoes content nets out and is not flagged; and because
   * the comparison is against the current head (not the branch point), content the source no
   * longer holds cannot be "duplicated" on a repeat merge.
   *
   * Cheap in the common case: the head is only reconstructed when some change carries a
   * substantial leading `@txt` insert or sets a field to a substantial delta value. Ordinary
   * edits (leading retain, short inserts) skip the check entirely. A reconstruction failure
   * propagates to the caller: with the guard enabled, "cannot check" must not silently become
   * "checked, fine" — a retryable read error is cheap to retry, a doubled document is not.
   */
  private async checkContentDuplication(
    sourceDocId: string,
    changes: Change[],
    override?: MergeBranchOptions['contentDuplicationGuard']
  ): Promise<void> {
    const configured = this.options.contentDuplicationGuard;
    const action = override === 'off' ? undefined : (override ?? configured?.action);
    if (!action) return;
    const minLength = configured?.minLength ?? DEFAULT_DUPLICATION_MIN_LENGTH;

    // Cheap first pass: collect the text-field paths the batch touches and whether any of
    // them could produce the duplication signature — a `@txt` op that PREPENDS a substantial
    // run (no leading retain), or a field set to a substantial delta value.
    const paths = new Set<string>();
    let triggered = false;
    for (const change of changes) {
      for (const op of change.ops) {
        if (typeof op.path !== 'string') continue;
        if (op.op === '@txt') {
          paths.add(op.path);
          if (leadingInsertText(op.value).length >= minLength) triggered = true;
        } else if (op.op === 'replace' || op.op === 'add') {
          for (const found of collectDeltaTexts(op.value, op.path)) {
            paths.add(found.path);
            // Doubling via a set requires the value to hold the field's content twice.
            if (found.text.length >= minLength * 2) triggered = true;
          }
        }
      }
    }
    if (!triggered) return;

    // Only now pay for a state reconstruction — the source's current head, read once.
    const { state } = await getStateAtRevision(this.store, sourceDocId, undefined, { reconstruction: {} });

    for (const path of paths) {
      const beforeText = fieldPlainText(valueAtPath(state, path));
      // Nothing substantial to duplicate: fields the branch introduced, or that the source
      // has since emptied, are left alone.
      if (beforeText == null || beforeText.length < minLength) continue;

      let segments: TextSegment[] = [{ text: beforeText, original: true }];
      for (const change of changes) {
        for (const op of change.ops) {
          segments = applyOpToSegments(segments, op, path);
        }
      }

      const duplicatedChars = findDuplication(beforeText, segments, minLength);
      if (duplicatedChars == null) continue;

      if (action === 'refuse') {
        console.error(
          `[OTBranchManager] refusing merge into ${sourceDocId}: content-doubling signature at ` +
            `"${path}" — the batch re-inserts ${duplicatedChars} chars the field already contains.`
        );
        throw new MergeContentDuplicationError(sourceDocId, path, duplicatedChars);
      }
      console.warn(
        `[OTBranchManager] merge into ${sourceDocId} matches the content-doubling signature at ` +
          `"${path}" (${duplicatedChars} chars re-inserted); proceeding per guard action 'warn'.`
      );
    }
  }

  /**
   * Resolve the source revision to use as the merge base (`baseRev`) for a branch's merges.
   *
   * Healthy branches merge at `branchedAtRev`. A branch can carry a `branchedAtRev` that is
   * *ahead* of the source's committed tip — e.g. a migrated/re-synced document whose change
   * log was renumbered down under the branch record. Committing with a `baseRev` greater than
   * the source's current rev trips `commitChanges`' "baseRev ahead of server revision" guard,
   * so the base is clamped to the source tip: nothing exists between the tip and
   * `branchedAtRev`, so rebasing onto the real tip is correct.
   *
   * The clamped base is persisted as `mergeBaseRev` BEFORE anything is committed, and every
   * later attempt prefers it. This is what makes merge retries idempotent on clamped
   * branches: `commitChanges` dedups re-sent changes by id within
   * `listChanges(startAfter: baseRev)`, and the first attempt's own commits advance the
   * source tip past `branchedAtRev` — so a retry that recomputed `min(branchedAtRev, tip)`
   * would use a *higher* base, and the changes already committed below it would escape
   * deduplication and be applied twice. Pinning the base keeps the dedup window identical
   * across retries and server instances. First writer wins via CAS when the store supports it.
   *
   * The healthy path (`branchedAtRev <= tip`) must also respect a pin it cannot see in its
   * own snapshot: a concurrent merge's commits may be exactly what advanced the tip past
   * `branchedAtRev`, so a merge whose branch snapshot predates that merge's pin would
   * otherwise take the early return with the higher base and re-apply the committed changes.
   * Because the pin is written before anything is committed, on a strongly consistent store
   * any tip read that includes another merge's commits also observes its pin — so the healthy
   * path re-loads the branch record after the tip read and prefers a freshly pinned base.
   */
  private async resolveMergeBase(branch: Branch): Promise<number> {
    if (branch.mergeBaseRev != null) return branch.mergeBaseRev;

    const sourceCurrentRev = await this.store.getCurrentRev(branch.docId);
    if (branch.branchedAtRev <= sourceCurrentRev) {
      // The tip may have been advanced by a concurrent merge that pinned a clamped base
      // before committing; our snapshot predates the pin, so check for it fresh.
      const fresh = await this.store.loadBranch(branch.id);
      if (fresh?.mergeBaseRev != null) return fresh.mergeBaseRev;
      return branch.branchedAtRev;
    }

    const clamped = sourceCurrentRev;
    // The clamp only fires on a corrupted/renumbered source doc — exactly the
    // data-integrity case worth surfacing rather than merging silently.
    console.warn(
      `[OTBranchManager] branch ${branch.id} branchedAtRev (${branch.branchedAtRev}) is ahead of ` +
        `source ${branch.docId} currentRev (${sourceCurrentRev}); clamping merge base to ${clamped}`
    );

    if (this.store.updateBranchIf) {
      const applied = await this.store.updateBranchIf(
        branch.id,
        { mergeBaseRev: clamped, modifiedAt: Date.now() },
        { mergeBaseRev: undefined }
      );
      if (!applied) {
        // A concurrent merge pinned the base first (or the record changed) — theirs wins.
        const current = await this.store.loadBranch(branch.id);
        if (current?.mergeBaseRev != null) return current.mergeBaseRev;
      }
    } else {
      await this.store.updateBranch(branch.id, { mergeBaseRev: clamped, modifiedAt: Date.now() });
    }
    return clamped;
  }
}

// Re-export for backwards compatibility
export { assertBranchMetadata } from './branchUtils.js';
