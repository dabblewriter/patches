import { signal } from 'easy-signal';
import { createChange } from '../../../data/change.js';
import type { JSONPatchOp } from '../../../json-patch/types.js';
import { UnsplittableChangeError } from '../../../net/error.js';
import type { Change } from '../../../types.js';

/**
 * Function that calculates the storage size of data.
 * Used by change batching to determine if changes need to be split.
 *
 * Import pre-built calculators from '@dabble/patches/compression':
 * - `compressedSizeBase64` - Uses actual LZ compression + base64
 * - `compressedSizeUint8` - Uses actual LZ compression to binary
 *
 * Or provide your own (e.g., ratio estimate):
 * ```typescript
 * const ratioEstimate = (data) => getJSONByteSize(data) * 0.5;
 * ```
 */
export type SizeCalculator = (data: unknown) => number;

/** Estimate JSON string byte size. */
export function getJSONByteSize(data: unknown): number {
  try {
    const stringified = JSON.stringify(data);
    return stringified ? new TextEncoder().encode(stringified).length : 0;
  } catch (e) {
    // Handle circular structures (from JSON.stringify) or other errors.
    console.error('Error calculating JSON size:', e);
    throw new Error('Error calculating JSON size', { cause: e });
  }
}

/** Why the splitter had no seam to cut an op on. */
export type OversizedOpReason =
  /** Op type has no splitter (not `@txt`, `replace` or `add`). */
  | 'op-type'
  /** A single delta op that isn't a string insert: an embed, or a retain that can't shrink. */
  | 'delta-op'
  /** A `replace`/`add` whose value is a string or array, not a structure to pull text out of. */
  | 'value-not-object'
  /** A `replace`/`add` object value with no text deltas to extract. */
  | 'value-no-text'
  /** A single code point of an insert (possibly a surrogate pair) that still measures over budget. */
  | 'insert-chunk';

/** An op the splitter could not break below the storage budget. */
export interface OversizedOpReport {
  /** The JSON Patch op type (`@txt`, `replace`, `add`, …). */
  op: string;
  path: string;
  /** Measured size of the op, by the caller's size calculator. */
  bytes: number;
  /** The budget it overshot. */
  maxBytes: number;
  /**
   * Which budget `maxBytes` is: `'storage'` for the per-change storage split
   * (`maxStorageBytes`, possibly compressed), `'payload'` for the wire re-split
   * (`maxPayloadBytes`, raw JSON). One op over both budgets reports once per pass — filter on
   * this to avoid double-counting in telemetry.
   */
  budget: 'storage' | 'payload';
  docId?: string;
  changeId?: string;
  /** True when the op went out anyway; false when it was refused with an `UnsplittableChangeError`. */
  emitted: boolean;
  reason: OversizedOpReason;
}

/**
 * Fires for every op the splitter cannot break below `maxStorageBytes`, whether it went out anyway
 * or was refused. Subscribe to route these to telemetry: an emitted one is a change riding above
 * the intended budget (fine until the store disagrees), a refused one is user work that can never
 * be saved.
 */
export const onOversizedOp = signal<(report: OversizedOpReport) => void>();

/** Options for splitting changes, beyond the byte budget itself. */
export interface ChangeSplitOptions {
  /**
   * Hard ceiling for an op the splitter cannot break apart. Below it an unsplittable op is emitted
   * as before (and reported via {@link onOversizedOp}); above it the split fails with an
   * `UnsplittableChangeError`. Defaults to `Infinity`, so every op is emitted, as it always was.
   *
   * Keep it well above `maxBytes`: that budget is a conservative split *target*, so refusing at it
   * would reject changes the store accepts happily. Set this to what the store genuinely rejects.
   */
  maxUnsplittableBytes?: number;
  /** Doc id, carried on {@link OversizedOpReport} for the consumer's telemetry. */
  docId?: string;
  /**
   * Which budget this split enforces, stamped on {@link OversizedOpReport}. Defaults to
   * `'storage'`; `breakChangesIntoBatches` stamps `'payload'` on its wire re-split.
   */
  budget?: 'storage' | 'payload';
}

