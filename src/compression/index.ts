/**
 * Tree-shakable compression utilities for Patches.
 *
 * This module provides compression functionality that is only bundled
 * when explicitly imported. If you don't use compression, these ~18KB
 * won't be included in your bundle.
 *
 * @example Client: Size calculator for change splitting
 * ```typescript
 * import { compressedSizeUint8 } from '@dabble/patches/compression';
 *
 * new OTDoc(state, {}, {
 *   sizeCalculator: compressedSizeUint8,
 *   maxStorageBytes: 1_000_000,
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

import { compressToBase64, compressToUint8Array, decompressFromBase64, decompressFromUint8Array } from './lz.js';
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
 * Estimate the stored size of a change after base64 LZ compression.
 *
 * When passed a Change object (has an `ops` array), only the `ops` field is
 * compressed — mirroring what `CompressedStoreBackend` does — so the estimate
 * reflects the actual stored size rather than compressing everything together.
 * For other data it falls back to compressing the whole value.
 */
export const compressedSizeBase64: SizeCalculator = data => {
  if (data === undefined || data === null) return 0;
  try {
    if (typeof data === 'object' && 'ops' in data && Array.isArray((data as Record<string, unknown>).ops)) {
      const { ops, ...rest } = data as Record<string, unknown>;
      const compressedOps = compressToBase64(JSON.stringify(ops as JSONPatchOp[]));
      return new TextEncoder().encode(JSON.stringify({ ...rest, ops: compressedOps })).length;
    }
    const json = JSON.stringify(data);
    if (!json) return 0;
    return compressToBase64(json).length;
  } catch {
    return 0;
  }
};

/**
 * Estimate the stored size of a change after uint8array LZ compression.
 *
 * When passed a Change object (has an `ops` array), only the `ops` field is
 * compressed — mirroring what `CompressedStoreBackend` does — so the estimate
 * reflects the actual stored size rather than compressing everything together.
 * For other data it falls back to compressing the whole value.
 */
export const compressedSizeUint8: SizeCalculator = data => {
  if (data === undefined || data === null) return 0;
  try {
    if (typeof data === 'object' && 'ops' in data && Array.isArray((data as Record<string, unknown>).ops)) {
      const { ops, ...rest } = data as Record<string, unknown>;
      const compressedOps = compressToUint8Array(JSON.stringify(ops as JSONPatchOp[]));
      const nonOpsSize = new TextEncoder().encode(JSON.stringify(rest)).length;
      return nonOpsSize + compressedOps.length;
    }
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
