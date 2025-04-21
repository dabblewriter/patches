import { createId } from 'crypto-id';
import type { Change } from '../types.js';

/** Estimate JSON string byte size. */
export function getJSONByteSize(data: any): number {
  // Basic estimation, might not be perfectly accurate due to encoding nuances
  return new TextEncoder().encode(JSON.stringify(data)).length;
}

/** Break changes into batches based on maxBatchSize. */
export function breakIntoBatches(changes: Change[], maxSize?: number): Change[][] {
  if (!maxSize || getJSONByteSize(changes) < maxSize) {
    return [changes];
  }

  const batchId = createId(12);
  const batches: Change[][] = [];
  let currentBatch: Change[] = [];
  let currentSize = 2; // Account for [] wrapper

  for (const change of changes) {
    // Add batchId if breaking up
    const changeWithBatchId = { ...change, batchId };
    const changeSize = getJSONByteSize(changeWithBatchId) + (currentBatch.length > 0 ? 1 : 0); // Add 1 for comma

    // If a single change is too big, we have an issue (should be rare)
    if (changeSize > maxSize && currentBatch.length === 0) {
      console.error(
        `Single change ${change.id} (size ${changeSize}) exceeds maxBatchSize (${maxSize}). Sending as its own batch.`
      );
      batches.push([changeWithBatchId]); // Send it anyway
      continue;
    }

    if (currentSize + changeSize > maxSize) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSize = 2;
    }

    currentBatch.push(changeWithBatchId);
    currentSize += changeSize;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
