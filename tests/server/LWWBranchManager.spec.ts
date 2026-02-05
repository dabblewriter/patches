import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LWWBranchManager } from '../../src/server/LWWBranchManager';
import { LWWMemoryStoreBackend } from '../../src/server/LWWMemoryStoreBackend';
import { LWWServer } from '../../src/server/LWWServer';
import type { Branch } from '../../src/types';

// Mock createId for predictable branch IDs
vi.mock('crypto-id', () => ({
  createId: vi.fn(() => 'generated-id'),
}));

describe('LWWBranchManager', () => {
  let store: LWWMemoryStoreBackend;
  let server: LWWServer;
  let branchManager: LWWBranchManager;

  beforeEach(() => {
    store = new LWWMemoryStoreBackend();
    server = new LWWServer(store);
    branchManager = new LWWBranchManager(store, server);
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create branch manager with store and server', () => {
      expect(branchManager).toBeDefined();
    });

    it('should have static api definition', () => {
      expect(LWWBranchManager.api).toEqual({
        listBranches: 'read',
        createBranch: 'write',
        updateBranch: 'write',
        closeBranch: 'write',
        mergeBranch: 'write',
      });
    });
  });

  describe('listBranches', () => {
    it('should list branches for a document', async () => {
      // Create a branch first
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);
      await branchManager.createBranch('doc1', 1, { name: 'Feature Branch' });

      const result = await branchManager.listBranches('doc1');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Feature Branch');
      expect(result[0].docId).toBe('doc1');
    });

    it('should return empty array when no branches exist', async () => {
      const result = await branchManager.listBranches('doc1');
      expect(result).toEqual([]);
    });
  });

  describe('createBranch', () => {
    it('should create a branch from current state', async () => {
      // Set up source document
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);

      const branchId = await branchManager.createBranch('doc1', 1, { name: 'Feature Branch' });

      expect(branchId).toBe('generated-id');

      // Verify branch was created
      const branches = await branchManager.listBranches('doc1');
      expect(branches).toHaveLength(1);
      expect(branches[0]).toMatchObject({
        id: 'generated-id',
        docId: 'doc1',
        branchedAtRev: 1,
        status: 'open',
        name: 'Feature Branch',
      });
    });

    it('should copy document state to branch', async () => {
      // Set up source document
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);

      const branchId = await branchManager.createBranch('doc1', 1);

      // Branch should have same state as source
      const branchDoc = await server.getDoc(branchId);
      expect(branchDoc.state).toEqual({ name: 'Alice' });
    });

    it('should copy field metadata to branch (preserving timestamps)', async () => {
      // Set up source document
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);

      const branchId = await branchManager.createBranch('doc1', 1);

      // Branch should have same field metadata
      const branchFields = await store.listFields(branchId);
      expect(branchFields).toHaveLength(1);
      expect(branchFields[0].path).toBe('/name');
      expect(branchFields[0].value).toBe('Alice');
      expect(branchFields[0].ts).toBe(1000); // Timestamp preserved
    });

    it('should throw when branching from a branch', async () => {
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);
      const branchId = await branchManager.createBranch('doc1', 1);

      await expect(branchManager.createBranch(branchId, 1)).rejects.toThrow(
        'Cannot create a branch from another branch.'
      );
    });

    it('should use custom branch ID generator if provided', async () => {
      // Add custom ID generator to store
      (store as any).createBranchId = vi.fn(() => 'custom-branch-id');

      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);

      const branchId = await branchManager.createBranch('doc1', 1);

      expect(branchId).toBe('custom-branch-id');
    });
  });

  describe('updateBranch', () => {
    it('should update branch metadata', async () => {
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);
      const branchId = await branchManager.createBranch('doc1', 1);

      await branchManager.updateBranch(branchId, { name: 'Updated Name' });

      const branches = await branchManager.listBranches('doc1');
      expect(branches[0].name).toBe('Updated Name');
    });

    it('should throw when trying to modify protected fields', async () => {
      await expect(branchManager.updateBranch('branch1', { id: 'new-id' } as any)).rejects.toThrow(
        'Cannot modify branch field id'
      );
    });
  });

  describe('closeBranch', () => {
    it('should close branch with default status', async () => {
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);
      const branchId = await branchManager.createBranch('doc1', 1);

      await branchManager.closeBranch(branchId);

      const branches = await branchManager.listBranches('doc1');
      expect(branches[0].status).toBe('closed');
    });

    it('should close branch with specified status', async () => {
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);
      const branchId = await branchManager.createBranch('doc1', 1);

      await branchManager.closeBranch(branchId, 'archived');

      const branches = await branchManager.listBranches('doc1');
      expect(branches[0].status).toBe('archived');
    });
  });

  describe('mergeBranch', () => {
    it('should throw when branch not found', async () => {
      await expect(branchManager.mergeBranch('nonexistent')).rejects.toThrow('Branch with ID nonexistent not found.');
    });

    it('should throw when branch is not open', async () => {
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);
      const branchId = await branchManager.createBranch('doc1', 1);
      await branchManager.closeBranch(branchId, 'merged');

      await expect(branchManager.mergeBranch(branchId)).rejects.toThrow(
        `Branch ${branchId} is not open (status: merged). Cannot merge.`
      );
    });

    it('should close branch when no changes to merge', async () => {
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);
      const branchId = await branchManager.createBranch('doc1', 1);
      // No changes on branch

      const result = await branchManager.mergeBranch(branchId);

      expect(result).toEqual([]);
      const branches = await branchManager.listBranches('doc1');
      expect(branches[0].status).toBe('merged');
    });

    it('should merge branch changes to source document', async () => {
      // Set up source document
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);

      // Create branch
      const branchId = await branchManager.createBranch('doc1', 1);

      // Make changes on branch
      await server.commitChanges(branchId, [
        { id: 'c2', ops: [{ op: 'replace', path: '/name', value: 'Bob', ts: 2000 }] },
      ]);

      // Merge branch
      const result = await branchManager.mergeBranch(branchId);

      // Verify merge result
      expect(result).toHaveLength(1);

      // Verify source document updated
      const sourceDoc = await server.getDoc('doc1');
      expect(sourceDoc.state.name).toBe('Bob');

      // Verify branch closed
      const branches = await branchManager.listBranches('doc1');
      expect(branches[0].status).toBe('merged');
    });

    it('should resolve conflicts using LWW (later timestamp wins)', async () => {
      // Set up source document
      await server.commitChanges('doc1', [
        { id: 'c1', ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }] },
      ]);

      // Create branch
      const branchId = await branchManager.createBranch('doc1', 1);

      // Make changes on branch with ts=2000
      await server.commitChanges(branchId, [
        { id: 'c2', ops: [{ op: 'replace', path: '/name', value: 'BranchValue', ts: 2000 }] },
      ]);

      // Make concurrent changes on source with ts=3000 (after branch change)
      await server.commitChanges('doc1', [
        { id: 'c3', ops: [{ op: 'replace', path: '/name', value: 'SourceValue', ts: 3000 }] },
      ]);

      // Merge branch - source's later timestamp should win
      await branchManager.mergeBranch(branchId);

      const sourceDoc = await server.getDoc('doc1');
      expect(sourceDoc.state.name).toBe('SourceValue'); // ts=3000 > ts=2000
    });

    it('should handle merge with multiple fields', async () => {
      // Set up source document
      await server.commitChanges('doc1', [
        {
          id: 'c1',
          ops: [
            { op: 'replace', path: '/name', value: 'Alice', ts: 1000 },
            { op: 'replace', path: '/age', value: 30, ts: 1000 },
          ],
        },
      ]);

      // Create branch
      const branchId = await branchManager.createBranch('doc1', 1);

      // Make changes on branch
      await server.commitChanges(branchId, [
        {
          id: 'c2',
          ops: [
            { op: 'replace', path: '/name', value: 'Bob', ts: 2000 },
            { op: 'replace', path: '/city', value: 'NYC', ts: 2000 },
          ],
        },
      ]);

      // Merge branch
      await branchManager.mergeBranch(branchId);

      // Verify source document updated
      const sourceDoc = await server.getDoc('doc1');
      expect(sourceDoc.state).toEqual({
        name: 'Bob',
        age: 30,
        city: 'NYC',
      });
    });
  });

  describe('integration: full branch lifecycle', () => {
    it('should handle create -> modify -> merge workflow', async () => {
      // 1. Create source document
      await server.commitChanges('doc1', [
        {
          id: 'c1',
          ops: [
            { op: 'replace', path: '/title', value: 'Original', ts: 1000 },
            { op: 'replace', path: '/count', value: 0, ts: 1000 },
          ],
        },
      ]);

      // 2. Create branch
      const branchId = await branchManager.createBranch('doc1', 1, { name: 'Feature' });

      // Verify branch state
      let branchDoc = await server.getDoc(branchId);
      expect(branchDoc.state).toEqual({ title: 'Original', count: 0 });

      // 3. Make changes on branch
      await server.commitChanges(branchId, [
        { id: 'c2', ops: [{ op: 'replace', path: '/title', value: 'Modified', ts: 2000 }] },
      ]);

      branchDoc = await server.getDoc(branchId);
      expect(branchDoc.state.title).toBe('Modified');

      // 4. Make concurrent changes on source
      await server.commitChanges('doc1', [{ id: 'c3', ops: [{ op: 'replace', path: '/count', value: 5, ts: 1500 }] }]);

      // 5. Merge branch
      await branchManager.mergeBranch(branchId);

      // 6. Verify final state
      const sourceDoc = await server.getDoc('doc1');
      expect(sourceDoc.state).toEqual({
        title: 'Modified', // From branch (ts=2000)
        count: 5, // From concurrent source change (ts=1500)
      });

      // 7. Verify branch is closed
      const branches = await branchManager.listBranches('doc1');
      expect(branches[0].status).toBe('merged');
    });
  });
});
