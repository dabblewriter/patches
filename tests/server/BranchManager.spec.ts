import { createId } from 'crypto-id';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BranchManager } from '../../src/server/BranchManager';
import { PatchServer } from '../../src/server/PatchServer';
import type {
  Branch,
  BranchingStoreBackend,
  BranchStatus,
  Change,
  ListChangesOptions,
  ListVersionsOptions,
  VersionMetadata,
} from '../../src/types';

// Mock crypto-id
vi.mock('crypto-id', () => ({
  createId: vi.fn(() => `mock-id-${Math.random().toString(36).substring(7)}`),
}));

/**
 * Mock implementation of BranchingStoreBackend for testing BranchManager
 */
class MockBranchingStoreBackend implements BranchingStoreBackend {
  private docs: Map<string, { state: any; rev: number; changes: Change[] }> = new Map();
  private versions: Map<string, { metadata: VersionMetadata; state: any; changes: Change[] }[]> = new Map();
  private branches: Map<string, Branch[]> = new Map(); // docId -> branches from this doc
  private branchLookup: Map<string, Branch> = new Map(); // branchId -> branch metadata
  private subscriptions: Map<string, Set<string>> = new Map(); // clientId -> Set<docId>

  // Helper methods
  private _getDocData(docId: string) {
    if (!this.docs.has(docId)) {
      this.docs.set(docId, { state: null, rev: 0, changes: [] });
    }
    return this.docs.get(docId)!;
  }

  private _getDocVersions(docId: string) {
    if (!this.versions.has(docId)) {
      this.versions.set(docId, []);
    }
    return this.versions.get(docId)!;
  }

  private _getDocBranches(docId: string) {
    if (!this.branches.has(docId)) {
      this.branches.set(docId, []);
    }
    return this.branches.get(docId)!;
  }

  // Subscription methods
  addSubscription = vi.fn(async (clientId: string, docIds: string[]): Promise<string[]> => {
    if (!this.subscriptions.has(clientId)) {
      this.subscriptions.set(clientId, new Set());
    }
    const clientSubs = this.subscriptions.get(clientId)!;
    docIds.forEach(id => clientSubs.add(id));
    return docIds;
  });

  removeSubscription = vi.fn(async (clientId: string, docIds: string[]): Promise<string[]> => {
    const clientSubs = this.subscriptions.get(clientId);
    if (clientSubs) {
      docIds.forEach(id => clientSubs.delete(id));
    }
    return docIds;
  });

  // Change methods
  saveChanges = vi.fn(async (docId: string, changes: Change[]): Promise<void> => {
    const docData = this._getDocData(docId);
    for (const change of changes) {
      // If rev not set, assign next rev
      if (!change.rev || change.rev === 0) {
        change.rev = docData.rev + 1;
      }
      docData.changes.push(change);
      docData.rev = Math.max(docData.rev, change.rev);
    }
  });

  listChanges = vi.fn(async (docId: string, options: ListChangesOptions = {}): Promise<Change[]> => {
    const docData = this._getDocData(docId);
    let changes = docData.changes;

    if (options.startAfter !== undefined) {
      changes = changes.filter(c => c.rev > options.startAfter!);
    }
    if (options.endBefore !== undefined) {
      changes = changes.filter(c => c.rev < options.endBefore!);
    }
    if (options.reverse) {
      changes = [...changes].reverse();
    }
    if (options.limit !== undefined) {
      changes = changes.slice(0, options.limit);
    }
    return changes;
  });

  // Version methods
  createVersion = vi.fn(
    async (docId: string, metadata: VersionMetadata, state: any, changes: Change[]): Promise<void> => {
      const docVersions = this._getDocVersions(docId);
      docVersions.push({ metadata, state, changes });
    }
  );

