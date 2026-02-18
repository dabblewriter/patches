import type { ReadonlyStore, Signal, Store } from 'easy-signal';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { ChangeMutator, DocSyncStatus } from '../types.js';

/**
 * Options for creating a PatchesDoc instance
 */
export interface PatchesDocOptions {
  /**
   * Maximum size in bytes for a single change's storage representation.
   * Changes exceeding this will be split. Used for backends with row size limits.
   */
  maxStorageBytes?: number;
  /**
   * Custom size calculator for storage limit checks.
   * Import from '@dabble/patches/compression' for actual compression measurement,
   * or provide your own function (e.g., ratio estimate).
   *
   * @example
   * import { compressedSizeBase64 } from '@dabble/patches/compression';
   * { sizeCalculator: compressedSizeBase64, maxStorageBytes: 1_000_000 }
   */
  sizeCalculator?: (data: unknown) => number;
}

/**
 * Interface for a document synchronized using JSON patches.
 *
 * This is the app-facing interface. The doc captures user changes as JSON Patch
 * ops and emits them via onChange. The algorithm handles packaging ops into Changes,
 * persisting them, and updating the doc's state.
 *
 * This interface is implemented by both OTDoc (Operational Transformation)
 * and LWWDoc (Last-Write-Wins) implementations via BaseDoc.
 *
 * Internal methods (updateSyncStatus, applyChanges, import) are on BaseDoc, not this interface.
 */
export interface PatchesDoc<T extends object = object> extends ReadonlyStore<T> {
  /** The unique identifier for this document. */
  readonly id: string;

  /** Last committed revision number from the server. */
  readonly committedRev: number;

  /** Are there local changes that haven't been committed yet? */
  readonly hasPending: boolean;

  /** Current sync status of this document. */
  readonly syncStatus: Store<DocSyncStatus>;

  /** Error from the last failed sync attempt, if any. */
  readonly syncError: Store<Error | undefined>;

  /** Whether the document has completed its initial load. Sticky: once true, never reverts to false. */
  readonly isLoaded: Store<boolean>;

  /**
   * Subscribe to be notified when the user makes local changes.
   * Emits the JSON Patch ops captured from the change() call.
   * The algorithm handles packaging these into Changes.
   */
  readonly onChange: Signal<(ops: JSONPatchOp[]) => void>;

  /**
   * Captures an update to the document, emitting JSON Patch ops via onChange.
   * Does NOT apply locally - the algorithm handles state updates.
   * @param mutator Function that uses JSONPatch methods with type-safe paths.
   */
  change(mutator: ChangeMutator<T>): void;
}

// Re-export OTDoc as the default PatchesDoc class for backwards compatibility
export { OTDoc, OTDoc as PatchesDocClass } from './OTDoc.js';
