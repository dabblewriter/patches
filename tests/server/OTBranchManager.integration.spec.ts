import { describe, expect, it, vi } from 'vitest';
import { buildVersionState } from '../../src/algorithms/ot/server/buildVersionState';
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
    // Build state through the exported builder, like a production store: the version's parent
    // chain is what bounds the reads, so a version written without one is visible here.
    const state = await buildVersionState(this, docId, metadata, changes);
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
    // Copy — real backends deserialize an independent snapshot per read. Returning the live
    // record would let stale-snapshot interleavings self-heal via shared mutation, hiding
    // exactly the concurrency races these tests exist to model.
    const branch = this.branches.get(branchId);
    return branch ? { ...branch } : null;
  }

  async createBranch(branch: Branch): Promise<void> {
    this.branches.set(branch.id, { ...branch });
  }

  async updateBranch(branchId: string, updates: Partial<Branch>): Promise<void> {
    const branch = this.branches.get(branchId);
    if (branch) Object.assign(branch, updates);
  }

  async updateBranchIf(branchId: string, updates: Partial<Branch>, expected: Record<string, any>): Promise<boolean> {
    const branch = this.branches.get(branchId);
    if (!branch || branch.deleted) return false;
    // Every key present on `expected` must match (undefined = field not set on the record).
    for (const key of Object.keys(expected)) {
      if ((branch as Record<string, any>)[key] !== expected[key]) return false;
    }
    Object.assign(branch, updates);
    return true;
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

/**
 * Simulate a crash in the B-1 window: the merge commit lands but the process dies before the
 * `lastMergedRev` update. Only the first watermark write fails; base-pinning writes
 * (`mergeBaseRev`) and later attempts go through.
 */
function failWatermarkOnce(store: MemoryOTBranchStore) {
  const original = store.updateBranchIf.bind(store);
  let failed = false;
  store.updateBranchIf = async (branchId, updates, expected) => {
    if (!failed && 'lastMergedRev' in updates) {
      failed = true;
      throw new Error('simulated crash before watermark update');
    }
    return original(branchId, updates, expected);
  };
}

/** All change ids on a doc, in log order — duplicates would appear twice. */
async function changeIds(store: MemoryOTBranchStore, docId: string): Promise<string[]> {
  return (await store.listChanges(docId, {})).map(c => c.id);
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
    await server.captureCurrentVersion(branchId, { name: 'Session 1' });

    await manager.mergeBranch(branchId);
    const afterFirst = store.getVersions('doc1').filter(v => v.origin === 'branch');
    expect(afterFirst.map(v => v.name)).toEqual(['Session 1']);

    // Branch session 2: rev 4, versioned on the branch
    await server.commitChanges(branchId, [change('e3', 3, '/edit3', 3)]);
    await server.captureCurrentVersion(branchId, { name: 'Session 2' });

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

  it('chains the first copied version to the source timeline', async () => {
    const { store, server, manager } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Prod shape: the source carries its own auto-versions below the branch point.
    await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
    await server.commitChanges('doc1', [change('s2', 1, '/src2', 2)]);
    const sourceVersion = await server.captureCurrentVersion('doc1');

    const branchId = await manager.createBranch('doc1', 2);
    await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
    await server.captureCurrentVersion(branchId, { name: 'Session' });

    await manager.mergeBranch(branchId);

    // Unanchored, building the copy's state replays doc1 from rev 1 (and warns about it).
    const [copied] = store.getVersions('doc1').filter(v => v.origin === 'branch');
    expect(copied.parentId).toBe(sourceVersion);
    expect(warn).not.toHaveBeenCalled();

    // Bridged from the parent snapshot, the copy still holds the true state at its endRev.
    expect(JSON.parse((await store.loadVersionState('doc1', copied.id))!)).toEqual({
      src1: 1,
      src2: 2,
      edit1: 1,
    });
    warn.mockRestore();
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

  describe('merge retry and concurrency safety', () => {
    it('retries cleanly after a crash between commit and watermark update — zero duplicate ops', async () => {
      const { store, server, manager } = setup();

      await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
      const branchId = await manager.createBranch('doc1', 1);
      await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
      await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);

      failWatermarkOnce(store);
      await expect(manager.mergeBranch(branchId)).rejects.toThrow('simulated crash');

      // The commit landed but the watermark write did not — the classic crash window.
      expect((await store.loadBranch(branchId))!.lastMergedRev).toBeUndefined();
      expect(await changeIds(store, 'doc1')).toEqual(['s1', 'e1', 'e2']);

      // Retry re-reads the stale watermark and re-sends the same changes; their preserved
      // ids dedup inside commitChanges, so the mainline gains nothing twice.
      await manager.mergeBranch(branchId);

      expect(await changeIds(store, 'doc1')).toEqual(['s1', 'e1', 'e2']);
      expect((await store.loadBranch(branchId))!.lastMergedRev).toBe(3);
      const { state } = await coldLoad(server, 'doc1');
      expect(state).toEqual({ src1: 1, edit1: 1, edit2: 2 });
    });

    it('does not duplicate copied versions when a crashed merge is retried', async () => {
      const { store, server, manager } = setup();

      await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
      const branchId = await manager.createBranch('doc1', 1);
      await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
      await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);
      const branchVersionId = (await server.captureCurrentVersion(branchId, { name: 'Session 1' }))!;

      failWatermarkOnce(store);
      await expect(manager.mergeBranch(branchId)).rejects.toThrow('simulated crash');
      await manager.mergeBranch(branchId);

      // The retry adopts the copy made by the first attempt instead of minting a duplicate.
      const copied = store.getVersions('doc1').filter(v => v.origin === 'branch');
      expect(copied).toHaveLength(1);
      expect(copied[0].id).toBe(branchVersionId);
      expect(copied[0].name).toBe('Session 1');
    });

    it('handles interleaved concurrent merges — no duplicates, no lost edits, watermark correct', async () => {
      const { store, server, manager } = setup();

      await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
      const branchId = await manager.createBranch('doc1', 1);
      await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
      await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);

      // Park merge A between its commit and its watermark CAS — the interleaving window.
      let parkA!: () => void;
      const aParked = new Promise<void>(resolve => (parkA = resolve));
      let releaseA!: () => void;
      const aReleased = new Promise<void>(resolve => (releaseA = resolve));
      const original = store.updateBranchIf.bind(store);
      let intercept = true;
      store.updateBranchIf = async (branchId, updates, expected) => {
        if (intercept && 'lastMergedRev' in updates) {
          intercept = false;
          parkA();
          await aReleased;
        }
        return original(branchId, updates, expected);
      };

      const mergeA = manager.mergeBranch(branchId);
      await aParked;

      // An edit lands on the branch while A is mid-merge…
      await server.commitChanges(branchId, [change('e3', 3, '/edit3', 3)]);
      // …and a second merge of the same branch runs to completion before A finishes.
      await manager.mergeBranch(branchId);
      expect((await store.loadBranch(branchId))!.lastMergedRev).toBe(4);

      releaseA();
      await mergeA;

      // A's stale CAS loses and reconciles — it must not rewind the watermark to 3.
      expect((await store.loadBranch(branchId))!.lastMergedRev).toBe(4);
      // e1/e2 were sent by both merges but committed once; e3 was merged exactly once.
      expect(await changeIds(store, 'doc1')).toEqual(['s1', 'e1', 'e2', 'e3']);
      const { state } = await coldLoad(server, 'doc1');
      expect(state).toEqual({ src1: 1, edit1: 1, edit2: 2, edit3: 3 });
      // Nothing left to merge.
      expect(await manager.mergeBranch(branchId)).toEqual([]);
    });

    it('leaves a mid-merge branch edit uncovered so the next merge picks it up', async () => {
      const { store, server, manager } = setup();

      await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
      const branchId = await manager.createBranch('doc1', 1);
      await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
      await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);

      let parkA!: () => void;
      const aParked = new Promise<void>(resolve => (parkA = resolve));
      let releaseA!: () => void;
      const aReleased = new Promise<void>(resolve => (releaseA = resolve));
      const original = store.updateBranchIf.bind(store);
      let intercept = true;
      store.updateBranchIf = async (branchId, updates, expected) => {
        if (intercept && 'lastMergedRev' in updates) {
          intercept = false;
          parkA();
          await aReleased;
        }
        return original(branchId, updates, expected);
      };

      const mergeA = manager.mergeBranch(branchId);
      await aParked;
      // Branch edit lands after A read its batch (revs 2–3) but before A stamps the watermark.
      await server.commitChanges(branchId, [change('e3', 3, '/edit3', 3)]);
      releaseA();
      await mergeA;

      // The watermark covers only what A actually merged — never the branch tip at write time.
      expect((await store.loadBranch(branchId))!.lastMergedRev).toBe(3);
      expect(await changeIds(store, 'doc1')).toEqual(['s1', 'e1', 'e2']);

      // The next merge picks up the uncovered edit.
      await manager.mergeBranch(branchId);
      expect((await store.loadBranch(branchId))!.lastMergedRev).toBe(4);
      expect(await changeIds(store, 'doc1')).toEqual(['s1', 'e1', 'e2', 'e3']);
      const { state } = await coldLoad(server, 'doc1');
      expect(state).toEqual({ src1: 1, edit1: 1, edit2: 2, edit3: 3 });
    });

    it('dedups a clamped-branch retry via the pinned merge base even though the tip advanced', async () => {
      const { store, server, manager } = setup();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Migrated doc: source renumbered down to rev 3, branch record still claims
      // branchedAtRev 5 (ahead of the tip).
      await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
      await server.commitChanges('doc1', [change('s2', 1, '/src2', 2)]);
      await server.commitChanges('doc1', [change('s3', 2, '/src3', 3)]);
      const now = Date.now();
      await store.createBranch({
        id: 'b1',
        docId: 'doc1',
        branchedAtRev: 5,
        contentStartRev: 2,
        createdAt: now,
        modifiedAt: now,
      });
      await store.saveChanges('b1', [
        { ...rootChange('i1', { src1: 1, src2: 2, src3: 3 }), createdAt: now, committedAt: now } as Change,
      ]);
      await server.commitChanges('b1', [change('e1', 1, '/edit1', 1)]);
      await server.commitChanges('b1', [change('e2', 2, '/edit2', 2)]);

      failWatermarkOnce(store);
      await expect(manager.mergeBranch('b1')).rejects.toThrow('simulated crash');

      // First attempt clamped the base to the tip (3), pinned it, and committed e1/e2 at 4–5.
      expect((await store.loadBranch('b1'))!.mergeBaseRev).toBe(3);
      expect(await changeIds(store, 'doc1')).toEqual(['s1', 's2', 's3', 'e1', 'e2']);

      // The tip (5) now equals branchedAtRev, so an unpinned retry would recompute base=5 —
      // a dedup window that no longer contains the committed copies at revs 4–5, letting
      // e1/e2 commit a second time. The pinned base keeps the window stable.
      await manager.mergeBranch('b1');

      expect(await changeIds(store, 'doc1')).toEqual(['s1', 's2', 's3', 'e1', 'e2']);
      expect((await store.loadBranch('b1'))!.lastMergedRev).toBe(3);
      const { state } = await coldLoad(server, 'doc1');
      expect(state).toEqual({ src1: 1, src2: 2, src3: 3, edit1: 1, edit2: 2 });
      warnSpy.mockRestore();
    });

    it('dedups concurrent merges of a clamped branch when one reads the tip after the other commits', async () => {
      const { store, server, manager } = setup();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Migrated doc: source renumbered down to rev 3, branch record still claims
      // branchedAtRev 5 (ahead of the tip).
      await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
      await server.commitChanges('doc1', [change('s2', 1, '/src2', 2)]);
      await server.commitChanges('doc1', [change('s3', 2, '/src3', 3)]);
      const now = Date.now();
      await store.createBranch({
        id: 'b1',
        docId: 'doc1',
        branchedAtRev: 5,
        contentStartRev: 2,
        createdAt: now,
        modifiedAt: now,
      });
      await store.saveChanges('b1', [
        { ...rootChange('i1', { src1: 1, src2: 2, src3: 3 }), createdAt: now, committedAt: now } as Change,
      ]);
      await server.commitChanges('b1', [change('e1', 1, '/edit1', 1)]);
      await server.commitChanges('b1', [change('e2', 2, '/edit2', 2)]);

      // Park merge B inside its source-tip read: B's branch snapshot predates any pin, and
      // the read completes only after merge A has pinned the clamped base and committed.
      let parkB!: () => void;
      const bParked = new Promise<void>(resolve => (parkB = resolve));
      let releaseB!: () => void;
      const bReleased = new Promise<void>(resolve => (releaseB = resolve));
      const originalGetCurrentRev = store.getCurrentRev.bind(store);
      let intercept = true;
      store.getCurrentRev = async docId => {
        if (intercept && docId === 'doc1') {
          intercept = false;
          parkB();
          await bReleased;
        }
        return originalGetCurrentRev(docId);
      };

      const mergeB = manager.mergeBranch('b1');
      await bParked;

      // Merge A runs to completion: clamps and pins the base (3), commits e1/e2 at revs 4–5.
      await manager.mergeBranch('b1');
      expect((await store.loadBranch('b1'))!.mergeBaseRev).toBe(3);
      expect(await changeIds(store, 'doc1')).toEqual(['s1', 's2', 's3', 'e1', 'e2']);

      // B resumes: its tip read (5) includes A's own merge commits, so branchedAtRev (5) <=
      // tip and the healthy early-return off the stale snapshot would resolve base 5 — a
      // dedup window that misses the copies at revs 4–5, committing e1/e2 a second time.
      // B must observe A's pin (written before A committed anything) and reuse base 3.
      releaseB();
      await mergeB;

      expect(await changeIds(store, 'doc1')).toEqual(['s1', 's2', 's3', 'e1', 'e2']);
      expect((await store.loadBranch('b1'))!.lastMergedRev).toBe(3);
      const { state } = await coldLoad(server, 'doc1');
      expect(state).toEqual({ src1: 1, src2: 2, src3: 3, edit1: 1, edit2: 2 });
      warnSpy.mockRestore();
    });

    it('keeps working on stores without the updateBranchIf capability (legacy semantics)', async () => {
      const { store, server, manager } = setup();
      (store as any).updateBranchIf = undefined;

      await server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
      const branchId = await manager.createBranch('doc1', 1);
      await server.commitChanges(branchId, [change('e1', 1, '/edit1', 1)]);
      await manager.mergeBranch(branchId);
      expect((await store.loadBranch(branchId))!.lastMergedRev).toBe(2);

      await server.commitChanges(branchId, [change('e2', 2, '/edit2', 2)]);
      await manager.mergeBranch(branchId);
      expect((await store.loadBranch(branchId))!.lastMergedRev).toBe(3);
      expect(await changeIds(store, 'doc1')).toEqual(['s1', 'e1', 'e2']);
    });
  });
});