  listVersions = vi.fn(async (docId: string, options: ListVersionsOptions = {}): Promise<VersionMetadata[]> => {
    let docVersions = this._getDocVersions(docId);
    let versions = docVersions.map(v => v.metadata);

    if (options.origin) {
      versions = versions.filter(v => v.origin === options.origin);
    }
    if (options.groupId) {
      versions = versions.filter(v => v.groupId === options.groupId);
    }
    if (options.orderBy) {
      versions.sort((a, b) => {
        if (options.orderBy === 'startDate') return a.startDate - b.startDate;
        if (options.orderBy === 'rev') return a.rev - b.rev;
        if (options.orderBy === 'baseRev') return a.baseRev - b.baseRev;
        return 0;
      });
    }
    if (options.reverse) {
      versions = versions.reverse();
    }
    if (options.startAfter !== undefined) {
      versions = versions.filter(v => {
        const compareValue =
          options.orderBy === 'startDate'
            ? v.startDate
            : options.orderBy === 'rev'
              ? v.rev
              : options.orderBy === 'baseRev'
                ? v.baseRev
                : v.rev;
        return compareValue > options.startAfter!;
      });
    }
    if (options.endBefore !== undefined) {
      versions = versions.filter(v => {
        const compareValue =
          options.orderBy === 'startDate'
            ? v.startDate
            : options.orderBy === 'rev'
              ? v.rev
              : options.orderBy === 'baseRev'
                ? v.baseRev
                : v.rev;
        return compareValue < options.endBefore!;
      });
    }
    if (options.limit !== undefined) {
      versions = versions.slice(0, options.limit);
    }
    return versions;
  });

  loadVersionState = vi.fn(async (docId: string, versionId: string): Promise<any> => {
    const version = this._getDocVersions(docId).find(v => v.metadata.id === versionId);
    if (!version) return undefined;
    return version.state;
  });

  loadVersionChanges = vi.fn(async (docId: string, versionId: string): Promise<Change[]> => {
    const version = this._getDocVersions(docId).find(v => v.metadata.id === versionId);
    if (!version) return [];
    return version.changes;
  });

  updateVersion = vi.fn(async (docId: string, versionId: string, updates: Partial<VersionMetadata>): Promise<void> => {
    const version = this._getDocVersions(docId).find(v => v.metadata.id === versionId);
    if (version) {
      Object.assign(version.metadata, updates);
    }
  });

  // Branch methods
  createBranch = vi.fn(async (branch: Branch): Promise<void> => {
    const docBranches = this._getDocBranches(branch.branchedFromId);
    docBranches.push(branch);
    this.branchLookup.set(branch.id, branch);
  });

  loadBranch = vi.fn(async (branchId: string): Promise<Branch | null> => {
    return this.branchLookup.get(branchId) || null;
  });

  listBranches = vi.fn(async (docId: string): Promise<Branch[]> => {
    return this._getDocBranches(docId);
  });

  updateBranch = vi.fn(
    async (branchId: string, updates: Partial<Pick<Branch, 'status' | 'name' | 'metadata'>>): Promise<void> => {
      const branch = this.branchLookup.get(branchId);
      if (branch) {
        Object.assign(branch, updates);
      }
    }
  );

  closeBranch = vi.fn(async (branchId: string): Promise<void> => {
    await this.updateBranch(branchId, { status: 'closed' });
  });

  // Doc methods
  deleteDoc = vi.fn(async (docId: string): Promise<void> => {
    this.docs.delete(docId);
    this.versions.delete(docId);
  });

  // Helper methods for tests
  setDocState(docId: string, state: any, rev: number) {
    this._getDocData(docId).state = state;
    this._getDocData(docId).rev = rev;
  }
}

// --- Tests ---

