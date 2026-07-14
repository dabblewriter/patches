import { describe, expect, it, vi } from 'vitest';
import { buildVersionState } from '../../src/algorithms/ot/server/buildVersionState';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { base64Compressor } from '../../src/compression';
import { createVersionMetadata } from '../../src/data/version';
import { CompressedStoreBackend } from '../../src/server/CompressedStoreBackend';
import { readStreamAsString } from '../../src/server/jsonReadable';
import { OTBranchManager } from '../../src/server/OTBranchManager';
import { OTServer } from '../../src/server/OTServer';
import type { BranchingStoreBackend, OTStoreBackend } from '../../src/server/types';
import type {
  Branch,
  Change,
  ChangeInput,
  EditableVersionMetadata,
  ListBranchesOptions,
  ListChangesOptions,
  ListVersionsOptions,
  VersionMetadata,
} from '../../src/types';

/**
 * In-memory OT + branching store that builds version state from the changes handed to
 * createVersion (via the exported buildVersionState), like a production store would.
 * Rows are stored as given so tests can assert exactly what the wrapper persisted.
 */
class MemoryOTBranchStore implements OTStoreBackend, BranchingStoreBackend {
  private docs = new Map<string, Change[]>();
  private versions = new Map<string, { metadata: VersionMetadata; state: any; changes: Change[] }[]>();
  private branches = new Map<string, Branch>();

  /** Log reads during state building go through the decompressing wrapper, like a production store. */
  readView: OTStoreBackend = this;

  async getCurrentRev(docId: string): Promise<number> {
    return this.docs.get(docId)?.at(-1)?.rev ?? 0;
  }

  async saveChanges(docId: string, changes: Change[]): Promise<void> {
    const existing = this.docs.get(docId) ?? [];
    this.docs.set(
      docId,
      [...existing, ...changes].sort((a, b) => a.rev - b.rev)
    );
  }

  async listChanges(docId: string, options: ListChangesOptions = {}): Promise<Change[]> {
    let changes = this.docs.get(docId) ?? [];
    if (options.startAfter !== undefined) changes = changes.filter(c => c.rev > options.startAfter!);
    if (options.endBefore !== undefined) changes = changes.filter(c => c.rev < options.endBefore!);
    if (options.withoutBatchId) changes = changes.filter(c => c.batchId !== options.withoutBatchId);
    if (options.reverse) changes = [...changes].reverse();
    if (options.limit !== undefined) changes = changes.slice(0, options.limit);
    return changes;
  }

  async deleteDoc(docId: string): Promise<void> {
    this.docs.delete(docId);
    this.versions.delete(docId);
  }

  async createVersion(docId: string, metadata: VersionMetadata, changes: Change[] = []): Promise<void> {
    const state = await buildVersionState(this.readView, docId, metadata, changes);
    const versions = this.versions.get(docId) ?? [];
    versions.push({ metadata, state, changes });
    this.versions.set(docId, versions);
  }

  async listVersions(docId: string, options: ListVersionsOptions = {}): Promise<VersionMetadata[]> {
    let result = (this.versions.get(docId) ?? []).map(v => v.metadata);
    if (options.origin) result = result.filter(v => v.origin === options.origin);
    if (options.groupId) result = result.filter(v => v.groupId === options.groupId);
    const orderBy = options.orderBy || 'endRev';
    result.sort((a, b) => (a[orderBy] as number) - (b[orderBy] as number));
    if (options.reverse) result.reverse();
    if (options.startAfter !== undefined) {
      const cursor = options.startAfter as number;
      result = result.filter(v =>
        options.reverse ? (v[orderBy] as number) < cursor : (v[orderBy] as number) > cursor
      );
    }
    if (options.endBefore !== undefined) {
      const cursor = options.endBefore as number;
      result = result.filter(v =>
        options.reverse ? (v[orderBy] as number) > cursor : (v[orderBy] as number) < cursor
      );
    }
    if (options.limit !== undefined) result = result.slice(0, options.limit);
    return result;
  }

