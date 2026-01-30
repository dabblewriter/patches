import type { OpsCompressor } from '../compression/index.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type {
  Change,
  DocumentTombstone,
  EditableVersionMetadata,
  ListChangesOptions,
  ListVersionsOptions,
  VersionMetadata,
} from '../types.js';
import type { PatchesStoreBackend } from './types.js';

/**
 * A Change object where ops may be compressed.
 * Used internally for storage; decompressed before returning to callers.
 */
interface StoredChange extends Omit<Change, 'ops'> {
  ops: JSONPatchOp[] | string | Uint8Array;
}

/**
 * Wraps a PatchesStoreBackend to transparently compress/decompress the ops field of Changes.
 * Compression happens before save and decompression happens after load.
 *
 * This allows backends with row-size limits to store larger changes by compressing the payload.
 *
 * @example
 * import { base64Compressor } from '@dabble/patches/compression';
 * const backend = new CompressedStoreBackend(myStore, base64Compressor);
 */
export class CompressedStoreBackend implements PatchesStoreBackend {
  constructor(
    private readonly store: PatchesStoreBackend,
    private readonly compressor: OpsCompressor
  ) {}

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

  // === Version Operations (compress changes and state ops) ===

  async createVersion(docId: string, metadata: VersionMetadata, state: any, changes: Change[]): Promise<void> {
    const compressedChanges = changes.map(c => this.compressChange(c));
    return this.store.createVersion(docId, metadata, state, compressedChanges as unknown as Change[]);
  }

  async appendVersionChanges(
    docId: string,
    versionId: string,
    changes: Change[],
    newEndedAt: number,
    newRev: number,
    newState: any
  ): Promise<void> {
    const compressedChanges = changes.map(c => this.compressChange(c));
    return this.store.appendVersionChanges(
      docId,
      versionId,
      compressedChanges as unknown as Change[],
      newEndedAt,
      newRev,
      newState
    );
  }

  async loadVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    const stored = (await this.store.loadVersionChanges(docId, versionId)) as unknown as StoredChange[];
    return stored.map(s => this.decompressChange(s));
  }

  // === Pass-through Operations (no compression needed) ===

  get loadLastVersionState(): PatchesStoreBackend['loadLastVersionState'] {
    return this.store.loadLastVersionState?.bind(this.store);
  }

  get saveLastVersionState(): PatchesStoreBackend['saveLastVersionState'] {
    return this.store.saveLastVersionState?.bind(this.store);
  }

  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    return this.store.updateVersion(docId, versionId, metadata);
  }

  async listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]> {
    return this.store.listVersions(docId, options);
  }

  async loadVersionState(docId: string, versionId: string): Promise<any | undefined> {
    return this.store.loadVersionState(docId, versionId);
  }

  async deleteDoc(docId: string): Promise<void> {
    return this.store.deleteDoc(docId);
  }

  async createTombstone(tombstone: DocumentTombstone): Promise<void> {
    return this.store.createTombstone(tombstone);
  }

  async getTombstone(docId: string): Promise<DocumentTombstone | undefined> {
    return this.store.getTombstone(docId);
  }

  async removeTombstone(docId: string): Promise<void> {
    return this.store.removeTombstone(docId);
  }
}
