import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChange } from '../../src/data/change';
import { JSONPatch } from '../../src/json-patch/JSONPatch';
import { PatchesServer, assertVersionMetadata } from '../../src/server/PatchesServer';
import type { PatchesStoreBackend } from '../../src/server/types';
import type { Change, EditableVersionMetadata } from '../../src/types';
import { getISO, getLocalISO } from '../../src/utils/dates';

// Mock the algorithm modules
vi.mock('../../src/algorithms/server/getSnapshotAtRevision');
vi.mock('../../src/algorithms/server/getStateAtRevision');
vi.mock('../../src/algorithms/server/handleOfflineSessionsAndBatches');
vi.mock('../../src/algorithms/server/createVersion');
vi.mock('../../src/algorithms/shared/applyChanges');
vi.mock('../../src/data/change');
vi.mock('../../src/json-patch/applyPatch');
vi.mock('../../src/json-patch/createJSONPatch');
vi.mock('../../src/json-patch/transformPatch');

import { createVersion as createVersionAlgorithm } from '../../src/algorithms/server/createVersion';
import { getSnapshotAtRevision } from '../../src/algorithms/server/getSnapshotAtRevision';
import { getStateAtRevision } from '../../src/algorithms/server/getStateAtRevision';
import { handleOfflineSessionsAndBatches } from '../../src/algorithms/server/handleOfflineSessionsAndBatches';
import { applyChanges } from '../../src/algorithms/shared/applyChanges';
import { applyPatch } from '../../src/json-patch/applyPatch';
import { createJSONPatch } from '../../src/json-patch/createJSONPatch';
import { transformPatch } from '../../src/json-patch/transformPatch';

