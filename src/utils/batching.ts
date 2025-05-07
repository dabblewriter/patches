import { createId } from 'crypto-id';
import type { Change } from '../types.js';
import { breakChange } from './breakChange.js'; // Import from new file
import { getJSONByteSize } from './getJSONByteSize.js'; // Import from new file

/** Break changes into batches based on maxPayloadBytes. */
export function breakIntoBatches(changes: Change[], maxPayloadBytes?: number): Change[][] {
  if (!maxPayloadBytes || getJSONByteSize(changes) < maxPayloadBytes) {
    return [changes];
  }

  const batchId = createId(12);
  const batches: Change[][] = [];
  let currentBatch: Change[] = [];
  let currentSize = 2; // Account for [] wrapper

  for (const change of changes) {
    // Add batchId if breaking up
    const changeWithBatchId = { ...change, batchId };
    const individualActualSize = getJSONByteSize(changeWithBatchId);
    let itemsToProcess: Change[];

    if (individualActualSize > maxPayloadBytes) {
      itemsToProcess = breakChange(changeWithBatchId, maxPayloadBytes);
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
