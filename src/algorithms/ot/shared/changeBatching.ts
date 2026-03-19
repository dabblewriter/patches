import { createId } from 'crypto-id';
import { createChange } from '../../../data/change.js';
import type { JSONPatchOp } from '../../../json-patch/types.js';
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
 */
export function breakChanges(changes: Change[], maxBytes: number, sizeCalculator?: SizeCalculator): Change[] {
  const results: Change[] = [];
  for (const change of changes) {
    results.push(...breakSingleChange(change, maxBytes, sizeCalculator));
  }
  return results;
}

/** Default wire batch size limit (1MB) */
const DEFAULT_MAX_PAYLOAD_BYTES = 1_000_000;

/**
 * Options for breaking changes into batches.
 */
export interface BreakChangesIntoBatchesOptions {
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
  const { maxStorageBytes, sizeCalculator } = opts;

  // First, split individual changes if they exceed storage limit
  let processedChanges = changes;
  if (maxStorageBytes) {
    processedChanges = breakChanges(changes, maxStorageBytes, sizeCalculator);
  }

  // If all changes fit in one batch, return as-is
  if (getJSONByteSize(processedChanges) < maxPayloadBytes) {
    return [processedChanges];
  }

  const batchId = createId(12);
  const batches: Change[][] = [];
  let currentBatch: Change[] = [];
  let currentSize = 2; // Account for [] wrapper