describe('PatchesServer', () => {
  let server: PatchesServer;
  let mockStore: PatchesStoreBackend;

  beforeEach(() => {
    mockStore = {
      listChanges: vi.fn(),
      saveChanges: vi.fn(),
      deleteDoc: vi.fn(),
      createVersion: vi.fn(),
    } as any;

    server = new PatchesServer(mockStore);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create server with default options', () => {
      const server = new PatchesServer(mockStore);
      expect(server).toBeDefined();
      expect(server.store).toBe(mockStore);
    });

    it('should create server with custom session timeout', () => {
      const server = new PatchesServer(mockStore, { sessionTimeoutMinutes: 60 });
      expect(server).toBeDefined();
    });

    it('should have onChangesCommitted signal', () => {
      expect(typeof server.onChangesCommitted).toBe('function');
    });

    it('should have onDocDeleted signal', () => {
      expect(typeof server.onDocDeleted).toBe('function');
    });
  });

  describe('getDoc', () => {
    it('should get document state at latest revision', async () => {
      const mockState = { content: 'test' };
      vi.mocked(getStateAtRevision).mockResolvedValue({ state: mockState, rev: 5 });

      const result = await server.getDoc('doc1');

      expect(getStateAtRevision).toHaveBeenCalledWith(mockStore, 'doc1', undefined);
      expect(result).toEqual({ state: mockState, rev: 5 });
    });

    it('should get document state at specific revision', async () => {
      const mockState = { content: 'test' };
      vi.mocked(getStateAtRevision).mockResolvedValue({ state: mockState, rev: 3 });

      const result = await server.getDoc('doc1', 3);

      expect(getStateAtRevision).toHaveBeenCalledWith(mockStore, 'doc1', 3);
      expect(result).toEqual({ state: mockState, rev: 3 });
    });
  });

  describe('getChangesSince', () => {
    it('should get changes after specific revision', async () => {
      const mockChanges = [
        { id: 'change1', rev: 2 },
        { id: 'change2', rev: 3 },
      ] as Change[];
      vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

      const result = await server.getChangesSince('doc1', 1);

      expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', { startAfter: 1 });
      expect(result).toBe(mockChanges);
    });
  });

  describe('commitChanges', () => {
    const mockChange = {
      id: 'change1',
      baseRev: 1,
      rev: 2,
      batchId: 'batch1',
      ops: [{ op: 'replace', path: '/content', value: 'new content' }],
      createdAt: getLocalISO(),
      committedAt: getISO(),
    } as Change;

    beforeEach(() => {
      vi.mocked(getSnapshotAtRevision).mockResolvedValue({
        state: { content: 'old' },
        rev: 1,
        changes: [],
      });
      vi.mocked(getStateAtRevision).mockResolvedValue({
        state: { content: 'old' },
        rev: 1,
      });
      vi.mocked(applyChanges).mockReturnValue({ content: 'old' });
      vi.mocked(mockStore.listChanges).mockResolvedValue([]);
      vi.mocked(transformPatch).mockReturnValue([{ op: 'replace', path: '/content', value: 'new content' }]);
      vi.mocked(applyPatch).mockReturnValue({ content: 'new content' });
      vi.mocked(mockStore.saveChanges).mockResolvedValue();
    });

    it('should return empty arrays for empty changes', async () => {
      const result = await server.commitChanges('doc1', []);
      expect(result).toEqual([[], []]);
    });

    it('should fill in baseRev when missing (apply to latest)', async () => {
      // Create a change without baseRev and without batchId (to skip offline handling)
      const changeWithoutBaseRev = {
        id: 'change1',
        rev: 2,
        ops: [{ op: 'replace', path: '/content', value: 'new content' }],
        createdAt: getLocalISO(),
        // No baseRev - should be filled in
        // No batchId - skip offline handling
      } as any;
      const result = await server.commitChanges('doc1', [changeWithoutBaseRev]);
      // Should succeed, not throw - baseRev gets filled in with current revision
      expect(result[1]).toHaveLength(1);
      expect(result[1][0].baseRev).toBe(1); // Current rev from mock
    });

    it('should throw error for inconsistent baseRev in batch', async () => {
      const change1 = { ...mockChange, baseRev: 1 };
      const change2 = { ...mockChange, id: 'change2', baseRev: 2 };

      await expect(server.commitChanges('doc1', [change1, change2])).rejects.toThrow(
        'Client changes must have consistent baseRev'
      );
    });

    it('should throw error when client baseRev is ahead of server', async () => {
      vi.mocked(getSnapshotAtRevision).mockResolvedValue({
        state: { content: 'old' },
        rev: 1,
        changes: [],
      });

      const futureChange = { ...mockChange, baseRev: 5 };
      await expect(server.commitChanges('doc1', [futureChange])).rejects.toThrow(
        'Client baseRev (5) is ahead of server revision (1)'
      );
    });

    it('should successfully commit new changes', async () => {
      // Mock handleOfflineSessionsAndBatches to return the input changes
      vi.mocked(handleOfflineSessionsAndBatches).mockResolvedValue([mockChange]);

      const result = await server.commitChanges('doc1', [mockChange]);

      expect(mockStore.saveChanges).toHaveBeenCalledWith(
        'doc1',
        expect.arrayContaining([
          expect.objectContaining({
            id: 'change1',
            rev: 2,
            ops: [{ op: 'replace', path: '/content', value: 'new content' }],
          }),
        ])
      );
      expect(result[0]).toEqual([]); // No committed changes
      expect(result[1]).toHaveLength(1); // One transformed change
    });

    it('should filter out already committed changes', async () => {
      const existingChange = { ...mockChange, id: 'existing' };
      vi.mocked(mockStore.listChanges).mockResolvedValue([existingChange]);

      const result = await server.commitChanges('doc1', [existingChange]);

      expect(result[0]).toEqual([existingChange]); // Existing committed changes
      expect(result[1]).toEqual([]); // No new changes
      expect(mockStore.saveChanges).not.toHaveBeenCalled();
    });

    it('should handle offline sessions with batchId (fast-forward)', async () => {
      const offlineChanges = [mockChange];
      vi.mocked(handleOfflineSessionsAndBatches).mockResolvedValue(offlineChanges);
      // No committed changes = fast-forward
      vi.mocked(mockStore.listChanges).mockResolvedValue([]);

      await server.commitChanges('doc1', [mockChange]);

      expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
        mockStore,
        expect.any(Number), // sessionTimeoutMillis
        'doc1',
        [mockChange],
        1,
        'batch1',
        'main', // Fast-forward: origin is 'main'
        true, // isOffline
        undefined // maxPayloadBytes
      );
    });

    it('should handle offline sessions with batchId (divergent)', async () => {
      const offlineChanges = [mockChange];
      const committedChange = { ...mockChange, id: 'committed' } as Change;
      vi.mocked(handleOfflineSessionsAndBatches).mockResolvedValue(offlineChanges);
      // Has committed changes = divergent
      vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);

      await server.commitChanges('doc1', [mockChange]);

      expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
        mockStore,
        expect.any(Number), // sessionTimeoutMillis
        'doc1',
        [mockChange],
        1,
        'batch1',
        'offline-branch', // Divergent: origin is 'offline-branch'
        true, // isOffline
        undefined // maxPayloadBytes
      );
    });

    it('should handle transformation that results in no-op changes', async () => {
      // Need committed changes to trigger transformation path (not fast-forward)
      const committedChange = { ...mockChange, id: 'committed' } as Change;
      vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);
      // Change without batchId to avoid offline handling
      const changeWithoutBatch = { ...mockChange, batchId: undefined } as Change;
      vi.mocked(transformPatch).mockReturnValue([]);

      const result = await server.commitChanges('doc1', [changeWithoutBatch]);

      expect(result[1]).toEqual([]); // No transformed changes
      expect(mockStore.saveChanges).not.toHaveBeenCalled();
    });

    it('should handle apply patch errors gracefully', async () => {
      // Need committed changes to trigger transformation path (not fast-forward)
      const committedChange = { ...mockChange, id: 'committed' } as Change;
      vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);
      // Change without batchId to avoid offline handling
      const changeWithoutBatch = { ...mockChange, batchId: undefined } as Change;
      vi.mocked(applyPatch).mockImplementation(() => {
        throw new Error('Apply patch failed');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

      const result = await server.commitChanges('doc1', [changeWithoutBatch]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error applying change'), expect.any(Error));
      expect(result[1]).toEqual([]);

      consoleSpy.mockRestore();
    });

    it('should emit onChangesCommitted signal after successful commit', async () => {
      const emitSpy = vi.spyOn(server.onChangesCommitted, 'emit').mockResolvedValue();

      await server.commitChanges('doc1', [mockChange], undefined, 'client1');

      expect(emitSpy).toHaveBeenCalledWith('doc1', expect.any(Array), 'client1');
    });

    it('should handle notification errors gracefully', async () => {
      const emitSpy = vi.spyOn(server.onChangesCommitted, 'emit').mockRejectedValue(new Error('Notification failed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

      await server.commitChanges('doc1', [mockChange]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to notify clients'), expect.any(Error));

      emitSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('change', () => {
    it('should create and commit server-side changes', async () => {
      const mockPatch = new JSONPatch([{ op: 'replace', path: '/content', value: 'new' }]);
      vi.spyOn(mockPatch, 'apply').mockImplementation(vi.fn());

      const getDocSpy = vi.spyOn(server, 'getDoc').mockResolvedValue({ state: { content: 'old' }, rev: 1 });
      vi.mocked(createJSONPatch).mockReturnValue(mockPatch);
      vi.mocked(createChange).mockReturnValue({
        id: 'change1',
        baseRev: 1,
        rev: 2,
        ops: mockPatch.ops,
        createdAt: getLocalISO(),
        committedAt: getISO(),
      } as Change);

      const commitSpy = vi.spyOn(server, 'commitChanges').mockResolvedValue([[], []]);

      const result = await server.change(
        'doc1',
        (patch, path) => {
          patch.replace(path.content, 'new');
        },
        { author: 'server' }
      );

      expect(createJSONPatch).toHaveBeenCalledWith(expect.any(Function));
      expect(mockPatch.apply).toHaveBeenCalledWith({ content: 'old' });
      expect(commitSpy).toHaveBeenCalledWith('doc1', [expect.any(Object)]);
      expect(result).toBeDefined();

      getDocSpy.mockRestore();
      commitSpy.mockRestore();
    });

    it('should return null for no-op changes', async () => {
      const mockPatch = new JSONPatch([]);
      vi.spyOn(mockPatch, 'apply').mockImplementation(vi.fn());

      const getDocSpy = vi.spyOn(server, 'getDoc').mockResolvedValue({ state: { content: 'old' }, rev: 1 });
      vi.mocked(createJSONPatch).mockReturnValue(mockPatch);

      const result = await server.change('doc1', () => {
        // No changes
      });

      expect(result).toBeNull();
      getDocSpy.mockRestore();
    });
  });

  describe('deleteDoc', () => {
    it('should delete document and emit signal', async () => {
      const emitSpy = vi.spyOn(server.onDocDeleted, 'emit').mockResolvedValue();

      await server.deleteDoc('doc1', undefined, 'client1');

      expect(mockStore.deleteDoc).toHaveBeenCalledWith('doc1');
      expect(emitSpy).toHaveBeenCalledWith('doc1', undefined, 'client1');
    });
  });

  describe('captureCurrentVersion', () => {
    it('should create version with metadata', async () => {
      const mockVersion = {
        id: 'version1',
        origin: 'main' as const,
        startedAt: getISO(),
        endedAt: getISO(),
        startRev: 1,
        endRev: 5,
      };

      vi.mocked(getSnapshotAtRevision).mockResolvedValue({
        state: { content: 'test' },
        rev: 5,
        changes: [
          {
            id: 'change1',
            rev: 5,
            baseRev: 1,
            createdAt: getLocalISO(),
            committedAt: getISO(),
          } as Change,
        ],
      });
      vi.mocked(applyChanges).mockReturnValue({ content: 'test' });
      vi.mocked(createVersionAlgorithm).mockResolvedValue(mockVersion);

      const result = await server.captureCurrentVersion('doc1', { name: 'v1.0' });

      expect(createVersionAlgorithm).toHaveBeenCalledWith(
        expect.any(Object), // store
        'doc1',
        { content: 'test' },
        expect.any(Array), // changes
        { name: 'v1.0' }
      );
      expect(result).toBe('version1');
    });

    it('should throw error when no changes to create version', async () => {
      vi.mocked(getSnapshotAtRevision).mockResolvedValue({
        state: { content: 'test' },
        rev: 5,
        changes: [],
      });
      vi.mocked(applyChanges).mockReturnValue({ content: 'test' });
      vi.mocked(createVersionAlgorithm).mockResolvedValue(undefined);

      await expect(server.captureCurrentVersion('doc1')).rejects.toThrow('No changes to create a version');
    });
  });
});

describe('assertVersionMetadata', () => {
  it('should allow undefined metadata', () => {
    expect(() => assertVersionMetadata(undefined)).not.toThrow();
  });

  it('should allow valid editable metadata', () => {
    const metadata: EditableVersionMetadata = {
      name: 'v1.0',
      description: 'Initial version',
      tags: ['release'],
    };

    expect(() => assertVersionMetadata(metadata)).not.toThrow();
  });

  it('should throw error for non-modifiable fields', () => {
    const invalidFields = [
      'id',
      'parentId',
      'groupId',
      'origin',
      'branchName',
      'startedAt',
      'endedAt',
      'rev',
      'baseRev',
    ];

    invalidFields.forEach(field => {
      const metadata = { [field]: 'value' } as any;
      expect(() => assertVersionMetadata(metadata)).toThrow(`Cannot modify version field ${field}`);
    });
  });

  it('should allow custom metadata fields', () => {
    const metadata = {
      customField: 'value',
      anotherField: 123,
      nested: { data: 'test' },
    } as any;

    expect(() => assertVersionMetadata(metadata)).not.toThrow();
  });
});
