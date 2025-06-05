import { createChange } from '../../data/change.js';
import type { JSONPatchOp } from '../../json-patch/types.js';
import type { Change } from '../../types.js';
import { getJSONByteSize } from './getJSONByteSize.js';

/**
 * Break a single Change into multiple Changes so that the JSON string size never exceeds `maxBytes`.
 *
 * - Splits first by JSON-Patch *ops*
 * - If an individual op is still too big and is a "@txt" op,
 *   split its Delta payload into smaller Deltas
 */
export function breakChange(orig: Change, maxBytes: number): Change[] {
  if (getJSONByteSize(orig) <= maxBytes) return [orig];

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
    if (getJSONByteSize({ ...orig, ops: tentative }) > maxBytes) flush();

    // Handle the case where a single op is too large
    if (group.length === 0 && getJSONByteSize({ ...orig, ops: [op] }) > maxBytes) {
      // We have a single op that's too big - can only be @txt op with large delta
      if (op.op === '@txt' && op.value) {
        const pieces = breakTextOp(orig, op, maxBytes, rev);
        byOps.push(...pieces);
        // Only update rev if we got results from breakTextOp
        if (pieces.length > 0) {
          rev = pieces[pieces.length - 1].rev + 1; // Update rev for next changes
        }
        continue;
      } else if (op.op === 'replace' || op.op === 'add') {
        // For replace/add operations with large value payloads, try to split the value if it's a string or array
        const pieces = breakLargeValueOp(orig, op, maxBytes, rev);
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
 */
function breakTextOp(origChange: Change, textOp: JSONPatchOp, maxBytes: number, startRev: number): Change[] {
  const results: Change[] = [];
  let rev = startRev;

  const baseSize = getJSONByteSize({ ...origChange, ops: [{ ...textOp, value: '' }] });
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
    const testBatchSize = getJSONByteSize({ ...origChange, ops: [{ ...textOp, value: testBatchOps }] });

    if (currentOpsForNextChangePiece.length > 0 && testBatchSize > maxBytes) {
      flushCurrentChangePiece();
      // After flush, retainToPrefixCurrentPiece still holds the value for the *start* of the new piece (current op)
    }

    // Check if the op itself (with its prefix) is too large for a new piece
    const opStandaloneOps = retainToPrefixCurrentPiece > 0 ? [{ retain: retainToPrefixCurrentPiece }, op] : [op];
    const opStandaloneSize = getJSONByteSize({ ...origChange, ops: [{ ...textOp, value: opStandaloneOps }] });

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
 * Attempt to break a large value in a replace/add operation
 */
function breakLargeValueOp(origChange: Change, op: JSONPatchOp, maxBytes: number, startRev: number): Change[] {
  const results: Change[] = [];
  let rev = startRev;
  const baseOpSize = getJSONByteSize({ ...op, value: '' });
  const baseChangeSize = getJSONByteSize({ ...origChange, ops: [{ ...op, value: '' }] }) - baseOpSize;
  const valueBudget = maxBytes - baseChangeSize - 50;

  if (typeof op.value === 'string' && op.value.length > 100) {
    const text = op.value;
    const targetChunkSize = Math.max(1, valueBudget);
    const numChunks = Math.ceil(text.length / targetChunkSize);
    const chunkSize = Math.ceil(text.length / numChunks);
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      const newOp: any = { op: 'add' };
      if (i === 0) {
        newOp.op = op.op;
        newOp.path = op.path;
        newOp.value = chunk;
      } else {
        newOp.op = 'patch';
        newOp.path = op.path;
        newOp.appendString = chunk;
      }
      results.push(deriveNewChange(origChange, rev++, [newOp]));
    }
    return results;
  } else if (Array.isArray(op.value) && op.value.length > 1) {
    const originalArray = op.value;
    let currentChunk: any[] = [];
    let chunkStartIndex = 0;
    for (let i = 0; i < originalArray.length; i++) {
      const item = originalArray[i];
      const tentativeChunk = [...currentChunk, item];
      const tentativeOp = { ...op, value: tentativeChunk };
      const tentativeChangeSize = getJSONByteSize({ ...origChange, ops: [tentativeOp] });
      if (currentChunk.length > 0 && tentativeChangeSize > maxBytes) {
        const chunkOp: any = {};
        if (chunkStartIndex === 0) {
          chunkOp.op = op.op;
          chunkOp.path = op.path;
          chunkOp.value = currentChunk;
        } else {
          chunkOp.op = 'patch';
          chunkOp.path = op.path;
          chunkOp.appendArray = currentChunk;
        }
        results.push(deriveNewChange(origChange, rev++, [chunkOp]));
        currentChunk = [item];
        chunkStartIndex = i;
      } else {
        currentChunk.push(item);
      }
    }
    if (currentChunk.length > 0) {
      const chunkOp: any = {};
      if (chunkStartIndex === 0) {
        chunkOp.op = op.op;
        chunkOp.path = op.path;
        chunkOp.value = currentChunk;
      } else {
        chunkOp.op = 'patch';
        chunkOp.path = op.path;
        chunkOp.appendArray = currentChunk;
      }
      results.push(deriveNewChange(origChange, rev++, [chunkOp]));
    }
    return results;
  }
  console.warn(
    `Warning: Single operation of type ${op.op} (path: ${op.path}) could not be split further by breakLargeValueOp despite exceeding maxBytes. Including as is.`
  );
  return [deriveNewChange(origChange, rev++, [op])]; // Return original op in a new change if not splittable by this func
}

function deriveNewChange(origChange: Change, rev: number, ops: JSONPatchOp[]) {
  // Filter out metadata that shouldn't be part of the new change object
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, ops: _o, rev: _r, baseRev: _br, created: _c, batchId: _bi, ...metadata } = origChange;
  return createChange(origChange.baseRev, rev, ops, metadata);
}