  async loadVersion(docId: string, versionId: string): Promise<VersionMetadata | undefined> {
    return this.versions.get(docId)?.find(v => v.metadata.id === versionId)?.metadata;
  }

  async loadVersionState(docId: string, versionId: string): Promise<string | undefined> {
    const state = this.versions.get(docId)?.find(v => v.metadata.id === versionId)?.state;
    return state !== undefined && state !== null ? JSON.stringify(state) : undefined;
  }

  async loadVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    return this.versions.get(docId)?.find(v => v.metadata.id === versionId)?.changes ?? [];
  }

  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    const version = this.versions.get(docId)?.find(v => v.metadata.id === versionId);
    if (version) Object.assign(version.metadata, metadata);
  }

  async listBranches(docId: string, options?: ListBranchesOptions): Promise<Branch[]> {
    const since = options?.since ?? 0;
    return [...this.branches.values()].filter(b => b.docId === docId && (since ? b.modifiedAt > since : !b.deleted));
  }

  async loadBranch(branchId: string): Promise<Branch | null> {
    return this.branches.get(branchId) ?? null;
  }

  async createBranch(branch: Branch): Promise<void> {
    this.branches.set(branch.id, branch);
  }

  async updateBranch(branchId: string, updates: Partial<Branch>): Promise<void> {
    const branch = this.branches.get(branchId);
    if (branch) Object.assign(branch, updates);
  }

  async deleteBranch(branchId: string): Promise<void> {
    this.branches.delete(branchId);
  }

  /** Raw stored rows, exactly as persisted (compressed or not). */
  rawChanges(docId: string): Change[] {
    return this.docs.get(docId) ?? [];
  }

  rawVersions(docId: string): { metadata: VersionMetadata; state: any; changes: Change[] }[] {
    return this.versions.get(docId) ?? [];
  }

  /** Seed a version row directly, bypassing state building (simulates legacy stored data). */
  seedVersion(docId: string, metadata: VersionMetadata, changes: Change[]): void {
    const versions = this.versions.get(docId) ?? [];
    versions.push({ metadata, state: undefined, changes });
    this.versions.set(docId, versions);
  }
}

function change(id: string, baseRev: number, path: string, value: any): ChangeInput {
  return { id, baseRev, rev: baseRev + 1, ops: [{ op: 'add', path, value }] };
}

function rootChange(id: string, value: any): ChangeInput {
  return { id, baseRev: 0, rev: 1, ops: [{ op: 'replace', path: '', value }] };
}

/** Cold load: parse the getDoc stream and apply the change tail to the version state. */
async function coldLoad(server: OTServer, docId: string): Promise<any> {
  const json = await readStreamAsString(await server.getDoc(docId));
  const { state, changes } = JSON.parse(json);
  return applyChanges(state, changes);
}

function setup() {
  const store = new MemoryOTBranchStore();
  const wrapped = new CompressedStoreBackend(store, base64Compressor);
  store.readView = wrapped;
  const server = new OTServer(wrapped);
  const manager = new OTBranchManager(wrapped, server);
  return { store, wrapped, server, manager };
}

