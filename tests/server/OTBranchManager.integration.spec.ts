import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVersionState } from '../../src/algorithms/ot/server/buildVersionState';
import { breakChanges, breakChangesIntoBatches } from '../../src/algorithms/ot/shared/changeBatching';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { compressedSizeUint8 } from '../../src/compression';
import { createChange } from '../../src/data/change';
import { createVersionMetadata } from '../../src/data/version';
import type { BranchClientStore } from '../../src/client/BranchClientStore';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { PatchesBranchClient } from '../../src/client/PatchesBranchClient';
import { DuplicateChangeIdsError } from '../../src/server/DuplicateChangeIdsError';
import { readStreamAsString } from '../../src/server/jsonReadable';
import {
  MergeContentDuplicationError,
  MergeFrameAlignmentError,
  MergePartialProgressError,
  OTBranchManager,
  type OTBranchManagerOptions,
} from '../../src/server/OTBranchManager';
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
  private committedIds = new Map<string, Set<string>>();
  private versions = new Map<string, { metadata: VersionMetadata; state?: any; changes: Change[] }[]>();
  private branches = new Map<string, Branch>();

  async getCurrentRev(docId: string): Promise<number> {
    return this.docs.get(docId)?.at(-1)?.rev ?? 0;
  }

  async saveChanges(docId: string, changes: Change[]): Promise<void> {
    // The mandatory write-time id guard production stores implement: merge retries re-send
    // changes whose committed copies sit outside commitChanges' read-side dedup window, and
    // only this catches them. Nothing is written when any id is a duplicate.
    const ids = this.committedIds.get(docId) ?? new Set<string>();
    const duplicates = changes.filter(c => ids.has(c.id)).map(c => c.id);
    if (duplicates.length > 0) throw new DuplicateChangeIdsError(docId, duplicates);
    changes.forEach(c => ids.add(c.id));
    this.committedIds.set(docId, ids);

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
    if (options.maxBytes !== undefined) {
      // Byte-budget read hint: stop once the accumulated ops pass the budget, but never
      // return an empty page — a single oversized change must still be readable.
      let bytes = 0;
      const budgeted: Change[] = [];
      for (const c of changes) {
        bytes += JSON.stringify(c.ops).length;
        if (bytes > options.maxBytes && budgeted.length > 0) break;
        budgeted.push(c);
      }
      changes = budgeted;
    }
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

  /** Drop a doc's changes at or below `rev`, as a compacted/pruned production log would. */
  pruneChangesThrough(docId: string, rev: number): void {
    this.docs.set(
      docId,
      (this.docs.get(docId) ?? []).filter(c => c.rev > rev)
    );
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

function setup(managerOptions?: OTBranchManagerOptions) {
  const store = new MemoryOTBranchStore();
  const server = new OTServer(store);
  const manager = new OTBranchManager(store, server, managerOptions);
  return { store, server, manager };
}

/**
 * Simulate a crash in a merge window: its commit lands but the process dies before the
 * `lastMergedRev` update. Only the `nth` watermark write fails; base-pinning writes
 * (`mergeBaseRev`) and later attempts go through.
 */
function failWatermarkOnce(store: MemoryOTBranchStore, nth = 1) {
  const original = store.updateBranchIf.bind(store);
  let writes = 0;
  let failed = false;
  store.updateBranchIf = async (branchId, updates, expected) => {
    if (!failed && 'lastMergedRev' in updates && ++writes === nth) {
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

/**
 * A merge result must be applicable as one run: `PatchesSync.applyMergeChanges` walks it in rev
 * order, so an interior gap between the first and last rev would strand the tail.
 */
function expectRevDense(changes: Change[]): void {
  expect(changes.map(c => c.rev)).toEqual(changes.map((_, i) => changes[0].rev + i));
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
    // The source carries no versions of its own, so each copied version's state build
    // legitimately replays from rev 1 — and warns about it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
    warn.mockRestore();
  });

  it('re-stamps copied branch versions into the source rev-space', async () => {
    const { store, server, manager } = setup();
    // Neither the branch nor the source carries a chainable version, so the state builds
    // legitimately replay from rev 1 — and warn about it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
    warn.mockRestore();
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

    const { state } = await coldLoad(server, 'doc1');
    expect(state).toEqual({ src1: 1, src2: 2, edit1: 1, edit2: 2 });
    warn.mockRestore();
  });

  // A branch under active editorial review accumulates changes for as long as it stays open —
  // five figures within a couple of days on a shared book (DAB-896). Merging that in one batch
  // scales the read, the transform, the write batch and the response with the branch's whole
  // history, so the merge is committed in windows instead.
  describe('windowed merge', () => {
    beforeEach(() => {
      // Copied versions build against a source with no versions of its own; that warns.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.mocked(console.warn).mockRestore();
    });

    /** Source at rev 2 with `count` single-op branch edits waiting to merge. */
    async function branchWithEdits(count: number, managerOptions?: OTBranchManagerOptions) {
      const ctx = setup(managerOptions);
      await ctx.server.commitChanges('doc1', [rootChange('s1', { src1: 1 })]);
      await ctx.server.commitChanges('doc1', [change('s2', 1, '/src2', 2)]);
      const branchId = await ctx.manager.createBranch('doc1', 2);
      for (let i = 1; i <= count; i++) {
        await ctx.server.commitChanges(branchId, [change(`e${i}`, i, `/edit${i}`, i)]);
      }
      return { ...ctx, branchId };
    }

    const expectedState = (count: number) => {
      const state: Record<string, number> = { src1: 1, src2: 2 };
      for (let i = 1; i <= count; i++) state[`edit${i}`] = i;
      return state;
    };

    /** The window slice reads on the branch — the frame's catch-up reads carry no byte budget. */
    const windowReads = (calls: [string, ListChangesOptions?][], branchId: string) =>
      calls.filter(([docId, options]) => docId === branchId && options?.maxBytes !== undefined);

    it('merges a branch larger than the window across several windows', async () => {
      const { store, server, manager, branchId } = await branchWithEdits(7, { maxChangesPerMerge: 2 });
      const listChanges = vi.spyOn(store, 'listChanges');

      const committed = await manager.mergeBranch(branchId);

      // 7 edits (branch revs 2..8) at 2 per window: four windows, each starting where the
      // frame left off rather than back at the content floor, then the trailing read that
      // finds nothing left — the only thing that ends a merge, since a short slice can mean
      // a byte-trimmed window rather than the end of the branch.
      const reads = windowReads(listChanges.mock.calls as any, branchId);
      expect(reads.every(([, options]) => options!.limit === 2)).toBe(true);
      expect(reads.map(([, options]) => options!.startAfter)).toEqual([1, 3, 5, 7, 8]);

      // Every edit lands exactly once, and the caller still sees the whole merge.
      const { state } = await coldLoad(server, 'doc1');
      expect(state).toEqual(expectedState(7));
      expect(committed).toHaveLength(7);
      const ids = await changeIds(store, 'doc1');
      expect(new Set(ids).size).toBe(ids.length);
      listChanges.mockRestore();
    });

    it('produces the same source state as an unwindowed merge', async () => {
      const windowed = await branchWithEdits(7, { maxChangesPerMerge: 2 });
      const single = await branchWithEdits(7, { maxChangesPerMerge: 1_000 });

      await windowed.manager.mergeBranch(windowed.branchId);
      await single.manager.mergeBranch(single.branchId);

      const a = await coldLoad(windowed.server, 'doc1');
      const b = await coldLoad(single.server, 'doc1');
      expect(a.state).toEqual(b.state);
      expect(a.rev).toBe(b.rev);
    });

    it('advances the watermark to the branch tip so a follow-up merge is a no-op', async () => {
      const { store, manager, branchId } = await branchWithEdits(5, { maxChangesPerMerge: 2 });

      await manager.mergeBranch(branchId);

      expect((await store.loadBranch(branchId))?.lastMergedRev).toBe(6);
      await expect(manager.mergeBranch(branchId)).resolves.toEqual([]);
    });

    it('answers [] for a repeat merge when only the source has moved', async () => {
      const { store, server, manager, branchId } = await branchWithEdits(5, { maxChangesPerMerge: 2 });
      await manager.mergeBranch(branchId);

      // Foreign rows alone are the source moving on its own, not this branch merging — and
      // nothing persists on this path, so reporting them would repeat on every poll.
      const tip = await store.getCurrentRev('doc1');
      await server.commitChanges('doc1', [change('f1', tip, '/foreign', 1)]);
      await expect(manager.mergeBranch(branchId)).resolves.toEqual([]);
      await expect(manager.mergeBranch(branchId)).resolves.toEqual([]);
    });

    // The point of advancing the watermark per window: a merge that dies part-way is resumable
    // rather than all-or-nothing, so a branch too big to merge in one go still converges.
    it('resumes from the last committed window after a mid-merge failure', async () => {
      const { store, server, manager, branchId } = await branchWithEdits(7, { maxChangesPerMerge: 2 });
      const realListChanges = store.listChanges.bind(store);
      let reads = 0;
      store.listChanges = async (docId, options) => {
        if (docId === branchId && options?.maxBytes !== undefined && ++reads === 3) {
          throw new Error('simulated failure mid-merge');
        }
        return realListChanges(docId, options);
      };

      await expect(manager.mergeBranch(branchId)).rejects.toThrow('simulated failure mid-merge');

      // Two windows committed and the watermark records them — nothing is rolled back.
      expect((await store.loadBranch(branchId))?.lastMergedRev).toBe(5);
      expect((await coldLoad(server, 'doc1')).state).toEqual(expectedState(4));

      store.listChanges = realListChanges;
      await manager.mergeBranch(branchId);

      expect((await coldLoad(server, 'doc1')).state).toEqual(expectedState(7));
      const ids = await changeIds(store, 'doc1');
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('merge retry and concurrency safety', () => {
    // These merges copy branch versions onto sources that carry no versions of their own, so
    // building each copy's state legitimately replays from rev 1 — and warns about it. The
    // clamped-branch merges below also warn about clamping. Suppress both for clean output.
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.mocked(console.warn).mockRestore();
    });

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

    it('drains a mid-merge branch edit in the same call — watermark covers only what was read', async () => {
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
      // Branch edit lands after A read its first window (revs 2–3) but before A stamps the
      // watermark, so it sits above the cursor A is about to write.
      await server.commitChanges(branchId, [change('e3', 3, '/edit3', 3)]);
      releaseA();
      const merged = await mergeA;

      // A's next window reads past the cursor it just wrote and picks the edit up, so the call
      // drains the branch rather than leaving work for a follow-up merge.
      expect(merged.map(c => c.id)).toEqual(['e1', 'e2', 'e3']);
      const ids = await changeIds(store, 'doc1');
      expect(ids).toEqual(['s1', 'e1', 'e2', 'e3']);
      expect(new Set(ids).size).toBe(ids.length);

      // The watermark is the highest branch rev actually READ and committed — the merge never
      // stamps a tip it has not read, so an edit landing after the last read stays uncovered.
      const branch = (await store.loadBranch(branchId))!;
      expect(branch.lastMergedRev).toBe(4);
      expect(branch.lastMergedRev).toBe(await store.getCurrentRev(branchId));
      const { state } = await coldLoad(server, 'doc1');
      expect(state).toEqual({ src1: 1, edit1: 1, edit2: 2, edit3: 3 });
      expect(await manager.mergeBranch(branchId)).toEqual([]);
    });

    it('dedups a clamped-branch retry via the pinned merge base even though the tip advanced', async () => {
      const { store, server, manager } = setup();

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
    });

    it('dedups concurrent merges of a clamped branch when one reads the tip after the other commits', async () => {
      const { store, server, manager } = setup();

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

// ---------------------------------------------------------------------------
// DAB-760: "merging an editor copy duplicates the content of every scene".
//
// An editor copy is a client-seeded branch: the whole manuscript is seeded as
// changes at branch revs 1..N (a root replace, split by breakChanges), and
// `contentStartRev` = N+1. Merge replays only changes at/after contentStartRev,
// so the seed is meant to be excluded and never re-applied to main.
//
// The reporter rejected every tracked change first (net-zero content delta) and
// the merge STILL doubled every scene's body — Ryan's server-side op evidence:
// "~150 docs hit with @txt ops that are pure inserts with no leading retain —
// the merge inserted the branch's entire body at position 0 of each doc."
//
// Unlike every existing branch-merge test above (plain JSON `add` ops), these
// exercise `@txt` text-field merge, which is where a retain-less whole-body
// insert can arise (see src/json-patch/ops/text.ts apply-onto-empty-base).
// ---------------------------------------------------------------------------

/** An `@txt` (text field) op: composes `ops` onto the delta at `path`. */
function txtOp(path: string, ops: any[]) {
  return { op: '@txt' as const, path, value: ops };
}

/** A one-op `@txt` change. */
function txtChange(id: string, baseRev: number, path: string, ops: any[]): ChangeInput {
  return { id, baseRev, rev: baseRev + 1, ops: [txtOp(path, ops)] };
}

describe('DAB-760 editor-copy merge doubling', () => {
  const BODY1 = 'Chapter one. The grey cat sat by the window.\n';
  const BODY2 = 'Chapter two. The dog ran across the wide green yard.\n';

  // The guard is opt-in (refuse-vs-warn and the length threshold are consuming-server
  // policy); these tests arm it the way a protecting server would. The low threshold
  // matches the short test bodies.
  const GUARD: OTBranchManagerOptions = { contentDuplicationGuard: { action: 'refuse', minLength: 16 } };

  // A realistic two-scene manuscript. Bodies are inline Delta `{ops}` in the
  // project state — exactly how `cloneDeep(liveProject)` captures them.
  function manuscript() {
    return {
      docs: {
        d1: { id: 'd1', body: { content: { ops: [{ insert: BODY1 }] } } },
        d2: { id: 'd2', body: { content: { ops: [{ insert: BODY2 }] } } },
      },
    };
  }

  function docBody(state: any, docId: string): string {
    const c = state?.docs?.[docId]?.body?.content;
    const ops: any[] = Array.isArray(c) ? c : (c?.ops ?? []);
    return ops.map(o => (typeof o.insert === 'string' ? o.insert : '')).join('');
  }

  // A) Control — proves two things at once using the REAL client seeding path:
  //    1. `breakChanges` splits the whole-project seed into a structural replace
  //       plus one retain-less `@txt` insert per doc body (Ryan's op shape).
  //    2. When `contentStartRev` correctly counts that split, the merge excludes
  //       the entire seed and does not double — the server merge is faithful.
  it('control: real breakChanges seed with a correct contentStartRev does not double', async () => {
    const { store, server, manager } = setup(GUARD);
    const state = manuscript();
    await server.commitChanges('doc1', [rootChange('s1', state)]);

    // Seed exactly as the client does: one root-replace, split by breakChanges.
    const rootReplace = createChange(0, 1, [{ op: 'replace', path: '', value: state }], { committedAt: 0 }) as Change;
    const seed = breakChanges([rootReplace], 200); // small budget → per-doc @txt extraction
    // The seed really is a structural replace + per-doc @txt body inserts.
    expect(seed[0].ops[0].op).toBe('replace');
    expect(seed.some(c => c.ops.some((o: any) => o.op === '@txt'))).toBe(true);
    const seedSpan = seed[seed.length - 1].rev; // N
    expect(seedSpan).toBeGreaterThan(1);

    const branchId = 'branchOK';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: seedSpan + 1 }); // correct floor
    await store.saveChanges(branchId, seed);

    // A real edit above the floor that nets to zero: tracked insert, then reject.
    await server.commitChanges(branchId, [txtChange('ins', seedSpan, '/docs/d1/body/content', [{ insert: 'X' }])]);
    await server.commitChanges(branchId, [txtChange('rej', seedSpan + 1, '/docs/d1/body/content', [{ delete: 1 }])]);

    await manager.mergeBranch(branchId);

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(BODY1);
    expect(docBody(after, 'd2')).toBe(BODY2);
  });

  // B) Guard — the recorded `contentStartRev` undercounts the seed's committed
  //    rev span, so the per-doc `@txt` body inserts (revs 2..N) sit ABOVE the
  //    floor and `mergeBranch` would replay them onto main, re-inserting every
  //    scene's body at position 0 (the original DAB-760 doubling — no real edits,
  //    the reviewer rejected everything). The merge guard now detects that
  //    content-doubling signature and refuses the merge before committing, so the
  //    manuscript is left intact instead of doubled.
  //
  //    In production the desync arises at the seed→server sync boundary (the seed
  //    spans more revs than the floor accounts for). Modeled here as the floor
  //    sitting just after the structural replace (rev 1).
  it('guard: a floor that undercounts the seed is refused, not doubled', async () => {
    const { store, server, manager } = setup(GUARD);
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);

    // The real breakChanges shape for a large manuscript, made explicit so the
    // assertions are exact: structural replace (rev 1) then one @txt body per doc.
    const seed: Change[] = [
      createChange(
        0,
        1,
        [
          {
            op: 'replace',
            path: '',
            value: { docs: { d1: { id: 'd1', body: { content: {} } }, d2: { id: 'd2', body: { content: {} } } } },
          },
        ],
        { committedAt: 0 }
      ) as Change,
      createChange(1, 2, [txtOp('/docs/d1/body/content', [{ insert: BODY1 }])], { committedAt: 0 }) as Change,
      createChange(2, 3, [txtOp('/docs/d2/body/content', [{ insert: BODY2 }])], { committedAt: 0 }) as Change,
    ];
    const seedSpan = seed[seed.length - 1].rev; // 3
    expect(seedSpan).toBeGreaterThan(2); // the @txt bodies really are above the floor

    // THE DEFECT: floor undercounts the seed (2 instead of seedSpan + 1 = 4).
    const branchId = 'branchBug';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 });
    await store.saveChanges(branchId, seed);

    // A branch version above the floor — a refused merge must not copy it onto the source.
    await store.createVersion(
      branchId,
      createVersionMetadata({ origin: 'main', startRev: 2, endRev: 3, groupId: branchId }),
      seed.slice(1)
    );

    // Before the guard this doubled every scene; now the merge is refused before committing.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();

    // Nothing was committed — the manuscript is untouched (not doubled).
    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(BODY1);
    expect(docBody(after, 'd2')).toBe(BODY2);

    // ...and the refusal is genuinely side-effect-free: no changes, no orphaned version
    // copies on the source, and no watermark advance.
    expect(await changeIds(store, 'doc1')).toEqual(['s1']);
    expect(store.getVersions('doc1')).toEqual([]);
    expect((await store.loadBranch(branchId))!.lastMergedRev).toBeUndefined();
  });

  // C) No false positive — a legitimate branch that inserts a substantial NEW
  //    opening paragraph at the very start of a scene is a retain-less leading
  //    insert too, but it does not duplicate the field's existing head, so the
  //    guard must let it merge and land the new text (inserted, not doubled).
  it('guard: allows a legitimate large leading insert of new text', async () => {
    const { server, manager } = setup(GUARD);
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);

    const branchId = await manager.createBranch('doc1', 1); // server-materialized seed at rev 1
    const NEW_OPENING = 'A wholly new opening paragraph that did not exist before.\n';
    await server.commitChanges(branchId, [txtChange('open', 1, '/docs/d1/body/content', [{ insert: NEW_OPENING }])]);

    await manager.mergeBranch(branchId); // must NOT throw

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(NEW_OPENING + BODY1); // inserted at the head, not doubled
    expect(docBody(after, 'd2')).toBe(BODY2);
  });

  // D) Recreate the REAL desync end-to-end with the actual batching functions — nothing about
  //    the floor is hand-picked. dw3 computes `contentStartRev` from a COMPRESSED storage split
  //    (MAX_STORAGE_BYTES via compressedSizeUint8) but PatchesSync commits the seed split by the
  //    UNCOMPRESSED payload limit. A highly-compressible manuscript fits one storage piece yet
  //    the wire splits it into several, so `contentStartRev` undercounts the committed seed and
  //    the merge replays the tail. The small limits below mirror that real compressed/uncompressed
  //    asymmetry (dw3 uses 900KB compressed storage vs a 1MB uncompressed wire limit).
  it('recreate: compressed-vs-uncompressed seed split undercounts the floor; guard refuses the merge', async () => {
    const { store, server, manager } = setup(GUARD);
    const STORAGE = 3_000; // compressed measure (mirrors dw3 MAX_STORAGE_BYTES = 900_000)
    const PAYLOAD = 6_000; // uncompressed wire limit (mirrors the 1MB maxPayloadBytes)

    const bigBody = 'The grey cat sat by the window and watched the rain. '.repeat(600); // ~32KB, compresses tiny
    const state = { docs: { d1: { id: 'd1', body: { content: { ops: [{ insert: bigBody }] } } } } };
    await server.commitChanges('doc1', [rootChange('s1', state)]);

    const rootReplace = createChange(0, 1, [{ op: 'replace', path: '', value: state }], { committedAt: 0 }) as Change;

    // What the branch client USED to record for the floor: a storage-only (compressed) split.
    const storageOnly = breakChanges([rootReplace], STORAGE, compressedSizeUint8);
    const oldContentStartRev = storageOnly[storageOnly.length - 1].rev + 1;

    // What PatchesSync actually commits on the wire: split by both limits (payload is uncompressed).
    const committedSeed = breakChangesIntoBatches([rootReplace], {
      maxPayloadBytes: PAYLOAD,
      maxStorageBytes: STORAGE,
      sizeCalculator: compressedSizeUint8,
    }).flat();
    const committedSpan = committedSeed[committedSeed.length - 1].rev;

    // THE DESYNC — straight from the real functions, no hand-set floor:
    expect(committedSpan).toBeGreaterThan(oldContentStartRev - 1);

    // A branch created the old way pins the undercounting floor while the server holds the full
    // committed seed. The merge would re-insert the seeded body onto main; the guard refuses it.
    const branchId = 'branchRecreate';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: oldContentStartRev });
    await store.saveChanges(branchId, committedSeed);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(bigBody); // intact, not doubled
  });

  // E) End-to-end through the FIXED client path: the branch client persists the seed through
  //    a real algorithm whose own storage split is stricter than `docOptions` (the configs
  //    are independent in real deployments) and derives `contentStartRev` from the revisions
  //    actually persisted. The committed seed then matches the floor, so a real server merge
  //    with the guard armed neither doubles nor refuses. Under the old prediction-based
  //    floor, this exact setup undercounted the seed and the merge replayed its tail.
  it('end-to-end: a client-seeded branch derives a floor that merges without doubling', async () => {
    const { store, server, manager } = setup(GUARD);

    const bigBody = 'The grey cat sat by the window and watched the rain.\n'.repeat(600); // ~32KB
    const state = { docs: { d1: { id: 'd1', body: { content: { ops: [{ insert: bigBody }] } } } } };
    await server.commitChanges('doc1', [rootChange('s1', state)]);

    const docOptions = { maxStorageBytes: 3_000, maxPayloadBytes: 6_000, sizeCalculator: compressedSizeUint8 };
    const clientStore = new OTInMemoryStore();
    // The algorithm's own (uncompressed) storage limit re-splits the docOptions pre-split.
    const algorithm = new OTAlgorithm(clientStore, { maxStorageBytes: 2_000 });
    let sentContentStartRev = 0;
    const offlineApi = {
      listBranches: async () => [],
      createBranch: async (_docId: string, _rev: number, meta?: { contentStartRev?: number }) => {
        sentContentStartRev = meta!.contentStartRev!;
        return 'branchE2E';
      },
      updateBranch: async () => {},
      deleteBranch: async () => {},
      loadBranch: async () => undefined,
      saveBranches: async () => {},
      removeBranches: async () => {},
      listPendingBranches: async () => [],
      getLastModifiedAt: async () => undefined,
    } as unknown as BranchClientStore;
    const patchesStub = {
      defaultAlgorithm: 'ot',
      algorithms: { ot: algorithm },
      docOptions,
      trackDocs: async () => {},
      untrackDocs: async () => {},
      onChange: { emit: () => {} },
    } as any;

    const client = new PatchesBranchClient('doc1', offlineApi, patchesStub);
    const branchId = await client.createBranch(1, { id: 'branchE2E' }, state);

    // The floor counts the revisions the algorithm actually persisted...
    const seed = await clientStore.getPendingChanges(branchId);
    expect(seed.length).toBeGreaterThan(1);
    expect(sentContentStartRev).toBe(seed[seed.length - 1].rev + 1);
    // ...and the persisted seed is flush-stable: re-splitting with the sync config does not
    // renumber it, so the committed revisions are exactly the persisted ones.
    expect(breakChangesIntoBatches(seed, docOptions).flat().length).toBe(seed.length);

    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: sentContentStartRev });
    await store.saveChanges(branchId, seed);

    // A tracked edit that nets to zero (insert, then reject), like the original report.
    const seedSpan = seed[seed.length - 1].rev;
    await server.commitChanges(branchId, [txtChange('ins', seedSpan, '/docs/d1/body/content', [{ insert: 'X' }])]);
    await server.commitChanges(branchId, [txtChange('rej', seedSpan + 1, '/docs/d1/body/content', [{ delete: 1 }])]);

    await manager.mergeBranch(branchId); // guard armed — a bad floor would refuse here

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(bigBody); // intact: not doubled, not refused
  });

  // F) The near-miss: a floor off by ONE rev replays only the seed's LAST stored piece — a
  //    retain-prefixed insert that re-lands a mid-body slice immediately before the surviving
  //    copy of the same text. A prefix check misses it (silent corruption); tracking what the
  //    batch inserts against what survives catches it.
  it('guard: a floor off by one rev (a single tail piece) is refused', async () => {
    const { store, server, manager } = setup(GUARD);
    const STORAGE = 3_000;
    const PAYLOAD = 6_000;

    const bigBody = 'The grey cat sat by the window and watched the rain.\n'.repeat(600);
    const state = { docs: { d1: { id: 'd1', body: { content: { ops: [{ insert: bigBody }] } } } } };
    await server.commitChanges('doc1', [rootChange('s1', state)]);

    const rootReplace = createChange(0, 1, [{ op: 'replace', path: '', value: state }], { committedAt: 0 }) as Change;
    const committedSeed = breakChangesIntoBatches([rootReplace], {
      maxPayloadBytes: PAYLOAD,
      maxStorageBytes: STORAGE,
      sizeCalculator: compressedSizeUint8,
    }).flat();
    const committedSpan = committedSeed[committedSeed.length - 1].rev;
    expect(committedSpan).toBeGreaterThan(2);

    const branchId = 'branchOffByOne';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: committedSpan }); // one short
    await store.saveChanges(branchId, committedSeed);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(bigBody);
  });

  // F2) The same near-miss with the piece shapes OLDER splitters persisted: retain-less tail
  //     pieces that re-insert their slice at the head of the field. Branches seeded before the
  //     positional fix still hold these, so the head-anchored signature must keep refusing them.
  it('guard: a legacy retain-less tail piece is still refused', async () => {
    const { store, server, manager } = setup(GUARD);
    const STORAGE = 3_000;
    const PAYLOAD = 6_000;

    const bigBody = 'The grey cat sat by the window and watched the rain.\n'.repeat(600);
    const state = { docs: { d1: { id: 'd1', body: { content: { ops: [{ insert: bigBody }] } } } } };
    await server.commitChanges('doc1', [rootChange('s1', state)]);

    const rootReplace = createChange(0, 1, [{ op: 'replace', path: '', value: state }], { committedAt: 0 }) as Change;
    const committedSeed = breakChangesIntoBatches([rootReplace], {
      maxPayloadBytes: PAYLOAD,
      maxStorageBytes: STORAGE,
      sizeCalculator: compressedSizeUint8,
    })
      .flat()
      // Strip the positional retain prefixes back off, reproducing what a pre-fix splitter stored.
      .map(change => ({
        ...change,
        ops: change.ops.map(op =>
          op.op === '@txt' && Array.isArray(op.value) && op.value[0]?.retain ? { ...op, value: op.value.slice(1) } : op
        ),
      }));
    const committedSpan = committedSeed[committedSeed.length - 1].rev;
    expect(committedSpan).toBeGreaterThan(2);

    const branchId = 'branchLegacyTail';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: committedSpan }); // one short
    await store.saveChanges(branchId, committedSeed);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(bigBody);
  });

  // H) The retry contract under the guard. A crash between commit and watermark re-presents a
  //    batch the source has ALREADY committed, so on the retry every ordinary insert sits
  //    immediately before its own committed copy — indistinguishable, by text shape alone,
  //    from a replayed tail piece. Changes already inside the commit dedup window
  //    (`listChanges(startAfter: baseRev)`) are excluded from the guard walk, so the retry
  //    stays the documented dedup-to-a-no-op instead of latching the branch behind a refusal.
  it('guard: a crash-retry of an already-committed batch is not refused', async () => {
    const { store, server, manager } = setup(GUARD);
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
    const branchId = await manager.createBranch('doc1', 1);
    const para = 'A wholly new passage, absent from the source. ';
    await server.commitChanges(branchId, [
      txtChange('p1', 1, '/docs/d1/body/content', [{ retain: 13 }, { insert: para }]),
    ]);

    failWatermarkOnce(store);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toThrow('simulated crash');
    // The commit landed; the watermark write did not. The retry walks a head that already
    // contains `para` — and must not read that as content doubling.
    await manager.mergeBranch(branchId);
    err.mockRestore();

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(`Chapter one. ${para}The grey cat sat by the window.\n`);
  });

  // I) Formatted spans arrive as ADJACENT inserted fragments (bold/plain/italic), each under
  //    minLength on its own. The coalesced second pass still refuses the tail-piece shape when
  //    the duplicate is delivered fragmented.
  it('guard: a fragmented (formatted) tail-piece duplicate is still refused', async () => {
    const { server, manager } = setup(GUARD);
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
    const branchId = await manager.createBranch('doc1', 1);
    const slice = 'The grey cat sat by the window.'; // BODY1 at position 13, 31 chars
    await server.commitChanges(branchId, [
      txtChange('frag', 1, '/docs/d1/body/content', [
        { retain: 13 },
        { insert: slice.slice(0, 10), attributes: { bold: true } },
        { insert: slice.slice(10, 20) },
        { insert: slice.slice(20), attributes: { italic: true } },
      ]),
    ]);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();
  });

  // J) DOCUMENTED TRADE-OFF, pinned deliberately: pasting an exact ≥minLength copy of a
  //    passage immediately BEFORE its original (cursor at the start, paste) composes to the
  //    same text shape as a replayed tail piece, and is refused. Pasting AFTER the copied text
  //    merges fine, as does editing the pasted copy first. The escapes are the per-merge
  //    `'off'` override and the consumer's minLength policy. If this class of edit needs to
  //    merge untouched, the signature needs a discriminator beyond text shape — a product
  //    decision for the guard's owner, not something detection can infer.
  it('guard: pasting a duplicate paragraph immediately before its original is refused', async () => {
    const { server, manager } = setup(GUARD);
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
    const branchId = await manager.createBranch('doc1', 1);
    await server.commitChanges(branchId, [
      txtChange('paste', 1, '/docs/d1/body/content', [{ retain: 13 }, { insert: 'The grey cat sat by the window.' }]),
    ]);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();
  });

  // G) A whole-field `replace`/`add` is in the same family as the `@txt` seed pieces (the
  //    seed splitter emits structural replaces alongside them): one carrying an
  //    already-doubled value must be refused, while an ordinary rewrite passes.
  it('guard: a whole-field replace carrying doubled content is refused; a plain rewrite is not', async () => {
    const { server, manager } = setup(GUARD);
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);

    const doubled = await manager.createBranch('doc1', 1, { id: 'branchReplaceDoubled' });
    await server.commitChanges(doubled, [
      {
        id: 'rep',
        baseRev: 1,
        rev: 2,
        ops: [{ op: 'replace', path: '/docs/d1/body/content', value: { ops: [{ insert: BODY1 + BODY1 }] } }],
      },
    ]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(doubled)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();

    const REWRITE = `Rewritten opening. ${BODY1}`;
    const rewrite = await manager.createBranch('doc1', 1, { id: 'branchReplaceRewrite' });
    await server.commitChanges(rewrite, [
      {
        id: 'rw',
        baseRev: 1,
        rev: 2,
        ops: [{ op: 'replace', path: '/docs/d1/body/content', value: { ops: [{ insert: REWRITE }] } }],
      },
    ]);
    await manager.mergeBranch(rewrite); // must NOT throw

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(REWRITE);
  });

  // H) Ordinary editing shapes that carry a substantial leading insert must all merge: the
  //    delta library normalizes a paste-over-selection to insert-before-delete, so a prefix
  //    check refuses them. Tracking deleted spans lets them net out.
  it('guard: paste-over-selection, identical re-paste, and delete+undo all merge', async () => {
    const path = '/docs/d1/body/content';

    // Select-all, paste back a trimmed version that keeps the opening.
    {
      const { server, manager } = setup(GUARD);
      await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
      const branchId = await manager.createBranch('doc1', 1);
      const TRIMMED = 'Chapter one. The grey cat sat.\n';
      await server.commitChanges(branchId, [
        txtChange('trim', 1, path, [{ insert: TRIMMED }, { delete: BODY1.length }]),
      ]);
      await manager.mergeBranch(branchId); // must NOT throw
      const { state: after } = await coldLoad(server, 'doc1');
      expect(docBody(after, 'd1')).toBe(TRIMMED);
    }

    // Select-all, paste identical content back.
    {
      const { server, manager } = setup(GUARD);
      await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
      const branchId = await manager.createBranch('doc1', 1);
      await server.commitChanges(branchId, [
        txtChange('paste', 1, path, [{ insert: BODY1 }, { delete: BODY1.length }]),
      ]);
      await manager.mergeBranch(branchId); // must NOT throw
      const { state: after } = await coldLoad(server, 'doc1');
      expect(docBody(after, 'd1')).toBe(BODY1);
    }

    // Delete the opening, then undo — both inside the same merge batch.
    {
      const { server, manager } = setup(GUARD);
      await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
      const branchId = await manager.createBranch('doc1', 1);
      await server.commitChanges(branchId, [txtChange('del', 1, path, [{ delete: 20 }])]);
      await server.commitChanges(branchId, [txtChange('undo', 2, path, [{ insert: BODY1.slice(0, 20) }])]);
      await manager.mergeBranch(branchId); // must NOT throw
      const { state: after } = await coldLoad(server, 'doc1');
      expect(docBody(after, 'd1')).toBe(BODY1);
    }
  });

  // I) Repeat merges compare against the source's CURRENT head, not the branch point: after
  //    the source dropped a scene's content, a writer re-pasting it on the branch is
  //    restoring content the source no longer has — not duplicating it.
  it('guard: re-adding content the source has since deleted merges on a second merge', async () => {
    const { server, manager } = setup(GUARD);
    const path = '/docs/d1/body/content';
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);

    const branchId = await manager.createBranch('doc1', 1);
    await server.commitChanges(branchId, [txtChange('e1', 1, path, [{ insert: 'X' }])]);
    await manager.mergeBranch(branchId); // first merge: doc1 now holds 'X' + BODY1 at rev 2

    // The source drops the scene's whole body...
    await server.commitChanges('doc1', [txtChange('m1', 2, path, [{ delete: BODY1.length + 1 }])]);
    // ...and the writer re-pastes it on the branch.
    await server.commitChanges(branchId, [txtChange('rp', 2, path, [{ insert: BODY1 }])]);

    await manager.mergeBranch(branchId); // must NOT throw — the head no longer holds BODY1

    const { state: after } = await coldLoad(server, 'doc1');
    const body = docBody(after, 'd1');
    expect(body.indexOf(BODY1)).toBeGreaterThanOrEqual(0);
    expect(body.indexOf(BODY1)).toBe(body.lastIndexOf(BODY1)); // restored once, not doubled
  });

  // J) A field opening with an embed is protected too: the replayed seed re-inserts the
  //    embed and the body text ahead of the original, and the text run behind the embed is
  //    what identifies the duplication.
  it('guard: a field opening with an embed is still protected', async () => {
    const { store, server, manager } = setup(GUARD);
    const path = '/docs/d1/body/content';
    const withEmbed = {
      docs: { d1: { id: 'd1', body: { content: { ops: [{ insert: { image: 'cover.png' } }, { insert: BODY1 }] } } } },
    };
    await server.commitChanges('doc1', [rootChange('s1', withEmbed)]);

    const seed: Change[] = [
      createChange(0, 1, [{ op: 'replace', path: '', value: { docs: { d1: { id: 'd1', body: { content: {} } } } } }], {
        committedAt: 0,
      }) as Change,
      createChange(1, 2, [txtOp(path, [{ insert: { image: 'cover.png' } }, { insert: BODY1 }])], {
        committedAt: 0,
      }) as Change,
    ];
    const branchId = 'branchEmbed';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 }); // undercounts
    await store.saveChanges(branchId, seed);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();
  });

  // K) The guard is policy, so it is off unless the consuming server configures it — the
  //    doubling shape merges (badly) on an unconfigured manager. This also documents the raw
  //    failure the guard exists to stop.
  it('without configuration the guard is off and the doubling shape merges', async () => {
    const { store, server, manager } = setup(); // no guard configured
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
    const branchId = 'branchUnguarded';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 });
    await store.saveChanges(branchId, [
      createChange(0, 1, [{ op: 'replace', path: '', value: {} }], { committedAt: 0 }) as Change,
      createChange(1, 2, [txtOp('/docs/d1/body/content', [{ insert: BODY1 }])], { committedAt: 0 }) as Change,
    ]);

    await manager.mergeBranch(branchId); // no guard: proceeds

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(BODY1 + BODY1); // the unguarded outcome: doubled
  });

  // L) 'warn' logs the signature and lets the merge proceed — the observe-only rollout mode.
  it('guard action warn: logs and proceeds', async () => {
    const { store, server, manager } = setup({ contentDuplicationGuard: { action: 'warn', minLength: 16 } });
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
    const branchId = 'branchWarn';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 });
    await store.saveChanges(branchId, [
      createChange(0, 1, [{ op: 'replace', path: '', value: {} }], { committedAt: 0 }) as Change,
      createChange(1, 2, [txtOp('/docs/d1/body/content', [{ insert: BODY1 }])], { committedAt: 0 }) as Change,
    ]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await manager.mergeBranch(branchId); // must NOT throw
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/docs/d1/body/content'));
    warn.mockRestore();

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(BODY1 + BODY1);
  });

  // M) The per-merge override is the recovery escape hatch: 'off' lets a consumer push a
  //    refused merge through after inspection, and arming per-merge works on an
  //    unconfigured manager.
  it('per-merge override can disable the configured guard', async () => {
    const { store, server, manager } = setup(GUARD);
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
    const branchId = 'branchOverride';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 });
    await store.saveChanges(branchId, [
      createChange(0, 1, [{ op: 'replace', path: '', value: {} }], { committedAt: 0 }) as Change,
      createChange(1, 2, [txtOp('/docs/d1/body/content', [{ insert: BODY1 }])], { committedAt: 0 }) as Change,
    ]);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();
    await manager.mergeBranch(branchId, { contentDuplicationGuard: 'off' }); // explicit override

    const { state: after } = await coldLoad(server, 'doc1');
    expect(docBody(after, 'd1')).toBe(BODY1 + BODY1);
  });

  it('per-merge override can arm the guard on an unconfigured manager', async () => {
    const { store, server, manager } = setup(); // no guard configured
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
    const branchId = 'branchArm';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 });
    // Use a body long enough for the default 64-char threshold (no configured minLength).
    const LONG = BODY1.repeat(3);
    await server.commitChanges('doc1', [txtChange('grow', 1, '/docs/d1/body/content', [{ insert: LONG }])]);
    await store.saveChanges(branchId, [
      createChange(0, 1, [{ op: 'replace', path: '', value: {} }], { committedAt: 0 }) as Change,
      createChange(1, 2, [txtOp('/docs/d1/body/content', [{ insert: LONG }])], { committedAt: 0 }) as Change,
    ]);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId, { contentDuplicationGuard: 'refuse' })).rejects.toBeInstanceOf(
      MergeContentDuplicationError
    );
    err.mockRestore();
  });

  // N) With the guard armed, "cannot check" must not become "checked, fine": a failure
  //    reading the source's head propagates (the caller can retry) instead of silently
  //    skipping the check and letting a doubling merge through.
  it('guard: a head reconstruction failure propagates instead of skipping the check', async () => {
    const { store, server, manager } = setup(GUARD);
    await server.commitChanges('doc1', [rootChange('s1', manuscript())]);
    const branchId = 'branchReadFail';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 });
    await store.saveChanges(branchId, [
      createChange(0, 1, [{ op: 'replace', path: '', value: {} }], { committedAt: 0 }) as Change,
      createChange(1, 2, [txtOp('/docs/d1/body/content', [{ insert: BODY1 }])], { committedAt: 0 }) as Change,
    ]);

    const originalListChanges = store.listChanges.bind(store);
    store.listChanges = async (docId, options) => {
      if (docId === 'doc1') throw new Error('simulated store read failure');
      return originalListChanges(docId, options);
    };

    await expect(manager.mergeBranch(branchId)).rejects.toThrow('simulated store read failure');

    // Nothing was committed while the check was unavailable.
    store.listChanges = originalListChanges;
    expect(await changeIds(store, 'doc1')).toEqual(['s1']);
    expect((await store.loadBranch(branchId))!.lastMergedRev).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Windowed merges against a source that moved. A window commits its slice at the source tip,
