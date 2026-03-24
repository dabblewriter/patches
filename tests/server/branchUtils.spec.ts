import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertBranchMetadata,
  assertBranchExists,
  assertNotABranch,
  branchManagerApi,
  createBranchRecord,
  generateBranchId,
  wrapMergeCommit,
} from '../../src/server/branchUtils';
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
