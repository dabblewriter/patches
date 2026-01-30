import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchesBranchManager, assertBranchMetadata } from '../../src/server/PatchesBranchManager';
import { PatchesServer } from '../../src/server/PatchesServer';
import type { BranchingStoreBackend } from '../../src/server/types';
import type { Branch, BranchStatus, Change, EditableBranchMetadata, VersionMetadata } from '../../src/types';

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

describe('PatchesBranchManager', () => {
  let branchManager: PatchesBranchManager;
  let mockStore: BranchingStoreBackend;
  let mockServer: PatchesServer;

  beforeEach(() => {
    mockStore = {
      listBranches: vi.fn(),
      loadBranch: vi.fn(),
      createBranch: vi.fn(),
      updateBranch: vi.fn(),
      createVersion: vi.fn(),
      listVersions: vi.fn(),
      loadVersionState: vi.fn(),
      loadVersionChanges: vi.fn(),
      listChanges: vi.fn(),
    } as any;

    mockServer = {
      getStateAtRevision: vi.fn(),
      commitChanges: vi.fn(),
    } as any;

    branchManager = new PatchesBranchManager(mockStore, mockServer);

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
      const mockBranches: Branch[] = [
        {
          id: 'branch1',
          docId: 'doc1',
          branchedAtRev: 5,
          createdAt: Date.now(),
          status: 'open',
          name: 'Feature Branch',
        },
        {
          id: 'branch2',
          docId: 'doc1',
          branchedAtRev: 3,
          createdAt: Date.now(),
          status: 'merged',
          name: 'Bug Fix Branch',
        },
      ];

      vi.mocked(mockStore.listBranches).mockResolvedValue(mockBranches);

      const result = await branchManager.listBranches('doc1');

      expect(mockStore.listBranches).toHaveBeenCalledWith('doc1');
      expect(result).toEqual(mockBranches);
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
      branchName: 'Test Branch',
    };

    beforeEach(() => {
      vi.mocked(mockStore.loadBranch).mockResolvedValue(null);
      vi.mocked(mockServer.getStateAtRevision).mockResolvedValue({ state: mockState, rev: 5 });
      vi.mocked(createId).mockReturnValue('generated-id');
      vi.mocked(createVersionMetadata).mockReturnValue(mockVersion);
      vi.mocked(mockStore.createVersion).mockResolvedValue();
      vi.mocked(mockStore.createBranch).mockResolvedValue();
    });

    it('should create branch successfully', async () => {
      const metadata: EditableBranchMetadata = {
        name: 'Test Branch',
        description: 'A test branch',
      };

      const result = await branchManager.createBranch('doc1', 5, metadata);

      expect(mockStore.loadBranch).toHaveBeenCalledWith('doc1');
      expect(mockServer.getStateAtRevision).toHaveBeenCalledWith('doc1', 5);
      expect(createVersionMetadata).toHaveBeenCalledWith({
        origin: 'main',
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
        endRev: 5,
        startRev: 5,
        name: 'Test Branch',
        groupId: 'generated-id',
        branchName: 'Test Branch',
      });
      expect(mockStore.createVersion).toHaveBeenCalledWith('generated-id', mockVersion, mockState, []);
      expect(mockStore.createBranch).toHaveBeenCalledWith({
        name: 'Test Branch',
        description: 'A test branch',
        id: 'generated-id',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: expect.any(Number),
        status: 'open',
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
        createdAt: expect.any(Number),
        status: 'open',
      });
    });

    it('should throw error when trying to branch from a branch', async () => {
      const existingBranch: Branch = {
        id: 'branch1',
        docId: 'original-doc',
        branchedAtRev: 1,
        createdAt: Date.now(),
        status: 'open',
      };

      vi.mocked(mockStore.loadBranch).mockResolvedValue(existingBranch);

      await expect(branchManager.createBranch('branch1', 5)).rejects.toThrow(
        'Cannot create a branch from another branch.'
      );
    });

    it('should handle state retrieval errors', async () => {
      vi.mocked(mockServer.getStateAtRevision).mockRejectedValue(new Error('State not found'));

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
      expect(mockStore.createVersion).toHaveBeenCalledWith(customBranchId, customVersion, mockState, []);
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
    it('should update branch metadata', async () => {
      const metadata: EditableBranchMetadata = {
        name: 'Updated Branch',
        description: 'Updated description',
      };

      vi.mocked(mockStore.updateBranch).mockResolvedValue();

      await branchManager.updateBranch('branch1', metadata);

      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', metadata);
    });

    it('should propagate store errors', async () => {
      const error = new Error('Update failed');
      vi.mocked(mockStore.updateBranch).mockRejectedValue(error);

      await expect(branchManager.updateBranch('branch1', { name: 'Test' })).rejects.toThrow('Update failed');
    });
  });

  describe('closeBranch', () => {
    it('should close branch with default status', async () => {
      vi.mocked(mockStore.updateBranch).mockResolvedValue();

      await branchManager.closeBranch('branch1');

      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', { status: 'closed' });
    });

    it('should close branch with specific status', async () => {
      vi.mocked(mockStore.updateBranch).mockResolvedValue();

      await branchManager.closeBranch('branch1', 'merged');

      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', { status: 'merged' });
    });
  });

  describe('mergeBranch', () => {
    const mockBranch: Branch = {
      id: 'branch1',
      docId: 'doc1',
      branchedAtRev: 5,
      createdAt: Date.now(),
      status: 'open',
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
        branchName: 'Feature Branch',
        startedAt: Date.now(),
        endedAt: Date.now(),
        endRev: 2,
        startRev: 0,
      },
    ];

    beforeEach(() => {
      vi.mocked(mockStore.loadBranch).mockResolvedValue(mockBranch);
      vi.mocked(mockStore.listChanges).mockResolvedValue(mockBranchChanges);
      vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
      vi.mocked(mockStore.loadVersionState).mockResolvedValue({ title: 'New Title', section: 'New Section' });
      vi.mocked(mockStore.loadVersionChanges).mockResolvedValue(mockBranchChanges);
      vi.mocked(mockStore.createVersion).mockResolvedValue();
      vi.mocked(mockStore.updateBranch).mockResolvedValue();
    });

    it('should merge branch successfully', async () => {
      const flattenedChange = {
        id: 'merged-change',
        baseRev: 5,
        rev: 7,
        ops: [
          { op: 'replace', path: '/title', value: 'New Title' },
          { op: 'add', path: '/section', value: 'New Section' },
        ],
        createdAt: Date.now(),
        committedAt: Date.now(),
        metadata: {},
      };

      const committedChanges: Change[] = [flattenedChange];

      vi.mocked(createChange).mockReturnValue(flattenedChange);
      vi.mocked(mockServer.commitChanges).mockResolvedValue([[], committedChanges]);

      const result = await branchManager.mergeBranch('branch1');

      expect(mockStore.loadBranch).toHaveBeenCalledWith('branch1');
      expect(mockStore.listChanges).toHaveBeenCalledWith('branch1', {});
      expect(mockStore.listVersions).toHaveBeenCalledWith('branch1', { origin: 'main' });
      expect(createChange).toHaveBeenCalledWith(
        5,
        7,
        mockBranchChanges.flatMap(c => c.ops)
      );
      expect(mockServer.commitChanges).toHaveBeenCalledWith('doc1', [flattenedChange]);
      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', { status: 'merged' });
      expect(result).toEqual(committedChanges);
    });

    it('should throw error for non-existent branch', async () => {
      vi.mocked(mockStore.loadBranch).mockResolvedValue(null);

      await expect(branchManager.mergeBranch('nonexistent')).rejects.toThrow('Branch with ID nonexistent not found.');
    });

    it('should throw error for non-open branch', async () => {
      const closedBranch = { ...mockBranch, status: 'merged' as BranchStatus };
      vi.mocked(mockStore.loadBranch).mockResolvedValue(closedBranch);

      await expect(branchManager.mergeBranch('branch1')).rejects.toThrow(
        'Branch branch1 is not open (status: merged). Cannot merge.'
      );
    });

    it('should handle branch with no changes', async () => {
      vi.mocked(mockStore.listChanges).mockResolvedValue([]);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await branchManager.mergeBranch('branch1');

      expect(consoleSpy).toHaveBeenCalledWith('Branch branch1 has no changes to merge.');
      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch1', { status: 'merged' });
      expect(result).toEqual([]);

      consoleSpy.mockRestore();
    });

    it('should handle commit errors gracefully', async () => {
      const commitError = new Error('Commit failed');
      vi.mocked(createChange).mockReturnValue({
        id: 'merged-change',
        baseRev: 5,
        rev: 7,
        ops: [],
        createdAt: Date.now(),
        committedAt: Date.now(),
        metadata: {},
      });
      vi.mocked(mockServer.commitChanges).mockRejectedValue(commitError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(branchManager.mergeBranch('branch1')).rejects.toThrow('Merge failed: Commit failed');

      expect(consoleSpy).toHaveBeenCalledWith('Failed to merge branch branch1 into doc1:', commitError);

      consoleSpy.mockRestore();
    });

    it('should create versions for all branch versions', async () => {
      const multipleVersions: VersionMetadata[] = [
        {
          id: 'version1',
          parentId: undefined,
          groupId: 'branch1',
          origin: 'main',
          branchName: 'Feature Branch',
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
          branchName: 'Feature Branch',
          startedAt: Date.now(),
          endedAt: Date.now(),
          endRev: 2,
          startRev: 1,
        },
      ];

      vi.mocked(mockStore.listVersions).mockResolvedValue(multipleVersions);
      vi.mocked(createVersionMetadata)
        .mockReturnValueOnce({
          id: 'new-version1',
          origin: 'branch',
          parentId: undefined,
          startedAt: Date.now(),
          endedAt: Date.now(),
          endRev: 1,
          startRev: 5,
        })
        .mockReturnValueOnce({
          id: 'new-version2',
          origin: 'branch',
          parentId: 'new-version1',
          startedAt: Date.now(),
          endedAt: Date.now(),
          endRev: 2,
          startRev: 5,
        });
      vi.mocked(createChange).mockReturnValue({
        id: 'merged-change',
        baseRev: 5,
        rev: 7,
        ops: [],
        createdAt: Date.now(),
        committedAt: Date.now(),
        metadata: {},
      });
      vi.mocked(mockServer.commitChanges).mockResolvedValue([[], []]);

      await branchManager.mergeBranch('branch1');

      expect(mockStore.createVersion).toHaveBeenCalledTimes(2);
      expect(createVersionMetadata).toHaveBeenNthCalledWith(1, {
        ...multipleVersions[0],
        origin: 'branch',
        startRev: 5,
        groupId: 'branch1',
        branchName: 'Feature Branch',
        parentId: undefined,
      });
      expect(createVersionMetadata).toHaveBeenNthCalledWith(2, {
        ...multipleVersions[1],
        origin: 'branch',
        startRev: 5,
        groupId: 'branch1',
        branchName: 'Feature Branch',
        parentId: 'new-version1',
      });
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
    const invalidFields = ['id', 'docId', 'branchedAtRev', 'createdAt', 'status'];

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