// so every later window's changes must be lifted through the source's concurrent (foreign)
// changes RE-EXPRESSED in the branch's frame — the merge frame. Transformed against the raw
// committed forms instead, a later window lands its ops at offsets shifted by the branch's own
// earlier windows: text deleted or inserted in the wrong place.
// ---------------------------------------------------------------------------

describe('windowed merge with concurrent source edits', () => {
  beforeEach(() => {
    // Copied versions build against sources carrying no versions of their own; that warns.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.mocked(console.warn).mockRestore();
  });

  /** Plain text of the doc's `@txt` `/body` field. */
  function bodyText(state: any): string {
    const value = state?.body;
    const ops: any[] = Array.isArray(value) ? value : (value?.ops ?? []);
    return ops.map(o => (typeof o.insert === 'string' ? o.insert : '')).join('');
  }

  /** Commit one `/body` text edit onto `docId` at its current tip. */
  function editor({ store, server }: Pick<ReturnType<typeof setup>, 'store' | 'server'>) {
    return async (docId: string, id: string, ops: any[]) => {
      await server.commitChanges(docId, [txtChange(id, await store.getCurrentRev(docId), '/body', ops)]);
    };
  }

  async function seededSource(text: string, options?: OTBranchManagerOptions) {
    const ctx = setup(options);
    await ctx.server.commitChanges('doc1', [rootChange('s1', { body: { ops: [{ insert: text }] } })]);
    const branchId = await ctx.manager.createBranch('doc1', 1);
    return { ...ctx, branchId, edit: editor(ctx), apply: applier(ctx) };
  }

  /** Commit one change of arbitrary ops onto `docId` at its current tip. */
  function applier({ store, server }: Pick<ReturnType<typeof setup>, 'store' | 'server'>) {
    return async (docId: string, id: string, ops: any[], extra?: Partial<ChangeInput>) => {
      const baseRev = await store.getCurrentRev(docId);
      await server.commitChanges(docId, [{ id, baseRev, rev: baseRev + 1, ops, ...extra }]);
    };
  }

  /** A source doc holding a plain array — array ops make a misplaced frame an index shift. */
  async function seededList(list: string[], options?: OTBranchManagerOptions) {
    const ctx = setup(options);
    await ctx.server.commitChanges('doc1', [rootChange('s1', { list })]);
    const branchId = await ctx.manager.createBranch('doc1', 1);
    return { ...ctx, branchId, apply: applier(ctx) };
  }

  /**
   * Run `inject` once, right after the merge reads the branch slice holding `changeId` and
   * before that window commits — the window where a foreign row lands in the commit result.
   * Returns whether it fired, so a test can prove it modelled the race it names.
   */
  function injectAfterSliceRead(
    store: MemoryOTBranchStore,
    branchId: string,
    changeId: string,
    inject: () => Promise<void>
  ): () => boolean {
    const realListChanges = store.listChanges.bind(store);
    let injected = false;
    store.listChanges = async (docId, options) => {
      const rows = await realListChanges(docId, options);
      if (!injected && docId === branchId && options?.maxBytes !== undefined && rows.some(r => r.id === changeId)) {
        injected = true;
        await inject();
      }
      return rows;
    };
    return () => injected;
  }

  /** The frame the branch record currently carries, parsed out of its persisted string form. */
  async function persistedPrograms(store: MemoryOTBranchStore, branchId: string): Promise<any[][]> {
    return JSON.parse((await store.loadBranch(branchId))!.mergeFrame!.programs);
  }

  // The repro the frame exists for: two branch edits whose second is expressed on top of the
  // first, plus a source edit that deletes text both of them sit near. One window merges them
  // as a single queue (the frame is implicit); two windows must reach the same text.
  it('windowed and one-shot merges agree on overlapping text edits', async () => {
    async function run(maxChangesPerMerge: number) {
      const { store, server, manager, branchId, edit } = await seededSource('Hello world', { maxChangesPerMerge });
      await edit(branchId, 'b1', [{ insert: 'XXXXX ' }]);
      await edit(branchId, 'b2', [{ retain: 8 }, { insert: '!' }]);
      await edit('doc1', 's2', [{ retain: 5 }, { delete: 6 }]);

      await manager.mergeBranch(branchId);
      const ids = await changeIds(store, 'doc1');
      expect(new Set(ids).size).toBe(ids.length);
      return bodyText((await coldLoad(server, 'doc1')).state);
    }

    const windowed = await run(1);
    const oneShot = await run(1_000);
    expect(oneShot).toBe('XXXXX He!llo\n');
    expect(windowed).toBe(oneShot);
  });

  // A second merge session starts where the first left off, but the source has moved since —
  // and its edit was made against text the first merge had already landed. Markers make a
  // misplaced retain visible as an exact-string mismatch.
  it('places a repeat merge correctly after the source edited already-merged content', async () => {
    async function run(maxChangesPerMerge: number) {
      const { server, manager, branchId, edit } = await seededSource('one two three four', { maxChangesPerMerge });
      await edit(branchId, 'b1', [{ insert: '[1]' }]);
      await edit(branchId, 'b2', [{ retain: 21 }, { insert: '[2]' }]);
      await manager.mergeBranch(branchId);

      // The source drops "one " from the merged text; the branch never saw that.
      await edit('doc1', 's2', [{ retain: 3 }, { delete: 4 }]);

      await edit(branchId, 'b3', [{ retain: 11 }, { insert: '[3]' }]);
      await edit(branchId, 'b4', [{ retain: 27 }, { insert: '[4]' }]);
      await manager.mergeBranch(branchId);

      return bodyText((await coldLoad(server, 'doc1')).state);
    }

    // [3] marks "three" and [4] the end, both shifted back by the four characters the source
    // deleted. A raw-form transform lands them four characters late.
    expect(await run(1_000)).toBe('[1]two [3]three four[2][4]\n');
    expect(await run(1)).toBe('[1]two [3]three four[2][4]\n');
  });

  it('reaches the same state at every window size (seeded fuzz)', async () => {
    const BASE = 'The quick brown fox jumps over the lazy do';

    function mulberry32(seed: number) {
      let a = seed;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /** 12 branch edits and 5 source edits in a seeded interleaving, each legal for its own text. */
    function schedule(seed: number) {
      const rand = mulberry32(seed);
      const lengths = { branch: BASE.length + 1, doc1: BASE.length + 1 };
      const targets: ('branch' | 'doc1')[] = [...Array(12).fill('branch'), ...Array(5).fill('doc1')];
      for (let i = targets.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [targets[i], targets[j]] = [targets[j], targets[i]];
      }
      return targets.map((target, i) => {
        const length = lengths[target];
        const at = Math.floor(rand() * length);
        if (rand() < 0.55 || length - at < 3) {
          const text = `<${i}>`;
          lengths[target] += text.length;
          return { target, ops: at ? [{ retain: at }, { insert: text }] : [{ insert: text }] };
        }
        const count = 1 + Math.floor(rand() * Math.min(4, length - at - 1));
        lengths[target] -= count;
        return { target, ops: at ? [{ retain: at }, { delete: count }] : [{ delete: count }] };
      });
    }

    async function run(items: ReturnType<typeof schedule>, maxChangesPerMerge: number) {
      const { server, manager, branchId, edit } = await seededSource(BASE, { maxChangesPerMerge });
      for (const [i, item] of items.entries()) {
        await edit(item.target === 'branch' ? branchId : 'doc1', `c${i}`, item.ops);
      }
      await manager.mergeBranch(branchId);
      return (await coldLoad(server, 'doc1')).state;
    }

    for (let seed = 1; seed <= 10; seed++) {
      const items = schedule(seed);
      const states = [];
      for (const maxChangesPerMerge of [1, 2, 3, 1_000]) states.push(await run(items, maxChangesPerMerge));
      const oneShot = JSON.stringify(states[3]);
      expect(
        states.map(state => JSON.stringify(state)),
        `seed ${seed}`
      ).toEqual([oneShot, oneShot, oneShot, oneShot]);
    }
  });

  // A foreign change landing between two windows is folded by the next window's catch-up; one
  // landing between a window's catch-up and its commit comes back in the commit result and is
  // folded forward through the slice as sent.
  it('converges when a foreign change lands mid-merge', async () => {
    const { store, server, manager, branchId, edit } = await seededSource('alpha beta gamma', {
      maxChangesPerMerge: 1,
    });
    await edit(branchId, 'b1', [{ insert: '<b1>' }]);
    await edit(branchId, 'b2', [{ retain: 20 }, { insert: '<b2>' }]);
    await edit(branchId, 'b3', [{ retain: 10 }, { insert: '<b3>' }]);

    // One source edit lands between windows (the next window's catch-up folds it)...
    const updateBranchIf = store.updateBranchIf.bind(store);
    let watermarks = 0;
    store.updateBranchIf = async (id, updates, expected) => {
      const applied = await updateBranchIf(id, updates, expected);
      if ('lastMergedRev' in updates && ++watermarks === 1) {
        await edit('doc1', 'f1', [{ retain: 6 }, { insert: '<f1>' }]);
      }
      return applied;
    };
    // ...and one inside the next window, after its catch-up read but before its commit, so it
    // comes back in the commit result and has to be folded forward through the slice as sent.
    const realListChanges = store.listChanges.bind(store);
    let sliceReads = 0;
    store.listChanges = async (docId, options) => {
      const rows = await realListChanges(docId, options);
      if (docId === branchId && options?.maxBytes !== undefined && ++sliceReads === 2) {
        await edit('doc1', 'f2', [{ insert: '<f2>' }]);
      }
      return rows;
    };

    await manager.mergeBranch(branchId);
    expect(watermarks).toBeGreaterThan(0);
    expect(sliceReads).toBeGreaterThan(1);

    const text = bodyText((await coldLoad(server, 'doc1')).state);
    for (const marker of ['<b1>', '<b2>', '<b3>', '<f1>', '<f2>']) {
      expect(text.indexOf(marker), marker).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(marker), marker).toBe(text.lastIndexOf(marker));
    }
    // Nothing but the markers changed: no character landed twice or went missing.
    expect(text.replace(/<[bf]\d>/g, '')).toBe('alpha beta gamma\n');
    const ids = await changeIds(store, 'doc1');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resumes a crashed windowed merge and returns the committed prefix too', async () => {
    const { store, server, manager, branchId, edit } = await seededSource('one two three four', {
      maxChangesPerMerge: 2,
    });
    await edit(branchId, 'b1', [{ insert: '[1]' }]);
    await edit(branchId, 'b2', [{ retain: 21 }, { insert: '[2]' }]);
    await edit(branchId, 'b3', [{ retain: 11 }, { insert: '[3]' }]);
    await edit(branchId, 'b4', [{ retain: 27 }, { insert: '[4]' }]);
    await edit('doc1', 's2', [{ retain: 3 }, { delete: 4 }]); // drops " two" from the source

    failWatermarkOnce(store);
    // Even a FIRST window's commit→watermark crash reports as partial progress — the exact
    // case where "nothing was changed" would be most tempting and most wrong — carrying the
    // crashed window's own rows and the foreign row it folded.
    const error = (await manager.mergeBranch(branchId).catch(e => e)) as MergePartialProgressError;
    expect(error).toBeInstanceOf(MergePartialProgressError);
    expect(error.committedChanges.map(c => c.id)).toEqual(['s2', 'b1', 'b2']);
    expect(error.mergedThroughRev).toBe(3);
    expect((error.cause as Error).message).toContain('simulated crash');

    // The first window's commit landed; its watermark write did not.
    const partial = await changeIds(store, 'doc1');
    expect(partial).toEqual(['s1', 's2', 'b1', 'b2']);
    expect((await store.loadBranch(branchId))!.lastMergedRev).toBeUndefined();

    const committed = await manager.mergeBranch(branchId);

    // The resumed merge reports the whole merge, not just what it committed itself — and
    // rev-dense across the span it observed, so the foreign row it folded (s2) rides along.
    expect(committed.map(c => c.id)).toEqual(['s2', 'b1', 'b2', 'b3', 'b4']);
    expectRevDense(committed);
    const ids = await changeIds(store, 'doc1');
    expect(ids).toEqual(['s1', 's2', 'b1', 'b2', 'b3', 'b4']);
    expect(new Set(ids).size).toBe(ids.length);
    // Both windows' markers sit where the source's deletion left them: [3] before "three",
    // [2] and [4] at the tail in the order the branch minted them.
    expect(bodyText((await coldLoad(server, 'doc1')).state)).toBe('[1]one [3]three four[2][4]\n');
  });

  // Frames over the persisted-size cap are cleared rather than written, so a merge picked up by
  // a different server instance has only the watermark to go on and rebuilds the frame from the
  // raw logs. That rebuild must land the remaining windows exactly where the carry would have.
  it('rebuilds an oversized (unpersisted) frame from the raw logs', async () => {
    const HUGE = 'z'.repeat(300_000);

    async function branchWithHugeForeignEdit(options: OTBranchManagerOptions) {
      const ctx = await seededSource('one two three four', options);
      await ctx.edit(ctx.branchId, 'b1', [{ insert: '[1]' }]);
      await ctx.edit(ctx.branchId, 'b2', [{ retain: 21 }, { insert: '[2]' }]);
      // A foreign change far larger than the frame budget: the frame carrying it cannot be stored.
      await ctx.edit('doc1', 's2', [{ retain: 3 }, { delete: 4 }, { insert: HUGE }]);
      return ctx;
    }

    const control = await branchWithHugeForeignEdit({ maxChangesPerMerge: 1_000 });
    await control.manager.mergeBranch(control.branchId);
    const expected = bodyText((await coldLoad(control.server, 'doc1')).state);

    const { store, server, branchId } = await branchWithHugeForeignEdit({ maxChangesPerMerge: 1 });
    const first = new OTBranchManager(store, server, { maxChangesPerMerge: 1 });
    // Kill the run after the first window commits and persists, before the second reads.
    const realListChanges = store.listChanges.bind(store);
    let windowReads = 0;
    store.listChanges = async (docId, options) => {
      if (docId === branchId && options?.maxBytes !== undefined && ++windowReads === 2) {
        throw new Error('simulated instance loss between windows');
      }
      return realListChanges(docId, options);
    };
    await expect(first.mergeBranch(branchId)).rejects.toThrow('simulated instance loss');
    store.listChanges = realListChanges;

    // The window persisted its watermark but cleared the frame it could not store.
    const branch = (await store.loadBranch(branchId))!;
    expect(branch.lastMergedRev).toBe(2);
    expect(branch.mergeFrame).toBeNull();

    // A fresh instance carries nothing: it must rebuild the frame from the source and branch logs.
    await new OTBranchManager(store, server, { maxChangesPerMerge: 1 }).mergeBranch(branchId);

    expect(bodyText((await coldLoad(server, 'doc1')).state)).toBe(expected);
    const ids = await changeIds(store, 'doc1');
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The guard decides over the whole unmerged batch before any window commits, so a refused
  // windowed merge is as side-effect-free as a refused one-shot merge.
  it('refuses a duplicating merge before the first window commits', async () => {
    const BODY = 'Chapter one. The grey cat sat by the window.\n';
    const { store, server, manager } = setup({
      contentDuplicationGuard: { action: 'refuse', minLength: 16 },
      maxChangesPerMerge: 1,
    });
    await server.commitChanges('doc1', [rootChange('s1', { body: { ops: [{ insert: BODY }] } })]);

    const branchId = 'branchGuardWindowed';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 }); // undercounts the seed
    await store.saveChanges(branchId, [
      createChange(0, 1, [{ op: 'replace', path: '', value: { body: { ops: [] } } }], { committedAt: 0 }) as Change,
      createChange(1, 2, [txtOp('/body', [{ insert: BODY }])], { committedAt: 0 }) as Change,
      createChange(2, 3, [txtOp('/body', [{ retain: 3 }, { insert: 'edit' }])], { committedAt: 0 }) as Change,
    ]);

    const before = await coldLoad(server, 'doc1');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();

    const after = await coldLoad(server, 'doc1');
    expect(after.rev).toBe(before.rev);
    expect(after.state).toEqual(before.state);
    expect(await changeIds(store, 'doc1')).toEqual(['s1']);
    expect((await store.loadBranch(branchId))!.lastMergedRev).toBeUndefined();
  });

  // A refusal must leave the BRANCH record as untouched as the source: the guard computes
  // its read floor without `resolveMergeBase`'s pin, so a clamped branch refused by the
  // guard carries no `mergeBaseRev` from the attempt.
  it('refuses a clamped branch without pinning its merge base', async () => {
    const BODY = 'Chapter one. The grey cat sat by the window.\n';
    const { store, server, manager } = setup({
      contentDuplicationGuard: { action: 'refuse', minLength: 16 },
    });
    await server.commitChanges('doc1', [rootChange('s1', { body: { ops: [{ insert: BODY }] } })]);

    const branchId = 'branchGuardClamped';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 }); // undercounts the seed
    await store.saveChanges(branchId, [
      createChange(0, 1, [{ op: 'replace', path: '', value: { body: { ops: [] } } }], { committedAt: 0 }) as Change,
      createChange(1, 2, [txtOp('/body', [{ insert: BODY }])], { committedAt: 0 }) as Change,
    ]);
    // A renumbered source leaves branchedAtRev ahead of the tip — the clamp case.
    await store.updateBranch(branchId, { branchedAtRev: 99 } as any);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();

    const branch = (await store.loadBranch(branchId))!;
    expect(branch.mergeBaseRev).toBeUndefined();
    expect(branch.lastMergedRev).toBeUndefined();
  });

  // The window's second axis: a branch of few but large changes is bounded on bytes, not count.
  it('bounds a window by its byte budget', async () => {
    const filler = 'x'.repeat(1_000);
    const { store, server, manager, branchId, edit } = await seededSource('start', {
      maxChangesPerMerge: 1_000,
      maxBytesPerMergeWindow: 2_500,
    });
    for (let i = 1; i <= 6; i++) await edit(branchId, `b${i}`, [{ insert: `${i}${filler}` }]);

    const listChanges = vi.spyOn(store, 'listChanges');
    // No window reads past the budget, so the branch drains over several of them.
    await manager.mergeBranch(branchId);

    const windowReads = listChanges.mock.calls.filter(
      ([docId, options]) => docId === branchId && options?.maxBytes !== undefined
    );
    expect(windowReads.length).toBeGreaterThan(1);
    expect(windowReads.every(([, options]) => options!.maxBytes === 2_500)).toBe(true);

    const text = bodyText((await coldLoad(server, 'doc1')).state);
    for (let i = 1; i <= 6; i++) expect(text).toContain(`${i}${filler}`);
    expect(text.replace(new RegExp(`[1-6]${filler}`, 'g'), '')).toBe('start\n');
    const ids = await changeIds(store, 'doc1');
    expect(new Set(ids).size).toBe(ids.length);
    listChanges.mockRestore();
  });

  // The empty slice is the completion signal, and completing with rows still unread is a
  // silent under-merge — so the merge verifies the signal against the branch tip. A store
  // that stands by its empty read while the tip says otherwise fails loudly.
  it('rejects a store whose empty window read contradicts the branch tip', async () => {
    const { store, manager, branchId, edit } = await seededSource('one two three');
    await edit(branchId, 'b1', [{ insert: '[1]' }]);

    const real = store.listChanges.bind(store);
    store.listChanges = async (docId, options) => {
      if (docId === branchId && options?.maxBytes !== undefined) return [];
      return real(docId, options);
    };

    await expect(manager.mergeBranch(branchId)).rejects.toThrow('violated the read contract');
    expect((await store.loadBranch(branchId))!.lastMergedRev).toBeUndefined();
  });

  // ...but one transient empty read is indistinguishable from an edit landing between the
  // slice read and the tip read, so the merge re-reads once instead of crying store bug.
  it('re-reads once when an empty window read races a landing edit', async () => {
    const { store, server, manager, branchId, edit } = await seededSource('one two three');
    await edit(branchId, 'b1', [{ insert: '[1]' }]);

    const real = store.listChanges.bind(store);
    let lied = false;
    store.listChanges = async (docId, options) => {
      if (!lied && docId === branchId && options?.maxBytes !== undefined) {
        lied = true;
        return [];
      }
      return real(docId, options);
    };

    const committed = await manager.mergeBranch(branchId);
    expect(committed.map(c => c.id)).toEqual(['b1']);
    expect(bodyText((await coldLoad(server, 'doc1')).state)).toBe('[1]one two three\n');
  });

  // A window whose slice lifts to nothing still has to account for the foreign row that
  // obsoleted it — through the slice AS SENT, exactly once. Folding that row raw leaves the
  // frame carrying an effect the branch's own ops already had, and every later window's ops
  // land shifted by it.
  it('folds a foreign row through a window whose changes lift to noops', async () => {
    async function run(maxChangesPerMerge: number) {
      const { store, server, manager, branchId, apply } = await seededList(['a', 'b', 'c', 'd'], {
        maxChangesPerMerge,
      });
      await apply(branchId, 'b1', [{ op: 'remove', path: '/list/0' }]);
      await apply(branchId, 'b2', [{ op: 'replace', path: '/list/2', value: 'X' }]);
      // The source removes the same element between the first window's slice read and its
      // commit, so the window's own change lifts away and only the foreign row comes back.
      const injected = injectAfterSliceRead(store, branchId, 'b1', () =>
        apply('doc1', 'f1', [{ op: 'remove', path: '/list/0' }])
      );

      await manager.mergeBranch(branchId);
      expect(injected()).toBe(true);
      // The branch's own removal lifted away against the source's; only the foreign row landed.
      const ids = await changeIds(store, 'doc1');
      expect(ids).toEqual(['s1', 'f1', 'b2']);
      expect(new Set(ids).size).toBe(ids.length);
      return (await coldLoad(server, 'doc1')).state.list;
    }

    expect(await run(1_000)).toEqual(['b', 'c', 'X']);
    expect(await run(1)).toEqual(['b', 'c', 'X']);
  });

  // The same double-fold with the noop window LAST: its frame is the one persisted, so the
  // next merge session is what a stale copy corrupts.
  it('persists a noop window frame without a raw copy of the foreign row', async () => {
    const { store, server, manager, branchId, apply } = await seededList(['a', 'b', 'c', 'd'], {
      maxChangesPerMerge: 1,
    });
    await apply(branchId, 'b1', [{ op: 'add', path: '/list/4', value: 'B1' }]);
    await apply(branchId, 'b2', [{ op: 'remove', path: '/list/0' }]);
    const injected = injectAfterSliceRead(store, branchId, 'b2', () =>
      apply('doc1', 'f1', [{ op: 'remove', path: '/list/0' }])
    );

    await manager.mergeBranch(branchId);
    expect(injected()).toBe(true);
    expect((await coldLoad(server, 'doc1')).state.list).toEqual(['b', 'c', 'd', 'B1']);

    // The persisted frame expresses the foreign removal AFTER the branch's own, which already
    // performed it — so it carries no removal at all.
    const ops = (await persistedPrograms(store, branchId)).flat();
    expect(ops.filter(op => op.op === 'remove' && op.path === '/list/0')).toEqual([]);

    await apply(branchId, 'b3', [{ op: 'replace', path: '/list/1', value: 'X' }]);
    await manager.mergeBranch(branchId);

    // A stale removal in the frame would have shifted this replace down to /list/0.
    expect((await coldLoad(server, 'doc1')).state.list).toEqual(['b', 'X', 'd', 'B1']);
  });

  // A byte-trimmed slice is shorter than the change limit but does not mean the branch is
  // drained — only an empty read does. Ending on the short slice left the tail unmerged.
  it('merges every byte-bounded window in one call', async () => {
    const filler = 'x'.repeat(1_000);
    const { store, manager, branchId, edit } = await seededSource('start', {
      maxChangesPerMerge: 1_000,
      maxBytesPerMergeWindow: 2_500,
    });
    for (let i = 1; i <= 6; i++) await edit(branchId, `b${i}`, [{ insert: `${i}${filler}` }]);

    await manager.mergeBranch(branchId);

    expect((await store.loadBranch(branchId))!.lastMergedRev).toBe(await store.getCurrentRev(branchId));
  });

  // Two merges read the same slice; the loser commits into a source that already holds its
  // rows, so the commit answers with pure echoes and a foreign row ABOVE them. The echoes are
  // its own rows: that foreign row folds through what is left of the queue after them
  // (nothing), never through the whole queue a second time.
  it('folds correctly when a concurrent merge dedups the whole window', async () => {
    /** The same history without the losing merge — the text the race must not disturb. */
    async function sequential() {
      const { server, manager, branchId, edit } = await seededSource('alpha beta gamma');
      await edit(branchId, 'b1', [{ insert: '<b1>' }]);
      await edit(branchId, 'b2', [{ retain: 20 }, { insert: '<b2>' }]);
      await manager.mergeBranch(branchId);
      await edit('doc1', 'f1', [{ retain: 6 }, { insert: '<f1>' }]);
      await edit(branchId, 'b3', [{ retain: 10 }, { insert: '<b3>' }]);
      await manager.mergeBranch(branchId);
      return bodyText((await coldLoad(server, 'doc1')).state);
    }

    /**
     * The loser parks holding its slice while the winner merges the same one and a foreign
     * edit lands on top of it. On a CAS store the loser's watermark write loses and its frame
     * is dropped; on a legacy (max-wins) store the equal watermark stands and the loser's
     * frame is what the NEXT merge lifts through — so the fold has to be right either way.
     */
    async function race(cas: boolean) {
      const { store, server, manager, branchId, edit } = await seededSource('alpha beta gamma');
      if (!cas) (store as any).updateBranchIf = undefined;
      await edit(branchId, 'b1', [{ insert: '<b1>' }]);
      await edit(branchId, 'b2', [{ retain: 20 }, { insert: '<b2>' }]);

      let release!: () => void;
      let reached!: () => void;
      const parked = new Promise<void>(resolve => (release = resolve));
      const atSlice = new Promise<void>(resolve => (reached = resolve));
      const realListChanges = store.listChanges.bind(store);
      let parkedOnce = false;
      store.listChanges = async (docId, options) => {
        const rows = await realListChanges(docId, options);
        if (!parkedOnce && docId === branchId && options?.maxBytes !== undefined) {
          parkedOnce = true;
          reached();
          await parked;
        }
        return rows;
      };

      const losing = new OTBranchManager(store, server).mergeBranch(branchId);
      await atSlice;
      await manager.mergeBranch(branchId);
      await edit('doc1', 'f1', [{ retain: 6 }, { insert: '<f1>' }]);
      release();
      const loser = await losing;

      const programs = JSON.stringify(await persistedPrograms(store, branchId));
      await edit(branchId, 'b3', [{ retain: 10 }, { insert: '<b3>' }]);
      await manager.mergeBranch(branchId);
      return {
        loser,
        programs,
        ids: await changeIds(store, 'doc1'),
        text: bodyText((await coldLoad(server, 'doc1')).state),
      };
    }

    const expected = await sequential();
    for (const cas of [true, false]) {
      const { loser, programs, ids, text } = await race(cas);
      const label = `cas ${cas}`;
      // The loser commits nothing new and reports its rows as echoes, foreign row above.
      expect(
        loser.map(c => c.id),
        label
      ).toEqual(['b1', 'b2', 'f1']);
      expectRevDense(loser);
      expect(ids, label).toEqual(['s1', 'b1', 'b2', 'f1', 'b3']);
      // The surviving frame carries the foreign row's insert once, never twice.
      expect(programs.split('<f1>').length - 1, label).toBeLessThanOrEqual(1);
      // A double-folded row would shift the next merge's insert by its own length.
      expect(text, label).toBe(expected);
    }
  });

  // One commit result can interleave foreign rows AROUND our own rows — foreign below the
  // echoes, foreign above them. Each run folds through what remains of the as-sent queue at
  // its position: the first through everything, the last through nothing.
  it('folds multiple foreign runs from one window commit through the right suffixes', async () => {
    async function sequential() {
      const { server, manager, branchId, edit } = await seededSource('alpha beta gamma');
      await edit(branchId, 'b1', [{ insert: '<b1>' }]);
      await edit(branchId, 'b2', [{ retain: 20 }, { insert: '<b2>' }]);
      await edit('doc1', 'f0', [{ retain: 6 }, { insert: '<f0>' }]);
      await manager.mergeBranch(branchId);
      await edit('doc1', 'f1', [{ retain: 12 }, { insert: '<f1>' }]);
      await edit(branchId, 'b3', [{ retain: 10 }, { insert: '<b3>' }]);
      await manager.mergeBranch(branchId);
      return bodyText((await coldLoad(server, 'doc1')).state);
    }

    // The loser parks holding its slice; f0 lands, the winner merges the slice, f1 lands.
    // The loser's resend then answers with [f0, b1, b2, f1] in one result.
    async function race() {
      const { store, server, manager, branchId, edit } = await seededSource('alpha beta gamma');
      await edit(branchId, 'b1', [{ insert: '<b1>' }]);
      await edit(branchId, 'b2', [{ retain: 20 }, { insert: '<b2>' }]);

      let release!: () => void;
      let reached!: () => void;
      const parked = new Promise<void>(resolve => (release = resolve));
      const atSlice = new Promise<void>(resolve => (reached = resolve));
      const realListChanges = store.listChanges.bind(store);
      let parkedOnce = false;
      store.listChanges = async (docId, options) => {
        const rows = await realListChanges(docId, options);
        if (!parkedOnce && docId === branchId && options?.maxBytes !== undefined) {
          parkedOnce = true;
          reached();
          await parked;
        }
        return rows;
      };

      const losing = new OTBranchManager(store, server).mergeBranch(branchId);
      await atSlice;
      await edit('doc1', 'f0', [{ retain: 6 }, { insert: '<f0>' }]);
      await manager.mergeBranch(branchId);
      await edit('doc1', 'f1', [{ retain: 12 }, { insert: '<f1>' }]);
      release();
      const loser = await losing;

      await edit(branchId, 'b3', [{ retain: 10 }, { insert: '<b3>' }]);
      await manager.mergeBranch(branchId);
      return {
        loser,
        ids: await changeIds(store, 'doc1'),
        text: bodyText((await coldLoad(server, 'doc1')).state),
      };
    }

    const expected = await sequential();
    const { loser, ids, text } = await race();
    expect(loser.map(c => c.id)).toEqual(['f0', 'b1', 'b2', 'f1']);
    expectRevDense(loser);
    expect(ids).toEqual(['s1', 'f0', 'b1', 'b2', 'f1', 'b3']);
    // A run folded through the wrong suffix would shift the next merge's insert.
    expect(text).toBe(expected);
  });

  // A window failing after an earlier one committed is not "nothing happened": the prefix is
  // permanent and the error has to say so, or consumers tell users a merge left no trace.
  it('reports partial progress when a later window fails, and resumes on retry', async () => {
    const { store, manager, branchId, edit } = await seededSource('one two three four', {
      maxChangesPerMerge: 1,
    });
    await edit(branchId, 'b1', [{ insert: '[1]' }]);
    await edit(branchId, 'b2', [{ retain: 21 }, { insert: '[2]' }]);
    await edit(branchId, 'b3', [{ retain: 11 }, { insert: '[3]' }]);

    failWatermarkOnce(store, 2); // the second window's watermark write

    const error = (await manager.mergeBranch(branchId).catch(e => e)) as MergePartialProgressError;
    expect(error).toBeInstanceOf(MergePartialProgressError);
    // The crashed window's committed rows ride in the error too — classification keys on
    // "did the commit land", not "did the window return".
    expect(error.committedChanges.map(c => c.id)).toEqual(['b1', 'b2']);
    expect(error.mergedThroughRev).toBe(3);
    expect((error.cause as Error).message).toContain('simulated crash');

    const retried = await manager.mergeBranch(branchId);
    expectRevDense(retried);
    // The retry resumes past the durable watermark (b1's window), re-observing the crashed
    // window's rows and committing the rest.
    expect(retried.map(c => c.id)).toEqual(['b2', 'b3']);

    // Every branch change is reported across the failure and the retry...
    const reported = new Set([...error.committedChanges, ...retried].map(c => c.id).filter(id => id.startsWith('b')));
    expect([...reported].sort()).toEqual(['b1', 'b2', 'b3']);
    // ...and landed on the source exactly once.
    expect(await changeIds(store, 'doc1')).toEqual(['s1', 'b1', 'b2', 'b3']);
    expect((await store.loadBranch(branchId))!.lastMergedRev).toBe(await store.getCurrentRev(branchId));
  });

  // The guard walks the whole unmerged batch, so a duplicating change waiting in a LATER
  // window still refuses before the first window commits anything.
  it('refuses when the duplicating change sits in a later window', async () => {
    const BODY = 'Chapter one. The grey cat sat by the window.\n';
    const { store, server, manager } = setup({
      contentDuplicationGuard: { action: 'refuse', minLength: 16 },
      maxChangesPerMerge: 1,
    });
    await server.commitChanges('doc1', [rootChange('s1', { body: { ops: [{ insert: BODY }] } })]);

    const branchId = 'branchGuardLateWindow';
    await manager.createBranch('doc1', 1, { id: branchId, contentStartRev: 2 }); // undercounts the seed
    await store.saveChanges(branchId, [
      createChange(0, 1, [{ op: 'replace', path: '', value: { body: { ops: [] } } }], { committedAt: 0 }) as Change,
      // Window 1 is an ordinary small edit; window 2 replays the seed onto content the source
      // already holds.
      createChange(1, 2, [txtOp('/body', [{ insert: 'Hi. ' }])], { committedAt: 0 }) as Change,
      createChange(2, 3, [txtOp('/body', [{ retain: 4 }, { insert: BODY }])], { committedAt: 0 }) as Change,
    ]);

    const before = await coldLoad(server, 'doc1');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeContentDuplicationError);
    err.mockRestore();

    // Nothing of window 1 escaped: the refusal is decided before the first commit.
    const after = await coldLoad(server, 'doc1');
    expect(after.rev).toBe(before.rev);
    expect(after.state).toEqual(before.state);
    expect(await changeIds(store, 'doc1')).toEqual(['s1']);
    expect((await store.loadBranch(branchId))!.lastMergedRev).toBeUndefined();
  });

  // Array indices shift as bluntly as text offsets: a frame carrying the source's concurrent
  // insert has to move each window's adds the same way one queue would.
  it('lands array ops through the frame where a one-shot merge lands them', async () => {
    async function run(maxChangesPerMerge: number) {
      const { store, server, manager, branchId, apply } = await seededList(['a', 'b', 'c', 'd', 'e'], {
        maxChangesPerMerge,
      });
      await apply(branchId, 'b1', [{ op: 'add', path: '/list/1', value: 'B1' }]);
      await apply(branchId, 'b2', [{ op: 'add', path: '/list/4', value: 'B2' }]);
      await apply('doc1', 's2', [{ op: 'add', path: '/list/3', value: 'S2' }]);

      await manager.mergeBranch(branchId);
      const ids = await changeIds(store, 'doc1');
      expect(new Set(ids).size).toBe(ids.length);
      return (await coldLoad(server, 'doc1')).state.list;
    }

    const oneShot = await run(1_000);
    // The branch's two adds keep their slots; the source's lands beside the second.
    expect(oneShot).toEqual(['a', 'B1', 'b', 'c', 'B2', 'S2', 'd', 'e']);
    expect(await run(1)).toEqual(oneShot);
  });

  // `batchId` is client-mintable, so an ordinary source change can wear the branch's id. It
  // must fold as the foreign change it is rather than wedge the merge or shift what follows.
  it('treats a foreign change wearing the branch batchId as foreign', async () => {
    async function run(impostor: boolean) {
      const { store, server, manager, branchId, edit, apply } = await seededSource('one two three four', {
        maxChangesPerMerge: 1,
      });
      await edit(branchId, 'b1', [{ insert: '[1]' }]);
      await manager.mergeBranch(branchId);

      await apply(
        'doc1',
        'imp',
        [txtOp('/body', [{ retain: 3 }, { insert: '<imp>' }])],
        impostor ? { batchId: branchId } : undefined
      );
      await edit(branchId, 'b2', [{ retain: 11 }, { insert: '[2]' }]);
      await manager.mergeBranch(branchId);

      const text = bodyText((await coldLoad(server, 'doc1')).state);
      expect(text.split('<imp>').length - 1).toBe(1);
      const ids = await changeIds(store, 'doc1');
      expect(new Set(ids).size).toBe(ids.length);
      return text;
    }

    expect(await run(true)).toBe(await run(false));
  });

  // The frame's advance needs the raw branch ops behind its own committed merge rows. A log
  // compacted past them cannot supply those, and no retry ever will.
  it('surfaces a pruned branch log as an alignment failure', async () => {
    const { store, manager, branchId, edit } = await seededSource('one two three four');
    await edit(branchId, 'b1', [{ insert: '[1]' }]);
    await edit(branchId, 'b2', [{ retain: 21 }, { insert: '[2]' }]);
    await manager.mergeBranch(branchId);

    await edit(branchId, 'b3', [{ retain: 11 }, { insert: '[3]' }]);
    // The branch log is compacted below the watermark, and the frame that would have skipped
    // the rebuild is gone (an oversized frame is cleared, not stored).
    store.pruneChangesThrough(branchId, (await store.loadBranch(branchId))!.lastMergedRev!);
    await store.updateBranch(branchId, { mergeFrame: null });

    await expect(manager.mergeBranch(branchId)).rejects.toBeInstanceOf(MergeFrameAlignmentError);
  });

  /** A windowed merge over a concurrent source edit, so the branch ends up carrying a frame. */
  async function mergeWithForeignEdit() {
    const ctx = await seededSource('alpha beta gamma', { maxChangesPerMerge: 1 });
    await ctx.edit(ctx.branchId, 'b1', [{ insert: '<b1>' }]);
    await ctx.edit(ctx.branchId, 'b2', [{ retain: 20 }, { insert: '<b2>' }]);
    await ctx.edit('doc1', 's2', [{ retain: 6 }, { insert: '<s2>' }]);
    await ctx.manager.mergeBranch(ctx.branchId);
    return ctx;
  }

  // Document stores refuse a nested array as a field value, so the frame's programs are
  // persisted as a JSON string — not an array that happens to serialize.
  it('persists the frame programs as a JSON string', async () => {
    const { store, branchId } = await mergeWithForeignEdit();

    const frame = (await store.loadBranch(branchId))!.mergeFrame!;
    expect(typeof frame.programs).toBe('string');
    expect(() => JSON.parse(frame.programs)).not.toThrow();
    expect(JSON.parse(frame.programs).length).toBeGreaterThan(0);
  });

  // The frame is server-internal working state and runs to hundreds of kilobytes; it must not
  // ride every branch-list sync out to every client.
  it('strips the frame from listed branches while the record keeps it', async () => {
    const { store, manager, branchId } = await mergeWithForeignEdit();

    const listed = await manager.listBranches('doc1');
    expect(listed.map(b => b.id)).toEqual([branchId]);
    expect(listed.every(b => !('mergeFrame' in b))).toBe(true);
    expect((await store.loadBranch(branchId))!.mergeFrame).toBeDefined();
  });
});
