import { Op } from '@dabble/delta';
import { createId } from 'crypto-id';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change } from '../types.js';
import { getJSONByteSize } from './getJSONByteSize.js'; // Import from new location

/**
 * Break a single Change into multiple Changes so that
 * JSON.stringify(change).length never exceeds `maxBytes`.
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
    byOps.push({
      ...orig,
      id: createId(),
      rev: rev++,
      ops: group,
      created: Date.now(),
    });
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

  // Calculate the budget for the delta content itself
  const baseSize = getJSONByteSize({ ...origChange, ops: [{ ...textOp, value: '' }] });
  const budget = maxBytes - baseSize;
  // Ensure maxLength for splitLargeInsert is at least 1, apply a smaller buffer
  const buffer = 20; // Reduced buffer
  const maxLength = Math.max(1, budget - buffer);

  // Ensure deltaOps is always an array, handle both Delta objects and raw arrays
  let deltaOps: any[] = [];

  if (textOp.value) {
    if (Array.isArray(textOp.value)) {
      // Direct array of ops
      deltaOps = textOp.value;
    } else if (textOp.value.ops && Array.isArray(textOp.value.ops)) {
      // Delta object with ops property
      deltaOps = textOp.value.ops;
    } else if (typeof textOp.value === 'object') {
      // Convert object to array with single op
      deltaOps = [textOp.value];
    }
  }

  let currentOps: any[] = [];
  let retain = 0;

  // Helper to create a Change with current accumulated delta ops
  const flushDelta = () => {
    if (!currentOps.length) return;

    const newOp = {
      ...textOp,
      value: currentOps,
    };

    results.push({
      ...origChange,
      id: createId(),
      rev: rev++,
      ops: [newOp],
      created: Date.now(),
    });

    currentOps = [];
  };

  for (const op of deltaOps) {
    // Check if adding this op would exceed the size limit
    const tentativeOps = [...currentOps, op];
    const tentativeChange = {
      ...origChange,
      ops: [{ ...textOp, value: tentativeOps }],
    };

    // Add an initial retain op if we're starting a new group of ops and there were prior ops
    if (currentOps.length === 0 && retain) {
      currentOps.push({ retain });
    }

    if (getJSONByteSize(tentativeChange) > maxBytes) {
      flushDelta();

      // Handle the case where a single delta op is too large (e.g., very large text insert)
      if (currentOps.length === 0 && getJSONByteSize({ ...origChange, ops: [op] }) > maxBytes) {
        // Split large insert into chunks
        const retainBeforeChunks = retain; // Capture retain position BEFORE these chunks
        const [newRetain, chunks] = splitLargeInsert(op, retain, maxLength);
        retain = newRetain; // Update overall retain state for ops *after* these chunks

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          // Only add retain before the *first* chunk from splitLargeInsert
          if (i === 0 && retainBeforeChunks > 0) {
            currentOps = [{ retain: retainBeforeChunks }, chunk];
          } else {
            currentOps = [chunk];
          }
          flushDelta(); // Flushes the chunk (potentially with retain on first)
        }
        continue;
      }
    }

    currentOps.push(op);

    if (!op.delete) {
      retain += Op.length(op);
    }
  }

  // Flush any remaining ops
  flushDelta();

  return results;
}

/**
 * Split a large insert operation into multiple smaller ones
 */
function splitLargeInsert(insertOp: any, retain: number, maxChunkSize: number): any[] {
  const results: any[] = [];

  if (!insertOp.insert || typeof insertOp.insert !== 'string') {
    throw new Error(`Single @txt operation exceeds maxBytes. Cannot split further.`);
  }

  const text = insertOp.insert;
  // const attrs = insertOp.attributes || {}; // attrs not used currently

  // Ensure maxChunkSize is positive
  if (maxChunkSize <= 0) {
    throw new Error(`Calculated maxChunkSize is <= 0, cannot split insert.`);
  }

  // Ensure chunkSize is at least 1 to prevent infinite loops
  const targetChunkSize = Math.max(1, maxChunkSize);
  const numChunks = Math.ceil(text.length / targetChunkSize);
  const chunkSize = Math.ceil(text.length / numChunks);

  for (let i = 0; i < text.length; i += chunkSize) {
    const chunkText = text.slice(i, i + chunkSize);
    const op = { ...insertOp, insert: chunkText }; // Keep original attrs

    // For the first chunk, no retain is needed
    // Retain calculation seems complex, let breakTextOp handle retains between chunks
    // if (i !== 0) {
    //   results.push({ retain });
    // }

    results.push(op);
    // Retain is now managed by the caller (breakTextOp)
    // retain += Op.length(op);
  }

  // Return just the ops, retain calculation happens in breakTextOp
  return [retain, results]; // This return signature might need review based on usage
}

