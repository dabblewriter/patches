/**
 * Tree-shakable compression utilities for Patches.
 *
 * This module provides compression functionality that is only bundled
 * when explicitly imported. If you don't use compression, these ~18KB
 * won't be included in your bundle.
 *
 * @example Client: Size calculator for change splitting
 * ```typescript
 * import { createOpsCompressedSizeCalculator, uint8Compressor } from '@dabble/patches/compression';
 *
 * new OTDoc(state, {}, {
 *   sizeCalculator: createOpsCompressedSizeCalculator(uint8Compressor, 1_000_000),
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
 * Create a size calculator that accurately measures change storage size when the
 * server uses a `CompressedStoreBackend`.
 *
 * Uses a two-step approach for efficiency:
 * 1. **Fast path**: JSON string length — cheap and sufficient for 99% of changes
 *    that are well under the storage limit.
 * 2. **Slow path**: Compresses only the `ops` field (mirroring what
 *    `CompressedStoreBackend` does) and returns the actual stored size. This gives
 *    accurate measurements for large changes that need to be split.
 *
 * @param compressor - The same `OpsCompressor` used by your `CompressedStoreBackend`
 *   (e.g. `uint8Compressor` or `base64Compressor`). This keeps the calculator
 *   configurable — not all servers use compression.
 * @param maxBytes - The storage limit in bytes. Compression is only performed when
 *   the JSON size exceeds this value.
 *
 * @example
 * ```typescript
 * import { createOpsCompressedSizeCalculator, uint8Compressor } from '@dabble/patches/compression';
 *
 * new OTDoc(state, {}, {
 *   sizeCalculator: createOpsCompressedSizeCalculator(uint8Compressor, 1_000_000),
 *   maxStorageBytes: 1_000_000,
 * });
 * ```
 */
export function createOpsCompressedSizeCalculator(compressor: OpsCompressor, maxBytes: number): SizeCalculator {
  return (data: unknown) => {
    if (data === undefined || data === null) return 0;
    try {
      const json = JSON.stringify(data);
      if (!json) return 0;

      // Fast path: JSON string length is a cheap first approximation.
      // For ASCII/Latin content json.length ≈ byte count, so this avoids
      // compression work for the vast majority of small changes.
      if (json.length < maxBytes) return json.length;

      // Slow path: if the data looks like a Change (has an `ops` array),
      // compress only the ops field — mirroring what CompressedStoreBackend does.
      if (typeof data === 'object' && 'ops' in data && Array.isArray((data as Record<string, unknown>).ops)) {
        const { ops, ...rest } = data as Record<string, unknown>;
        const compressedOps = compressor.compress(ops as JSONPatchOp[]);

        if (compressedOps instanceof Uint8Array) {
          // Binary storage: non-ops JSON size + raw binary ops byte count.
          const nonOpsSize = new TextEncoder().encode(JSON.stringify(rest)).length;
          return nonOpsSize + compressedOps.length;
        } else {
          // String storage (e.g. base64): measure full JSON with compressed ops.
          const storedJson = JSON.stringify({ ...rest, ops: compressedOps });
          return new TextEncoder().encode(storedJson).length;
        }
      }

      // Fallback for non-Change data: accurate byte size.
      return new TextEncoder().encode(json).length;
    } catch {
      return 0;
    }
  };
}

/**
 * Calculate size after base64 LZ compression of the entire data object.
 * Use `createOpsCompressedSizeCalculator` instead when your server uses
 * `CompressedStoreBackend`, as that compresses only the `ops` field for a
 * more accurate size estimate.
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
 * Calculate size after uint8array LZ compression of the entire data object.
 * Use `createOpsCompressedSizeCalculator` instead when your server uses
 * `CompressedStoreBackend`, as that compresses only the `ops` field for a
 * more accurate size estimate.
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
