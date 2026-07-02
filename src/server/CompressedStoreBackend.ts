import type { OpsCompressor } from '../compression/index.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type {
  Branch,
  Change,
  DocumentTombstone,
  EditableVersionMetadata,
  ListBranchesOptions,
  ListChangesOptions,
  ListVersionsOptions,
  VersionMetadata,
} from '../types.js';
import type { BranchingStoreBackend, OTStoreBackend, TombstoneStoreBackend } from './types.js';

/**
 * Store backend type that supports OT operations and optionally tombstones and branching.
 */
type CompressibleStore = OTStoreBackend & Partial<TombstoneStoreBackend> & Partial<BranchingStoreBackend>;

/**
 * A Change object where ops may be compressed.
 * Used internally for storage; decompressed before returning to callers.
 */
interface StoredChange extends Omit<Change, 'ops'> {
  ops: JSONPatchOp[] | string | Uint8Array;
}

/**
 * Wraps an OTStoreBackend to transparently compress/decompress the ops field of Changes.
 * Compression happens before save and decompression happens after load.
 *
 * Compression covers change rows only (saveChanges/listChanges). Version changes pass
 * through uncompressed: the inner store builds version state from them, and versions
 * live in blob/JSON storage without row-size limits. Branch and tombstone metadata
 * carry no ops and pass through untouched.
 *
 * This allows backends with row-size limits to store larger changes by compressing the payload.
 *
 * @example
 * import { base64Compressor } from '@dabble/patches/compression';
 * const backend = new CompressedStoreBackend(myStore, base64Compressor);
 */
export class CompressedStoreBackend
  implements OTStoreBackend, Partial<TombstoneStoreBackend>, Partial<BranchingStoreBackend>
{
  /** Present only when the inner store defines it, so ID generation falls back correctly. */
  createBranchId?: (docId: string) => Promise<string> | string;

  constructor(
    private readonly store: CompressibleStore,
    private readonly compressor: OpsCompressor
  ) {
    if (store.createBranchId) this.createBranchId = store.createBranchId.bind(store);
  }

  /**
   * Compresses a single change's ops field.
   */
  private compressChange(change: Change): StoredChange {
    return {
      ...change,
      ops: this.compressor.compress(change.ops),
    };
  }

  /**
   * Decompresses a single change's ops field.
   */
  private decompressChange(stored: StoredChange): Change {
    if (this.compressor.isCompressed(stored.ops)) {
      return {
        ...stored,
        ops: this.compressor.decompress(stored.ops),
      } as Change;
    }
    // Already decompressed (for backwards compatibility if some ops weren't compressed)
    return stored as Change;
  }

  // === Change Operations (compressed) ===

  async saveChanges(docId: string, changes: Change[]): Promise<void> {
    const compressed = changes.map(c => this.compressChange(c));
    return this.store.saveChanges(docId, compressed as unknown as Change[]);
  }

  async listChanges(docId: string, options: ListChangesOptions): Promise<Change[]> {
    const stored = (await this.store.listChanges(docId, options)) as unknown as StoredChange[];
    return stored.map(s => this.decompressChange(s));
  }

  // === Version Operations (uncompressed) ===

  // Changes pass through uncompressed: the inner store builds version state by applying
  // them (see buildVersionState), and compressed ops would silently produce empty state.
  async createVersion(docId: string, metadata: VersionMetadata, changes?: Change[]): Promise<void> {
    return this.store.createVersion(docId, metadata, changes);
  }

  // Decompression retained for versions stored compressed by earlier releases;
  // the isCompressed check makes it a no-op for uncompressed rows.
  async loadVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    const stored = (await this.store.loadVersionChanges?.(docId, versionId)) as unknown as StoredChange[] | undefined;
    return stored?.map(s => this.decompressChange(s)) ?? [];
  }

  // === Pass-through Operations (no compression needed) ===

  async getCurrentRev(docId: string): Promise<number> {
    return this.store.getCurrentRev(docId);
  }

  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    return this.store.updateVersion(docId, versionId, metadata);
  }

  async listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]> {
    return this.store.listVersions(docId, options);
  }

  async loadVersion(docId: string, versionId: string): Promise<VersionMetadata | undefined> {
    return this.store.loadVersion(docId, versionId);
  }

  async loadVersionState(docId: string, versionId: string): Promise<string | ReadableStream<string> | undefined> {
    return this.store.loadVersionState(docId, versionId);
  }

  async deleteDoc(docId: string): Promise<void> {
    return this.store.deleteDoc(docId);
  }

  async createTombstone(tombstone: DocumentTombstone): Promise<void> {
    return this.store.createTombstone?.(tombstone);
  }

  async getTombstone(docId: string): Promise<DocumentTombstone | undefined> {
    return this.store.getTombstone?.(docId);
  }

  async removeTombstone(docId: string): Promise<void> {
    return this.store.removeTombstone?.(docId);
  }

  async listBranches(docId: string, options?: ListBranchesOptions): Promise<Branch[]> {
    return (await this.store.listBranches?.(docId, options)) ?? [];
  }

  async loadBranch(branchId: string): Promise<Branch | null> {
    return (await this.store.loadBranch?.(branchId)) ?? null;
  }

  async createBranch(branch: Branch): Promise<void> {
    return this.store.createBranch?.(branch);
  }

  async updateBranch(
    branchId: string,
    updates: Partial<Omit<Branch, 'id' | 'docId' | 'branchedAtRev' | 'createdAt' | 'contentStartRev'>>
  ): Promise<void> {
    return this.store.updateBranch?.(branchId, updates);
  }

  async deleteBranch(branchId: string): Promise<void> {
    return this.store.deleteBranch?.(branchId);
  }
}
