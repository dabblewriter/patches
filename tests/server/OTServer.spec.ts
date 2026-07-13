import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChange } from '../../src/data/change';
import { JSONPatch } from '../../src/json-patch/JSONPatch';
import { clearAuthContext, setAuthContext } from '../../src/net/serverContext';
import { OTServer } from '../../src/server/OTServer';
import { readStreamAsString } from '../../src/server/jsonReadable';
import { assertVersionMetadata } from '../../src/server/utils';
import type { OTStoreBackend } from '../../src/server/types';
import type { Change, EditableVersionMetadata } from '../../src/types';

// Mock the algorithm modules
vi.mock('../../src/algorithms/ot/server/getSnapshotAtRevision');
vi.mock('../../src/algorithms/ot/server/getStateAtRevision');
vi.mock('../../src/algorithms/ot/server/handleOfflineSessionsAndBatches');
vi.mock('../../src/algorithms/ot/server/createVersion');
vi.mock('../../src/algorithms/ot/shared/applyChanges');
vi.mock('../../src/data/change');
vi.mock('../../src/json-patch/createJSONPatch');
vi.mock('../../src/json-patch/transformPatch');

import {
  createVersion as createVersionAlgorithm,
  createVersionAtRev,
} from '../../src/algorithms/ot/server/createVersion';
import {
  findLatestMainVersion,
  getSnapshotAtRevision,
  getSnapshotStream,
} from '../../src/algorithms/ot/server/getSnapshotAtRevision';
import { getStateAtRevision } from '../../src/algorithms/ot/server/getStateAtRevision';
import { handleOfflineSessionsAndBatches } from '../../src/algorithms/ot/server/handleOfflineSessionsAndBatches';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { createJSONPatch } from '../../src/json-patch/createJSONPatch';
import { transformPatch } from '../../src/json-patch/transformPatch';

