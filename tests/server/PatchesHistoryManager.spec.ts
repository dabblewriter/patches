import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PatchesHistoryManager } from '../../src/server/PatchesHistoryManager';
import { PatchesServer } from '../../src/server/PatchesServer';
import type { PatchesStoreBackend } from '../../src/server/types';
import type {
  Change,
  EditableVersionMetadata,
  ListChangesOptions,
  ListVersionsOptions,
  VersionMetadata,
} from '../../src/types';

// Mock the PatchesServer module
vi.mock('../../src/server/PatchesServer', async () => {
  const actual = await vi.importActual('../../src/server/PatchesServer');
  return {
    ...actual,
    assertVersionMetadata: vi.fn(),
  };
});

import { assertVersionMetadata } from '../../src/server/PatchesServer';

describe('PatchesHistoryManager', () => {
  let historyManager: PatchesHistoryManager;
  let mockServer: PatchesServer;
  let mockStore: PatchesStoreBackend;

  beforeEach(() => {
    mockStore = {
      listVersions: vi.fn(),
      updateVersion: vi.fn(),
      loadVersionState: vi.fn(),
      loadVersionChanges: vi.fn(),
      listChanges: vi.fn(),
    } as any;

    mockServer = {
      store: mockStore,
      captureCurrentVersion: vi.fn(),
    } as any;

    historyManager = new PatchesHistoryManager(mockServer);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create history manager with server and store', () => {
      expect(historyManager).toBeDefined();
      expect(historyManager['patches']).toBe(mockServer);
      expect(historyManager['store']).toBe(mockStore);
    });
  });

  describe('listVersions', () => {
    const mockVersions: VersionMetadata[] = [
      {
        id: 'version1',
        parentId: undefined,
        groupId: 'group1',
        origin: 'main',
        branchName: undefined,
        startDate: 1000,
        endDate: 2000,
        rev: 5,
        baseRev: 1,
        name: 'Version 1',
        description: 'First version',
      },
      {
        id: 'version2',
        parentId: 'version1',
        groupId: 'group1',
        origin: 'main',
        branchName: undefined,
        startDate: 3000,
        endDate: 4000,
        rev: 10,
        baseRev: 5,
        name: 'Version 2',
        description: 'Second version',
      },
    ];

    it('should list versions with default options', async () => {
      vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);

      const result = await historyManager.listVersions('doc1');

      expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
        orderBy: 'startDate',
      });
      expect(result).toEqual(mockVersions);
    });

    it('should list versions with custom options', async () => {
      const options: ListVersionsOptions = {
        limit: 10,
        reverse: true,
        origin: 'branch',
        orderBy: 'startDate',
      };

      vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);

      const result = await historyManager.listVersions('doc1', options);

      expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', options);
      expect(result).toEqual(mockVersions);
    });

    it('should set default orderBy when not provided in options', async () => {
      const options: ListVersionsOptions = {
        limit: 5,
        reverse: false,
      };

      vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);

      await historyManager.listVersions('doc1', options);

      expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
        ...options,
        orderBy: 'startDate',
      });
    });

    it('should preserve existing orderBy in options', async () => {
      const options: ListVersionsOptions = {
        orderBy: 'rev',
        limit: 3,
      };

      vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);

      await historyManager.listVersions('doc1', options);

      expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', options);
    });
  });

  describe('createVersion', () => {
    it('should create version with metadata validation', async () => {
      const metadata: EditableVersionMetadata = {
        name: 'New Version',
        description: 'A new version',
        tags: ['release'],
      };

      vi.mocked(mockServer.captureCurrentVersion).mockResolvedValue('version-123');

      const result = await historyManager.createVersion('doc1', metadata);

      expect(assertVersionMetadata).toHaveBeenCalledWith(metadata);
      expect(mockServer.captureCurrentVersion).toHaveBeenCalledWith('doc1', metadata);
      expect(result).toBe('version-123');
    });

    it('should create version without metadata', async () => {
      vi.mocked(mockServer.captureCurrentVersion).mockResolvedValue('version-123');

      const result = await historyManager.createVersion('doc1');

      expect(assertVersionMetadata).toHaveBeenCalledWith(undefined);
      expect(mockServer.captureCurrentVersion).toHaveBeenCalledWith('doc1', undefined);
      expect(result).toBe('version-123');
    });

    it('should propagate errors from server createVersion', async () => {
      const error = new Error('Creation failed');
      vi.mocked(mockServer.captureCurrentVersion).mockRejectedValue(error);

      await expect(historyManager.createVersion('doc1')).rejects.toThrow('Creation failed');
    });
  });

  describe('updateVersion', () => {
    it('should update version with metadata validation', async () => {
      const metadata: EditableVersionMetadata = {
        name: 'Updated Version',
        description: 'Updated description',
      };

      vi.mocked(mockStore.updateVersion).mockResolvedValue();

      await historyManager.updateVersion('doc1', 'version1', metadata);

      expect(assertVersionMetadata).toHaveBeenCalledWith(metadata);
      expect(mockStore.updateVersion).toHaveBeenCalledWith('doc1', 'version1', metadata);
    });

    it('should propagate store update errors', async () => {
      const metadata: EditableVersionMetadata = { name: 'Test' };
      const error = new Error('Update failed');
      vi.mocked(mockStore.updateVersion).mockRejectedValue(error);

      await expect(historyManager.updateVersion('doc1', 'version1', metadata)).rejects.toThrow('Update failed');
    });
  });

  describe('getStateAtVersion', () => {
    it('should load state for valid version', async () => {
      const mockState = { content: 'test content', title: 'Test Doc' };
      vi.mocked(mockStore.loadVersionState).mockResolvedValue(mockState);

      const result = await historyManager.getStateAtVersion('doc1', 'version1');

      expect(mockStore.loadVersionState).toHaveBeenCalledWith('doc1', 'version1');
      expect(result).toEqual(mockState);
    });

    it('should handle store errors gracefully', async () => {
      const storeError = new Error('Store failed');
      vi.mocked(mockStore.loadVersionState).mockRejectedValue(storeError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(historyManager.getStateAtVersion('doc1', 'version1')).rejects.toThrow(
        'Could not load state for version version1.'
      );

      expect(consoleSpy).toHaveBeenCalledWith('Failed to load state for version version1 of doc doc1.', storeError);

      consoleSpy.mockRestore();
    });

    it('should throw descriptive error for failed state loading', async () => {
      vi.mocked(mockStore.loadVersionState).mockRejectedValue(new Error('Not found'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(historyManager.getStateAtVersion('doc1', 'nonexistent')).rejects.toThrow(
        'Could not load state for version nonexistent.'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('getChangesForVersion', () => {
    const mockChanges: Change[] = [
      {
        id: 'change1',
        rev: 2,
        baseRev: 1,
        ops: [{ op: 'add', path: '/title', value: 'Test' }],
        created: 1000,
        metadata: {},
      },
      {
        id: 'change2',
        rev: 3,
        baseRev: 2,
        ops: [{ op: 'replace', path: '/content', value: 'Updated content' }],
        created: 2000,
        metadata: {},
      },
    ];

    it('should load changes for valid version', async () => {
      vi.mocked(mockStore.loadVersionChanges).mockResolvedValue(mockChanges);

      const result = await historyManager.getChangesForVersion('doc1', 'version1');

      expect(mockStore.loadVersionChanges).toHaveBeenCalledWith('doc1', 'version1');
      expect(result).toEqual(mockChanges);
    });

    it('should handle store errors gracefully', async () => {
      const storeError = new Error('Changes not found');
      vi.mocked(mockStore.loadVersionChanges).mockRejectedValue(storeError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(historyManager.getChangesForVersion('doc1', 'version1')).rejects.toThrow(
        'Could not load changes for version version1.'
      );

      expect(consoleSpy).toHaveBeenCalledWith('Failed to load changes for version version1 of doc doc1.', storeError);

      consoleSpy.mockRestore();
    });

    it('should throw descriptive error for failed changes loading', async () => {
      vi.mocked(mockStore.loadVersionChanges).mockRejectedValue(new Error('Database error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(historyManager.getChangesForVersion('doc1', 'missing-version')).rejects.toThrow(
        'Could not load changes for version missing-version.'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('listServerChanges', () => {
    const mockChanges: Change[] = [
      {
        id: 'server-change1',
        rev: 1,
        baseRev: 0,
        ops: [{ op: 'add', path: '', value: { title: 'New Doc' } }],
        created: 1000,
        metadata: {},
      },
      {
        id: 'server-change2',
        rev: 2,
        baseRev: 1,
        ops: [{ op: 'replace', path: '/title', value: 'Updated Doc' }],
        created: 2000,
        metadata: {},
      },
    ];

    it('should list server changes with default options', async () => {
      vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

      const result = await historyManager.listServerChanges('doc1');

      expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', {});
      expect(result).toEqual(mockChanges);
    });

    it('should list server changes with custom options', async () => {
      const options: ListChangesOptions = {
        startAfter: 5,
        endBefore: 10,
        limit: 20,
        withoutBatchId: 'batch-exclude',
      };

      vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

      const result = await historyManager.listServerChanges('doc1', options);

      expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', options);
      expect(result).toEqual(mockChanges);
    });

    it('should propagate store errors', async () => {
      const error = new Error('Database connection failed');
      vi.mocked(mockStore.listChanges).mockRejectedValue(error);

      await expect(historyManager.listServerChanges('doc1')).rejects.toThrow('Database connection failed');
    });

    it('should handle empty results', async () => {
      vi.mocked(mockStore.listChanges).mockResolvedValue([]);

      const result = await historyManager.listServerChanges('doc1');

      expect(result).toEqual([]);
    });
  });

  describe('integration scenarios', () => {
    it('should handle workflow of creating and listing versions', async () => {
      const metadata: EditableVersionMetadata = {
        name: 'Feature Complete',
        description: 'All features implemented',
      };

      // Mock creation
      vi.mocked(mockServer.captureCurrentVersion).mockResolvedValue('new-version-id');

      // Mock listing
      const versions = [
        {
          id: 'new-version-id',
          parentId: undefined,
          groupId: 'group1',
          origin: 'main' as const,
          branchName: undefined,
          startDate: 1000,
          endDate: 2000,
          rev: 5,
          baseRev: 1,
          name: 'Feature Complete',
          description: 'All features implemented',
        },
      ];
      vi.mocked(mockStore.listVersions).mockResolvedValue(versions);

      // Create version
      const versionId = await historyManager.createVersion('doc1', metadata);
      expect(versionId).toBe('new-version-id');

      // List versions
      const listedVersions = await historyManager.listVersions('doc1');
      expect(listedVersions).toHaveLength(1);
      expect(listedVersions[0].name).toBe('Feature Complete');
    });

    it('should handle version state and changes loading together', async () => {
      const mockState = { title: 'Test Document', content: 'Some content' };
      const mockChanges: Change[] = [
        {
          id: 'change1',
          rev: 1,
          baseRev: 0,
          ops: [{ op: 'add', path: '', value: mockState }],
          created: 1000,
          metadata: {},
        },
      ];

      vi.mocked(mockStore.loadVersionState).mockResolvedValue(mockState);
      vi.mocked(mockStore.loadVersionChanges).mockResolvedValue(mockChanges);

      const [state, changes] = await Promise.all([
        historyManager.getStateAtVersion('doc1', 'version1'),
        historyManager.getChangesForVersion('doc1', 'version1'),
      ]);

      expect(state).toEqual(mockState);
      expect(changes).toEqual(mockChanges);
    });
  });
});
