import type { Op } from '@dabble/delta';
import { findLatestMainVersion } from '../algorithms/ot/server/getSnapshotAtRevision.js';
import { getStateAtRevision } from '../algorithms/ot/server/getStateAtRevision.js';
import { transformIncomingChangesWithFrame } from '../algorithms/ot/server/transformIncomingChanges.js';
import { breakChanges } from '../algorithms/ot/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import { toOps } from '../json-patch/ops/text.js';
import { createVersionMetadata } from '../data/version.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type {
  Branch,
  Change,
  CreateBranchMetadata,
  EditableBranchMetadata,
  ListBranchesOptions,
  MergeFrame,
} from '../types.js';
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

/** Default maximum branch changes committed per merge window. */
export const DEFAULT_MERGE_WINDOW_CHANGES = 2_000;

/** Default maximum serialized ops bytes per merge window — the window's second axis. */
export const DEFAULT_MERGE_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Backstop against a store that silently drops watermark writes (the loop's cursor check
 * breaks first in any real scenario). Far above any real branch at the default window size.
 */
const MAX_MERGE_WINDOWS = 500;

/**
 * Frames larger than this are not persisted — branch records live in stores with document
 * size limits. The merge still completes (the frame is carried in memory); only a resumed or
 * repeat merge pays the rebuild from the raw logs.
 */
const MAX_PERSISTED_FRAME_BYTES = 256 * 1024;

/** Page size for frame catch-up, alignment and guard reads. */
const FRAME_PAGE_CHANGES = 500;

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
  /**
   * Maximum branch changes committed per merge window. Windows keep a merge's reads, commit
   * batches, memory and CPU proportional to the window rather than to how long the branch has
   * been open. Defaults to {@link DEFAULT_MERGE_WINDOW_CHANGES}.
   */
  maxChangesPerMerge?: number;
  /**
   * Maximum serialized ops bytes per merge window — the second axis of the window bound
   * (`maxChangesPerMerge` caps document count; this caps memory for branches carrying large
   * changes). Passed to the store as a read hint (`ListChangesOptions.maxBytes`) and enforced
   * in memory after the read. Defaults to {@link DEFAULT_MERGE_WINDOW_BYTES}.
   */
  maxBytesPerMergeWindow?: number;
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

/**
 * The contiguous run of text a `@txt` delta inserts after at most leading retains — the shape of
 * a replayed seed piece. Pieces stored by older splitters are retain-less and prepend at position
 * 0; position-correct pieces retain to their slot first and insert there. A leading delete marks
 * an ordinary edit (no seed piece deletes), and anything after the run is irrelevant here — this
 * is only the cheap arming trigger; the segment walk decides.
 */
