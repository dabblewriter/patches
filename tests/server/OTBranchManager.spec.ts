import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTBranchManager, assertBranchMetadata } from '../../src/server/OTBranchManager';
import type { PatchesServer } from '../../src/server/PatchesServer';
import type { BranchingStoreBackend, OTStoreBackend } from '../../src/server/types';
import type { Branch, Change, EditableBranchMetadata, VersionMetadata } from '../../src/types';

// Mock the dependencies
vi.mock('crypto-id', () => ({
  createId: vi.fn(() => 'generated-id'),
}));

vi.mock('../../src/data/change', () => ({
  createChange: vi.fn(),
}));

vi.mock('../../src/data/version', () => ({
  createVersionMetadata: vi.fn(),
}));

import { createId } from 'crypto-id';
import { createChange } from '../../src/data/change';
import { createVersionMetadata } from '../../src/data/version';

// OTBranchManager requires a store that implements both OTStoreBackend and BranchingStoreBackend
type OTBranchStore = OTStoreBackend & BranchingStoreBackend;

describe('OTBranchManager', () => {
  let branchManager: OTBranchManager;
  let mockStore: OTBranchStore;
  let mockServer: PatchesServer;

  beforeEach(() => {
    mockStore = {
      // BranchingStoreBackend methods
      listBranches: vi.fn(),
      loadBranch: vi.fn(),
      createBranch: vi.fn(),
      updateBranch: vi.fn(),
      deleteBranch: vi.fn(),
      // OTStoreBackend methods (extends ServerStoreBackend and VersioningStoreBackend)
      deleteDoc: vi.fn(),
      saveChanges: vi.fn(),
      listChanges: vi.fn(),
      loadVersionChanges: vi.fn(),
      getCurrentRev: vi.fn().mockResolvedValue(0),
      createVersion: vi.fn(),
      listVersions: vi.fn(),
      loadVersion: vi.fn(),
      loadVersionState: vi.fn(),
      updateVersion: vi.fn(),
    } as OTBranchStore;

    mockServer = {
      getDoc: vi.fn(),
      commitChanges: vi.fn(),
    } as any;

    branchManager = new OTBranchManager(mockStore, mockServer);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create branch manager with store and server', () => {
      expect(branchManager).toBeDefined();
    });
  });

  describe('listBranches', () => {
    it('should list branches for a document', async () => {
      const now = Date.now();
      const mockBranches: Branch[] = [
        {
          id: 'branch1',
          docId: 'doc1',
          branchedAtRev: 5,
          contentStartRev: 2,
          createdAt: now,
          modifiedAt: now,
          name: 'Feature Branch',
        },
        {
          id: 'branch2',
          docId: 'doc1',
          branchedAtRev: 3,
          contentStartRev: 2,
          createdAt: now,
          modifiedAt: now,
          name: 'Bug Fix Branch',
        },
      ];

      vi.mocked(mockStore.listBranches).mockResolvedValue(mockBranches);

      const result = await branchManager.listBranches('doc1');

      expect(mockStore.listBranches).toHaveBeenCalledWith('doc1', undefined);
      expect(result).toEqual(mockBranches);
    });

    it('should pass since option to store', async () => {
      vi.mocked(mockStore.listBranches).mockResolvedValue([]);

      await branchManager.listBranches('doc1', { since: 1234567890 });

      expect(mockStore.listBranches).toHaveBeenCalledWith('doc1', { since: 1234567890 });
    });

    it('should handle empty branch list', async () => {
      vi.mocked(mockStore.listBranches).mockResolvedValue([]);

      const result = await branchManager.listBranches('doc1');

      expect(result).toEqual([]);
    });
  });

  describe('createBranch', () => {
    const mockState = { title: 'Document', content: 'Content' };
    const mockVersion: VersionMetadata = {
      id: 'version1',
      origin: 'main' as const,
      startedAt: Date.now(),
      endedAt: Date.now(),
      endRev: 5,
      startRev: 5,
      groupId: 'generated-id',
      name: 'Test Branch',
    };

    // Source document version used by getStateAtRevision
    const sourceVersion: VersionMetadata = {
      id: 'source-version',
      origin: 'main' as const,
      startedAt: Date.now(),
      endedAt: Date.now(),
      endRev: 5,
      startRev: 0,
    };

    beforeEach(() => {
      vi.mocked(mockStore.loadBranch).mockResolvedValue(null);
      // Mock store methods needed by getStateAtRevision
      vi.mocked(mockStore.listVersions).mockResolvedValue([sourceVersion]);
      vi.mocked(mockStore.loadVersionState).mockResolvedValue(JSON.stringify(mockState));
      vi.mocked(mockStore.listChanges).mockResolvedValue([]);
      vi.mocked(createId).mockReturnValue('generated-id');
      vi.mocked(createChange).mockReturnValue({
        id: 'initial-change',
        baseRev: 0,
        rev: 1,
        ops: [{ op: 'replace', path: '', value: mockState }],
        createdAt: Date.now(),
        committedAt: Date.now(),
      });
      vi.mocked(createVersionMetadata).mockReturnValue(mockVersion);
      vi.mocked(mockStore.createVersion).mockResolvedValue();
      vi.mocked(mockStore.saveChanges).mockResolvedValue();
      vi.mocked(mockStore.createBranch).mockResolvedValue();
    });

    it('should create branch successfully', async () => {
      const metadata: EditableBranchMetadata = {
        name: 'Test Branch',
        description: 'A test branch',
      };

      const result = await branchManager.createBranch('doc1', 5, metadata);

      expect(mockStore.loadBranch).toHaveBeenCalledWith('doc1');
      // getStateAtRevision calls listVersions and loadVersionState
      expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', expect.objectContaining({ orderBy: 'endRev' }));
      // The initial version is stamped with branch-local revs (init changes start at rev 1),
      // not the source's branch-point rev — cold loads select versions in the branch's rev-space.
      expect(createVersionMetadata).toHaveBeenCalledWith({
        origin: 'main',
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
        endRev: 1,
        startRev: 1,
        name: 'Test Branch',
        groupId: 'generated-id',
      });
      expect(mockStore.saveChanges).toHaveBeenCalledWith('generated-id', expect.any(Array));
      expect(mockStore.createVersion).toHaveBeenCalledWith('generated-id', mockVersion, expect.any(Array));
      expect(mockStore.createBranch).toHaveBeenCalledWith({
        name: 'Test Branch',
        description: 'A test branch',
        id: 'generated-id',
        docId: 'doc1',
        branchedAtRev: 5,
        contentStartRev: 2,
        createdAt: expect.any(Number),
        modifiedAt: expect.any(Number),
      });
      expect(result).toBe('generated-id');
    });

    it('should create branch without metadata', async () => {
      const result = await branchManager.createBranch('doc1', 3);

      expect(result).toBe('generated-id');
      expect(mockStore.createBranch).toHaveBeenCalledWith({
        id: 'generated-id',
        docId: 'doc1',
        branchedAtRev: 3,
        contentStartRev: 2,
        createdAt: expect.any(Number),
        modifiedAt: expect.any(Number),
      });
    });

    it('should skip initial change creation when contentStartRev is set', async () => {
      const result = await branchManager.createBranch('doc1', 5, { name: 'Offline', contentStartRev: 4 });

      expect(result).toBe('generated-id');
      expect(mockStore.createBranch).toHaveBeenCalledWith(expect.objectContaining({ contentStartRev: 4 }));
      // Should NOT create initial changes or version — the client already created them
      expect(mockStore.saveChanges).not.toHaveBeenCalled();
      expect(mockStore.createVersion).not.toHaveBeenCalled();
    });

    it('should be idempotent when metadata.id matches existing branch', async () => {
      const existing: Branch = {
        id: 'my-branch',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: Date.now(),
        modifiedAt: Date.now(),

        contentStartRev: 2,
      };
      vi.mocked(mockStore.loadBranch).mockResolvedValue(existing);

      const result = await branchManager.createBranch('doc1', 5, { id: 'my-branch' });

      expect(result).toBe('my-branch');
      // Should NOT create anything new
      expect(mockStore.createBranch).not.toHaveBeenCalled();
      expect(mockStore.saveChanges).not.toHaveBeenCalled();
    });

    it('should throw when metadata.id matches branch for different doc', async () => {
      const existing: Branch = {
        id: 'my-branch',
        docId: 'other-doc',
        branchedAtRev: 5,
        createdAt: Date.now(),
        modifiedAt: Date.now(),

        contentStartRev: 2,
      };
      vi.mocked(mockStore.loadBranch).mockResolvedValue(existing);

      await expect(branchManager.createBranch('doc1', 5, { id: 'my-branch' })).rejects.toThrow(
        'already exists for a different document'
      );
    });

    it('should throw error when trying to branch from a branch', async () => {
      const existingBranch: Branch = {
        id: 'branch1',
        docId: 'original-doc',
        branchedAtRev: 1,
        contentStartRev: 2,
        createdAt: Date.now(),
        modifiedAt: Date.now(),
      };

      vi.mocked(mockStore.loadBranch).mockResolvedValue(existingBranch);

      await expect(branchManager.createBranch('branch1', 5)).rejects.toThrow(
        'Cannot create a branch from another branch.'
      );
    });

    it('should handle state retrieval errors', async () => {
      vi.mocked(mockStore.listVersions).mockRejectedValue(new Error('State not found'));

      await expect(branchManager.createBranch('doc1', 5)).rejects.toThrow('State not found');
    });

    it('should use store.createBranchId when provided', async () => {
      const customBranchId = 'docs/doc1/branches/custom-123';
      mockStore.createBranchId = vi.fn().mockReturnValue(customBranchId);

      const customVersion: VersionMetadata = {
        ...mockVersion,
        groupId: customBranchId,
      };
      vi.mocked(createVersionMetadata).mockReturnValue(customVersion);

      const result = await branchManager.createBranch('doc1', 5);

      expect(mockStore.createBranchId).toHaveBeenCalledWith('doc1');
      expect(createId).not.toHaveBeenCalled();
      expect(mockStore.createVersion).toHaveBeenCalledWith(customBranchId, customVersion, expect.any(Array));
      expect(mockStore.createBranch).toHaveBeenCalledWith(expect.objectContaining({ id: customBranchId }));
      expect(result).toBe(customBranchId);
    });

    it('should support async createBranchId', async () => {
      const customBranchId = 'docs/doc1/branches/async-456';
      mockStore.createBranchId = vi.fn().mockResolvedValue(customBranchId);

      const customVersion: VersionMetadata = {
        ...mockVersion,
        groupId: customBranchId,
      };
      vi.mocked(createVersionMetadata).mockReturnValue(customVersion);

      const result = await branchManager.createBranch('doc1', 5);

      expect(mockStore.createBranchId).toHaveBeenCalledWith('doc1');
      expect(result).toBe(customBranchId);
    });
  });

  describe('updateBranch', () => {
    it('should update branch metadata with modifiedAt', async () => {
      const metadata: EditableBranchMetadata = {
        name: 'Updated Branch',
        description: 'Updated description',
      };

      vi.mocked(mockStore.updateBranch).mockResolvedValue();

      await branchManager.updateBranch('branch1', metadata);

      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', {
        ...metadata,
        modifiedAt: expect.any(Number),
      });
    });

    it('should propagate store errors', async () => {
      const error = new Error('Update failed');
      vi.mocked(mockStore.updateBranch).mockRejectedValue(error);

      await expect(branchManager.updateBranch('branch1', { name: 'Test' })).rejects.toThrow('Update failed');
    });

    it('should drop client-supplied lastMergedRev (server-authoritative merge watermark)', async () => {
      // PatchesSync forwards whole branch records, so a stale lastMergedRev arrives on
      // ordinary renames — honoring it would rewind the merge cursor and re-merge changes.
      vi.mocked(mockStore.updateBranch).mockResolvedValue();

      await branchManager.updateBranch('branch1', { name: 'Renamed', lastMergedRev: 1 });

      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', {
        name: 'Renamed',
        modifiedAt: expect.any(Number),
      });
    });

    it('should drop client-supplied mergeBaseRev (server-authoritative merge base)', async () => {
      // A forged/stale mergeBaseRev would shift the merge's dedup window and let
      // already-merged changes be applied twice.
      vi.mocked(mockStore.updateBranch).mockResolvedValue();

      await branchManager.updateBranch('branch1', { name: 'Renamed', mergeBaseRev: 3 });

      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', {
        name: 'Renamed',
        modifiedAt: expect.any(Number),
      });
    });
  });

  describe('deleteBranch', () => {
    it('should delegate to store.deleteBranch', async () => {
      vi.mocked(mockStore.deleteBranch).mockResolvedValue();

      await branchManager.deleteBranch('branch1');

      expect(mockStore.deleteBranch).toHaveBeenCalledWith('branch1');
    });
  });

  describe('mergeBranch', () => {
    const mockBranch: Branch = {
      id: 'branch1',
      docId: 'doc1',
      branchedAtRev: 5,
      contentStartRev: 2,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      name: 'Feature Branch',
    };

    const mockBranchChanges: Change[] = [
      {
        id: 'change1',
        rev: 1,
        baseRev: 0,
        ops: [{ op: 'replace', path: '/title', value: 'New Title' }],
        createdAt: Date.now(),
        committedAt: Date.now(),
        metadata: {},
      },
      {
        id: 'change2',
        rev: 2,
        baseRev: 1,
        ops: [{ op: 'add', path: '/section', value: 'New Section' }],
        createdAt: Date.now(),
        committedAt: Date.now(),
        metadata: {},
      },
    ];

    const mockVersions: VersionMetadata[] = [
      {
        id: 'version1',
        parentId: undefined,
        groupId: 'branch1',
        origin: 'main',
        startedAt: Date.now(),
        endedAt: Date.now(),
        endRev: 2,
        startRev: 0,
      },
    ];

    beforeEach(() => {
      vi.mocked(mockStore.loadBranch).mockResolvedValue(mockBranch);
      // Healthy branch: the source's current rev is at or beyond branchedAtRev,
      // so the merge-base clamp is a no-op and baseRev stays at branchedAtRev.
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(5);
      vi.mocked(mockStore.listChanges).mockResolvedValue(mockBranchChanges);
      // The branch's versions are the ones to copy; the source carries no main version of its
      // own unless a test gives it one, so the first copy has nothing to chain to.
      vi.mocked(mockStore.listVersions).mockImplementation(async docId => (docId === 'branch1' ? mockVersions : []));
      vi.mocked(mockStore.loadVersionState).mockResolvedValue(
        JSON.stringify({ title: 'New Title', section: 'New Section' })
      );
      vi.mocked(mockStore.loadVersionChanges!).mockResolvedValue(mockBranchChanges);
      vi.mocked(mockStore.createVersion).mockResolvedValue();
      vi.mocked(mockStore.updateBranch).mockResolvedValue();
    });

    it('should merge branch successfully with original change IDs preserved', async () => {
      const committedChanges: Change[] = mockBranchChanges.map((c, i) => ({
        ...c,
        baseRev: 5,
        rev: 6 + i,
        batchId: 'branch1',
      }));

      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: committedChanges });

      const result = await branchManager.mergeBranch('branch1');

      expect(mockStore.loadBranch).toHaveBeenCalledWith('branch1');
      expect(mockStore.listChanges).toHaveBeenCalledWith('branch1', { startAfter: 1 });
      // Versions use the same cursor as changes so repeat merges don't re-copy them
      expect(mockStore.listVersions).toHaveBeenCalledWith('branch1', {
        origin: 'main',
        orderBy: 'endRev',
        startAfter: 1,
      });
      // Should send original changes re-stamped with baseRev and batchId
      expect(mockServer.commitChanges).toHaveBeenCalledWith('doc1', [
        expect.objectContaining({ id: 'change1', baseRev: 5, rev: 6, batchId: 'branch1' }),
        expect.objectContaining({ id: 'change2', baseRev: 5, rev: 7, batchId: 'branch1' }),
      ]);
      // Should NOT call createChange (no flattening)
      expect(createChange).not.toHaveBeenCalled();
      // Should update lastMergedRev instead of closing branch
      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', {
        lastMergedRev: 2,
        modifiedAt: expect.any(Number),
      });
      expect(result).toEqual(committedChanges);
    });

    it('clamps the merge base when branchedAtRev is ahead of the source tip and persists it', async () => {
      // Migrated/re-synced doc: the branch records branchedAtRev=295 but the
      // source's change log was renumbered down to a current rev of 294. Without
      // clamping, committing with baseRev=295 trips commitChanges' "baseRev ahead
      // of server revision" guard and the merge throws. The base must clamp to
      // the source tip (294) so the branch's edits rebase onto the real head.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(mockStore.loadBranch).mockResolvedValue({ ...mockBranch, branchedAtRev: 295 });
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(294);

      const committedChanges = mockBranchChanges.map((c, i) => ({
        ...c,
        baseRev: 294,
        rev: 295 + i,
        batchId: 'branch1',
      }));
      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: committedChanges });

      const result = await branchManager.mergeBranch('branch1');

      expect(mockServer.commitChanges).toHaveBeenCalledWith('doc1', [
        expect.objectContaining({ id: 'change1', baseRev: 294, rev: 295, batchId: 'branch1' }),
        expect.objectContaining({ id: 'change2', baseRev: 294, rev: 296, batchId: 'branch1' }),
      ]);
      // The clamped base is persisted BEFORE the commit so retries (and other instances)
      // reuse it — recomputing min(branchedAtRev, tip) after our own commits advanced the
      // tip would shrink the dedup window and re-apply already-merged changes.
      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', {
        mergeBaseRev: 294,
        modifiedAt: expect.any(Number),
      });
      expect(warnSpy).toHaveBeenCalled();
      expect(result).toEqual(committedChanges);
      warnSpy.mockRestore();
    });

    it('prefers a persisted mergeBaseRev over recomputing the clamp', async () => {
      // The branch already carries the pinned base from a previous (clamped) merge attempt.
      // A retry must use it verbatim — even though min(branchedAtRev, tip) would now be
      // higher — so previously committed merge changes stay inside the dedup window.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(mockStore.loadBranch).mockResolvedValue({ ...mockBranch, branchedAtRev: 295, mergeBaseRev: 290 });
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(296);

      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: [] });

      await branchManager.mergeBranch('branch1');

      // A recomputed clamp would have based these at min(295, 296) = 295.
      expect(mockServer.commitChanges).toHaveBeenCalledWith('doc1', [
        expect.objectContaining({ id: 'change1', baseRev: 290, rev: 291, batchId: 'branch1' }),
        expect.objectContaining({ id: 'change2', baseRev: 290, rev: 292, batchId: 'branch1' }),
      ]);
      // The clamp path never ran: it warns and re-pins the base, and does neither here. (The
      // tip itself is read regardless, to bound the version-parent lookup below.)
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('clamping merge base'));
      expect(mockStore.updateBranch).not.toHaveBeenCalledWith(
        'branch1',
        expect.objectContaining({ mergeBaseRev: expect.anything() })
      );
      warnSpy.mockRestore();
    });

    it('pins the clamped merge base first-writer-wins when the store supports CAS', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const updateBranchIf = vi.fn().mockResolvedValue(true);
      mockStore.updateBranchIf = updateBranchIf;
      vi.mocked(mockStore.loadBranch).mockResolvedValue({ ...mockBranch, branchedAtRev: 295 });
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(294);
      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: [] });

      await branchManager.mergeBranch('branch1');

      expect(updateBranchIf).toHaveBeenCalledWith(
        'branch1',
        { mergeBaseRev: 294, modifiedAt: expect.any(Number) },
        { mergeBaseRev: undefined }
      );
      warnSpy.mockRestore();
    });

    it('adopts a concurrently pinned merge base when the CAS loses', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Lose the mergeBaseRev CAS (a concurrent merge pinned it first); the later
      // lastMergedRev CAS succeeds normally.
      const updateBranchIf = vi.fn(async (_id: string, updates: Record<string, any>) => !('mergeBaseRev' in updates));
      mockStore.updateBranchIf = updateBranchIf;
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(294);
      // First load: no pinned base; re-read after losing the CAS: another merge pinned 293.
      vi.mocked(mockStore.loadBranch)
        .mockResolvedValueOnce({ ...mockBranch, branchedAtRev: 295 })
        .mockResolvedValue({ ...mockBranch, branchedAtRev: 295, mergeBaseRev: 293 });
      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: [] });

      await branchManager.mergeBranch('branch1');

      expect(mockServer.commitChanges).toHaveBeenCalledWith('doc1', [
        expect.objectContaining({ id: 'change1', baseRev: 293, rev: 294, batchId: 'branch1' }),
        expect.objectContaining({ id: 'change2', baseRev: 293, rev: 295, batchId: 'branch1' }),
      ]);
      warnSpy.mockRestore();
    });

    it('should throw error for non-existent branch', async () => {
      vi.mocked(mockStore.loadBranch).mockResolvedValue(null);

      await expect(branchManager.mergeBranch('nonexistent')).rejects.toThrow('Branch with ID nonexistent not found.');
    });

    it('should reject a deleted (tombstoned) branch', async () => {
      // Tombstones drop lastMergedRev (and possibly branchedAtRev); merging one would
      // re-copy versions and commit against garbage revs.
      vi.mocked(mockStore.loadBranch).mockResolvedValue({
        id: 'branch1',
        docId: 'doc1',
        modifiedAt: Date.now(),
        deleted: true,
      } as any);

      await expect(branchManager.mergeBranch('branch1')).rejects.toThrow('Branch branch1 has been deleted.');
      expect(mockServer.commitChanges).not.toHaveBeenCalled();
      expect(mockStore.createVersion).not.toHaveBeenCalled();
    });

    it('should return empty array when no changes to merge', async () => {
      vi.mocked(mockStore.listChanges).mockResolvedValue([]);

      const result = await branchManager.mergeBranch('branch1');

      // Should NOT update branch or close it when there's nothing to merge
      expect(mockStore.updateBranch).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should use max-wins for lastMergedRev on concurrent merges', async () => {
      const committedChanges = mockBranchChanges.map((c, i) => ({
        ...c,
        baseRev: 5,
        rev: 6 + i,
        batchId: 'branch1',
      }));
      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: committedChanges });

      // After commit, simulate another client having already merged with a higher rev
      let loadCallCount = 0;
      vi.mocked(mockStore.loadBranch).mockImplementation(async () => {
        loadCallCount++;
        if (loadCallCount === 1) return mockBranch; // First call: initial load
        return { ...mockBranch, lastMergedRev: 10 }; // Second call: post-commit, concurrent merge set it to 10
      });

      await branchManager.mergeBranch('branch1');

      // Should use the higher value (10) from concurrent merge, not our local value (2)
      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', {
        lastMergedRev: 10,
        modifiedAt: expect.any(Number),
      });
    });

    it('should handle commit errors gracefully', async () => {
      const commitError = new Error('Commit failed');
      vi.mocked(mockServer.commitChanges).mockRejectedValue(commitError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(branchManager.mergeBranch('branch1')).rejects.toThrow('Merge failed: Commit failed');

      expect(consoleSpy).toHaveBeenCalledWith('Failed to merge branch branch1 into doc1:', commitError);

      consoleSpy.mockRestore();
    });

    it('should use lastMergedRev when branch was previously merged', async () => {
      const previouslyMergedBranch = {
        ...mockBranch,
        lastMergedRev: 5, // Already merged through rev 5
      };
      vi.mocked(mockStore.loadBranch).mockResolvedValue(previouslyMergedBranch);

      const newChanges: Change[] = [
        {
          id: 'change3',
          rev: 6,
          baseRev: 5,
          ops: [{ op: 'replace', path: '/footer', value: 'New Footer' }],
          createdAt: Date.now(),
          committedAt: Date.now(),
          metadata: {},
        },
      ];
      vi.mocked(mockStore.listChanges).mockResolvedValue(newChanges);

      vi.mocked(mockServer.commitChanges).mockResolvedValue({
        changes: newChanges.map(c => ({ ...c, baseRev: 5, rev: 6, batchId: 'branch1' })),
      });

      await branchManager.mergeBranch('branch1');

      // Should query changes after lastMergedRev, not contentStartRev
      expect(mockStore.listChanges).toHaveBeenCalledWith('branch1', { startAfter: 5 });
      // Should update lastMergedRev to the latest branch rev
      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', {
        lastMergedRev: 6,
        modifiedAt: expect.any(Number),
      });
    });

    it('should create versions for all branch versions with deterministic ids', async () => {
      const multipleVersions: VersionMetadata[] = [
        {
          id: 'version1',
          parentId: undefined,
          groupId: 'branch1',
          origin: 'main',
          name: 'Feature Branch',
          startedAt: Date.now(),
          endedAt: Date.now(),
          endRev: 1,
          startRev: 0,
        },
        {
          id: 'version2',
          parentId: undefined,
          groupId: 'branch1',
          origin: 'main',
          name: 'Feature Branch',
          startedAt: Date.now(),
          endedAt: Date.now(),
          endRev: 2,
          startRev: 1,
        },
      ];

      vi.mocked(mockStore.listVersions).mockImplementation(async docId =>
        docId === 'branch1' ? multipleVersions : []
      );
      vi.mocked(mockStore.loadVersion).mockResolvedValue(undefined);
      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: [] });

      await branchManager.mergeBranch('branch1');

      expect(mockStore.createVersion).toHaveBeenCalledTimes(2);
      // Copies keep the branch version's id (per-doc namespaced) so retried/concurrent merges
      // can detect an existing copy instead of duplicating it. No fresh id is minted.
      expect(createVersionMetadata).not.toHaveBeenCalled();
      // Copied versions are re-stamped into the source's rev-space (branchStartRevOnSource=5,
      // startAfter=1): branch rev r maps to 5 + max(0, r - 1). Keeping branch-local revs would
      // poison the source's version watermark.
      expect(mockStore.createVersion).toHaveBeenNthCalledWith(
        1,
        'doc1',
        expect.objectContaining({
          id: 'version1',
          origin: 'branch',
          startRev: 5,
          endRev: 5,
          groupId: 'branch1',
          name: 'Feature Branch',
        }),
        expect.anything()
      );
      // No prior copy and no main version on the source, so there is nothing to chain to: the
      // parentId key must be omitted, not set to undefined (Firestore rejects undefined values).
      const firstMetadata = vi.mocked(mockStore.createVersion).mock.calls[0][1];
      expect(Object.hasOwn(firstMetadata, 'parentId')).toBe(false);
      expect(mockStore.createVersion).toHaveBeenNthCalledWith(
        2,
        'doc1',
        expect.objectContaining({
          id: 'version2',
          origin: 'branch',
          startRev: 5,
          endRev: 6,
          groupId: 'branch1',
          name: 'Feature Branch',
          parentId: 'version1',
        }),
        expect.anything()
      );
    });

    it('chains the first copied version to the latest main version on the source', async () => {
      const sourceVersion: VersionMetadata = {
        id: 'source-v1',
        origin: 'main',
        startedAt: Date.now(),
        endedAt: Date.now(),
        startRev: 1,
        endRev: 4,
      };
      vi.mocked(mockStore.listVersions).mockImplementation(async docId =>
        docId === 'branch1' ? mockVersions : [sourceVersion]
      );
      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: [] });

      await branchManager.mergeBranch('branch1');

      // Unanchored, building the copy's state would replay the source document from rev 1.
      expect(mockStore.createVersion).toHaveBeenCalledWith(
        'doc1',
        expect.objectContaining({ id: 'version1', origin: 'branch', parentId: 'source-v1' }),
        expect.anything()
      );
    });

    it('skips version copies that already exist on the source (retry/concurrent merge)', async () => {
      const multipleVersions: VersionMetadata[] = [
        {
          id: 'version1',
          groupId: 'branch1',
          origin: 'main',
          startedAt: Date.now(),
          endedAt: Date.now(),
          endRev: 1,
          startRev: 0,
        },
        {
          id: 'version2',
          groupId: 'branch1',
          origin: 'main',
          startedAt: Date.now(),
          endedAt: Date.now(),
          endRev: 2,
          startRev: 1,
        },
      ];
      vi.mocked(mockStore.listVersions).mockResolvedValue(multipleVersions);
      // version1 was already copied by a previous (crashed or concurrent) merge attempt.
      vi.mocked(mockStore.loadVersion).mockImplementation(async (_docId, versionId) =>
        versionId === 'version1' ? ({ id: 'version1' } as VersionMetadata) : undefined
      );
      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: [] });

      await branchManager.mergeBranch('branch1');

      expect(mockStore.createVersion).toHaveBeenCalledTimes(1);
      // The new copy still chains onto the pre-existing one.
      expect(mockStore.createVersion).toHaveBeenCalledWith(
        'doc1',
        expect.objectContaining({ id: 'version2', parentId: 'version1' }),
        expect.anything()
      );
    });

    it('advances lastMergedRev via CAS when the store supports it', async () => {
      const updateBranchIf = vi.fn().mockResolvedValue(true);
      mockStore.updateBranchIf = updateBranchIf;
      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: [] });

      await branchManager.mergeBranch('branch1');

      // Conditioned on the watermark observed when the merge began (never merged).
      expect(updateBranchIf).toHaveBeenCalledWith(
        'branch1',
        { lastMergedRev: 2, modifiedAt: expect.any(Number) },
        { lastMergedRev: undefined }
      );
      // The legacy read-then-write path must not also run.
      expect(mockStore.updateBranch).not.toHaveBeenCalled();
    });

    it('does not regress the watermark when a concurrent merge already covered this batch', async () => {
      const updateBranchIf = vi.fn().mockResolvedValue(false);
      mockStore.updateBranchIf = updateBranchIf;
      vi.mocked(mockServer.commitChanges).mockResolvedValue({ changes: [] });
      // Initial load: never merged. Re-read after the failed CAS: a concurrent merge
      // advanced the watermark past our batch (rev 2).
      vi.mocked(mockStore.loadBranch)
        .mockResolvedValueOnce(mockBranch)
        .mockResolvedValue({ ...mockBranch, lastMergedRev: 10 });

      await branchManager.mergeBranch('branch1');

      // One CAS attempt, then reconcile: 10 >= 2, so no further write — and crucially no
      // blind overwrite that would rewind 10 back to 2.
      expect(updateBranchIf).toHaveBeenCalledTimes(1);
      expect(mockStore.updateBranch).not.toHaveBeenCalled();
    });
  });
});

describe('assertBranchMetadata', () => {
  it('should allow undefined metadata', () => {
    expect(() => assertBranchMetadata(undefined)).not.toThrow();
  });

  it('should allow valid editable metadata', () => {
    const metadata: EditableBranchMetadata = {
      name: 'Feature Branch',
      description: 'Working on new feature',
      tags: ['feature', 'wip'],
    };

    expect(() => assertBranchMetadata(metadata)).not.toThrow();
  });

  it('should throw error for non-modifiable fields', () => {
    const invalidFields = ['id', 'docId', 'branchedAtRev', 'createdAt', 'modifiedAt', 'contentStartRev'];

    invalidFields.forEach(field => {
      const metadata = { [field]: 'value' } as any;
      expect(() => assertBranchMetadata(metadata)).toThrow(`Cannot modify branch field ${field}`);
    });
  });

  it('should allow custom metadata fields', () => {
    const metadata = {
      customField: 'value',
      priority: 'high',
      assignee: 'user123',
    } as any;

    expect(() => assertBranchMetadata(metadata)).not.toThrow();
  });
});
