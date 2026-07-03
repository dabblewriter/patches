import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceMergeWatermark,
  assertBranchMetadata,
  assertBranchExists,
  assertNotABranch,
  branchManagerApi,
  createBranchRecord,
  generateBranchId,
  stripMergeWatermark,
  wrapMergeCommit,
} from '../../src/server/branchUtils';
import type { BranchingStoreBackend } from '../../src/server/types';
import type { Branch } from '../../src/types';

describe('branchUtils', () => {
  describe('branchManagerApi', () => {
    it('should have correct API definition', () => {
      expect(branchManagerApi).toEqual({
        listBranches: 'read',
        createBranch: 'write',
        updateBranch: 'write',
        deleteBranch: 'write',
        mergeBranch: 'write',
      });
    });
  });

  describe('assertBranchMetadata', () => {
    it('should not throw for valid metadata', () => {
      expect(() => assertBranchMetadata({ name: 'my-branch' })).not.toThrow();
    });

    it('should not throw for undefined metadata', () => {
      expect(() => assertBranchMetadata(undefined)).not.toThrow();
    });

    it('should throw for protected field: id', () => {
      expect(() => assertBranchMetadata({ id: 'abc' } as any)).toThrow('Cannot modify branch field id');
    });

    it('should throw for protected field: docId', () => {
      expect(() => assertBranchMetadata({ docId: 'doc1' } as any)).toThrow('Cannot modify branch field docId');
    });

    it('should throw for protected field: branchedAtRev', () => {
      expect(() => assertBranchMetadata({ branchedAtRev: 5 } as any)).toThrow(
        'Cannot modify branch field branchedAtRev'
      );
    });

    it('should throw for protected field: createdAt', () => {
      expect(() => assertBranchMetadata({ createdAt: 12345 } as any)).toThrow('Cannot modify branch field createdAt');
    });

    it('should throw for protected field: modifiedAt', () => {
      expect(() => assertBranchMetadata({ modifiedAt: 12345 } as any)).toThrow('Cannot modify branch field modifiedAt');
    });
  });

  describe('generateBranchId', () => {
    it('should use store createBranchId if available (sync)', async () => {
      const store = {
        createBranchId: vi.fn().mockReturnValue('custom-branch-id'),
      };

      const result = await generateBranchId(store, 'doc1');

      expect(result).toBe('custom-branch-id');
      expect(store.createBranchId).toHaveBeenCalledWith('doc1');
    });

    it('should use store createBranchId if available (async)', async () => {
      const store = {
        createBranchId: vi.fn().mockResolvedValue('async-branch-id'),
      };

      const result = await generateBranchId(store, 'doc1');

      expect(result).toBe('async-branch-id');
      expect(store.createBranchId).toHaveBeenCalledWith('doc1');
    });

    it('should generate random ID if store has no createBranchId', async () => {
      const store = {};

      const result = await generateBranchId(store, 'doc1');

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result.length).toBe(22); // createId(22) default length
    });
  });

  describe('createBranchRecord', () => {
    it('should create branch record with required fields', () => {
      const before = Date.now();
      const branch = createBranchRecord('branch1', 'doc1', 5, 2);
      const after = Date.now();

      expect(branch.id).toBe('branch1');
      expect(branch.docId).toBe('doc1');
      expect(branch.branchedAtRev).toBe(5);
      expect(branch.contentStartRev).toBe(2);
      expect(branch.createdAt).toBeGreaterThanOrEqual(before);
      expect(branch.createdAt).toBeLessThanOrEqual(after);
      expect(branch.modifiedAt).toBeGreaterThanOrEqual(before);
      expect(branch.modifiedAt).toBeLessThanOrEqual(after);
    });

    it('should include optional metadata', () => {
      const branch = createBranchRecord('branch1', 'doc1', 5, 2, {
        name: 'feature-branch',
        customField: 'value',
      });

      expect(branch.name).toBe('feature-branch');
      expect(branch.customField).toBe('value');
    });

    it('should not allow metadata to override required fields', () => {
      const branch = createBranchRecord('branch1', 'doc1', 5, 2, {
        id: 'wrong-id',
      } as any);

      // Required fields should override metadata
      expect(branch.id).toBe('branch1');
    });
  });

  describe('assertNotABranch', () => {
    it('should not throw when document is not a branch', async () => {
      const store = {
        loadBranch: vi.fn().mockResolvedValue(null),
      };

      await expect(assertNotABranch(store, 'doc1')).resolves.not.toThrow();
      expect(store.loadBranch).toHaveBeenCalledWith('doc1');
    });

    it('should throw when document is already a branch', async () => {
      const store = {
        loadBranch: vi.fn().mockResolvedValue({
          id: 'doc1',
          docId: 'parent',
          branchedAtRev: 5,
          createdAt: Date.now(),
          modifiedAt: Date.now(),
          contentStartRev: 2,
        } as Branch),
      };

      await expect(assertNotABranch(store, 'doc1')).rejects.toThrow('Cannot create a branch from another branch.');
    });
  });

  describe('assertBranchExists', () => {
    it('should not throw for existing branch', () => {
      const branch: Branch = {
        id: 'branch1',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        contentStartRev: 2,
      };

      expect(() => assertBranchExists(branch, 'branch1')).not.toThrow();
    });

    it('should throw when branch is null', () => {
      expect(() => assertBranchExists(null, 'branch1')).toThrow('Branch with ID branch1 not found.');
    });

    it('should throw for a tombstoned branch', () => {
      // Contract-compliant tombstones keep only id/docId/modifiedAt/deleted
      const tombstone = {
        id: 'branch1',
        docId: 'doc1',
        modifiedAt: Date.now(),
        deleted: true,
      } as unknown as Branch;

      expect(() => assertBranchExists(tombstone, 'branch1')).toThrow('Branch branch1 has been deleted.');
    });
  });

  describe('stripMergeWatermark', () => {
    it('should remove lastMergedRev without mutating the input', () => {
      const metadata = { name: 'Feature', lastMergedRev: 7 };

      const result = stripMergeWatermark(metadata);

      expect(result).toEqual({ name: 'Feature' });
      expect(metadata.lastMergedRev).toBe(7);
    });

    it('should remove mergeBaseRev without mutating the input', () => {
      const metadata = { name: 'Feature', mergeBaseRev: 3 };

      const result = stripMergeWatermark(metadata);

      expect(result).toEqual({ name: 'Feature' });
      expect(metadata.mergeBaseRev).toBe(3);
    });

    it('should remove both server-managed merge fields at once', () => {
      expect(stripMergeWatermark({ name: 'Feature', lastMergedRev: 7, mergeBaseRev: 3 })).toEqual({
        name: 'Feature',
      });
    });

    it('should return metadata unchanged when no watermark present', () => {
      const metadata = { name: 'Feature' };
      expect(stripMergeWatermark(metadata)).toBe(metadata);
    });
  });

  describe('createBranchRecord merge bookkeeping', () => {
    it('should strip client-seeded lastMergedRev and mergeBaseRev', () => {
      // A forged lastMergedRev would skip changes on the first merge; a forged mergeBaseRev
      // would shift the merge's dedup window and re-apply already-merged changes.
      const branch = createBranchRecord('branch1', 'doc1', 5, 2, {
        name: 'feature',
        lastMergedRev: 9,
        mergeBaseRev: 1,
      } as any);

      expect(branch.name).toBe('feature');
      expect('lastMergedRev' in branch).toBe(false);
      expect('mergeBaseRev' in branch).toBe(false);
    });
  });

  describe('advanceMergeWatermark', () => {
    const baseBranch: Branch = {
      id: 'branch1',
      docId: 'doc1',
      branchedAtRev: 5,
      contentStartRev: 2,
      createdAt: 1,
      modifiedAt: 1,
    };

    function makeStore(overrides: Partial<BranchingStoreBackend> = {}): BranchingStoreBackend {
      return {
        listBranches: vi.fn(),
        loadBranch: vi.fn(),
        createBranch: vi.fn(),
        updateBranch: vi.fn(),
        deleteBranch: vi.fn(),
        ...overrides,
      };
    }

    describe('without CAS capability (legacy max-wins)', () => {
      it('writes the merged-through rev when higher than the stored watermark', async () => {
        const store = makeStore({ loadBranch: vi.fn().mockResolvedValue({ ...baseBranch, lastMergedRev: 3 }) });

        await advanceMergeWatermark(store, 'branch1', 3, 8);

        expect(store.updateBranch).toHaveBeenCalledWith('branch1', {
          lastMergedRev: 8,
          modifiedAt: expect.any(Number),
        });
      });

      it('keeps a higher concurrent watermark (max-wins)', async () => {
        const store = makeStore({ loadBranch: vi.fn().mockResolvedValue({ ...baseBranch, lastMergedRev: 12 }) });

        await advanceMergeWatermark(store, 'branch1', undefined, 8);

        expect(store.updateBranch).toHaveBeenCalledWith('branch1', {
          lastMergedRev: 12,
          modifiedAt: expect.any(Number),
        });
      });
    });

    describe('with CAS capability', () => {
      it('applies the update conditioned on the watermark observed at merge start', async () => {
        const updateBranchIf = vi.fn().mockResolvedValue(true);
        const store = makeStore({ updateBranchIf });

        await advanceMergeWatermark(store, 'branch1', 3, 8);

        expect(updateBranchIf).toHaveBeenCalledTimes(1);
        expect(updateBranchIf).toHaveBeenCalledWith(
          'branch1',
          { lastMergedRev: 8, modifiedAt: expect.any(Number) },
          { lastMergedRev: 3 }
        );
        expect(store.updateBranch).not.toHaveBeenCalled();
        expect(store.loadBranch).not.toHaveBeenCalled();
      });

      it('skips the write when a concurrent merge already covered the batch', async () => {
        const updateBranchIf = vi.fn().mockResolvedValue(false);
        const store = makeStore({
          updateBranchIf,
          loadBranch: vi.fn().mockResolvedValue({ ...baseBranch, lastMergedRev: 12 }),
        });

        await advanceMergeWatermark(store, 'branch1', undefined, 8);

        // One losing CAS, then reconcile: 12 >= 8 means our batch is covered — no overwrite
        // that would regress the watermark from 12 back to 8.
        expect(updateBranchIf).toHaveBeenCalledTimes(1);
        expect(store.updateBranch).not.toHaveBeenCalled();
      });

      it('retries with the fresh expected value when the concurrent merge is behind ours', async () => {
        const updateBranchIf = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const store = makeStore({
          updateBranchIf,
          loadBranch: vi.fn().mockResolvedValue({ ...baseBranch, lastMergedRev: 5 }),
        });

        await advanceMergeWatermark(store, 'branch1', undefined, 8);

        expect(updateBranchIf).toHaveBeenNthCalledWith(
          1,
          'branch1',
          { lastMergedRev: 8, modifiedAt: expect.any(Number) },
          { lastMergedRev: undefined }
        );
        expect(updateBranchIf).toHaveBeenNthCalledWith(
          2,
          'branch1',
          { lastMergedRev: 8, modifiedAt: expect.any(Number) },
          { lastMergedRev: 5 }
        );
      });

      it('gives up silently when the branch was deleted mid-merge', async () => {
        const updateBranchIf = vi.fn().mockResolvedValue(false);
        const store = makeStore({
          updateBranchIf,
          loadBranch: vi
            .fn()
            .mockResolvedValue({ id: 'branch1', docId: 'doc1', modifiedAt: 1, deleted: true } as unknown as Branch),
        });

        await expect(advanceMergeWatermark(store, 'branch1', undefined, 8)).resolves.toBeUndefined();
        expect(updateBranchIf).toHaveBeenCalledTimes(1);
      });

      it('throws after exhausting CAS retries', async () => {
        // Pathological store: CAS always fails but the record never advances.
        const updateBranchIf = vi.fn().mockResolvedValue(false);
        const store = makeStore({
          updateBranchIf,
          loadBranch: vi.fn().mockResolvedValue({ ...baseBranch, lastMergedRev: undefined }),
        });

        await expect(advanceMergeWatermark(store, 'branch1', undefined, 8)).rejects.toThrow(
          'Failed to advance merge watermark'
        );
      });
    });
  });

  describe('wrapMergeCommit', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should return result on success', async () => {
      const result = await wrapMergeCommit('branch1', 'doc1', async () => ['change1', 'change2']);

      expect(result).toEqual(['change1', 'change2']);
    });

    it('should wrap error with merge failed message', async () => {
      await expect(
        wrapMergeCommit('branch1', 'doc1', async () => {
          throw new Error('Original error');
        })
      ).rejects.toThrow('Merge failed: Original error');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to merge branch branch1 into doc1:', expect.any(Error));
    });

    it('should handle non-Error throws', async () => {
      await expect(
        wrapMergeCommit('branch1', 'doc1', async () => {
          throw 'string error';
        })
      ).rejects.toThrow('Merge failed: string error');
    });
  });
});