function seedShapedInsertText(value: unknown): string {
  const ops = toOps(value);
  if (!ops) return '';
  let text = '';
  for (const op of ops) {
    const insert = (op as { insert?: unknown }).insert;
    if (typeof insert === 'string') text += insert;
    else if (insert != null)
      text += EMBED_PLACEHOLDER; // embeds prepend content too
    else if (text)
      break; // a retain / delete ends the run
    else if ((op as { delete?: unknown }).delete != null) return ''; // leading delete: an ordinary edit
    // else: a leading retain — skip to where the piece inserts
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

  return (
    findInsertedDuplication(segments, minLength) ??
    // Formatted spans arrive as ADJACENT inserted fragments (bold/plain/italic), each shorter
    // than minLength on its own — coalesce same-provenance neighbours and look again so a
    // fragmented duplicate can't slip under the length gate. Second pass, not a replacement:
    // coalescing can also glue a duplicate to novel inserted text and hide it from the
    // exact-match checks, so the fragment-level pass keeps everything it caught before.
    findInsertedDuplication(coalesceSegments(segments), minLength)
  );
}

/** Merge adjacent segments of the same provenance into whole runs. */
function coalesceSegments(segments: TextSegment[]): TextSegment[] {
  const out: TextSegment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.original === segment.original) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

/** The inserted-run detection shared by the fragment-level and coalesced passes of {@link findDuplication}. */
function findInsertedDuplication(segments: TextSegment[], minLength: number): number | null {
  const originalRetained = segments
    .filter(s => s.original)
    .map(s => s.text)
    .join('');
  if (!originalRetained) return null;

  // Replayed-seed shape A — retain-less pieces (stored by older splitters) re-insert body text
  // ahead of the original content, which survives untouched. Flag a substantial inserted run
  // sitting ahead of all surviving original content that duplicates text still present in the
  // surviving spans. Anchoring to the head keeps a mid-document paste of repeated prose out of
  // scope, and requiring the original to survive lets trims, moves, re-pastes and undos net out.
  for (const segment of segments) {
    if (segment.original) break; // only the region ahead of all surviving original content
    if (segment.text.length >= minLength && originalRetained.includes(segment.text)) {
      return segment.text.length;
    }
  }

  // Replayed-seed shape B — position-correct pieces retain to their slot first, so replaying one
  // onto content it already seeded composes its insert IMMEDIATELY BEFORE the surviving copy of
  // the same text. Flag a substantial inserted run that the surviving original content resumes
  // with, verbatim. An ordinary paste lands after the text it copied or somewhere unrelated;
  // inserting a ≥minLength exact copy of precisely what follows it is the replay signature.
  let followingOriginal = originalRetained;
  for (const segment of segments) {
    if (segment.original) {
      followingOriginal = followingOriginal.slice(segment.text.length);
    } else if (segment.text.length >= minLength && followingOriginal.startsWith(segment.text)) {
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
 * Thrown when a windowed merge fails AFTER at least one window committed. The committed
 * prefix is real and visible on the source; the watermark points at it, so retrying the merge
 * resumes and completes rather than redoing. Consumers must not present this as "nothing was
 * changed" — that is only true of refusals raised before the first window (which throw their
 * original error, e.g. {@link MergeContentDuplicationError}).
 */
export class MergePartialProgressError extends Error {
  readonly code = 'MERGE_PARTIAL_PROGRESS';
  constructor(
    readonly branchId: string,
    /** Every change committed (and observed) before the failure, in rev order. */
    readonly committedChanges: Change[],
    /** The branch revision the merge is durably merged through. */
    readonly mergedThroughRev: number | undefined,
    override readonly cause: unknown
  ) {
    super(
      `Merge of branch ${branchId} failed after committing ${committedChanges.length} changes ` +
        `(merged through branch rev ${mergedThroughRev ?? 'unknown'}). The committed prefix is ` +
        `permanent; retrying the merge resumes and completes it. Cause: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = 'MergePartialProgressError';
  }
}

/**
 * Thrown when the merge frame cannot be aligned with the branch's change log: the source
 * carries committed merge rows whose branch changes no longer exist below the log's oldest
 * retained revision (a pruned/compacted branch log). This is permanent for the branch — the
 * raw ops the frame needs are gone — and needs operator attention rather than a retry.
 */
export class MergeFrameAlignmentError extends Error {
  readonly code = 'MERGE_FRAME_ALIGNMENT';
  constructor(
    readonly branchId: string,
    readonly missingIds: string[],
    detail: string
  ) {
    super(
      `Merge frame alignment failed for branch ${branchId}: ${detail} Retrying cannot succeed; ` +
        `the branch's raw change log no longer contains changes its committed merge rows reference ` +
        `(ids: ${missingIds.slice(0, 5).join(', ')}${missingIds.length > 5 ? ', …' : ''}).`
    );
    this.name = 'MergeFrameAlignmentError';
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
    const branches = await this.store.listBranches(docId, options);
    // The merge frame is server-internal working state and can run to 256KB; it must not ride
    // every branch-list sync to every client.
    return branches.map(branch => {
      if (!('mergeFrame' in branch)) return branch;
      const rest = { ...branch };
      delete rest.mergeFrame;
      return rest;
    });
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
   * Merges changes from a branch back into its source document, in bounded windows.
   *
   * Supports multiple merges — the branch stays open and `lastMergedRev` tracks
   * which branch revision was last merged. Subsequent merges only pick up new changes.
   *
   * All merge changes use `batchId: branchId` so that `commitChanges` never transforms
   * branch changes against each other (they share the same causal context).
   *
   * ## Windows and the merge frame
   *
   * At most `maxChangesPerMerge` changes (bounded on bytes too) commit per window, each
   * window as one atomic `saveChanges` batch, with `lastMergedRev` advancing after each — so
   * a merge's reads, writes, memory and CPU scale with the window and the source's
   * *concurrent* edits, never with how long the branch has been open.
   *
   * Correctness across windows rests on the **merge frame**: the source's concurrent
   * (foreign) changes re-expressed in the branch's frame — the advance half of the OT diamond
   * that `transformIncomingChanges` computes and a one-shot merge consumes implicitly via its
   * full queue. Committed foreign ops are stored in the frame they committed in; the branch's
   * earlier changes move where those ops land in the branch's frame, so a later window
   * transformed against the *raw* stored forms would land its ops at shifted offsets —
   * deleting or inserting the wrong characters (the pre-#66 lost-words shape). Each window
   * therefore lifts its slice through the frame, commits the lifted ops at the source tip (a
   * fast-forward — the commit-side read never grows), and advances the frame through the
   * slice's raw ops for the next window. The frame is persisted atomically with the watermark
   * (when it fits — see `MAX_PERSISTED_FRAME_BYTES`) and rebuilt from the raw logs otherwise.
   *
   * ## Retry and concurrency safety
   *
   * The commit and the watermark update are two writes, so a crash can land between them, and
   * nothing serializes two merges of the same branch. Safety comes from:
   *
   * 1. **Write-time id guard** — merged changes keep their original branch change ids, and
   *    the store's mandatory `[docId, change.id]` uniqueness (see
   *    `OTStoreBackend.saveChanges`) makes any re-send of already-committed changes resolve
   *    as a resend inside `commitChanges` instead of applying twice. The windowed commit's
   *    `baseRev` advances past earlier windows, so the read-side dedup cannot cover this —
   *    the store guard is load-bearing, not a backstop.
   * 2. **Frame catch-up** — a window finding its own committed rows above the frame's source
   *    position (a crash-resume's prefix, or a concurrent merge's windows) advances the frame
   *    through those rows' raw branch ops before proceeding, exactly as if it had committed
   *    them itself.
   * 3. **Watermark from the merged batch** — `lastMergedRev` is set to the highest branch rev
   *    actually read and committed, never the branch tip, so an edit landing on the branch
   *    mid-merge stays uncovered and is picked up by the next merge.
   * 4. **Forward-only watermark** — the update is a compare-and-set when the store supports
   *    `updateBranchIf` (see {@link advanceMergeWatermark}); a lost CAS drops the in-memory
   *    carry and the next window adopts the winner's persisted state.
   *
   * The content-duplication guard runs once, ahead of the first window, over the whole
   * unmerged batch — a refused merge leaves no side effects on the source document. A merge
   * that fails part-way (transient fault) leaves earlier windows committed and resumes on
   * retry rather than redoing; the source is never left mid-window.
   *
   * @param branchId - The ID of the branch document to merge.
   * @param options - Optional per-merge options (e.g. a content-duplication guard override).
   * @returns The server commit change(s) applied to the source document, across all windows —
   *   including a resumed crash's already-committed prefix.
   * @throws Error if branch not found, already closed/merged, or merge fails.
   */
  async mergeBranch(branchId: string, options?: MergeBranchOptions): Promise<Change[]> {
    // The guard decides refusal over the whole unmerged batch BEFORE any window commits
    // (streamed in pages — it never holds the branch's history in memory).
    await this.runContentDuplicationGuard(branchId, options?.contentDuplicationGuard);

    const committed: Change[] = [];
    const committedIds = new Set<string>();
    let carry: MergeCarry | undefined;
    let previousBranchRev: number | undefined;

    try {
      for (let window = 0; window < MAX_MERGE_WINDOWS; window++) {
        const result = await this.mergeBranchWindow(branchId, carry);
        if (!result) break;
        // A window after a lost CAS can re-encounter rows an earlier window already returned
        // (its catch-up replays from the adopted state) — the result must not repeat them.
        for (const change of result.changes) {
          if (committedIds.has(change.id)) continue;
          committedIds.add(change.id);
          committed.push(change);
        }
        carry = result.carry;
        // The cursor must move every window, or the next read returns the same changes and the
        // loop spins re-committing them. A store that silently drops the watermark write, or a
        // concurrent merge that regressed it, stops here with the work done so far. Completion
        // is detected by a window reading an empty slice (returning undefined above) — never by
        // a count heuristic, which a byte-trimmed or store-truncated read would fool.
        if (previousBranchRev !== undefined && result.branchRev <= previousBranchRev) break;
        previousBranchRev = result.branchRev;
      }
    } catch (error) {
      // A failure after the first window committed is NOT "nothing happened": the prefix is
      // permanent, the watermark points at it, and a retry resumes. Surface that distinctly
      // so consumers stop telling users the merge left no trace. A failure before anything
      // committed (including guard refusals, which run before the loop) throws unchanged.
      if (committed.length > 0) {
        throw new MergePartialProgressError(branchId, committed, previousBranchRev, error);
      }
      throw error;
    }
    return committed;
  }

  /**
   * Merge one window of a branch's unmerged changes; see {@link mergeBranch}. Returns
   * `undefined` when the branch has nothing left to merge (and nothing was resumed).
   */
  private async mergeBranchWindow(
    branchId: string,
    carry: MergeCarry | undefined
  ): Promise<{ changes: Change[]; branchRev: number; carry: MergeCarry | undefined } | undefined> {
    // Re-load per window: the previous window advanced the state this window starts from, and
    // a concurrent merge may have advanced it further — adopt whatever is current.
    const branch = await this.store.loadBranch(branchId);
    assertBranchExists(branch, branchId);
    const sourceDocId = branch.docId;
    const mergeBase = await this.resolveMergeBase(branch);

    // Establish the working frame. Prefer the in-memory carry while the branch record still
    // matches what this merge last wrote (frames too large to persist live only there);
    // otherwise adopt the persisted frame, or start empty at the merge base — fresh merges,
    // and legacy/oversized-frame branches whose already-merged spans the catch-up below
    // replays from the raw logs.
    let frame: WorkingFrame;
    if (carry && branch.lastMergedRev === carry.expectedWatermark) {
      frame = carry.frame;
    } else if (branch.mergeFrame && branch.mergeFrame.sourceRev >= mergeBase) {
      frame = parseFrame(branch.mergeFrame);
    } else {
      frame = { sourceRev: mergeBase, branchRev: (branch.contentStartRev ?? 2) - 1, programs: [] };
    }

    // 1. Catch the frame up to the source tip: fold foreign changes in commit order; advance
    //    through own committed merge rows via the branch's raw log. Crash resume, stale or
    //    missing frames, and concurrent merges all reduce to this one path.
    const resumed = await this.catchUpFrame(sourceDocId, branchId, frame);

    // 2. Read the next window of unmerged branch changes, bounded on both axes.
    const windowChanges = this.options.maxChangesPerMerge ?? DEFAULT_MERGE_WINDOW_CHANGES;
    const windowBytes = this.options.maxBytesPerMergeWindow ?? DEFAULT_MERGE_WINDOW_BYTES;
    let slice = await this.store.listChanges(branchId, {
      startAfter: frame.branchRev,
      limit: windowChanges,
      maxBytes: windowBytes,
    });
    slice = trimToByteBudget(slice, windowBytes);

    if (slice.length === 0) {
      // Nothing new to merge. Persist any progress the catch-up made (a pure resume), then
      // surface everything the catch-up observed so a retried merge still returns the full,
      // rev-dense result.
      const nextCarry = await this.persistMergeProgress(branch, frame);
      const resumedRows = byRev([...resumed.own, ...resumed.foreign]);
      if (resumedRows.length === 0) return undefined;
      return { changes: resumedRows, branchRev: frame.branchRev, carry: nextCarry };
    }

    const spanStart = frame.branchRev;
    const spanEnd = slice[slice.length - 1].rev;

    // 3. Lift the slice through the frame: its ops re-expressed at the source tip, and the
    //    frame advanced through the slice's raw ops for the window after this one.
    const { changes: lifted, advancedForeign } = transformIncomingChangesWithFrame(
      slice.map(change => ({ ...change })),
      frame.programs.map(toPseudoChange),
      frame.sourceRev
    );

    // Re-stamp for the source document context. baseRev is the source revision the lifted
    // ops are expressed at — normally the tip, so the commit fast-forwards and its read
    // stays empty. Original change ids are preserved: they are the identity the store's
    // write-time guard dedups a retried or concurrent re-send by.
    const changesToCommit = lifted.map((change, i) => ({
      ...change,
      baseRev: frame.sourceRev,
      rev: frame.sourceRev + i + 1,
      batchId: branchId,
    }));

    // 4. Copy this window's versions before the commit (crash-orphans are adopted by the
    //    retry via their deterministic ids), mapped onto the claimed source revs.
    await this.copyBranchVersions(branchId, sourceDocId, spanStart, spanEnd, frame.sourceRev);

    // 5. Commit, then account for every result row in rev order. The result mixes our rows
    //    with foreign rows committed since `baseRev`, and the frame must end up covering
    //    (`sourceRev`) exactly the rows it folded — a row folded but not covered is re-folded
    //    by the next catch-up and every later window transforms through it twice.
    const sliceIds = new Set(slice.map(change => change.id));
    const windowCommitted: Change[] = [];
    const foldedForeign: Change[] = [];
    let accountedRev = frame.sourceRev;
    let carryInvalid = false;
    if (changesToCommit.length > 0) {
      const result = (
        await wrapMergeCommit(branchId, sourceDocId, async () => {
          return (await this.patchesServer.commitChanges(sourceDocId, changesToCommit)).changes;
        })
      ).sort((a, b) => a.rev - b.rev);

      // Walk rows in rev order, consuming the as-sent queue as our own rows pass: a foreign
      // row's stored ops already include every slice row committed BEFORE it (our rows it
      // interleaved after, or a concurrent merge's dedup'd copies of them), so it folds
      // through only the REMAINING as-sent suffix — and a foreign row after our last own row
      // appends raw. Consecutive foreign rows fold as one sequential program.
      let sentSuffix = changesToCommit as Change[];
      for (let i = 0; i < result.length; i++) {
        const row = result[i];
        if (sliceIds.has(row.id)) {
          windowCommitted.push(row);
          const idx = sentSuffix.findIndex(change => change.id === row.id);
          if (idx !== -1) sentSuffix = sentSuffix.slice(idx + 1);
          accountedRev = row.rev;
        } else if (row.batchId !== branchId) {
          let runEnd = i;
          while (
            runEnd + 1 < result.length &&
            !sliceIds.has(result[runEnd + 1].id) &&
            result[runEnd + 1].batchId !== branchId
          ) {
            runEnd++;
          }
          const run = result.slice(i, runEnd + 1);
          advancedForeign.push(
            ...advanceProgramsThroughQueue(
              run.map(r => r.ops),
              sentSuffix
            )
          );
          foldedForeign.push(...run);
          accountedRev = run[run.length - 1].rev;
          i = runEnd;
        } else {
          // A concurrent merge committed rows beyond our slice mid-window. The frame cannot
          // account for them (their raw branch ops are not in hand), so stop here: rows at
          // and above this one stay uncovered for the next catch-up to replay, and the carry
          // is stale. Never advance `accountedRev` past this point.
          carryInvalid = true;
          break;
        }
      }
    }

    // 6. Advance the frame past this window: expressed after the slice's raw ops, covering
    //    every source row accounted for above (so the next catch-up folds nothing twice).
    const nextFrame: WorkingFrame = {
      sourceRev: Math.max(frame.sourceRev, accountedRev),
      branchRev: spanEnd,
      programs: advancedForeign,
    };

    // 7. Persist watermark + frame atomically; a lost CAS means a concurrent merge won and
    //    the carry is stale either way.
    const nextCarry = await this.persistMergeProgress(branch, nextFrame);

    return {
      changes: byRev([...resumed.own, ...resumed.foreign, ...windowCommitted, ...foldedForeign]),
      branchRev: spanEnd,
      carry: carryInvalid ? undefined : nextCarry,
    };
  }

  /**
   * Fold the source's changes committed after `frame.sourceRev` into the frame, in log
   * order. Foreign rows append as programs (their committed ops are already expressed at the
   * frame's position); rows from this branch's own merge batch are earlier windows' commits —
   * the frame advances through their raw branch ops, read from the branch log, exactly as if
   * this call had committed them. Returns every row encountered, split into own committed
   * merge rows (a crash-resume's prefix) and foreign rows, so the merge result stays
   * rev-dense.
   */
  private async catchUpFrame(
    sourceDocId: string,
    branchId: string,
    frame: WorkingFrame
  ): Promise<{ own: Change[]; foreign: Change[] }> {
    const own: Change[] = [];
    const foreign: Change[] = [];
    for (;;) {
      const page = await this.store.listChanges(sourceDocId, {
        startAfter: frame.sourceRev,
        limit: FRAME_PAGE_CHANGES,
      });
      if (page.length === 0) return { own, foreign };
      for (let i = 0; i < page.length; i++) {
        const row = page[i];
        if (row.batchId === branchId) {
          // A contiguous run of rows wearing our batch id (runs may split across pages; the
          // alignment composes across the split). The alignment classifies impostors —
          // batchId is client-mintable — back to foreign.
          let runEnd = i;
          while (runEnd + 1 < page.length && page[runEnd + 1].batchId === branchId) runEnd++;
          const run = page.slice(i, runEnd + 1);
          const reclassified = await this.advanceFrameThroughOwnRun(branchId, frame, run);
          for (const r of run) (reclassified.has(r.id) ? foreign : own).push(r);
          i = runEnd;
        } else {
          frame.programs.push(row.ops);
          frame.sourceRev = row.rev;
          foreign.push(row);
        }
      }
      if (page.length < FRAME_PAGE_CHANGES) return { own, foreign };
    }
  }

  /**
   * Advance the frame through a run of committed rows wearing this branch's batch id. The
   * rows' ids identify branch changes directly after the frame's branch position; their RAW
   * ops (the committed rows hold post-transform forms) are read from the branch log. The raw
   * span may include changes with no committed row — a lift can obsolete a change to a no-op
   * — and their raws still advance the frame: the branch's program included them.
   *
   * `batchId` is client-mintable, so id membership in the branch log is the authoritative
   * classifier: a run row whose id is nowhere in the log is an ordinary foreign change
   * wearing our batch id — it folds into the frame as a program instead of wedging the merge.
   * Returns the reclassified-foreign ids. A genuine gap in the branch log (a pruned log whose
   * oldest retained rev is past the frame's position) throws {@link MergeFrameAlignmentError}:
   * the raw ops the frame needs are permanently gone.
   */
  private async advanceFrameThroughOwnRun(branchId: string, frame: WorkingFrame, run: Change[]): Promise<Set<string>> {
    const runIds = new Set(run.map(change => change.id));
    const matched = new Set<string>();
    const rawSpan: Change[] = [];
    let cursor = frame.branchRev;
    let matchedSpanLength = 0;
    scan: for (;;) {
      const page = await this.store.listChanges(branchId, { startAfter: cursor, limit: FRAME_PAGE_CHANGES });
      if (page.length === 0) break;
      if (rawSpan.length === 0 && page[0].rev > frame.branchRev + 1) {
        // Branch revs are contiguous by construction; a gap here means the log was pruned
        // below the changes these committed rows reference. Permanent — surface it as such.
        throw new MergeFrameAlignmentError(
          branchId,
          [...runIds],
          `the branch log resumes at rev ${page[0].rev}, past the frame's position (${frame.branchRev}).`
        );
      }
      for (const change of page) {
        cursor = change.rev;
        rawSpan.push(change);
        if (runIds.has(change.id)) {
          matched.add(change.id);
          matchedSpanLength = rawSpan.length;
          if (matched.size === runIds.size) break scan;
        }
      }
    }

    const impostors = new Set([...runIds].filter(id => !matched.has(id)));
    // Advance through the raw span covering the matched rows only; trailing raws past the
    // last match belong to later windows (or are trailing lift-noops the next slice re-reads
    // and re-drops harmlessly).
    const span = rawSpan.slice(0, matchedSpanLength);
    if (span.length > 0) {
      frame.programs = advanceProgramsThroughQueue(frame.programs, span);
      frame.branchRev = span[span.length - 1].rev;
    }
    // Impostors are ordinary foreign changes: fold their ops as programs, in run order after
    // the span (positionally approximate only in the adversarial interleaved case — a
    // client deliberately minting our branch id as its batchId).
    for (const row of run) {
      if (impostors.has(row.id)) frame.programs.push(row.ops);
      frame.sourceRev = row.rev;
    }
    return impostors;
  }

  /**
   * Persist the watermark and frame in one write (see {@link advanceMergeWatermark}). An
   * oversized frame is cleared instead of written — the pair must never diverge — and lives
   * on only in the returned carry. Returns the carry for the next window, or `undefined`
   * when a concurrent merge superseded this one.
   */
  private async persistMergeProgress(branch: Branch, frame: WorkingFrame): Promise<MergeCarry | undefined> {
    if (frame.branchRev <= (branch.lastMergedRev ?? 0)) {
      // Nothing newly covered — don't touch the record (or regress a concurrent advance).
      return { frame, expectedWatermark: branch.lastMergedRev };
    }
    // Persisted programs are a JSON string: the natural array-of-arrays shape is unwritable
    // as a field value in document stores like Firestore.
    const programs = JSON.stringify(frame.programs);
    const fits = programs.length <= MAX_PERSISTED_FRAME_BYTES;
    const applied = await advanceMergeWatermark(
      this.store,
      branch.id,
      branch.lastMergedRev,
      frame.branchRev,
      fits ? { sourceRev: frame.sourceRev, branchRev: frame.branchRev, programs } : null
    );
    return applied ? { frame, expectedWatermark: frame.branchRev } : undefined;
  }

  /**
   * Copy the branch's not-yet-copied versions whose span ends inside this window, mapped
   * into the source's rev-space at the window's claimed revs. Copies keep the branch
   * version's id, so a retried or concurrent merge adopts existing copies instead of
   * duplicating them, and a crash-orphaned copy is harmless.
   */
  private async copyBranchVersions(
    branchId: string,
    sourceDocId: string,
    spanStart: number,
    spanEnd: number,
    claimedBase: number
  ): Promise<void> {
    const branchVersions = await this.store.listVersions(branchId, {
      origin: 'main',
      orderBy: 'endRev',
      startAfter: spanStart,
      endBefore: spanEnd + 1,
    });
    if (branchVersions.length === 0) return;

    // Map branch-local revs onto the window's claimed source revs. Copied versions must live
    // in the source's rev-space: a branch-local endRev past the source tip would become the
    // source's version watermark and leave real source revs un-versioned. Claimed revs can
    // over-shoot the committed ones when a lift obsoletes changes — boundaries stay monotone
    // and inside the window, which is what version reads require.
    const toSourceRev = (rev: number) => claimedBase + Math.max(0, Math.min(rev, spanEnd) - spanStart);

    let lastVersionId: string | undefined;
    for (const v of branchVersions) {
      const alreadyCopied = await this.store.loadVersion(sourceDocId, v.id);
      if (alreadyCopied) {
        lastVersionId = v.id;
        continue;
      }
      const startRev = toSourceRev(v.startRev);
      // The first copy in a window chains to the previous window's latest copy for this
      // branch, falling back to the source's own timeline for the first window. Unanchored,
      // building its state replays the source document from rev 1.
      const parentId =
        lastVersionId ??
        (await this.latestBranchVersionCopyId(sourceDocId, branchId)) ??
        (await findLatestMainVersion(this.store, sourceDocId, startRev - 1))?.id;
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
  }

  /** The most recently copied version on the source for this branch, if any. */
  private async latestBranchVersionCopyId(sourceDocId: string, branchId: string): Promise<string | undefined> {
    const [latest] = await this.store.listVersions(sourceDocId, {
      origin: 'branch',
      groupId: branchId,
      orderBy: 'endRev',
      reverse: true,
      limit: 1,
    });
    return latest?.id;
  }

  /**
   * Opt-in guard against merges whose net effect would duplicate content the source document
   * already has. When a merge floor (`contentStartRev` / `lastMergedRev`) undercounts a
   * client-seeded branch's seed, the merge replays stored seed pieces onto content the source
   * already holds, doubling it — and it survives "reject all tracked changes", because the
   * duplicated content is the seed, not the tracked edits. Pieces stored by older splitters are
   * retain-less and re-insert at the head; position-correct pieces retain to their slot and
   * re-insert immediately before the surviving copy of the same text. Both shapes are guarded.
   *
   * Detection walks each affected text field through the whole batch — composing `@txt`
   * deltas and field-level `replace`/`add`/`remove` sets in order — against the source's
   * CURRENT head, tracking which spans of the head survive and which runs the batch inserts.
   * A field is flagged when any of:
   *
   * - the final content contains the field's current head content two or more times (a field
   *   set wholesale to an already-doubled value), or
   * - a substantial inserted run sitting ahead of all surviving head content duplicates text
   *   that still survives in the field — the retain-less replayed-seed shape, or
   * - a substantial inserted run that the surviving original content resumes with verbatim —
   *   the position-correct replayed-seed shape (the replayed copy lands immediately before
   *   the survivor it duplicates).
   *
   * Because retained and deleted spans are tracked through the whole batch, an edit that
   * merely trims, moves, re-pastes or undoes content nets out and is not flagged; and because
   * the comparison is against the current head (not the branch point), content the source no
   * longer holds cannot be "duplicated" on a repeat merge. Changes already committed inside
   * the merge's dedup window (`listChanges(startAfter: baseRev)`, the corpus `commitChanges`
   * dedups resends against) are excluded from the walk: a crash-retry or concurrent
   * double-merge re-presents a batch the head already contains, and walking it would
   * self-match every ordinary insert against its own committed copy.
   *
   * Cheap in the common case: the head is only reconstructed when some change carries a
   * substantial `@txt` insert run after at most leading retains, or sets a field to a
   * substantial delta value. Ordinary edits (leading deletes, short inserts) skip the check
   * entirely. A reconstruction failure propagates to the caller: with the guard enabled,
   * "cannot check" must not silently become "checked, fine" — a retryable read error is cheap
   * to retry, a doubled document is not.
   */
  private async runContentDuplicationGuard(
    branchId: string,
    override?: MergeBranchOptions['contentDuplicationGuard']
  ): Promise<void> {
    const configured = this.options.contentDuplicationGuard;
    const action = override === 'off' ? undefined : (override ?? configured?.action);
    if (!action) return;
    const minLength = configured?.minLength ?? DEFAULT_DUPLICATION_MIN_LENGTH;

    const branch = await this.store.loadBranch(branchId);
    assertBranchExists(branch, branchId);
    const sourceDocId = branch.docId;
    const mergeBase = await this.resolveMergeBase(branch);
    const startAfterBranch = branch.lastMergedRev ?? (branch.contentStartRev ?? 2) - 1;

    // A retry after a crash in the commit→watermark window re-walks changes the source has
    // already committed: every ordinary insert then sits immediately before its own committed
    // copy and self-matches the position-correct replay signature — refusing a merge the
    // retry contract promises dedups to a no-op (likewise a concurrent double-merge). The
    // commit dedups those resends via the store's write-time id guard; exclude the same
    // corpus here so the guard only walks changes the commit would apply. Bounded: rows above
    // the frame's source position are at most a crashed window plus the source's own edits.
    const sinceRev = branch.mergeFrame?.sourceRev ?? mergeBase;
    const committedIds = new Set<string>();
    for await (const page of this.pageChanges(sourceDocId, sinceRev)) {
      for (const row of page) committedIds.add(row.id);
    }

    // Arm pass, streamed: collect the text-field paths the batch touches and whether any
    // could produce the duplication signature — a `@txt` op that inserts a substantial run
    // after at most leading retains (the seed-piece shape, retain-less or position-correct),
    // or a field set to a substantial delta value.
    const paths = new Set<string>();
    let triggered = false;
    for await (const page of this.pageChanges(branchId, startAfterBranch)) {
      for (const change of page) {
        if (committedIds.has(change.id)) continue;
        for (const op of change.ops) {
          if (typeof op.path !== 'string') continue;
          if (op.op === '@txt') {
            paths.add(op.path);
            if (seedShapedInsertText(op.value).length >= minLength) triggered = true;
          } else if (op.op === 'replace' || op.op === 'add') {
            for (const found of collectDeltaTexts(op.value, op.path)) {
              paths.add(found.path);
              // Doubling via a set requires the value to hold the field's content twice.
              if (found.text.length >= minLength * 2) triggered = true;
            }
          }
        }
      }
    }
    if (!triggered) return;

    // Only now pay for a state reconstruction — the source's current head, read once.
    const { state } = await getStateAtRevision(this.store, sourceDocId, undefined, { reconstruction: {} });

    // Re-collect the resend corpus AFTER the reconstruction: a concurrent merge completing
    // between the first collection and the head read would otherwise leave its rows in the
    // head but out of the exclusion set, and every ordinary insert in the batch would
    // self-match against its own committed copy — a spurious refusal (TOCTOU).
    for await (const page of this.pageChanges(sourceDocId, sinceRev)) {
      for (const row of page) committedIds.add(row.id);
    }

    // Segment pass, streamed: walk every armed field through the whole batch in one sweep.
    // Per-field state is the field's text plus span bookkeeping — never the batch itself.
    const fields = new Map<string, { beforeText: string; segments: TextSegment[] }>();
    for (const path of paths) {
      const beforeText = fieldPlainText(valueAtPath(state, path));
      // Nothing substantial to duplicate: fields the branch introduced, or that the source
      // has since emptied, are left alone.
      if (beforeText == null || beforeText.length < minLength) continue;
      fields.set(path, { beforeText, segments: [{ text: beforeText, original: true }] });
    }
    if (fields.size === 0) return;

    for await (const page of this.pageChanges(branchId, startAfterBranch)) {
      for (const change of page) {
        if (committedIds.has(change.id)) continue;
        for (const op of change.ops) {
          for (const [path, field] of fields) {
            field.segments = applyOpToSegments(field.segments, op, path);
          }
        }
      }
    }

    for (const [path, field] of fields) {
      const duplicatedChars = findDuplication(field.beforeText, field.segments, minLength);
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

  /** Page through a doc's committed changes in rev order. */
  private async *pageChanges(docId: string, startAfter: number): AsyncGenerator<Change[]> {
    let cursor = startAfter;
    for (;;) {
      const page = await this.store.listChanges(docId, { startAfter: cursor, limit: FRAME_PAGE_CHANGES });
      if (page.length === 0) return;
      yield page;
      cursor = page[page.length - 1].rev;
      if (page.length < FRAME_PAGE_CHANGES) return;
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
   * later attempt prefers it. The base anchors the merge frame — it is where foreign folding
   * starts and where version rev-mapping is rooted — so it must be identical across retries
   * and server instances: a retry that recomputed `min(branchedAtRev, tip)` after the first
   * attempt's own commits advanced the tip would anchor a *different* frame and re-fold the
   * first attempt's rows as foreign. First writer wins via CAS when the store supports it.
   * (Merge retry idempotency itself rests on the store's write-time id guard — see
   * `OTStoreBackend.saveChanges` — not on the base: windowed commits advance `baseRev` past
   * earlier windows, so the read-side dedup window cannot cover them.)
   *
   * The healthy path (`branchedAtRev <= tip`) must also respect a pin it cannot see in its
   * own snapshot: a concurrent merge's commits may be exactly what advanced the tip past
   * `branchedAtRev`, so a merge whose branch snapshot predates that merge's pin would
   * otherwise take the early return with the higher base and anchor a different frame.
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
      // No CAS available: re-load and prefer an existing pin before writing, mirroring the
      // CAS-failure handler — blindly writing would re-pin over a concurrent merge's base and
      // anchor this merge's frame past foreign rows it never folded.
      const current = await this.store.loadBranch(branch.id);
      if (current?.mergeBaseRev != null) return current.mergeBaseRev;
      await this.store.updateBranch(branch.id, { mergeBaseRev: clamped, modifiedAt: Date.now() });
    }
    return clamped;
  }
}

/**
 * The in-memory form of {@link MergeFrame}: programs as op arrays rather than the persisted
 * JSON string.
 */
interface WorkingFrame {
  sourceRev: number;
  branchRev: number;
  programs: JSONPatchOp[][];
}

/** Parse a persisted frame into its working form. */
function parseFrame(frame: MergeFrame): WorkingFrame {
  return { sourceRev: frame.sourceRev, branchRev: frame.branchRev, programs: JSON.parse(frame.programs) };
}

/** Sort changes by rev ascending. */
function byRev(changes: Change[]): Change[] {
  return changes.sort((a, b) => a.rev - b.rev);
}

/** Working state a windowed merge carries between windows; see {@link OTBranchManager.mergeBranch}. */
interface MergeCarry {
  frame: WorkingFrame;
  /** The `lastMergedRev` this merge last wrote — the carry is stale if the record moved. */
  expectedWatermark: number | undefined;
}

/** Wrap a frame program as a pseudo-change for the transform walk. */
function toPseudoChange(ops: JSONPatchOp[], i: number): Change {
  return { id: `#frame-${i}`, rev: i + 1, baseRev: 0, ops, createdAt: 0, committedAt: 0 } as Change;
}

/**
 * Advance foreign op programs through a queue's ops — the walk's advance half alone, with the
 * transformed queue discarded (those changes are already committed, or already lifted).
 */
function advanceProgramsThroughQueue(programs: JSONPatchOp[][], queue: Pick<Change, 'ops'>[]): JSONPatchOp[][] {
  if (programs.length === 0 || queue.length === 0) return programs;
  return transformIncomingChangesWithFrame(
    queue.map((change, i) => ({ ...change, id: `#queue-${i}` }) as Change),
    programs.map(toPseudoChange),
    0
  ).advancedForeign;
}

/**
 * Enforce the window's byte budget for stores that ignore the `maxBytes` read hint. Always
 * keeps at least one change — a single change over budget must still merge.
 */
function trimToByteBudget(changes: Change[], maxBytes: number): Change[] {
  let bytes = 0;
  for (let i = 0; i < changes.length; i++) {
    bytes += JSON.stringify(changes[i].ops).length;
    if (bytes > maxBytes && i > 0) return changes.slice(0, i);
  }
  return changes;
}

// Re-export for backwards compatibility
export { assertBranchMetadata } from './branchUtils.js';
