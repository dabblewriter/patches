/**
 * Tree-shakable compression utilities for Patches.
 *
 * This module provides compression functionality that is only bundled
 * when explicitly imported. If you don't use compression, these ~18KB
 * won't be included in your bundle.
 *
 * @example Client: Size calculator for change splitting
 * ```typescript
 * import { compressedSizeBase64 } from '@dabble/patches/compression';
 *
 * new PatchesDoc(state, {}, {
 *   sizeCalculator: compressedSizeBase64,
 *   maxStorageBytes: 1_000_000
 * });
 * ```
 *
 * @example Server: Compressor for storage backend
 * ```typescript
 * import { base64Compressor } from '@dabble/patches/compression';
 *
 * const backend = new CompressedStoreBackend(store, base64Compressor);
 * ```
 */

import {
  compressToBase64,
  compressToUint8Array,
  decompressFromBase64,
  decompressFromUint8Array,
} from '../algorithms/shared/lz.js';
import type { JSONPatchOp } from '../json-patch/types.js';

// ============================================================================
// Client: Size Calculators
// ============================================================================

/**
 * Function that calculates the storage size of data.
 * Used by change batching to determine if changes need to be split.
 */
export type SizeCalculator = (data: unknown) => number;

/**
 * Calculate size after base64 LZ compression.
 * Use this when your server uses base64 compression format.
 */
export const compressedSizeBase64: SizeCalculator = data => {
  if (data === undefined) return 0;
  try {
    const json = JSON.stringify(data);
    if (!json) return 0;
    return compressToBase64(json).length;
  } catch {
    return 0;
  }
};

/**
 * Calculate size after uint8array LZ compression.
 * Use this when your server uses binary compression format.
 */
export const compressedSizeUint8: SizeCalculator = data => {
  if (data === undefined) return 0;
  try {
    const json = JSON.stringify(data);
    if (!json) return 0;
    return compressToUint8Array(json).length;
  } catch {
    return 0;
  }
};

// ============================================================================
// Server: Ops Compressors
// ============================================================================

/**
 * Interface for compressing/decompressing JSON Patch operations.
 * Passed to CompressedStoreBackend to enable transparent compression.
 */
export interface OpsCompressor {
  /** Compress ops to string or binary format */
  compress: (ops: JSONPatchOp[]) => string | Uint8Array;
  /** Decompress string or binary back to ops array */
  decompress: (compressed: string | Uint8Array) => JSONPatchOp[];
  /** Type guard to check if ops are in compressed format */
  isCompressed: (ops: unknown) => ops is string | Uint8Array;
}

/**
 * Compressor that uses base64 encoding.
 * Works with any storage backend that supports strings.
 */
export const base64Compressor: OpsCompressor = {
  compress: ops => compressToBase64(JSON.stringify(ops)),
  decompress: compressed => JSON.parse(decompressFromBase64(compressed as string) || '[]'),
  isCompressed: (ops): ops is string => typeof ops === 'string',
};

/**
 * Compressor that uses binary Uint8Array format.
 * More efficient storage but requires backend that supports binary data.
 */
export const uint8Compressor: OpsCompressor = {
  compress: ops => compressToUint8Array(JSON.stringify(ops)),
  decompress: compressed => JSON.parse(decompressFromUint8Array(compressed as Uint8Array) || '[]'),
  isCompressed: (ops): ops is Uint8Array => ops instanceof Uint8Array,
};

// Re-export raw compression functions for advanced use cases
export { compressToBase64, compressToUint8Array, decompressFromBase64, decompressFromUint8Array };
