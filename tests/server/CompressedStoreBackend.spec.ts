import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompressedStoreBackend } from '../../src/server/CompressedStoreBackend';
import { base64Compressor, uint8Compressor } from '../../src/compression';
import type { OTStoreBackend, TombstoneStoreBackend } from '../../src/server/types';
import type { Change, VersionMetadata } from '../../src/types';

// CompressedStoreBackend accepts OTStoreBackend with optional TombstoneStoreBackend methods
type CompressibleStore = OTStoreBackend & Partial<TombstoneStoreBackend>;

describe('CompressedStoreBackend', () => {
  let mockStore: CompressibleStore;
  let savedChanges: any[];
  let savedVersionChanges: { changes: any[]; state: any }[];

  const createChange = (id: string, rev: number, ops: any[]): Change => ({
    id,
    rev,
    baseRev: rev - 1,
    ops,
    createdAt: 0,
    committedAt: 0,
  });

  beforeEach(() => {
    savedChanges = [];
    savedVersionChanges = [];

    mockStore = {
      saveChanges: vi.fn().mockImplementation(async (_docId, changes) => {
        savedChanges.push(...changes);
      }),
      listChanges: vi.fn().mockImplementation(async () => savedChanges),
      createVersion: vi.fn().mockImplementation(async (_docId, _metadata, state, changes) => {
        savedVersionChanges.push({ changes, state });
      }),
      appendVersionChanges: vi.fn().mockImplementation(async (_docId, _versionId, changes, _endedAt, _rev, state) => {
        savedVersionChanges.push({ changes, state });
      }),
      loadVersionChanges: vi.fn().mockImplementation(async () => {
        return savedVersionChanges.length > 0 ? savedVersionChanges[0].changes : [];
      }),
      updateVersion: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
      loadVersionState: vi.fn().mockResolvedValue(undefined),
      deleteDoc: vi.fn(),
      createTombstone: vi.fn(),
      getTombstone: vi.fn(),
      removeTombstone: vi.fn(),
    };
  });

  describe('saveChanges', () => {
    it('should compress ops before saving with base64 compressor', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const changes = [createChange('c1', 1, [{ op: 'add', path: '/test', value: 'hello' }])];

      await backend.saveChanges('doc1', changes);

      expect(mockStore.saveChanges).toHaveBeenCalledWith('doc1', expect.any(Array));
      expect(savedChanges).toHaveLength(1);
      expect(base64Compressor.isCompressed(savedChanges[0].ops)).toBe(true);
      expect(typeof savedChanges[0].ops).toBe('string');
    });

    it('should compress ops before saving with uint8 compressor', async () => {
      const backend = new CompressedStoreBackend(mockStore, uint8Compressor);
      const changes = [createChange('c1', 1, [{ op: 'add', path: '/test', value: 'hello' }])];

      await backend.saveChanges('doc1', changes);

      expect(savedChanges).toHaveLength(1);
      expect(savedChanges[0].ops).toBeInstanceOf(Uint8Array);
    });

    it('should preserve other change properties when compressing', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const changes = [
        {
          ...createChange('c1', 5, [{ op: 'replace', path: '/x', value: 1 }]),
          customField: 'preserved',
          batchId: 'batch123',
        },
      ];

      await backend.saveChanges('doc1', changes as Change[]);

      expect(savedChanges[0].id).toBe('c1');
      expect(savedChanges[0].rev).toBe(5);
      expect(savedChanges[0].baseRev).toBe(4);
      expect(savedChanges[0].customField).toBe('preserved');
      expect(savedChanges[0].batchId).toBe('batch123');
    });

    it('should handle multiple changes', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const changes = [
        createChange('c1', 1, [{ op: 'add', path: '/a', value: 1 }]),
        createChange('c2', 2, [{ op: 'add', path: '/b', value: 2 }]),
        createChange('c3', 3, [{ op: 'add', path: '/c', value: 3 }]),
      ];

      await backend.saveChanges('doc1', changes);

      expect(savedChanges).toHaveLength(3);
      savedChanges.forEach(change => {
        expect(base64Compressor.isCompressed(change.ops)).toBe(true);
      });
    });
  });

  describe('listChanges', () => {
    it('should decompress ops when loading with base64 compressor', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const originalOps = [{ op: 'add', path: '/test', value: 'hello' }];

      // Simulate stored compressed changes
      savedChanges.push({
        ...createChange('c1', 1, []),
        ops: base64Compressor.compress(originalOps),
      });

      const result = await backend.listChanges('doc1', {});

      expect(result).toHaveLength(1);
      expect(result[0].ops).toEqual(originalOps);
      expect(Array.isArray(result[0].ops)).toBe(true);
    });

    it('should decompress ops when loading with uint8 compressor', async () => {
      const backend = new CompressedStoreBackend(mockStore, uint8Compressor);
      const originalOps = [{ op: 'replace', path: '/x', value: 42 }];

      savedChanges.push({
        ...createChange('c1', 1, []),
        ops: uint8Compressor.compress(originalOps),
      });

      const result = await backend.listChanges('doc1', {});

      expect(result[0].ops).toEqual(originalOps);
    });

    it('should handle already decompressed ops (backwards compatibility)', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const originalOps = [{ op: 'add', path: '/test', value: 'uncompressed' }];

      // Store uncompressed ops directly (simulating old data)
      savedChanges.push({
        ...createChange('c1', 1, []),
        ops: originalOps,
      });

      const result = await backend.listChanges('doc1', {});

      expect(result[0].ops).toEqual(originalOps);
    });

    it('should pass options through to underlying store', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const options = { startAfter: 5, withoutBatchId: 'batch1' };

      await backend.listChanges('doc1', options);

      expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', options);
    });
  });

  describe('createVersion', () => {
    it('should compress changes when creating version', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const changes = [createChange('c1', 1, [{ op: 'add', path: '/test', value: 'data' }])];
      const metadata: VersionMetadata = {
        id: 'v1',
        endRev: 1,
        startRev: 1,
        origin: 'main' as const,
        startedAt: 0,
        endedAt: 3600000,
      };

      await backend.createVersion('doc1', metadata, { state: 'data' }, changes);

      expect(mockStore.createVersion).toHaveBeenCalled();
      const savedVersionChange = savedVersionChanges[0];
      expect(base64Compressor.isCompressed(savedVersionChange.changes[0].ops)).toBe(true);
    });

    it('should preserve state uncompressed', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const state = { text: 'hello', count: 42 };
      const metadata: VersionMetadata = {
        id: 'v1',
        endRev: 1,
        startRev: 1,
        origin: 'main' as const,
        startedAt: 0,
        endedAt: 3600000,
      };

      await backend.createVersion('doc1', metadata, state, []);

      expect(savedVersionChanges[0].state).toEqual(state);
    });
  });

  describe('appendVersionChanges', () => {
    it('should compress changes when appending to version', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const changes = [createChange('c2', 2, [{ op: 'replace', path: '/test', value: 'updated' }])];

      await backend.appendVersionChanges('doc1', 'v1', changes, 7200000, 2, { updated: true });

      expect(mockStore.appendVersionChanges).toHaveBeenCalled();
      const appendedChanges = savedVersionChanges[0].changes;
      expect(base64Compressor.isCompressed(appendedChanges[0].ops)).toBe(true);
    });
  });

  describe('loadVersionChanges', () => {
    it('should decompress changes when loading version', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const originalOps = [{ op: 'add', path: '/v', value: 'version-data' }];

      savedVersionChanges.push({
        changes: [
          {
            ...createChange('c1', 1, []),
            ops: base64Compressor.compress(originalOps),
          },
        ],
        state: {},
      });

      const result = await backend.loadVersionChanges('doc1', 'v1');

      expect(result[0].ops).toEqual(originalOps);
    });
  });

  describe('pass-through operations', () => {
    it('should delegate updateVersion without modification', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const metadata = { name: 'Updated Version' };

      await backend.updateVersion('doc1', 'v1', metadata);

      expect(mockStore.updateVersion).toHaveBeenCalledWith('doc1', 'v1', metadata);
    });

    it('should delegate listVersions without modification', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const options = { limit: 10 };

      await backend.listVersions('doc1', options);

      expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', options);
    });

    it('should delegate loadVersionState without modification', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const expectedState = { data: 'test' };
      vi.mocked(mockStore.loadVersionState).mockResolvedValue(expectedState);

      const result = await backend.loadVersionState('doc1', 'v1');

      expect(mockStore.loadVersionState).toHaveBeenCalledWith('doc1', 'v1');
      expect(result).toEqual(expectedState);
    });

    it('should delegate deleteDoc without modification', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);

      await backend.deleteDoc('doc1');

      expect(mockStore.deleteDoc).toHaveBeenCalledWith('doc1');
    });
  });

  describe('roundtrip integration', () => {
    it('should correctly roundtrip changes through save and load', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const originalChanges = [
        createChange('c1', 1, [
          { op: 'add', path: '/title', value: 'Test Document' },
          { op: 'add', path: '/items', value: [1, 2, 3] },
        ]),
        createChange('c2', 2, [{ op: 'replace', path: '/title', value: 'Updated Title' }]),
      ];

      await backend.saveChanges('doc1', originalChanges);
      const loaded = await backend.listChanges('doc1', {});

      expect(loaded).toHaveLength(2);
      expect(loaded[0].ops).toEqual(originalChanges[0].ops);
      expect(loaded[1].ops).toEqual(originalChanges[1].ops);
    });

    it('should correctly roundtrip complex nested operations', async () => {
      const backend = new CompressedStoreBackend(mockStore, base64Compressor);
      const complexOps = [
        {
          op: 'add',
          path: '/nested',
          value: {
            level1: {
              level2: {
                array: [{ deep: 'value' }, { another: 'object' }],
                date: '2024-01-01',
              },
            },
          },
        },
      ];
      const changes = [createChange('c1', 1, complexOps)];

      await backend.saveChanges('doc1', changes);
      const loaded = await backend.listChanges('doc1', {});

      expect(loaded[0].ops).toEqual(complexOps);
    });
  });
});