/** Everything the recursive splitters need, threaded as one value. */
interface SplitContext extends Required<Pick<ChangeSplitOptions, 'maxUnsplittableBytes'>> {
  maxBytes: number;
  sizeCalculator?: SizeCalculator;
  docId?: string;
  changeId?: string;
  budget: 'storage' | 'payload';
  /**
   * Set on a {@link verifyPieces} re-split. The first pass already reported every op it had no
   * seam for, and a re-split walks those same ops again under a tighter budget — emitting again
   * would double-count one op in the consumer's telemetry. Refusal is unaffected:
   * `maxUnsplittableBytes` does not move between passes, so the emit/refuse decision is identical
   * either way.
   */
  resplit?: boolean;
}

/**
 * Break changes into smaller changes so that each change's storage size never exceeds `maxBytes`.
 *
 * - Splits first by JSON-Patch *ops*
 * - If an individual op is still too big and is a "@txt" op,
 *   split its Delta payload into smaller Deltas
 *
 * @param changes - The changes to break apart
 * @param maxBytes - Maximum storage size in bytes per change
 * @param sizeCalculator - Custom size calculator (e.g., for compressed size)
 * @param options - Unsplittable-op ceiling and reporting context
 * @throws {UnsplittableChangeError} When an op can't be split and exceeds `maxUnsplittableBytes`
 */
export function breakChanges(
  changes: Change[],
  maxBytes: number,
  sizeCalculator?: SizeCalculator,
  options?: ChangeSplitOptions
): Change[] {
  const results: Change[] = [];
  // Splitting one change into N pieces occupies N revs, so every change after it shifts up
  let revShift = 0;
  for (const change of changes) {
    const shifted = revShift ? { ...change, rev: change.rev + revShift } : change;
    const pieces = breakSingleChange(shifted, {
      maxBytes,
      sizeCalculator,
      maxUnsplittableBytes: options?.maxUnsplittableBytes ?? Infinity,
      docId: options?.docId,
      changeId: change.id,
      budget: options?.budget ?? 'storage',
    });
    revShift += pieces.length - 1;
    results.push(...pieces);
  }
  return results;
}

/**
 * Report an op the splitter ran out of seams on, and refuse it when it is past the point the store
 * will accept. Returning normally means "emit it anyway", exactly as before this guard existed.
 */
function guardUnsplittable(
  ctx: SplitContext,
  op: string,
  path: string,
  bytes: number,
  reason: OversizedOpReason
): void {
  const emitted = bytes <= ctx.maxUnsplittableBytes;
  if (!ctx.resplit) {
    onOversizedOp.emit({
      op,
      path,
      bytes,
      maxBytes: ctx.maxBytes,
      budget: ctx.budget,
      docId: ctx.docId,
      changeId: ctx.changeId,
      emitted,
      reason,
    });
  }
  if (!emitted) {
    throw new UnsplittableChangeError(op, path, bytes, ctx.maxUnsplittableBytes, {
      docId: ctx.docId,
      changeId: ctx.changeId,
    });
  }
  if (!ctx.resplit) {
    console.warn(`Oversized op ${op} at "${path}" is ${bytes} bytes and cannot be split; including it anyway`);
  }
}

/** Default wire batch size limit (1MB) */
const DEFAULT_MAX_PAYLOAD_BYTES = 1_000_000;

/**
 * Options for breaking changes into batches.
 */
export interface BreakChangesIntoBatchesOptions extends ChangeSplitOptions {
  /** Batch limit for wire (uncompressed JSON). Defaults to 1MB. */
  maxPayloadBytes?: number;
  /** Per-change storage limit. If exceeded, individual changes are split. */
  maxStorageBytes?: number;
  /** Custom size calculator for storage limit (e.g., compressed size). */
  sizeCalculator?: SizeCalculator;
}

