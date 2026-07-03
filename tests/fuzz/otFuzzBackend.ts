import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges.js';
import { RevConflictError } from '../../src/server/RevConflictError.js';
import type { OTStoreBackend } from '../../src/server/types.js';
import type {
  Change,
  EditableVersionMetadata,
  ListChangesOptions,
  ListVersionsOptions,
  VersionMetadata,
} from '../../src/types.js';

interface StoredVersion {
  metadata: VersionMetadata;
  /** JSON string of the state at metadata.endRev (built at creation, like real backends). */
  state: string;
  changes: Change[];
}

interface StoredDoc {
  changes: Change[];
  versions: Map<string, StoredVersion>;
}

/**
 * In-memory OT store backend for the convergence fuzz suite.
 *
 * Faithful to the OTStoreBackend contract in the ways the fuzzer exercises:
 * - `saveChanges` enforces [docId, rev] uniqueness with RevConflictError, like real stores.
 * - `createVersion` builds and persists version state (required — `getDoc` streams version
 *   state as the snapshot base), by replaying the full change log through `endRev`.
 * - `listVersions` implements the cursor semantics of ListVersionsOptions (startAfter /
 *   endBefore are cursors relative to the sort order, flipping under `reverse`).
 *
 * The full change log is retained forever so the suite can independently reconstruct the
 * authoritative head state and audit change-id accounting.
 */
export class OTFuzzBackend implements OTStoreBackend {
  private docs = new Map<string, StoredDoc>();

  private getOrCreate(docId: string): StoredDoc {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = { changes: [], versions: new Map() };
      this.docs.set(docId, doc);
    }
    return doc;
  }

  /** The full committed change log (fuzz assertions read this). */
  log(docId: string): Change[] {
    return this.docs.get(docId)?.changes ?? [];
  }

  /** All stored versions (fuzz assertions may inspect these). */
  allVersions(docId: string): StoredVersion[] {
    return Array.from(this.docs.get(docId)?.versions.values() ?? []);
  }

  async getCurrentRev(docId: string): Promise<number> {
    const doc = this.docs.get(docId);
    return doc?.changes[doc.changes.length - 1]?.rev ?? 0;
  }

  async saveChanges(docId: string, changes: Change[]): Promise<void> {
    const doc = this.getOrCreate(docId);
    const existing = new Set(doc.changes.map(c => c.rev));
    for (const change of changes) {
      if (change.rev == null) throw new Error(`saveChanges: change ${change.id} has no rev`);
      if (existing.has(change.rev)) throw new RevConflictError(`Rev ${change.rev} already exists for ${docId}`);
      existing.add(change.rev);
    }
    doc.changes.push(...changes);
    doc.changes.sort((a, b) => a.rev - b.rev);
  }

  async listChanges(docId: string, options: ListChangesOptions = {}): Promise<Change[]> {
    const doc = this.docs.get(docId);
    if (!doc) return [];
    let changes = doc.changes.slice();
    if (options.startAfter !== undefined) changes = changes.filter(c => c.rev > options.startAfter!);
    if (options.endBefore !== undefined) changes = changes.filter(c => c.rev < options.endBefore!);
    if (options.withoutBatchId !== undefined) changes = changes.filter(c => c.batchId !== options.withoutBatchId);
    if (options.reverse) changes.reverse();
    if (options.limit !== undefined) changes = changes.slice(0, options.limit);
    return changes;
  }

  async deleteDoc(docId: string): Promise<void> {
    this.docs.delete(docId);
  }

  async createVersion(docId: string, metadata: VersionMetadata, changes?: Change[]): Promise<void> {
    const doc = this.getOrCreate(docId);
    // Build version state the way a real backend must: state at endRev. The full log is
    // retained, so replay from scratch — simple and unambiguous.
    const upToEnd = doc.changes.filter(c => c.rev <= metadata.endRev);
    const state = applyChanges(null, upToEnd);
    doc.versions.set(metadata.id, { metadata, state: JSON.stringify(state), changes: changes ?? [] });
  }

  async listVersions(docId: string, options: ListVersionsOptions = {}): Promise<VersionMetadata[]> {
    const doc = this.docs.get(docId);
    if (!doc) return [];
    const orderBy = options.orderBy ?? 'endRev';
    let versions = Array.from(doc.versions.values()).map(v => v.metadata);
    if (options.origin) versions = versions.filter(v => v.origin === options.origin);
    if (options.groupId) versions = versions.filter(v => v.groupId === options.groupId);

    const key = (v: VersionMetadata): number | string => v[orderBy] ?? 0;
    versions.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    if (options.reverse) versions.reverse();

    // startAfter/endBefore are cursors relative to the current sort order (see
    // ListVersionsOptions): ascending, startAfter keeps field > value; reversed, field < value.
    if (options.startAfter !== undefined) {
      versions = options.reverse
        ? versions.filter(v => key(v) < options.startAfter!)
        : versions.filter(v => key(v) > options.startAfter!);
    }
    if (options.endBefore !== undefined) {
      versions = options.reverse
        ? versions.filter(v => key(v) > options.endBefore!)
        : versions.filter(v => key(v) < options.endBefore!);
    }
    if (options.limit !== undefined) versions = versions.slice(0, options.limit);
    return versions;
  }

  async loadVersion(docId: string, versionId: string): Promise<VersionMetadata | undefined> {
    return this.docs.get(docId)?.versions.get(versionId)?.metadata;
  }

  async loadVersionState(docId: string, versionId: string): Promise<string | undefined> {
    return this.docs.get(docId)?.versions.get(versionId)?.state;
  }

  async loadVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    return this.docs.get(docId)?.versions.get(versionId)?.changes ?? [];
  }

  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    const version = this.docs.get(docId)?.versions.get(versionId);
    if (version) version.metadata = { ...version.metadata, ...metadata };
  }
}