  for (const change of processedChanges) {
    // Add batchId if breaking up
    const changeWithBatchId = { ...change, batchId };
    const individualActualSize = getJSONByteSize(changeWithBatchId);
    let itemsToProcess: Change[];

    // If individual change exceeds wire limit (shouldn't happen if maxStorageBytes < maxPayloadBytes)
    if (individualActualSize > maxPayloadBytes) {
      // Break using wire limit (uncompressed)
      itemsToProcess = breakSingleChange(changeWithBatchId, maxPayloadBytes).map(c => ({ ...c, batchId }));
    } else {
      itemsToProcess = [changeWithBatchId];
    }

    for (const item of itemsToProcess) {
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
 * Break a single Change into multiple Changes so that the storage size never exceeds `maxBytes`.
 * @param sizeCalculator - Custom size calculator (e.g., for compressed size)
 */
function breakSingleChange(orig: Change, maxBytes: number, sizeCalculator?: SizeCalculator): Change[] {
  if (getSizeForStorage(orig, sizeCalculator) <= maxBytes) return [orig];

  // First pass: split by ops
  const byOps: Change[] = [];
  let group: JSONPatchOp[] = [];
  let rev = orig.rev;

  const flush = () => {
    if (!group.length) return;
    byOps.push(deriveNewChange(orig, rev++, group));
    group = [];
  };

  for (const op of orig.ops) {
    const tentative = group.concat(op);
    if (getSizeForStorage({ ...orig, ops: tentative }, sizeCalculator) > maxBytes) flush();

    // Handle the case where a single op is too large
    if (group.length === 0 && getSizeForStorage({ ...orig, ops: [op] }, sizeCalculator) > maxBytes) {
      // We have a single op that's too big - can only be @txt op with large delta
      if (op.op === '@txt' && op.value) {
        const pieces = breakTextOp(orig, op, maxBytes, rev, sizeCalculator);
        byOps.push(...pieces);
        // Only update rev if we got results from breakTextOp
        if (pieces.length > 0) {
          rev = pieces[pieces.length - 1].rev + 1; // Update rev for next changes
        }
        continue;
      } else if (op.op === 'replace' || op.op === 'add') {
        // For replace/add operations with large value payloads, try to split the value if it's a string or array
        const pieces = breakLargeValueOp(orig, op, maxBytes, rev, sizeCalculator);
        byOps.push(...pieces);
        if (pieces.length > 0) {
          rev = pieces[pieces.length - 1].rev + 1;
        }
        continue;
      } else {
        // Non-splittable op that's too large, include it anyway with a warning
        console.warn(`Warning: Single operation of type ${op.op} exceeds maxBytes. Including it anyway.`);
        group.push(op);
        continue;
      }
    }

    group.push(op);
  }

  flush();
  return byOps;
}

/**
 * Break a large @txt operation into multiple smaller operations
 * @param sizeCalculator - Custom size calculator (e.g., for compressed size)
 */
function breakTextOp(
  origChange: Change,
  textOp: JSONPatchOp,
  maxBytes: number,
  startRev: number,
  sizeCalculator?: SizeCalculator
): Change[] {
  const results: Change[] = [];
  let rev = startRev;

  const baseSize = getSizeForStorage({ ...origChange, ops: [{ ...textOp, value: '' }] }, sizeCalculator);
  const budget = maxBytes - baseSize;
  const buffer = 20;
  const maxLength = Math.max(1, budget - buffer);

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

  let currentOpsForNextChangePiece: any[] = [];
  let retainToPrefixCurrentPiece = 0; // Retain that should prefix the ops in currentOpsForNextChangePiece

  const flushCurrentChangePiece = () => {
    if (!currentOpsForNextChangePiece.length) return;

    const opsToFlush = [...currentOpsForNextChangePiece];
    if (retainToPrefixCurrentPiece > 0) {
      if (!opsToFlush[0]?.retain) {
        // Only add if not already starting with a retain
        opsToFlush.unshift({ retain: retainToPrefixCurrentPiece });
      } else {
        // If it starts with retain, assume it's the intended one from deltaOps.
        // This might need adjustment if a small retain op is batched after a large retain prefix.
        // For now, this prioritizes an existing retain op at the start of the batch.
      }
    }
    results.push(deriveNewChange(origChange, rev++, [{ ...textOp, value: opsToFlush }]));
    currentOpsForNextChangePiece = [];
    // retainToPrefixCurrentPiece is NOT reset here, it carries over for the start of the next piece IF it's non-zero from a previous retain op.
  };

  for (const op of deltaOps) {
    // Try adding current op (with its necessary prefix) to the current batch
    const testBatchOps = [...currentOpsForNextChangePiece];
    if (retainToPrefixCurrentPiece > 0 && testBatchOps.length === 0) {
      // If batch is empty, it needs the prefix
      testBatchOps.push({ retain: retainToPrefixCurrentPiece });
    }
    testBatchOps.push(op);
    const testBatchSize = getSizeForStorage(
      { ...origChange, ops: [{ ...textOp, value: testBatchOps }] },
      sizeCalculator
    );

    if (currentOpsForNextChangePiece.length > 0 && testBatchSize > maxBytes) {
      flushCurrentChangePiece();
      // After flush, retainToPrefixCurrentPiece still holds the value for the *start* of the new piece (current op)
    }

    // Check if the op itself (with its prefix) is too large for a new piece
    const opStandaloneOps = retainToPrefixCurrentPiece > 0 ? [{ retain: retainToPrefixCurrentPiece }, op] : [op];
    const opStandaloneSize = getSizeForStorage(
      { ...origChange, ops: [{ ...textOp, value: opStandaloneOps }] },
      sizeCalculator
    );

    if (currentOpsForNextChangePiece.length === 0 && opStandaloneSize > maxBytes) {
      if (op.insert && typeof op.insert === 'string') {
        const insertChunks = splitLargeInsertText(op.insert, maxLength, op.attributes);
        for (let i = 0; i < insertChunks.length; i++) {
          const chunkOp = insertChunks[i];
          const opsForThisChunk: any[] = [];
          if (i === 0 && retainToPrefixCurrentPiece > 0) {
            // Prefix only the first chunk
            opsForThisChunk.push({ retain: retainToPrefixCurrentPiece });
          }
          opsForThisChunk.push(chunkOp);
          results.push(deriveNewChange(origChange, rev++, [{ ...textOp, value: opsForThisChunk }]));
        }
        retainToPrefixCurrentPiece = 0; // An insert consumes the preceding retain for the next original op
      } else {
        // Non-splittable large op (e.g., large retain)
        console.warn(`Warning: Single delta op too large, including with prefix: ${JSON.stringify(op)}`);
        results.push(deriveNewChange(origChange, rev++, [{ ...textOp, value: opStandaloneOps }]));
        retainToPrefixCurrentPiece = op.retain || 0;
      }
    } else {
      // Op fits into current batch (or starts a new one that fits)
      currentOpsForNextChangePiece.push(op);
      if (op.retain) {
        retainToPrefixCurrentPiece += op.retain; // Accumulate retain for the next op or flush
      } else {
        // Insert or delete
        retainToPrefixCurrentPiece = 0; // Consumes retain for the next op
      }
    }
  }

  if (currentOpsForNextChangePiece.length > 0) {
    flushCurrentChangePiece();
  }
  return results;
}

/**
 * Split a large insert string into multiple delta insert operations.
 * Each operation will have the original attributes.
 */
function splitLargeInsertText(text: string, maxChunkLength: number, attributes?: any): any[] {
  const results: any[] = [];
  if (maxChunkLength <= 0) {
    console.warn('splitLargeInsertText: maxChunkLength is invalid, returning original text as one chunk.');
    return [{ insert: text, attributes }];
  }
  for (let i = 0; i < text.length; i += maxChunkLength) {
    const chunkText = text.slice(i, i + maxChunkLength);
    results.push({ insert: chunkText, attributes: attributes ? { ...attributes } : undefined });
  }
  return results;
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
 * Non-object values (strings, arrays) and objects with no text deltas are included as-is
 * with a warning.
 */
function breakLargeValueOp(
  origChange: Change,
  op: JSONPatchOp,
  maxBytes: number,
  startRev: number,
  sizeCalculator?: SizeCalculator
): Change[] {
  const value = op.value;

  // Only handle plain object values
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    console.warn(`Oversized op ${op.op} at "${op.path}" is not an object; including as-is`);
    return [deriveNewChange(origChange, startRev, [op])];
  }

  // Extract text deltas, replacing them with stubs
  const textOps: JSONPatchOp[] = [];
  const strippedValue = stripTextDeltas(value, op.path, textOps);

  if (textOps.length === 0) {
    console.warn(`Oversized op ${op.op} at "${op.path}" has no text deltas; including as-is`);
    return [deriveNewChange(origChange, startRev, [op])];
  }

  // Build a combined Change: structural op with stubs + all @txt ops
  const allOps: JSONPatchOp[] = [{ ...op, value: strippedValue }, ...textOps];
  const combinedChange = deriveNewChange(origChange, startRev, allOps);

  // If combined Change fits within the limit, return it as-is
  if (getSizeForStorage(combinedChange, sizeCalculator) <= maxBytes) {
    return [combinedChange];
  }

  // Still too large — split by ops (individual @txt ops broken further by breakTextOp)
  return breakSingleChange(combinedChange, maxBytes, sizeCalculator);
}

function deriveNewChange(origChange: Change, rev: number, ops: JSONPatchOp[]) {
  // Filter out metadata that shouldn't be part of the new change object
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, ops: _o, rev: _r, baseRev: _br, created: _c, ...metadata } = origChange;
  return createChange(origChange.baseRev, rev, ops, metadata);
}