/**
 * Break changes into batches for network transmission.
 *
 * Two distinct limits:
 * - `maxPayloadBytes`: Controls batch size for wire transmission (uses uncompressed JSON size)
 * - `maxStorageBytes`: Controls per-change splitting for backend storage (uses sizeCalculator if provided)
 *
 * @param changes - The changes to batch
 * @param options - Batching options (or just maxPayloadBytes for backward compatibility)
 */
export function breakChangesIntoBatches(
  changes: Change[],
  options?: BreakChangesIntoBatchesOptions | number
): Change[][] {
  // Support both old signature (number) and new signature (options object)
  const opts: BreakChangesIntoBatchesOptions =
    typeof options === 'number' ? { maxPayloadBytes: options } : (options ?? {});

  const maxPayloadBytes = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const { maxStorageBytes, sizeCalculator, maxUnsplittableBytes, docId } = opts;

  // First, split individual changes if they exceed storage limit
  let processedChanges = changes;
  if (maxStorageBytes) {
    processedChanges = breakChanges(changes, maxStorageBytes, sizeCalculator, { maxUnsplittableBytes, docId });
  }

  // If all changes fit in one batch, return as-is
  if (getJSONByteSize(processedChanges) < maxPayloadBytes) {
    return [processedChanges];
  }

  // The batch id marks every wire batch as one upload; the server's own-upload exemption
  // (commitChanges) lets later batches — and resends after a lost ack — continue past the
  // guards that protect existing docs from foreign baseRev-0 writes. Derive it from the
  // queue head's persisted change id rather than minting randomly: a retry then presents
  // the SAME upload identity it presented last time, even after a reload, so an interrupted
  // upload can resume instead of being refused forever (DAB-837). Derived before the wire
  // re-split below, whose pieces get fresh ids per call.
  const batchId = changes[0].id;

  // Split any change too large for one wire batch. Reachable even with maxStorageBytes set:
  // the storage pass may measure compressed bytes while this one measures raw JSON, so a change
  // under the storage budget can still exceed the wire cap. breakChanges renumbers the whole
  // queue so split pieces never collide with the revs that follow them. Reports from this pass
  // are stamped `budget: 'payload'` so telemetry can tell them from the storage pass's.
  processedChanges = breakChanges(processedChanges, maxPayloadBytes, undefined, { docId, budget: 'payload' });
  const batches: Change[][] = [];
  let currentBatch: Change[] = [];
  let currentSize = 2; // Account for [] wrapper

  for (const change of processedChanges) {
    // Add batchId if breaking up
    const item = { ...change, batchId };
    const itemActualSize = getJSONByteSize(item);
    const itemSizeForBatching = itemActualSize + (currentBatch.length > 0 ? 1 : 0);

    if (currentBatch.length > 0 && currentSize + itemSizeForBatching > maxPayloadBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSize = 2;
    }

    const actualItemContribution = itemActualSize + (currentBatch.length > 0 ? 1 : 0);
    currentBatch.push(item);
    currentSize += actualItemContribution;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Get the size of data for storage limit checking.
 * If a sizeCalculator is provided, uses it; otherwise returns JSON size.
 */
function getSizeForStorage(data: unknown, sizeCalculator?: SizeCalculator): number {
  if (sizeCalculator) {
    return sizeCalculator(data);
  }
  return getJSONByteSize(data);
}

/**
 * A piece compresses slightly worse than the change it came from — LZ builds a smaller dictionary
 * over less input — so the calibrated ratio below runs a little optimistic for the pieces it sizes.
 * Aim under the cap to absorb that.
 *
 * Getting this wrong is never a correctness problem: `verifyPieces` measures every emitted piece
 * with the real calculator. Too optimistic costs a re-split pass. Too pessimistic costs extra
 * seams — invisible in tests, which pin piece *counts* as deterministic but not their magnitude,
 * and it surfaces as revision-count inflation on a large split (a branch seed most of all). Prefer
 * nudging this down rather than up.
 */
const PIECE_COMPRESSION_MARGIN = 1.1;

/** How many times a piece may be re-split after the estimate proved optimistic. */
const MAX_VERIFY_PASSES = 3;

/** Budget tightening applied per re-split pass, so boundaries actually move. */
const VERIFY_TIGHTEN = 0.8;

/** JSON byte size of one op, memoised — boundary-finding asks for the same op repeatedly. */
const opJSONSizes = new WeakMap<object, number>();
function opJSONSize(op: unknown): number {
  if (!op || typeof op !== 'object') return getJSONByteSize(op);
  const cached = opJSONSizes.get(op as object);
  if (cached !== undefined) return cached;
  const size = getJSONByteSize(op);
  opJSONSizes.set(op as object, size);
  return size;
}

interface SizeEstimator {
  /** Estimated storage bytes for a payload of `jsonBytes` JSON bytes. */
  storage(jsonBytes: number): number;
  /** Largest JSON payload expected to stay within `storageBytes`. */
  jsonBudget(storageBytes: number): number;
}

/**
 * Cheap size model for choosing split points inside one change.
 *
 * Finding boundaries asks "does this still fit?" once per op — and once per delta op inside an
 * oversized text op. Answering each of those by actually compressing the accumulated payload makes
 * splitting O(ops × payload): a ~5MB whole-document change took ~187s synchronously, which freezes
 * the tab and takes the browser down with it (DAB-931). So measure the change once, derive how many
 * storage bytes one JSON byte costs, and answer the hot questions from per-op JSON sizes that are
 * each computed once.
 *
 * The estimate only chooses *where* to cut. Every emitted piece is measured for real by
 * `verifyPieces`, so a bad ratio costs an extra split, never an oversized change.
 *
 * With no `sizeCalculator` the ratio is exactly 1 and this reproduces `getJSONByteSize` byte for
 * byte, so the uncompressed path keeps its previous split boundaries exactly.
 */
function createSizeEstimator(orig: Change, exactSize: number, sizeCalculator?: SizeCalculator): SizeEstimator {
  const jsonSize = getJSONByteSize(orig);
  const ratio = jsonSize > 0 ? exactSize / jsonSize : 1;
  const perJSONByte = ratio * (sizeCalculator ? PIECE_COMPRESSION_MARGIN : 1);
  return {
    storage: jsonBytes => jsonBytes * perJSONByte,
    jsonBudget: storageBytes => (perJSONByte > 0 ? storageBytes / perJSONByte : storageBytes),
  };
}

/** JSON bytes of a change carrying `contentBytes` of ops content across `count` ops. */
function withOpsBytes(envelopeBytes: number, contentBytes: number, count: number): number {
  // The ops array's own brackets are already in the envelope; only the commas between the
  // elements are unaccounted for.
  return envelopeBytes + contentBytes + Math.max(0, count - 1);
}

/**
 * Confirm every piece really fits, and re-split the ones that don't.
 *
 * Boundaries come from an estimate (see {@link createSizeEstimator}), and an estimate can run
 * optimistic. This is the gate that makes that safe: each piece is measured with the real
 * calculator, and an oversized piece is re-split under a tighter budget. Without it an optimistic
 * estimate would emit a change over the store's per-change cap — which the backend answers with a
 * terminal error, permanently wedging that change.
 */
function verifyPieces(pieces: Change[], orig: Change, ctx: SplitContext, pass: number): Change[] {
  // Without a calculator the estimate is exact arithmetic over JSON sizes, so there is nothing for
  // a re-check to catch.
  if (!ctx.sizeCalculator || pass >= MAX_VERIFY_PASSES || pieces.length === 0) return pieces;

  let resplit = false;
  const checked: Change[] = [];
  for (const piece of pieces) {
    const size = piece.ops.length === 0 ? 0 : ctx.sizeCalculator(piece);
    if (size <= ctx.maxBytes) {
      checked.push(piece);
      continue;
    }
    resplit = true;
    const tightened: SplitContext = { ...ctx, maxBytes: Math.floor(ctx.maxBytes * VERIFY_TIGHTEN), resplit: true };
    checked.push(...breakSingleChange(piece, tightened, pass + 1, size));
  }
  if (!resplit) return pieces;

  // Re-splitting inserts revs, so renumber the run. The first piece keeps the original id for the
  // same reason `finish` assigns it.
  return checked.map((piece, i) => ({ ...piece, rev: orig.rev + i, id: i === 0 ? orig.id : piece.id }));
}

/**
 * Break a single Change into multiple Changes so that the storage size never exceeds `ctx.maxBytes`.
 *
 * @param verifyPass - Re-split depth; see {@link verifyPieces}
 * @param knownExactSize - The caller's own measurement of `orig`, when it already has one
 */
function breakSingleChange(orig: Change, ctx: SplitContext, verifyPass = 0, knownExactSize?: number): Change[] {
  // Measuring a whole-document change means compressing megabytes, so reuse the caller's
  // measurement when it already has one.
  const exactSize = knownExactSize ?? getSizeForStorage(orig, ctx.sizeCalculator);
  if (exactSize <= ctx.maxBytes) return [orig];

  const estimator = createSizeEstimator(orig, exactSize, ctx.sizeCalculator);
  const envelope = getJSONByteSize({ ...orig, ops: [] });

  // First pass: split by ops
  const byOps: Change[] = [];
  let group: JSONPatchOp[] = [];
  let groupBytes = 0;
  let rev = orig.rev;

  const finish = () => {
    // The first piece keeps the original change's id: retries look the change up by its
    // caller-supplied stable id, and the id must survive splitting for that linkage to hold
    if (byOps.length > 0) byOps[0] = { ...byOps[0], id: orig.id };
    return byOps;
  };

  const flush = () => {
    if (!group.length) return;
    byOps.push(deriveNewChange(orig, rev++, group));
    group = [];
    groupBytes = 0;
  };

  for (const op of orig.ops) {
    const opBytes = opJSONSize(op);

    if (
      group.length > 0 &&
      estimator.storage(withOpsBytes(envelope, groupBytes + opBytes, group.length + 1)) > ctx.maxBytes
    ) {
      flush();
    }

    // Handle the case where a single op is too large. The estimate decides whether to look; the
    // real calculator decides what to do, because `guardUnsplittable` reports and refuses on a
    // measured size. One real measurement per oversized op is bounded — it was measuring on
    // *every* op that made this quadratic.
    if (group.length === 0 && estimator.storage(withOpsBytes(envelope, opBytes, 1)) > ctx.maxBytes) {
      const soloSize = getSizeForStorage({ ...orig, ops: [op] }, ctx.sizeCalculator);
      if (soloSize > ctx.maxBytes) {
        // We have a single op that's too big - can only be @txt op with large delta
        if (op.op === '@txt' && op.value) {
          const pieces = breakTextOp(orig, op, rev, ctx, estimator);
          byOps.push(...pieces);
          // Only update rev if we got results from breakTextOp
          if (pieces.length > 0) {
            rev = pieces[pieces.length - 1].rev + 1; // Update rev for next changes
          }
          continue;
        } else if (op.op === 'replace' || op.op === 'add') {
          // For replace/add operations with large value payloads, try to split the value if it's a string or array
          const pieces = breakLargeValueOp(orig, op, rev, ctx);
          byOps.push(...pieces);
          if (pieces.length > 0) {
            rev = pieces[pieces.length - 1].rev + 1;
          }
          continue;
        } else {
          guardUnsplittable(ctx, op.op, op.path, soloSize, 'op-type');
          group.push(op);
          groupBytes += opBytes;
          continue;
        }
      }
    }

    group.push(op);
    groupBytes += opBytes;
  }

  flush();
  return verifyPieces(finish(), orig, ctx, verifyPass);
}

/**
 * Break a large @txt operation into multiple smaller operations.
 *
 * The pieces are SEQUENTIAL changes: each composes onto the document produced by the piece before
 * it, exactly as replay applies them. Ops keep their original coordinates only inside the first
 * piece; every later piece must first retain past everything the earlier pieces retained or
 * inserted (a delete occupies no width in the document it leaves behind), or its ops would land at
 * the head of the document. `pieceStartPos` is that cursor. The content past it is untouched by
 * the earlier pieces, so the ops of a piece — expressed in the original delta's relative
 * coordinates — stay valid from that point on.
 */
function breakTextOp(
  origChange: Change,
  textOp: JSONPatchOp,
  startRev: number,
  ctx: SplitContext,
  estimator: SizeEstimator
): Change[] {
  const results: Change[] = [];
  let rev = startRev;

  let deltaOps: any[] = [];
  if (textOp.value) {
    if (Array.isArray(textOp.value)) {
      deltaOps = textOp.value;
    } else if ((textOp.value as any).ops && Array.isArray((textOp.value as any).ops)) {
      deltaOps = (textOp.value as any).ops;
    } else if (typeof textOp.value === 'object') {
      deltaOps = [textOp.value];
    }
  }

  // Width an op occupies in the document AFTER it applies: a retain skips it, a string insert adds
  // its length (UTF-16 units, delta's coordinate space), an embed insert adds 1, a delete removes
  // what it consumed.
  const advanceOf = (op: any): number =>
    op.retain ? op.retain : typeof op.insert === 'string' ? op.insert.length : op.insert !== undefined ? 1 : 0;

  // Position in the current document (all earlier pieces applied) where the next piece's ops act.
  let pieceStartPos = 0;
  const withStartRetain = (ops: any[]): any[] => (pieceStartPos > 0 ? [{ retain: pieceStartPos }, ...ops] : ops);

  const measure = (ops: any[]) =>
    getSizeForStorage({ ...origChange, ops: [{ ...textOp, value: ops }] }, ctx.sizeCalculator);

  // Envelope for a change carrying just this text op with an empty delta. Per-delta-op JSON sizes
  // are added to it, rather than re-measuring the whole change at every candidate boundary.
  const textEnvelope = getJSONByteSize({ ...origChange, ops: [{ ...textOp, value: [] }] });
  /** Estimated storage bytes for a piece of `contentBytes` across `count` ops, plus its start retain. */
  const estimatePiece = (contentBytes: number, count: number) => {
    const retainBytes = pieceStartPos > 0 ? opJSONSize({ retain: pieceStartPos }) : 0;
    return estimator.storage(
      withOpsBytes(textEnvelope, retainBytes + contentBytes, count + (pieceStartPos > 0 ? 1 : 0))
    );
  };

  let pieceOps: any[] = [];
  let pieceAdvance = 0;
  let pieceBytes = 0;

  const flushPiece = () => {
    if (!pieceOps.length) return;
    results.push(deriveNewChange(origChange, rev++, [{ ...textOp, value: withStartRetain(pieceOps) }]));
    pieceStartPos += pieceAdvance;
    pieceOps = [];
    pieceAdvance = 0;
    pieceBytes = 0;
  };

  for (const op of deltaOps) {
    const opBytes = opJSONSize(op);

    if (pieceOps.length > 0 && estimatePiece(pieceBytes + opBytes, pieceOps.length + 1) > ctx.maxBytes) {
      flushPiece();
    }

    // As in `breakSingleChange`: the estimate decides whether to look closer, the real calculator
    // decides what to do — `guardUnsplittable` reports and refuses on a measured size.
    if (pieceOps.length === 0 && estimatePiece(opBytes, 1) > ctx.maxBytes) {
      const standaloneOps = withStartRetain([op]);
      const standaloneSize = measure(standaloneOps);
      if (standaloneSize > ctx.maxBytes) {
        if (op.insert && typeof op.insert === 'string') {
          const insertPieces = splitLargeInsertText(
            origChange,
            textOp,
            op.insert,
            op.attributes,
            pieceStartPos,
            ctx,
            estimator
          );
          for (const pieceValue of insertPieces) {
            results.push(deriveNewChange(origChange, rev++, [{ ...textOp, value: pieceValue }]));
          }
          pieceStartPos += op.insert.length;
          continue;
        }
        // Non-splittable large op (a retain, or an embed insert like an image data URL)
        guardUnsplittable(ctx, textOp.op, textOp.path, standaloneSize, 'delta-op');
        results.push(deriveNewChange(origChange, rev++, [{ ...textOp, value: standaloneOps }]));
        pieceStartPos += advanceOf(op);
        continue;
      }
    }

    pieceOps.push(op);
    pieceAdvance += advanceOf(op);
    pieceBytes += opBytes;
  }

  flushPiece();
  return results;
}

/** Never cut between a surrogate pair: half a code point is a different character. */
function safeSplitIndex(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

/**
 * Split a large insert string into the delta-op arrays of the change pieces that carry it, each
 * measuring at or under `ctx.maxBytes`.
 *
 * `startPos` is the position in the current document where the insert begins. Every piece is
 * prefixed with a retain to its own position: the first piece retains to `startPos`, and each
 * later piece additionally retains past the chunks the earlier pieces inserted — the pieces are
 * sequential changes, so a piece without that cumulative retain would insert at the head of the
 * document.
 *
 * The character budget below is only a seed: it comes from a *byte* budget the size calculator may
 * measure post-compression, so it says nothing reliable about how big a chunk of this particular
 * text will store as. Every chunk is measured and halved until it fits. A cut is never placed
 * inside a surrogate pair; a lone pair that still cannot fit goes through `guardUnsplittable`
 * whole.
 */
function splitLargeInsertText(
  origChange: Change,
  textOp: JSONPatchOp,
  text: string,
  attributes: any,
  startPos: number,
  ctx: SplitContext,
  estimator: SizeEstimator
): any[][] {
  const pieces: any[][] = [];
  const measure = (deltaOps: any[]) =>
    getSizeForStorage({ ...origChange, ops: [{ ...textOp, value: deltaOps }] }, ctx.sizeCalculator);

  // Document position where the next chunk inserts; advances by each emitted chunk's length.
  let position = startPos;

  const emit = (chunk: string): void => {
    const deltaOps: any[] = position > 0 ? [{ retain: position }] : [];
    deltaOps.push({ insert: chunk, attributes: attributes ? { ...attributes } : undefined });
    const bytes = measure(deltaOps);
    if (bytes > ctx.maxBytes) {
      const mid = safeSplitIndex(chunk, Math.ceil(chunk.length / 2));
      if (mid > 0 && mid < chunk.length) {
        emit(chunk.slice(0, mid));
        emit(chunk.slice(mid));
        return;
      }
      // Down to one code point (possibly a surrogate pair) that still measures over budget.
      guardUnsplittable(ctx, textOp.op, textOp.path, bytes, 'insert-chunk');
    }
    pieces.push(deltaOps);
    position += chunk.length;
  };

  // Seed the chunk length through the estimator rather than treating a possibly-compressed byte
  // budget as a character count: under compression that seed is several times too short and emits
  // far more pieces than the budget needs. Still only a seed — every chunk is measured and halved
  // above, so a wrong guess costs iterations, never an oversized piece.
  const chunkOverhead = getJSONByteSize({
    ...origChange,
    ops: [{ ...textOp, value: [{ retain: startPos || 1 }, { insert: '', attributes }] }],
  });
  const seedLength = Math.max(1, Math.floor(estimator.jsonBudget(ctx.maxBytes)) - chunkOverhead - 20);
  for (let i = 0; i < text.length; ) {
    let end = Math.min(text.length, i + seedLength);
    if (end < text.length) end = safeSplitIndex(text, end);
    // A surrogate pair right at a one-unit seed is indivisible: take both units.
    if (end <= i) end = Math.min(text.length, i + 2);
    emit(text.slice(i, end));
    i = end;
  }
  return pieces;
}

/**
 * Recursively strip text delta objects from a value, replacing them with stubs.
 * For each text delta found, pushes a @txt op to `textOps`.
 *
 * Text deltas are detected as plain objects with an `ops` array containing at
 * least one `insert` operation (i.e. Quill Delta documents).
 */
function stripTextDeltas(value: any, basePath: string, textOps: JSONPatchOp[]): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  // Detect text delta: object with an ops array containing insert operations
  if (Array.isArray(value.ops) && value.ops.some((op: any) => op.insert !== undefined)) {
    // Extract as @txt op; the value is the ops array itself
    textOps.push({ op: '@txt' as const, path: basePath, value: value.ops });
    // Return a stub with the ops property removed
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ops: _ops, ...stub } = value;
    return stub;
  }

  // Recurse into object properties
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = stripTextDeltas(val, `${basePath}/${key}`, textOps);
  }
  return result;
}

