import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { createVersionMetadata } from '../../src/data/version';
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
 * In-memory OT + branching store with real listChanges/listVersions cursor semantics
 * (mirroring LWWMemoryStoreBackend) so branch flows can run end-to-end.
 */
class MemoryOTBranchStore implements OTStoreBackend, BranchingStoreBackend {
  private docs = new Map<string, Change[]>();
  private versions = new Map<string, { metadata: VersionMetadata; state?: any; changes: Change[] }[]>();
  private branches = new Map<string, Branch>();

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
    const versions = this.versions.get(docId) ?? [];
    // Build state like a production store would: replay the change log through endRev
    // (docs in these tests start with a root replace, so the log rebuilds from null)
    const log = (this.docs.get(docId) ?? []).filter(c => c.rev <= metadata.endRev);
    const state = log.length > 0 ? applyChanges(null, log) : undefined;
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
    // Cursors are relative to the (possibly reversed) sort order — see LWWMemoryStoreBackend
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
    return state !== undefined ? JSON.stringify(state) : undefined;
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
    const branch = this.branches.get(branchId);
    if (branch) {
      this.branches.set(branchId, {
        id: branch.id,
        docId: branch.docId,
        modifiedAt: Date.now(),
        deleted: true,
      } as Branch);
    }
  }

  getVersions(docId: string): VersionMetadata[] {
    return (this.versions.get(docId) ?? []).map(v => v.metadata);
  }
}

function change(id: string, baseRev: number, path: string, value: any): ChangeInput {
  return { id, baseRev, rev: baseRev + 1, ops: [{ op: 'add', path, value }] };
}

function rootChange(id: string, value: any): ChangeInput {
  return { id, baseRev: 0, rev: 1, ops: [{ op: 'replace', path: '', value }] };
}

/** Cold load: parse the getDoc stream and apply the change tail to the version state. */
async function coldLoad(server: OTServer, docId: string): Promise<{ state: any; rev: number; changes: Change[] }> {
  const json = await readStreamAsString(await server.getDoc(docId));
  const { state, rev, changes } = JSON.parse(json);
  return { state: applyChanges(state, changes), rev, changes };
}

function setup() {
  const store = new MemoryOTBranchStore();
  const server = new OTServer(store);
  const manager = new OTBranchManager(store, server);
  return { store, server, manager };
}

describe('OTBranchManager integration', () => {
  it('cold loads a branch with more revs than branchedAtRev without dropping early edits', async () => {
    const { server, manager } = setup();

    // Source at rev 3
    await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
    await server.commitChanges('doc1', [change('s2', 1, '/src2', 2)]);
    await server.commitChanges('doc1', [change('s3', 2, '/src3', 3)]);

    const branchId = await manager.createBranch('doc1', 3);

    // Four branch edits: branch revs 2..5, exceeding branchedAtRev (3)
    await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
    await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);
    await server.commitChanges(branchId, [change('e3', 3, '/edit3', 3)]);
    await server.commitChanges(branchId, [change('e4', 4, '/edit4', 4)]);

    // The initial version is stamped with branch-local revs (endRev 1), so a cold load
    // must replay all four edits — stamping the source's rev 3 dropped edit1/edit2.
    const { state } = await coldLoad(server, branchId);
    expect(state).toEqual({ src1: 1, src2: 2, src3: 3, edit1: 1, edit2: 2, edit3: 3, edit4: 4 });
  });

  it('does not re-copy already-merged branch versions on repeat merges', async () => {
    const { store, server, manager } = setup();

    await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
    const branchId = await manager.createBranch('doc1', 1);

    // Branch session 1: revs 2..3, versioned on the branch
    await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
    await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);
    const session1 = await store.listChanges(branchId, { startAfter: 1 });
    await store.createVersion(
      branchId,
      createVersionMetadata({ origin: 'main', name: 'Session 1', startedAt: 1, endedAt: 2, startRev: 2, endRev: 3 }),
      session1
    );

    await manager.mergeBranch(branchId);
    const afterFirst = store.getVersions('doc1').filter(v => v.origin === 'branch');
    expect(afterFirst.map(v => v.name)).toEqual(['Session 1']);

    // Branch session 2: rev 4, versioned on the branch
    await server.commitChanges(branchId, [change('e3', 3, '/edit3', 3)]);
    const session2 = await store.listChanges(branchId, { startAfter: 3 });
    await store.createVersion(
      branchId,
      createVersionMetadata({ origin: 'main', name: 'Session 2', startedAt: 3, endedAt: 3, startRev: 4, endRev: 4 }),
      session2
    );

    await manager.mergeBranch(branchId);

    // Session 1 must not be duplicated by the second merge
    const afterSecond = store.getVersions('doc1').filter(v => v.origin === 'branch');
    expect(afterSecond.map(v => v.name).sort()).toEqual(['Session 1', 'Session 2']);
  });

  it('re-stamps copied branch versions into the source rev-space', async () => {
    const { store, server, manager } = setup();

    // Source at rev 1; branch whose local rev-space extends past the post-merge source tip
    // (3 init changes seeded by the client: contentStartRev 4)
    await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
    const branchId = await manager.createBranch('doc1', 1, { id: 'branch1', contentStartRev: 4 });
    const now = Date.now();
    await store.saveChanges(branchId, [
      { ...rootChange('i1', { src1: 1 }), createdAt: now, committedAt: now } as Change,
      { ...change('i2', 1, '/init2', 2), createdAt: now, committedAt: now } as Change,
      { ...change('i3', 2, '/init3', 3), createdAt: now, committedAt: now } as Change,
    ]);

    // Branch user edits at branch revs 4..5, versioned on the branch as [4..5]
    await server.commitChanges(branchId, [change('e1', 3, '/edit1', 1)]);
    await server.commitChanges(branchId, [change('e2', 4, '/edit2', 2)]);
    const session = await store.listChanges(branchId, { startAfter: 3 });
    await store.createVersion(
      branchId,
      createVersionMetadata({ origin: 'main', name: 'Session', startedAt: 1, endedAt: 2, startRev: 4, endRev: 5 }),
      session
    );

    await manager.mergeBranch(branchId);

    // The merge commits source revs 2..3; the copied version must carry those revs, not the
    // branch-local [4..5] — a branch-local endRev (5) past the source tip (3) would poison
    // the source's version watermark and leave real source revs un-versioned.
    const copied = store.getVersions('doc1').filter(v => v.origin === 'branch');
    expect(copied).toHaveLength(1);
    expect(copied[0].startRev).toBe(2);
    expect(copied[0].endRev).toBe(3);
    expect(copied[0].endRev).toBeLessThanOrEqual(await store.getCurrentRev('doc1'));
  });

  it('merges and cold loads correctly across two merge rounds', async () => {
    const { server, manager } = setup();

    await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
    await server.commitChanges('doc1', [change('s2', 1, '/src2', 2)]);
    const branchId = await manager.createBranch('doc1', 2);

    await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
    await manager.mergeBranch(branchId);

    await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);
    await manager.mergeBranch(branchId);

    const { state } = await coldLoad(server, 'doc1');
    expect(state).toEqual({ src1: 1, src2: 2, edit1: 1, edit2: 2 });
  });
});
