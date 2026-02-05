import type { ServerStoreBackend, TombstoneStoreBackend } from './types.js';

/**
 * Type guard to check if a store implements TombstoneStoreBackend.
 */
export function isTombstoneStore(store: ServerStoreBackend): store is ServerStoreBackend & TombstoneStoreBackend {
  return 'createTombstone' in store && 'getTombstone' in store && 'removeTombstone' in store;
}

/**
 * Creates a tombstone for a document if the store supports it.
 * @param store - The store backend
 * @param docId - The document ID
 * @param lastRev - The last revision before deletion
 * @param clientId - The client that initiated deletion
 * @param skipTombstone - If true, skip creating the tombstone
 * @returns true if tombstone was created, false if skipped or store doesn't support it
 */
export async function createTombstoneIfSupported(
  store: ServerStoreBackend,
  docId: string,
  lastRev: number,
  clientId?: string,
  skipTombstone?: boolean
): Promise<boolean> {
  if (!isTombstoneStore(store) || skipTombstone) {
    return false;
  }
  await store.createTombstone({
    docId,
    deletedAt: Date.now(),
    lastRev,
    deletedByClientId: clientId,
  });
  return true;
}

/**
 * Removes a tombstone for a document if it exists.
 * @param store - The store backend
 * @param docId - The document ID
 * @returns true if tombstone was found and removed, false otherwise
 */
export async function removeTombstoneIfExists(store: ServerStoreBackend, docId: string): Promise<boolean> {
  if (!isTombstoneStore(store)) {
    return false;
  }
  const tombstone = await store.getTombstone(docId);
  if (!tombstone) {
    return false;
  }
  await store.removeTombstone(docId);
  return true;
}