/**
 * Attempt to break a large replace/add operation by extracting text deltas as @txt ops.
 *
 * Text delta objects (`{ ops: [{insert: ...}] }`) are replaced with stubs in the value,
 * and separate `@txt` ops are appended to the same Change. If the resulting Change still
 * exceeds maxBytes, it is split further by ops via breakSingleChange.
 *
 * Non-object values (strings, arrays) and objects with no text deltas have no seam to cut on, so
 * they go through `guardUnsplittable`: reported, and refused once past `maxUnsplittableBytes`.
 */
function breakLargeValueOp(origChange: Change, op: JSONPatchOp, startRev: number, ctx: SplitContext): Change[] {
  const value = op.value;
  const asIs = (reason: OversizedOpReason) => {
    const piece = deriveNewChange(origChange, startRev, [op]);
    guardUnsplittable(ctx, op.op, op.path, getSizeForStorage(piece, ctx.sizeCalculator), reason);
    return [piece];
  };

  // Only handle plain object values
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return asIs('value-not-object');
  }

  // Extract text deltas, replacing them with stubs
  const textOps: JSONPatchOp[] = [];
  const strippedValue = stripTextDeltas(value, op.path, textOps);

  if (textOps.length === 0) {
    return asIs('value-no-text');
  }

  // Build a combined Change: structural op with stubs + all @txt ops
  const allOps: JSONPatchOp[] = [{ ...op, value: strippedValue }, ...textOps];
  const combinedChange = deriveNewChange(origChange, startRev, allOps);

  // If combined Change fits within the limit, return it as-is
  const combinedSize = getSizeForStorage(combinedChange, ctx.sizeCalculator);
  if (combinedSize <= ctx.maxBytes) {
    return [combinedChange];
  }

  // Still too large — split by ops (individual @txt ops broken further by breakTextOp). Hand over
  // the measurement just taken; re-deriving it means compressing the whole document a second time.
  return breakSingleChange(combinedChange, ctx, 0, combinedSize);
}

function deriveNewChange(origChange: Change, rev: number, ops: JSONPatchOp[]) {
  // Filter out metadata that shouldn't be part of the new change object
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, ops: _o, rev: _r, baseRev: _br, created: _c, ...metadata } = origChange;
  return createChange(origChange.baseRev, rev, ops, metadata);
}