describe('BranchManager', () => {
  let mockStore: MockBranchingStoreBackend;
  let mockPatchServer: Partial<PatchServer>;
  let branchManager: BranchManager;
  const mainDocId = 'doc-main';

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = new MockBranchingStoreBackend();

    // Mock PatchServer with just the methods BranchManager needs
    mockPatchServer = {
      _getStateAtRevision: vi.fn().mockResolvedValue({ state: { value: 'test' }, rev: 10 }),
      patchDoc: vi.fn().mockResolvedValue([]),
    };

    branchManager = new BranchManager(mockStore as BranchingStoreBackend, mockPatchServer as PatchServer);

    // Reset createId mock to be deterministic
    let idCounter = 0;
    (createId as Mock).mockImplementation(() => `mock-id-${idCounter++}`);
  });

  describe('listBranches', () => {
    it('should return empty array if no branches exist', async () => {
      const branches = await branchManager.listBranches(mainDocId);
      expect(branches).toEqual([]);
      expect(mockStore.listBranches).toHaveBeenCalledWith(mainDocId);
    });

    it('should return branches for a document', async () => {
      const branch: Branch = {
        id: 'branch-1',
        branchedFromId: mainDocId,
        branchedRev: 10,
        created: Date.now(),
        status: 'open',
        name: 'Test Branch',
      };
      await mockStore.createBranch(branch);

      const branches = await branchManager.listBranches(mainDocId);
      expect(branches).toHaveLength(1);
      expect(branches[0].id).toBe('branch-1');
      expect(branches[0].name).toBe('Test Branch');
    });
  });

  describe('createBranch', () => {
    it('should create a branch with initial version at the branch point', async () => {
      const rev = 10;
      const branchName = 'Test Branch';
      const metadata = { author: 'User' };
      const stateAtRev = { value: 'test' };

      // Setup mock for _getStateAtRevision
      (mockPatchServer._getStateAtRevision as Mock).mockResolvedValue({ state: stateAtRev, rev });

      // Create branch
      const branchId = await branchManager.createBranch(mainDocId, rev, branchName, metadata);

      // Verify createVersion was called correctly
      expect(mockStore.createVersion).toHaveBeenCalledTimes(1);
      const createVersionCall = mockStore.createVersion.mock.calls[0];

      // Check branch document ID is correct
      expect(createVersionCall[0]).toBe(branchId);

      // Check version metadata
      const versionMetadata = createVersionCall[1];
      expect(versionMetadata.origin).toBe('main');
      expect(versionMetadata.rev).toBe(rev);
      expect(versionMetadata.baseRev).toBe(rev);
      expect(versionMetadata.name).toBe(branchName);
      expect(versionMetadata.groupId).toBe(branchId);
      expect(versionMetadata.branchName).toBe(branchName);

      // Check state
      expect(createVersionCall[2]).toBe(stateAtRev);

      // Check changes (should be empty array)
      expect(createVersionCall[3]).toEqual([]);

      // Verify createBranch was called correctly
      expect(mockStore.createBranch).toHaveBeenCalledTimes(1);
      const branch = mockStore.createBranch.mock.calls[0][0];
      expect(branch.id).toBe(branchId);
      expect(branch.branchedFromId).toBe(mainDocId);
      expect(branch.branchedRev).toBe(rev);
      expect(branch.name).toBe(branchName);
      expect(branch.status).toBe('open');
      expect(branch.metadata).toBe(metadata);
    });

    it('should throw error if trying to branch off a branch', async () => {
      // Setup: Create a branch
      const branchDocId = 'branch-doc';
      const branch: Branch = {
        id: branchDocId,
        branchedFromId: mainDocId,
        branchedRev: 5,
        created: Date.now(),
        status: 'open',
      };
      await mockStore.createBranch(branch);

      // Setup mock to return this branch
      mockStore.loadBranch.mockResolvedValue(branch);

      // Attempt to branch off the branch should fail
      await expect(branchManager.createBranch(branchDocId, 10)).rejects.toThrow(
        'Cannot create a branch from another branch.'
      );

      // Verify loadBranch was called
      expect(mockStore.loadBranch).toHaveBeenCalledWith(branchDocId);
    });
  });

  describe('closeBranch', () => {
    it('should update branch status to closed by default', async () => {
      await branchManager.closeBranch('branch-1');
      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch-1', { status: 'closed' });
    });

    it('should update branch status to specified status', async () => {
      await branchManager.closeBranch('branch-1', 'merged');
      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch-1', { status: 'merged' });

      await branchManager.closeBranch('branch-2', 'archived');
      expect(mockStore.updateBranch).toHaveBeenCalledWith('branch-2', { status: 'archived' });
    });
  });

  describe('mergeBranch', () => {
    let branch: Branch;
    let branchDocId: string;

    beforeEach(async () => {
      // Setup: Create a branch
      branchDocId = 'branch-1';
      branch = {
        id: branchDocId,
        branchedFromId: mainDocId,
        branchedRev: 10,
        created: Date.now() - 1000,
        status: 'open',
        name: 'Test Branch',
      };
      await mockStore.createBranch(branch);

      // Mock the branch lookup
      mockStore.loadBranch.mockResolvedValue(branch);

      // Set up some changes in the branch
      const changes: Change[] = [
        {
          id: 'change-1',
          ops: [{ op: 'add', path: '/property1', value: 'value1' }],
          rev: 11,
          baseRev: 10,
          created: Date.now() - 500,
        },
        {
          id: 'change-2',
          ops: [{ op: 'add', path: '/property2', value: 'value2' }],
          rev: 12,
          baseRev: 11,
          created: Date.now() - 200,
        },
      ];

      await mockStore.saveChanges(branchDocId, changes);
      mockStore.listChanges.mockResolvedValue(changes);

      // Set up a version in the branch
      const versionMetadata: VersionMetadata = {
        id: 'version-1',
        origin: 'main',
        startDate: Date.now() - 500,
        endDate: Date.now() - 200,
        rev: 12,
        baseRev: 10,
        groupId: branchDocId,
        branchName: 'Test Branch',
      };

      const state = { value: 'test', property1: 'value1', property2: 'value2' };
      await mockStore.createVersion(branchDocId, versionMetadata, state, changes);
      mockStore.listVersions.mockResolvedValue([versionMetadata]);
      mockStore.loadVersionState.mockResolvedValue(state);
      mockStore.loadVersionChanges.mockResolvedValue(changes);

      // Mock patchDoc to return a successful merge
      (mockPatchServer.patchDoc as Mock).mockResolvedValue([
        {
          id: 'merged-change',
          ops: changes.flatMap(c => c.ops),
          rev: 11,
          baseRev: 10,
          created: Date.now(),
        },
      ]);
    });

    it('should throw if branch not found', async () => {
      mockStore.loadBranch.mockResolvedValue(null);

      await expect(branchManager.mergeBranch('non-existent')).rejects.toThrow('Branch with ID non-existent not found.');
    });

    it('should throw if branch is not open', async () => {
      const closedBranch = { ...branch, status: 'closed' as BranchStatus };
      mockStore.loadBranch.mockResolvedValue(closedBranch);

      await expect(branchManager.mergeBranch(branchDocId)).rejects.toThrow(
        `Branch ${branchDocId} is not open (status: closed). Cannot merge.`
      );
    });

    it('should do nothing if branch has no changes', async () => {
      mockStore.listChanges.mockResolvedValue([]);

      const result = await branchManager.mergeBranch(branchDocId);

      expect(result).toEqual([]);
      expect(mockStore.updateBranch).toHaveBeenCalledWith(branchDocId, { status: 'merged' });
      expect(mockPatchServer.patchDoc).not.toHaveBeenCalled();
    });

    it('should copy branch versions to main doc and flatten changes', async () => {
      const result = await branchManager.mergeBranch(branchDocId);

      // Should list versions to find 'main' versions
      expect(mockStore.listVersions).toHaveBeenCalledWith(branchDocId, { origin: 'main' });

      // Should create a version in the main doc
      expect(mockStore.createVersion).toHaveBeenCalledWith(
        mainDocId,
        expect.objectContaining({
          origin: 'branch',
          baseRev: 10, // branchedRev
          groupId: branchDocId,
          branchName: 'Test Branch',
        }),
        expect.any(Object),
        expect.any(Array)
      );

      // Should create flattened change with all ops
      expect(mockPatchServer.patchDoc).toHaveBeenCalledWith(mainDocId, [
        expect.objectContaining({
          ops: expect.arrayContaining([
            { op: 'add', path: '/property1', value: 'value1' },
            { op: 'add', path: '/property2', value: 'value2' },
          ]),
          baseRev: 10, // branchedRev
          rev: 12, // branchedRev + changes.length
        }),
      ]);

      // Should mark branch as merged
      expect(mockStore.updateBranch).toHaveBeenCalledWith(branchDocId, { status: 'merged' });

      // Should return the result from patchDoc
      expect(result).toEqual([
        expect.objectContaining({
          id: 'merged-change',
        }),
      ]);
    });

    it('should handle merge failure', async () => {
      const error = new Error('Merge conflict');
      (mockPatchServer.patchDoc as Mock).mockRejectedValue(error);

      await expect(branchManager.mergeBranch(branchDocId)).rejects.toThrow('Merge failed: Merge conflict');

      // Should not mark branch as merged
      expect(mockStore.updateBranch).not.toHaveBeenCalled();
    });
  });
});
