import type { JSONPatchOp } from '../json-patch/types.js';
import type {
  Branch,
  Change,
  DocumentTombstone,
  EditableVersionMetadata,
  ListVersionsOptions,
  VersionMetadata,
} from '../types.js';
import type {
  BranchingStoreBackend,
  ListFieldsOptions,
  LWWStoreBackend,
  TextDeltaEntry,
  TextDeltaStoreBackend,
  TombstoneStoreBackend,
  VersioningStoreBackend,
} from './types.js';

interface DocData {
  snapshot: { state: any; rev: number } | null;
  ops: JSONPatchOp[];
  rev: number;
}

interface VersionData {
  metadata: VersionMetadata;
  state: any;
}

/**
 * In-memory implementation of LWWStoreBackend for testing.
 * Also implements TombstoneStoreBackend, VersioningStoreBackend, and BranchingStoreBackend
 * for comprehensive testing of all LWW functionality.
 *
 * @example
 * ```typescript
 * import { LWWServer } from '@dabble/patches/server';
 * import { LWWMemoryStoreBackend } from '@dabble/patches/server';
 *
 * const store = new LWWMemoryStoreBackend();
 * const server = new LWWServer(store);
 * ```
 */
export class LWWMemoryStoreBackend
  implements
    LWWStoreBackend,
    TextDeltaStoreBackend,
    VersioningStoreBackend,
    TombstoneStoreBackend,
    BranchingStoreBackend
{
  private docs = new Map<string, DocData>();
  private tombstones = new Map<string, DocumentTombstone>();
  private versions = new Map<string, VersionData[]>();
  private branches = new Map<string, Branch>();
  private textDeltas = new Map<string, TextDeltaEntry[]>();

  private getOrCreateDoc(docId: string): DocData {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = { snapshot: null, ops: [], rev: 0 };
      this.docs.set(docId, doc);
    }
    return doc;
  }

  // === Revision ===

  async getCurrentRev(docId: string): Promise<number> {
    return this.docs.get(docId)?.rev ?? 0;
  }

  // === Snapshot ===

  async getSnapshot(docId: string): Promise<{ state: any; rev: number } | null> {
    return this.docs.get(docId)?.snapshot ?? null;
  }

  async saveSnapshot(docId: string, state: any, rev: number): Promise<void> {
    const doc = this.getOrCreateDoc(docId);
    doc.snapshot = { state, rev };
    // Remove ops up to snapshot rev (they're baked into the snapshot)
    doc.ops = doc.ops.filter(op => (op.rev ?? 0) > rev);
  }

  // === Ops ===

  async saveOps(docId: string, newOps: JSONPatchOp[], pathsToDelete?: string[]): Promise<number> {
    const doc = this.getOrCreateDoc(docId);
    const newRev = ++doc.rev;

    // Delete specified paths
    if (pathsToDelete) {
      for (const path of pathsToDelete) {
        doc.ops = doc.ops.filter(op => op.path !== path);
      }
    }

    for (const op of newOps) {
      // Set the rev on the op
      op.rev = newRev;

      // Delete the existing op at this path and any children atomically
      const childPrefix = op.path + '/';
      doc.ops = doc.ops.filter(existing => existing.path !== op.path && !existing.path.startsWith(childPrefix));

      // Add the new op
      doc.ops.push(op);
    }

    return newRev;
  }

  async listOps(docId: string, options?: ListFieldsOptions): Promise<JSONPatchOp[]> {
    const doc = this.docs.get(docId);
    if (!doc) {
      return [];
    }

    // No options: return all ops
    if (!options) {
      return [...doc.ops];
    }

    // Filter by sinceRev
    if ('sinceRev' in options) {
      return doc.ops.filter(op => (op.rev ?? 0) > options.sinceRev);
    }

    // Filter by paths
    if ('paths' in options) {
      const pathSet = new Set(options.paths);
      return doc.ops.filter(op => pathSet.has(op.path));
    }

    return [];
  }

  // === Deletion ===

  async deleteDoc(docId: string): Promise<void> {
    this.docs.delete(docId);
    this.textDeltas.delete(docId);
  }

  // === Tombstones ===

  async createTombstone(tombstone: DocumentTombstone): Promise<void> {
    this.tombstones.set(tombstone.docId, tombstone);
  }

  async getTombstone(docId: string): Promise<DocumentTombstone | undefined> {
    return this.tombstones.get(docId);
  }

  async removeTombstone(docId: string): Promise<void> {
    this.tombstones.delete(docId);
  }

  // === Versioning ===

  async createVersion(docId: string, metadata: VersionMetadata, state: any, _changes?: Change[]): Promise<void> {
    const versions = this.versions.get(docId) || [];
    versions.push({ metadata, state });
    this.versions.set(docId, versions);
  }

  async listVersions(docId: string, options?: ListVersionsOptions): Promise<VersionMetadata[]> {
    const versions = this.versions.get(docId) || [];
    let result = versions.map(v => v.metadata);

    if (!options) return result;

    // Filter by origin
    if (options.origin) {
      result = result.filter(v => v.origin === options.origin);
    }

    // Filter by groupId
    if (options.groupId) {
      result = result.filter(v => v.groupId === options.groupId);
    }

    // Sort by orderBy field (default: endRev)
    const orderBy = options.orderBy || 'endRev';
    result.sort((a, b) => {
      const aVal = a[orderBy] as number;
      const bVal = b[orderBy] as number;
      return aVal - bVal;
    });

    // Handle reverse
    if (options.reverse) {
      result.reverse();
    }

    // Handle startAfter/endBefore
    if (options.startAfter !== undefined) {
      const startVal = options.startAfter as number;
      result = result.filter(v => (v[orderBy] as number) > startVal);
    }
    if (options.endBefore !== undefined) {
      const endVal = options.endBefore as number;
      result = result.filter(v => (v[orderBy] as number) < endVal);
    }

    // Handle limit
    if (options.limit !== undefined) {
      result = result.slice(0, options.limit);
    }

    return result;
  }

  async loadVersionState(docId: string, versionId: string): Promise<any | undefined> {
    const versions = this.versions.get(docId) || [];
    const version = versions.find(v => v.metadata.id === versionId);
    return version?.state;
  }

  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    const versions = this.versions.get(docId) || [];
    const version = versions.find(v => v.metadata.id === versionId);
    if (version) {
      Object.assign(version.metadata, metadata);
    }
  }

  // === Branching ===

  async listBranches(docId: string): Promise<Branch[]> {
    const result: Branch[] = [];
    for (const branch of this.branches.values()) {
      if (branch.docId === docId) {
        result.push(branch);
      }
    }
    return result;
  }

  async loadBranch(branchId: string): Promise<Branch | null> {
    return this.branches.get(branchId) || null;
  }

  async createBranch(branch: Branch): Promise<void> {
    this.branches.set(branch.id, branch);
  }

  async updateBranch(branchId: string, updates: Partial<Pick<Branch, 'status' | 'name' | 'metadata'>>): Promise<void> {
    const branch = this.branches.get(branchId);
    if (branch) {
      Object.assign(branch, updates);
    }
  }

  async closeBranch(branchId: string): Promise<void> {
    await this.updateBranch(branchId, { status: 'closed' });
  }

  // === Text Delta Log ===

  async appendTextDelta(docId: string, path: string, delta: any[], rev: number): Promise<void> {
    const deltas = this.textDeltas.get(docId) ?? [];
    deltas.push({ path, delta, rev });
    this.textDeltas.set(docId, deltas);
  }

  async getTextDeltasSince(docId: string, path: string, sinceRev: number): Promise<TextDeltaEntry[]> {
    const deltas = this.textDeltas.get(docId) ?? [];
    return deltas.filter(d => d.path === path && d.rev > sinceRev).sort((a, b) => a.rev - b.rev);
  }

  async getAllTextDeltasSince(docId: string, sinceRev: number): Promise<TextDeltaEntry[]> {
    const deltas = this.textDeltas.get(docId) ?? [];
    return deltas.filter(d => d.rev > sinceRev).sort((a, b) => a.rev - b.rev);
  }

  async pruneTextDeltas(docId: string, atOrBeforeRev: number, paths?: string[]): Promise<void> {
    const deltas = this.textDeltas.get(docId);
    if (!deltas) return;

    if (paths) {
      const pathSet = new Set(paths);
      this.textDeltas.set(
        docId,
        deltas.filter(d => !(pathSet.has(d.path) && d.rev <= atOrBeforeRev))
      );
    } else {
      this.textDeltas.set(
        docId,
        deltas.filter(d => d.rev > atOrBeforeRev)
      );
    }
  }

  // === Testing utilities ===

  /**
   * Clears all data from the store. Useful for test cleanup.
   */
  clear(): void {
    this.docs.clear();
    this.tombstones.clear();
    this.versions.clear();
    this.branches.clear();
    this.textDeltas.clear();
  }

  /**
   * Gets the raw document data for inspection in tests.
   */
  getDocData(docId: string): DocData | undefined {
    return this.docs.get(docId);
  }

  /**
   * Gets the versions for a document for inspection in tests.
   */
  getVersions(docId: string): VersionData[] | undefined {
    return this.versions.get(docId);
  }

  /**
   * Gets all branches for inspection in tests.
   */
  getBranches(): Map<string, Branch> {
    return this.branches;
  }
}
