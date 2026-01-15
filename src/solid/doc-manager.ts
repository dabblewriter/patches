import type { Patches } from '../client/Patches.js';
import type { PatchesDoc } from '../client/PatchesDoc.js';

/**
 * Reference counting manager for PatchesDoc instances.
 *
 * Tracks how many Solid components are using each document and only opens/closes
 * documents when the reference count goes to/from zero.
 *
 * This prevents the footgun where multiple components open the same doc but the
 * first one to unmount closes it for everyone else.
 */
export class DocManager {
  private refCounts = new Map<string, number>();
  private pendingOps = new Map<string, Promise<PatchesDoc<any>>>();

  /**
   * Opens a document with reference counting.
   *
   * - If this is the first reference, calls patches.openDoc()
   * - If doc is already open, returns existing instance and increments count
   * - Handles concurrent opens to the same doc safely
   *
   * @param patches - Patches instance
   * @param docId - Document ID to open
   * @returns Promise resolving to PatchesDoc instance
   */
  async openDoc<T extends object>(patches: Patches, docId: string): Promise<PatchesDoc<T>> {
    const currentCount = this.refCounts.get(docId) || 0;

    // If there's already a pending open operation, wait for it
    if (currentCount === 0 && this.pendingOps.has(docId)) {
      const doc = await this.pendingOps.get(docId)!;
      this.refCounts.set(docId, (this.refCounts.get(docId) || 0) + 1);
      return doc as PatchesDoc<T>;
    }

    // If ref count > 0, doc is already open
    if (currentCount > 0) {
      this.refCounts.set(docId, currentCount + 1);
      const doc = patches.getOpenDoc<T>(docId);
      if (!doc) {
        // This shouldn't happen, but handle it gracefully
        throw new Error(`Document ${docId} has ref count ${currentCount} but is not open in Patches`);
      }
      return doc;
    }

    // First reference - actually open the doc
    const openPromise = patches.openDoc<T>(docId);
    this.pendingOps.set(docId, openPromise);

    try {
      const doc = await openPromise;
      this.refCounts.set(docId, 1);
      return doc;
    } catch (error) {
      // If open failed, don't increment ref count
      this.refCounts.delete(docId);
      throw error;
    } finally {
      this.pendingOps.delete(docId);
    }
  }

  /**
   * Closes a document with reference counting.
   *
   * - Decrements the reference count
   * - Only calls patches.closeDoc() when count reaches zero
   * - Safe to call even if doc was never opened
   *
   * @param patches - Patches instance
   * @param docId - Document ID to close
   */
  async closeDoc(patches: Patches, docId: string): Promise<void> {
    const currentCount = this.refCounts.get(docId) || 0;

    if (currentCount === 0) {
      // No references - nothing to do (or already closed)
      return;
    }

    if (currentCount === 1) {
      // Last reference - actually close the doc
      this.refCounts.delete(docId);
      await patches.closeDoc(docId, { untrack: true });
    } else {
      // Still have other references - just decrement
      this.refCounts.set(docId, currentCount - 1);
    }
  }

  /**
   * Increments the reference count for a document without opening it.
   *
   * Used in explicit mode to track usage and prevent premature closes
   * from autoClose mode.
   *
   * @param docId - Document ID
   */
  incrementRefCount(docId: string): void {
    const currentCount = this.refCounts.get(docId) || 0;
    this.refCounts.set(docId, currentCount + 1);
  }

  /**
   * Decrements the reference count for a document without closing it.
   *
   * Used in explicit mode to release usage tracking.
   *
   * @param docId - Document ID
   */
  decrementRefCount(docId: string): void {
    const currentCount = this.refCounts.get(docId) || 0;
    if (currentCount > 0) {
      this.refCounts.set(docId, currentCount - 1);
    }
  }

  /**
   * Gets the current reference count for a document.
   *
   * Useful for debugging or advanced use cases.
   *
   * @param docId - Document ID
   * @returns Current reference count (0 if not tracked)
   */
  getRefCount(docId: string): number {
    return this.refCounts.get(docId) || 0;
  }

  /**
   * Clears all reference counts without closing documents.
   *
   * Use with caution - this is mainly for testing or cleanup scenarios
   * where you want to reset the manager state.
   */
  reset(): void {
    this.refCounts.clear();
    this.pendingOps.clear();
  }
}

/**
 * Singleton doc managers per Patches instance.
 * WeakMap ensures managers are GC'd when Patches instance is GC'd.
 */
const managers = new WeakMap<Patches, DocManager>();

/**
 * Gets or creates a DocManager for a Patches instance.
 *
 * @param patches - Patches instance
 * @returns DocManager for this Patches instance
 */
export function getDocManager(patches: Patches): DocManager {
  let manager = managers.get(patches);
  if (!manager) {
    manager = new DocManager();
    managers.set(patches, manager);
  }
  return manager;
}