/**
 * Attempt to break a large value in a replace/add operation
 */
function breakLargeValueOp(origChange: Change, op: JSONPatchOp, maxBytes: number, startRev: number): Change[] {
  const results: Change[] = [];
  let rev = startRev;

  // Calculate base size without the value to estimate budget for value chunks
  const baseOpSize = getJSONByteSize({ ...op, value: '' });
  const baseChangeSize = getJSONByteSize({ ...origChange, ops: [{ ...op, value: '' }] }) - baseOpSize;
  const valueBudget = maxBytes - baseChangeSize - 50; // 50 bytes buffer for overhead

  // Special case: if value is a string, we can split it into chunks
  if (typeof op.value === 'string' && op.value.length > 100) {
    // Only split reasonably large strings
    const text = op.value;
    // Ensure chunkSize is at least 1
    const targetChunkSize = Math.max(1, valueBudget);
    const numChunks = Math.ceil(text.length / targetChunkSize);
    const chunkSize = Math.ceil(text.length / numChunks);

    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      const newOp: any = { op: 'add' }; // Default to add?

      if (i === 0) {
        // First chunk: use original op type (add/replace) and path
        newOp.op = op.op;
        newOp.path = op.path;
        newOp.value = chunk;
      } else {
        // Subsequent chunks: use 'add' to append to the string (assuming target is container)
        // This assumes the path points to an array or object where subsequent adds make sense.
        // A more robust solution might need context or use a specific 'patch' op.
        // If path was `/foo/bar`, appending needs `/foo/bar/-` or similar if array?
        // For now, let's assume path allows adding / maybe this needs a custom 'append' op?
        // Reverting to a placeholder 'patch' op type needing server interpretation.
        newOp.op = 'patch';
        newOp.path = op.path; // Operate on the original path
        newOp.appendString = chunk;
      }

      results.push({
        ...origChange,
        id: createId(),
        rev: rev++,
        ops: [newOp],
        created: Date.now(),
      });
    }

    return results;
  } else if (Array.isArray(op.value) && op.value.length > 1) {
    // Special case: if value is an array, we can split it into smaller arrays
    // This requires careful size checking per chunk
    const originalArray = op.value;
    let currentChunk: any[] = [];
    let chunkStartIndex = 0;

    for (let i = 0; i < originalArray.length; i++) {
      const item = originalArray[i];
      const tentativeChunk = [...currentChunk, item];
      const tentativeOp = { ...op, value: tentativeChunk };
      const tentativeChangeSize = getJSONByteSize({ ...origChange, ops: [tentativeOp] });

      if (currentChunk.length > 0 && tentativeChangeSize > maxBytes) {
        // Flush current chunk
        const chunkOp: any = {};
        if (chunkStartIndex === 0) {
          chunkOp.op = op.op;
          chunkOp.path = op.path;
          chunkOp.value = currentChunk;
        } else {
          // Append subsequent chunks - needs server support for 'appendArray'
          chunkOp.op = 'patch';
          chunkOp.path = op.path;
          chunkOp.appendArray = currentChunk;
        }
        results.push({
          ...origChange,
          id: createId(),
          rev: rev++,
          ops: [chunkOp],
          created: Date.now(),
        });
        currentChunk = [item]; // Start new chunk with current item
        chunkStartIndex = i;
      } else {
        currentChunk.push(item);
      }
    }

    // Flush the last chunk
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
      results.push({
        ...origChange,
        id: createId(),
        rev: rev++,
        ops: [chunkOp],
        created: Date.now(),
      });
    }

    return results;
  }

  // If we can't split it, throw an error
  throw new Error(`Single operation of type ${op.op} (path: ${op.path}) exceeds maxBytes and can't be split further.`);
}
