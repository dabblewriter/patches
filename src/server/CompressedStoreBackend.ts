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
export class CompressedStoreBackend<S extends CompressibleStore = CompressibleStore>
  implements OTStoreBackend, Partial<TombstoneStoreBackend>, Partial<BranchingStoreBackend>
{
  /** Present only when the inner store defines it, so ID generation falls back correctly. */
  createBranchId?: (docId: string) => Promise<string> | string;

  // Branching methods exist on the wrapper ONLY when the inner store implements them (bound in
  // the constructor). Defining them unconditionally made the wrapper silently advertise
  // branching over a non-branching store: `createBranch` fabricated success, the branch
  // metadata evaporated, and `mergeBranch` later threw on the missing record (DAB-601).
  // Consumers feature-detect by presence, exactly as they would on the inner store — and the
  // TYPES follow the inner store too: wrapping a branching store yields required methods (so
  // e.g. OTBranchManager accepts the wrapper directly), wrapping a non-branching store yields
  // `undefined`.
  listBranches: S extends BranchingStoreBackend
    ? (docId: string, options?: ListBranchesOptions) => Promise<Branch[]>
    : undefined;
  loadBranch: S extends BranchingStoreBackend ? (branchId: string) => Promise<Branch | null> : undefined;
  createBranch: S extends BranchingStoreBackend ? (branch: Branch) => Promise<void> : undefined;
  updateBranch: S extends BranchingStoreBackend
    ? (
        branchId: string,
        updates: Partial<Omit<Branch, 'id' | 'docId' | 'branchedAtRev' | 'createdAt' | 'contentStartRev'>>
      ) => Promise<void>
    : undefined;
  deleteBranch: S extends BranchingStoreBackend ? (branchId: string) => Promise<void> : undefined;

  constructor(
    private readonly store: S,
    private readonly compressor: OpsCompressor
  ) {
    if (store.createBranchId) this.createBranchId = store.createBranchId.bind(store);
    // Conditional-typed properties can't be assigned generically without help — the runtime
    // presence check IS the S-extends-BranchingStoreBackend distinction the types encode.
    this.listBranches = (store.listBranches ? store.listBranches.bind(store) : undefined) as this['listBranches'];
    this.loadBranch = (store.loadBranch ? store.loadBranch.bind(store) : undefined) as this['loadBranch'];
    this.createBranch = (store.createBranch ? store.createBranch.bind(store) : undefined) as this['createBranch'];
    this.updateBranch = (store.updateBranch ? store.updateBranch.bind(store) : undefined) as this['updateBranch'];
    this.deleteBranch = (store.deleteBranch ? store.deleteBranch.bind(store) : undefined) as this['deleteBranch'];
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
}