describe('CompressedStoreBackend composition', () => {
  it('createBranch seeds real state from a compressed source doc', async () => {
    const { store, server, manager } = setup();

    await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
    await server.commitChanges('doc1', [change('s2', 1, '/src2', 2)]);

    // Sanity: the source change log is stored compressed
    expect(store.rawChanges('doc1').every(c => base64Compressor.isCompressed(c.ops))).toBe(true);

    const branchId = await manager.createBranch('doc1', 2);

    // The branch init change log rows are compressed exactly once
    const branchRows = store.rawChanges(branchId);
    expect(branchRows.length).toBeGreaterThan(0);
    for (const row of branchRows) {
      expect(base64Compressor.isCompressed(row.ops)).toBe(true);
      expect(Array.isArray(base64Compressor.decompress(row.ops as unknown as string))).toBe(true);
    }

    // The branch's initial version was built from real (uncompressed) init changes
    const [initialVersion] = store.rawVersions(branchId);
    expect(initialVersion.changes.every(c => Array.isArray(c.ops))).toBe(true);
    const versionState = await store.loadVersionState(branchId, initialVersion.metadata.id);
    expect(JSON.parse(versionState!)).toEqual({ src1: 1, src2: 2 });

    expect(await coldLoad(server, branchId)).toEqual({ src1: 1, src2: 2 });
  });

  it('mergeBranch round-trips without double-compressing the source log', async () => {
    const { store, server, manager } = setup();
    // The source carries no versions of its own, so each copied version's state build
    // legitimately replays from rev 1 — and warns about it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
    await server.commitChanges('doc1', [change('s2', 1, '/src2', 2)]);
    const branchId = await manager.createBranch('doc1', 2);

    await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
    await manager.mergeBranch(branchId);

    await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);
    await manager.mergeBranch(branchId);

    // Every source row is compressed exactly once: decompressing yields the ops array,
    // not a double-compressed string
    for (const row of store.rawChanges('doc1')) {
      expect(base64Compressor.isCompressed(row.ops)).toBe(true);
      expect(Array.isArray(base64Compressor.decompress(row.ops as unknown as string))).toBe(true);
    }

    const merged = await store.listChanges('doc1', {});
    expect(merged).toHaveLength(4);

    expect(await coldLoad(server, 'doc1')).toEqual({ src1: 1, src2: 2, edit1: 1, edit2: 2 });
    warn.mockRestore();
  });

  it('copies branch versions to the source with uncompressed change rows', async () => {
    const { store, wrapped, server, manager } = setup();
    // The source carries no versions of its own, so the copied version's state build
    // legitimately replays from rev 1 — and warns about it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
    const branchId = await manager.createBranch('doc1', 1);

    await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
    await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);
    await server.captureCurrentVersion(branchId, { name: 'Session' });

    await manager.mergeBranch(branchId);

    const copied = store.rawVersions('doc1').filter(v => v.metadata.origin === 'branch');
    expect(copied).toHaveLength(1);
    expect(copied[0].changes.every(c => Array.isArray(c.ops))).toBe(true);
    warn.mockRestore();
  });

  it('createVersion hands the inner store uncompressed changes that buildVersionState can apply', async () => {
    const { store, wrapped, server } = setup();

    await server.commitChanges('doc1', [rootChange('s1', { title: 'Doc' })]);
    await server.commitChanges('doc1', [change('s2', 1, '/count', 42)]);

    const changes = await wrapped.listChanges('doc1', {});
    await wrapped.createVersion(
      'doc1',
      createVersionMetadata({ origin: 'main', startedAt: 1, endedAt: 2, startRev: 1, endRev: 2 }),
      changes
    );

    const [version] = store.rawVersions('doc1');
    expect(version.changes.every(c => Array.isArray(c.ops))).toBe(true);
    const state = await store.loadVersionState('doc1', version.metadata.id);
    expect(JSON.parse(state!)).toEqual({ title: 'Doc', count: 42 });
  });

  it('loadVersionChanges still decompresses legacy compressed version rows', async () => {
    const { store, wrapped } = setup();

    const ops = [{ op: 'add' as const, path: '/legacy', value: true }];
    const legacyRow = {
      id: 'c1',
      rev: 1,
      baseRev: 0,
      ops: base64Compressor.compress(ops),
      createdAt: 0,
      committedAt: 0,
    } as unknown as Change;
    const metadata = createVersionMetadata({ origin: 'main', startedAt: 0, endedAt: 1, startRev: 1, endRev: 1 });
    store.seedVersion('doc1', metadata, [legacyRow]);

    const loaded = await wrapped.loadVersionChanges('doc1', metadata.id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].ops).toEqual(ops);
  });
});