describe('OTServer', () => {
  let server: OTServer;
  let mockStore: OTStoreBackend;

  beforeEach(() => {
    mockStore = {
      getCurrentRev: vi.fn().mockResolvedValue(0),
      listChanges: vi.fn(),
      saveChanges: vi.fn(),
      deleteDoc: vi.fn(),
      createVersion: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
      loadVersionState: vi.fn().mockResolvedValue(undefined),
      updateVersion: vi.fn(),
    } as any;

    server = new OTServer(mockStore);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create server with default options', () => {
      const server = new OTServer(mockStore);
      expect(server).toBeDefined();
      expect(server.store).toBe(mockStore);
    });

    it('should create server with custom session timeout', () => {
      const server = new OTServer(mockStore, { sessionTimeoutMinutes: 60 });
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
    it('should get document state at latest revision as a ReadableStream', async () => {
      const mockState = { content: 'test' };
      const mockJson = JSON.stringify({ state: mockState, rev: 5, changes: [] });
      const mockStream = new ReadableStream<string>({
        start(controller) {
          controller.enqueue(mockJson);
          controller.close();
        },
      });
      vi.mocked(getSnapshotStream).mockResolvedValue(mockStream);

      const stream = await server.getDoc('doc1');

      expect(getSnapshotStream).toHaveBeenCalledWith(mockStore, 'doc1', undefined);
      expect(stream).toBeInstanceOf(ReadableStream);
      const json = await readStreamAsString(stream);
      const result = JSON.parse(json);
      expect(result).toEqual({ state: mockState, rev: 5, changes: [] });
    });

    it('should forward the rev argument to getSnapshotStream', async () => {
      const mockStream = new ReadableStream<string>({
        start(controller) {
          controller.enqueue('{"state":null,"rev":3,"changes":[]}');
          controller.close();
        },
      });
      vi.mocked(getSnapshotStream).mockResolvedValue(mockStream);

      await server.getDoc('doc1', { rev: 3 });

      expect(getSnapshotStream).toHaveBeenCalledWith(mockStore, 'doc1', 3);
    });
  });

  describe('getChangesSince', () => {
    it('should return changes after specific revision', async () => {
      const mockChanges = [
        { id: 'change1', rev: 2 },
        { id: 'change2', rev: 3 },
      ] as Change[];
      vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

      const result = await server.getChangesSince('doc1', 1);

      expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', { startAfter: 1 });
      expect(result).toEqual(mockChanges);
    });
  });

  describe('commitChanges', () => {
    const mockChange = {
      id: 'change1',
      baseRev: 1,
      rev: 2,
      batchId: 'batch1',
      ops: [{ op: 'replace', path: '/content', value: 'new content' }],
      createdAt: Date.now(),
      committedAt: Date.now(),
    } as Change;

    beforeEach(() => {
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(1);
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
      vi.mocked(mockStore.saveChanges).mockResolvedValue();
    });

    it('should return empty array for empty changes', async () => {
      const result = await server.commitChanges('doc1', []);
      expect(result.changes).toEqual([]);
    });

    it('should fill in baseRev when missing (apply to latest)', async () => {
      // Create a change without baseRev and without batchId (to skip offline handling)
      const changeWithoutBaseRev = {
        id: 'change1',
        rev: 2,
        ops: [{ op: 'replace', path: '/content', value: 'new content' }],
        createdAt: Date.now(),
        // No baseRev - should be filled in
        // No batchId - skip offline handling
      } as any;
      const result = await server.commitChanges('doc1', [changeWithoutBaseRev]);
      // Should succeed, not throw - baseRev gets filled in with current revision
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].baseRev).toBe(1); // Current rev from mock
    });

    it('honors a configured maxChangesPerVersion (count-based versioning)', async () => {
      const countServer = new OTServer(mockStore, { maxChangesPerVersion: 10 });
      const recent = Date.now();
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(19);
      // Session/count check returns the current tip (recent → no session gap); the last
      // version is at rev 0, so 19 un-versioned changes cross the rev-20 boundary.
      vi.mocked(mockStore.listChanges).mockImplementation(async (_doc, opts: any) =>
        opts?.reverse && opts?.limit === 1 ? [{ ...mockChange, rev: 19, baseRev: 18, createdAt: recent }] : []
      );
      const change = {
        id: 'c1',
        rev: 20,
        baseRev: 19,
        ops: [{ op: 'add', path: '/x', value: 1 }],
        createdAt: recent,
      } as any;

      await countServer.commitChanges('doc1', [change]);

      expect(vi.mocked(createVersionAtRev)).toHaveBeenCalled();
    });

    it('does not count-version below the default threshold', async () => {
      // Default server (maxChangesPerVersion 1000): a rev 19→20 commit is nowhere near a
      // boundary, so no count-based version is created.
      const recent = Date.now();
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(19);
      vi.mocked(mockStore.listChanges).mockImplementation(async (_doc, opts: any) =>
        opts?.reverse && opts?.limit === 1 ? [{ ...mockChange, rev: 19, baseRev: 18, createdAt: recent }] : []
      );
      const change = {
        id: 'c1',
        rev: 20,
        baseRev: 19,
        ops: [{ op: 'add', path: '/x', value: 1 }],
        createdAt: recent,
      } as any;

      await server.commitChanges('doc1', [change]);

      expect(vi.mocked(createVersionAtRev)).not.toHaveBeenCalled();
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
      vi.mocked(handleOfflineSessionsAndBatches).mockResolvedValue();

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
      // Result is combined: catchup + new changes
      expect(result.changes).toHaveLength(1); // One transformed change, no catchup
    });

    it('should filter out already committed changes', async () => {
      const existingChange = { ...mockChange, id: 'existing' };
      vi.mocked(mockStore.listChanges).mockResolvedValue([existingChange]);

      const result = await server.commitChanges('doc1', [existingChange]);

      // Result contains catchup changes only (no new changes)
      expect(result.changes).toEqual([existingChange]);
      expect(mockStore.saveChanges).not.toHaveBeenCalled();
    });

    it('should handle offline sessions with batchId (fast-forward)', async () => {
      vi.mocked(handleOfflineSessionsAndBatches).mockResolvedValue();
      // No committed changes = fast-forward
      vi.mocked(mockStore.listChanges).mockResolvedValue([]);

      await server.commitChanges('doc1', [mockChange]);

      expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
        mockStore,
        expect.any(Number), // sessionTimeoutMillis
        'doc1',
        [mockChange],
        'main' // Fast-forward: origin is 'main'
      );
    });

    it('should handle offline sessions with batchId (divergent)', async () => {
      // A foreign committed change (different batch) = divergent
      const committedChange = { ...mockChange, id: 'committed', batchId: undefined } as Change;
      vi.mocked(handleOfflineSessionsAndBatches).mockResolvedValue();
      vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);

      await server.commitChanges('doc1', [mockChange]);

      expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
        mockStore,
        expect.any(Number), // sessionTimeoutMillis
        'doc1',
        [mockChange],
        'offline-branch' // Divergent: origin is 'offline-branch'
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

      // Result contains only catchup changes (no new transformed changes)
      expect(result.changes).toEqual([committedChange]);
      expect(mockStore.saveChanges).not.toHaveBeenCalled();
    });

    it('should handle transformation that produces valid changes with committed changes present', async () => {
      // Need committed changes to trigger transformation path (not fast-forward)
      const committedChange = { ...mockChange, id: 'committed' } as Change;
      vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);
      // Change without batchId to avoid offline handling
      const changeWithoutBatch = { ...mockChange, batchId: undefined } as Change;
      vi.mocked(transformPatch).mockReturnValue([{ op: 'replace', path: '/content', value: 'new content' }]);

      const result = await server.commitChanges('doc1', [changeWithoutBatch]);

      // Result contains catchup changes + transformed new changes
      expect(result.changes).toHaveLength(2);
      expect(result.changes[0]).toEqual(committedChange);
      expect(mockStore.saveChanges).toHaveBeenCalled();
    });

    it('should emit onChangesCommitted signal after successful commit', async () => {
      const emitSpy = vi.spyOn(server.onChangesCommitted, 'emit').mockResolvedValue();

      // Set auth context to provide clientId
      setAuthContext({ clientId: 'client1', metadata: {} });
      try {
        await server.commitChanges('doc1', [mockChange]);
        expect(emitSpy).toHaveBeenCalledWith('doc1', expect.any(Array), undefined, 'client1');
      } finally {
        clearAuthContext();
      }
    });

    it('should handle notification errors gracefully', async () => {
      const emitSpy = vi.spyOn(server.onChangesCommitted, 'emit').mockRejectedValue(new Error('Notification failed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await server.commitChanges('doc1', [mockChange]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to notify clients'), expect.any(Error));

      emitSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('change', () => {
    it('should create and commit server-side changes', async () => {
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(1);
      const mockPatch = new JSONPatch([{ op: 'replace', path: '/content', value: 'new' }]);

      vi.mocked(createJSONPatch).mockReturnValue(mockPatch);
      vi.mocked(createChange).mockReturnValue({
        id: 'change1',
        baseRev: 1,
        rev: 2,
        ops: mockPatch.ops,
        createdAt: Date.now(),
        committedAt: Date.now(),
      } as Change);

      const commitSpy = vi.spyOn(server, 'commitChanges').mockResolvedValue({ changes: [] });

      const result = await server.change(
        'doc1',
        (patch, path) => {
          patch.replace(path.content, 'new');
        },
        { author: 'server' }
      );

      expect(mockStore.getCurrentRev).toHaveBeenCalledWith('doc1');
      expect(createJSONPatch).toHaveBeenCalledWith(expect.any(Function));
      expect(commitSpy).toHaveBeenCalledWith('doc1', [expect.any(Object)]);
      expect(result).toBeDefined();

      commitSpy.mockRestore();
    });

    it('should return null for no-op changes', async () => {
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(1);
      const mockPatch = new JSONPatch([]);

      vi.mocked(createJSONPatch).mockReturnValue(mockPatch);

      const result = await server.change('doc1', () => {
        // No changes
      });

      expect(result).toBeNull();
    });
  });

  describe('deleteDoc', () => {
    it('should delete document and emit signal', async () => {
      const emitSpy = vi.spyOn(server.onDocDeleted, 'emit').mockResolvedValue();

      // Set auth context to provide clientId
      setAuthContext({ clientId: 'client1', metadata: {} });
      try {
        await server.deleteDoc('doc1');
        expect(mockStore.deleteDoc).toHaveBeenCalledWith('doc1');
        expect(emitSpy).toHaveBeenCalledWith('doc1', undefined, 'client1');
      } finally {
        clearAuthContext();
      }
    });
  });

  describe('captureCurrentVersion', () => {
    const mockVersion = {
      id: 'version1',
      origin: 'main' as const,
      startedAt: Date.now(),
      endedAt: Date.now(),
      startRev: 1,
      endRev: 5,
    };

    const latestMainVersion = {
      id: 'parent-v',
      origin: 'main' as const,
      startedAt: Date.now(),
      endedAt: Date.now(),
      startRev: 1,
      endRev: 4,
    };

    it('should chain the version to the latest main version and read only the changes since it', async () => {
      const changes = [{ id: 'change1', rev: 5, baseRev: 4 } as Change];
      vi.mocked(findLatestMainVersion).mockResolvedValue(latestMainVersion);
      vi.mocked(mockStore.listChanges).mockResolvedValue(changes);
      vi.mocked(createVersionAlgorithm).mockResolvedValue(mockVersion);

      const result = await server.captureCurrentVersion('doc1', { name: 'v1.0' });

      expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', { startAfter: 4 });
      expect(createVersionAlgorithm).toHaveBeenCalledWith(expect.any(Object), 'doc1', changes, {
        metadata: { name: 'v1.0' },
        parentId: 'parent-v',
      });
      expect(result).toBe('version1');
    });

    it('should create a first version with no parent on a doc that has none', async () => {
      const changes = [{ id: 'change1', rev: 1, baseRev: 0 } as Change];
      vi.mocked(findLatestMainVersion).mockResolvedValue(undefined);
      vi.mocked(mockStore.listChanges).mockResolvedValue(changes);
      vi.mocked(createVersionAlgorithm).mockResolvedValue(mockVersion);

      const result = await server.captureCurrentVersion('doc1');

      expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', { startAfter: 0 });
      expect(createVersionAlgorithm).toHaveBeenCalledWith(expect.any(Object), 'doc1', changes, {
        metadata: undefined,
        parentId: undefined,
      });
      expect(result).toBe('version1');
    });

    it('should return null when no changes to create version', async () => {
      vi.mocked(findLatestMainVersion).mockResolvedValue(latestMainVersion);
      vi.mocked(mockStore.listChanges).mockResolvedValue([]);
      vi.mocked(createVersionAlgorithm).mockResolvedValue(undefined);

      const result = await server.captureCurrentVersion('doc1');
      expect(result).toBeNull();
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
    // Mirrors the Disallowed list in EditableVersionMetadata — startRev/endRev (not the
    // Change fields rev/baseRev) are the protected version range fields.
    const invalidFields = ['id', 'parentId', 'groupId', 'origin', 'startedAt', 'endedAt', 'startRev', 'endRev'];

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
