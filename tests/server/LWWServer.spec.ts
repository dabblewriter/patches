import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthContext, setAuthContext } from '../../src/net/serverContext';
import { LWWServer } from '../../src/server/LWWServer';
import type { FieldMeta, LWWStoreBackend, LWWVersioningStoreBackend, ListFieldsOptions } from '../../src/server/types';
import type { ChangeInput, EditableVersionMetadata } from '../../src/types';

/**
 * Creates a mock LWWStoreBackend for testing.
 * Uses in-memory storage for snapshots, fields, and revisions.
 */
function createMockStore(): LWWStoreBackend & {
  snapshots: Map<string, { state: any; rev: number }>;
  fields: Map<string, FieldMeta>;
  revs: Map<string, number>;
} {
  const snapshots = new Map<string, { state: any; rev: number }>();
  const fields = new Map<string, FieldMeta>(); // key = `${docId}:${path}`
  const revs = new Map<string, number>();

  return {
    snapshots,
    fields,
    revs,

    getSnapshot: vi.fn(async (docId: string) => {
      return snapshots.get(docId) || null;
    }),

    saveSnapshot: vi.fn(async (docId: string, state: any, rev: number) => {
      snapshots.set(docId, { state, rev });
    }),

    listFields: vi.fn(async (docId: string, options?: ListFieldsOptions) => {
      const result: FieldMeta[] = [];

      if (!options) {
        // Return all fields for this doc
        for (const [key, field] of fields.entries()) {
          if (key.startsWith(`${docId}:`)) {
            result.push(field);
          }
        }
        return result;
      }

      if ('sinceRev' in options) {
        // Return fields changed since rev
        for (const [key, field] of fields.entries()) {
          if (key.startsWith(`${docId}:`) && field.rev > options.sinceRev) {
            result.push(field);
          }
        }
        return result;
      }

      if ('paths' in options) {
        // Return fields at specific paths
        for (const path of options.paths) {
          const key = `${docId}:${path}`;
          const field = fields.get(key);
          if (field) {
            result.push(field);
          }
        }
        return result;
      }

      return result;
    }),

    saveFields: vi.fn(async (docId: string, newFields: FieldMeta[]) => {
      // Atomically increment revision
      const current = revs.get(docId) || 0;
      const newRev = current + 1;
      revs.set(docId, newRev);

      for (const field of newFields) {
        const key = `${docId}:${field.path}`;

        // Delete children (simulate atomic child deletion)
        for (const [existingKey] of fields.entries()) {
          if (existingKey.startsWith(`${key}/`)) {
            fields.delete(existingKey);
          }
        }

        // Set the rev on the field
        field.rev = newRev;
        fields.set(key, field);
      }

      return newRev;
    }),

    deleteDoc: vi.fn(async (docId: string) => {
      snapshots.delete(docId);
      revs.delete(docId);
      for (const key of [...fields.keys()]) {
        if (key.startsWith(`${docId}:`)) {
          fields.delete(key);
        }
      }
    }),
  };
}

describe('LWWServer', () => {
  let server: LWWServer;
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    mockStore = createMockStore();
    server = new LWWServer(mockStore);
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create server with default options', () => {
      const server = new LWWServer(mockStore);
      expect(server).toBeDefined();
      expect(server.store).toBe(mockStore);
    });

    it('should create server with custom snapshotInterval', () => {
      const server = new LWWServer(mockStore, { snapshotInterval: 100 });
      expect(server).toBeDefined();
    });

    it('should have onChangesCommitted signal', () => {
      expect(typeof server.onChangesCommitted).toBe('function');
    });

    it('should have onDocDeleted signal', () => {
      expect(typeof server.onDocDeleted).toBe('function');
    });

    it('should have static api definition', () => {
      expect(LWWServer.api).toEqual({
        getDoc: 'read',
        getChangesSince: 'read',
        commitChanges: 'write',
        deleteDoc: 'write',
        undeleteDoc: 'write',
      });
    });
  });

  describe('getDoc', () => {
    it('should return empty state for non-existent document', async () => {
      const result = await server.getDoc('nonexistent');
      expect(result).toEqual({ state: {}, rev: 0 });
    });

    it('should return state from snapshot when no fields', async () => {
      mockStore.snapshots.set('doc1', { state: { name: 'Alice' }, rev: 5 });

      const result = await server.getDoc('doc1');

      expect(result).toEqual({ state: { name: 'Alice' }, rev: 5 });
    });

    it('should reconstruct state from snapshot + fields', async () => {
      mockStore.snapshots.set('doc1', { state: { name: 'Alice' }, rev: 5 });
      mockStore.fields.set('doc1:/age', { path: '/age', ts: 1000, rev: 6, value: 30 });

      const result = await server.getDoc('doc1');

      expect(result.state).toEqual({ name: 'Alice', age: 30 });
      expect(result.rev).toBe(6);
    });
  });

  describe('getChangesSince', () => {
    it('should return empty array when no fields since rev', async () => {
      const result = await server.getChangesSince('doc1', 5);
      expect(result).toEqual([]);
    });

    it('should synthesize change from fields since rev', async () => {
      mockStore.fields.set('doc1:/name', { path: '/name', ts: 1000, rev: 2, value: 'Alice' });
      mockStore.fields.set('doc1:/age', { path: '/age', ts: 1500, rev: 3, value: 30 });

      const result = await server.getChangesSince('doc1', 1);

      expect(result).toHaveLength(1);
      expect(result[0].ops).toHaveLength(2);
      expect(result[0].rev).toBe(3);
    });

    it('should sort ops by timestamp', async () => {
      mockStore.fields.set('doc1:/name', { path: '/name', ts: 2000, rev: 2, value: 'Alice' });
      mockStore.fields.set('doc1:/age', { path: '/age', ts: 1000, rev: 3, value: 30 });

      const result = await server.getChangesSince('doc1', 0);

      // Age should come first (lower ts)
      expect(result[0].ops[0].path).toBe('/age');
      expect(result[0].ops[1].path).toBe('/name');
    });
  });

  describe('commitChanges - LWW conflict resolution', () => {
    it('should return empty array for empty changes', async () => {
      const result = await server.commitChanges('doc1', []);
      expect(result).toEqual([]);
    });

    it('should apply first write when no existing field', async () => {
      const change: ChangeInput = {
        id: 'change1',
        ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result).toHaveLength(1);
      expect(result[0].rev).toBe(1);
      expect(mockStore.fields.get('doc1:/name')?.value).toBe('Alice');
    });

    it('should apply write with higher timestamp', async () => {
      mockStore.fields.set('doc1:/name', { path: '/name', ts: 1000, rev: 1, value: 'Alice' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'change2',
        ops: [{ op: 'replace', path: '/name', value: 'Bob', ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result).toHaveLength(1);
      expect(mockStore.fields.get('doc1:/name')?.value).toBe('Bob');
    });

    it('should reject write with lower timestamp', async () => {
      mockStore.fields.set('doc1:/name', { path: '/name', ts: 2000, rev: 1, value: 'Bob' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'change3',
        ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result).toHaveLength(1);
      // Rev should not change since no updates were made
      expect(result[0].rev).toBe(1);
      // State should remain unchanged
      expect(mockStore.fields.get('doc1:/name')?.value).toBe('Bob');
    });

    it('should apply write with equal timestamp (incoming wins on tie)', async () => {
      mockStore.fields.set('doc1:/name', { path: '/name', ts: 1000, rev: 1, value: 'Alice' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'change4',
        ops: [{ op: 'replace', path: '/name', value: 'Bob', ts: 1000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result).toHaveLength(1);
      expect(mockStore.fields.get('doc1:/name')?.value).toBe('Bob');
    });

    it('should use serverNow when op has no ts', async () => {
      const now = Date.now();
      const change: ChangeInput = {
        id: 'change5',
        ops: [{ op: 'replace', path: '/name', value: 'Alice' }], // No ts on op
      };

      await server.commitChanges('doc1', [change]);

      const field = mockStore.fields.get('doc1:/name');
      expect(field?.ts).toBeGreaterThanOrEqual(now);
    });
  });

  describe('commitChanges - special operations', () => {
    describe('@inc operations', () => {
      it('should always apply @inc regardless of timestamp', async () => {
        mockStore.fields.set('doc1:/count', { path: '/count', ts: 2000, rev: 1, value: 10 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'inc1',
          ops: [{ op: '@inc', path: '/count', value: 5, ts: 1000 }], // Lower timestamp
        };

        const result = await server.commitChanges('doc1', [change]);

        expect(result).toHaveLength(1);
        expect(mockStore.fields.get('doc1:/count')?.value).toBe(15);
      });

      it('should initialize to value if field does not exist', async () => {
        const change: ChangeInput = {
          id: 'inc2',
          ops: [{ op: '@inc', path: '/count', value: 5 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.fields.get('doc1:/count')?.value).toBe(5);
      });
    });

    describe('@bit operations', () => {
      it('should always apply @bit regardless of timestamp', async () => {
        mockStore.fields.set('doc1:/flags', { path: '/flags', ts: 2000, rev: 1, value: 0b0001 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'bit1',
          ops: [{ op: '@bit', path: '/flags', value: 0b0010, ts: 1000 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.fields.get('doc1:/flags')?.value).toBe(0b0011);
      });
    });

    describe('@max operations', () => {
      it('should update if value is greater', async () => {
        mockStore.fields.set('doc1:/lastSeen', { path: '/lastSeen', ts: 1000, rev: 1, value: 100 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'max1',
          ops: [{ op: '@max', path: '/lastSeen', value: 200 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.fields.get('doc1:/lastSeen')?.value).toBe(200);
      });

      it('should not update if value is smaller', async () => {
        mockStore.fields.set('doc1:/lastSeen', { path: '/lastSeen', ts: 1000, rev: 1, value: 200 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'max2',
          ops: [{ op: '@max', path: '/lastSeen', value: 100 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.fields.get('doc1:/lastSeen')?.value).toBe(200);
      });
    });

    describe('@min operations', () => {
      it('should update if value is smaller', async () => {
        mockStore.fields.set('doc1:/minPrice', { path: '/minPrice', ts: 1000, rev: 1, value: 100 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'min1',
          ops: [{ op: '@min', path: '/minPrice', value: 50 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.fields.get('doc1:/minPrice')?.value).toBe(50);
      });
    });
  });

  describe('commitChanges - remove operations', () => {
    it('should store field with undefined value for remove', async () => {
      mockStore.fields.set('doc1:/name', { path: '/name', ts: 1000, rev: 1, value: 'Alice' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'remove1',
        ops: [{ op: 'remove', path: '/name', ts: 2000 }],
      };

      await server.commitChanges('doc1', [change]);

      expect(mockStore.fields.get('doc1:/name')?.value).toBeUndefined();
    });
  });

  describe('commitChanges - hierarchy handling', () => {
    it('should delete children when setting parent', async () => {
      mockStore.fields.set('doc1:/obj/name', { path: '/obj/name', ts: 1000, rev: 1, value: 'Alice' });
      mockStore.fields.set('doc1:/obj/age', { path: '/obj/age', ts: 1000, rev: 1, value: 30 });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'parent1',
        ops: [{ op: 'replace', path: '/obj', value: { newProp: true }, ts: 2000 }],
      };

      await server.commitChanges('doc1', [change]);

      // Children should be deleted
      expect(mockStore.fields.has('doc1:/obj/name')).toBe(false);
      expect(mockStore.fields.has('doc1:/obj/age')).toBe(false);
      // Parent should have new value
      expect(mockStore.fields.get('doc1:/obj')?.value).toEqual({ newProp: true });
    });

    it('should self-heal when setting child on primitive parent', async () => {
      mockStore.fields.set('doc1:/obj', { path: '/obj', ts: 1000, rev: 1, value: 'primitive' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'child1',
        rev: 0, // Request catchup
        ops: [{ op: 'replace', path: '/obj/name', value: 'Alice', ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      // Op should be skipped, but parent should be in response for correction
      expect(result[0].ops).toContainEqual(expect.objectContaining({ path: '/obj', value: 'primitive' }));
    });
  });

  describe('commitChanges - catchup', () => {
    it('should include fields since client rev in response', async () => {
      mockStore.fields.set('doc1:/name', { path: '/name', ts: 1000, rev: 2, value: 'Alice' });
      mockStore.fields.set('doc1:/age', { path: '/age', ts: 1500, rev: 3, value: 30 });
      mockStore.revs.set('doc1', 3);

      const change: ChangeInput = {
        id: 'catchup1',
        rev: 1, // Client has rev 1, wants catchup
        ops: [{ op: 'replace', path: '/status', value: 'online', ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      // Response should include /name and /age as catchup ops
      expect(result[0].ops).toContainEqual(expect.objectContaining({ path: '/name' }));
      expect(result[0].ops).toContainEqual(expect.objectContaining({ path: '/age' }));
    });

    it('should filter out paths client just sent', async () => {
      mockStore.fields.set('doc1:/name', { path: '/name', ts: 1000, rev: 2, value: 'Alice' });
      mockStore.revs.set('doc1', 2);

      const change: ChangeInput = {
        id: 'catchup2',
        rev: 1,
        ops: [{ op: 'replace', path: '/name', value: 'Bob', ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      // /name should not be in response since client just sent it
      expect(result[0].ops).not.toContainEqual(expect.objectContaining({ path: '/name' }));
    });

    it('should filter out children of paths client sent', async () => {
      mockStore.fields.set('doc1:/obj/child', { path: '/obj/child', ts: 1000, rev: 2, value: 'x' });
      mockStore.revs.set('doc1', 2);

      const change: ChangeInput = {
        id: 'catchup3',
        rev: 1,
        ops: [{ op: 'replace', path: '/obj', value: { new: true }, ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      // /obj/child should not be in response since client sent parent
      expect(result[0].ops).not.toContainEqual(expect.objectContaining({ path: '/obj/child' }));
    });
  });

  describe('commitChanges - signals', () => {
    it('should emit onChangesCommitted signal', async () => {
      const emitSpy = vi.spyOn(server.onChangesCommitted, 'emit').mockResolvedValue();

      setAuthContext({ clientId: 'client1', metadata: {} });
      try {
        const change: ChangeInput = {
          id: 'signal1',
          ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(emitSpy).toHaveBeenCalledWith('doc1', expect.any(Array), 'client1');
      } finally {
        clearAuthContext();
      }
    });

    it('should handle notification errors gracefully', async () => {
      const emitSpy = vi.spyOn(server.onChangesCommitted, 'emit').mockRejectedValue(new Error('Emit failed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const change: ChangeInput = {
        id: 'signal2',
        ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
      };

      // Should not throw
      await server.commitChanges('doc1', [change]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to notify'), expect.any(Error));

      emitSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('should not emit when no changes are committed', async () => {
      const emitSpy = vi.spyOn(server.onChangesCommitted, 'emit');

      await server.commitChanges('doc1', []);

      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  describe('deleteDoc', () => {
    it('should delete document and emit signal', async () => {
      const emitSpy = vi.spyOn(server.onDocDeleted, 'emit').mockResolvedValue();
      mockStore.snapshots.set('doc1', { state: { name: 'Alice' }, rev: 1 });

      setAuthContext({ clientId: 'client1', metadata: {} });
      try {
        await server.deleteDoc('doc1');

        expect(mockStore.deleteDoc).toHaveBeenCalledWith('doc1');
        expect(emitSpy).toHaveBeenCalledWith('doc1', undefined, 'client1');
      } finally {
        clearAuthContext();
      }
    });

    it('should pass options through to signal', async () => {
      const emitSpy = vi.spyOn(server.onDocDeleted, 'emit').mockResolvedValue();

      await server.deleteDoc('doc1', { skipTombstone: true });

      expect(emitSpy).toHaveBeenCalledWith('doc1', { skipTombstone: true }, undefined);
    });

    it('should create tombstone if store supports it', async () => {
      const createTombstone = vi.fn();
      const getTombstone = vi.fn();
      const removeTombstone = vi.fn();

      // Set up a document with rev 5
      mockStore.snapshots.set('doc1', { state: { name: 'Alice' }, rev: 5 });

      const storeWithTombstone = {
        ...mockStore,
        createTombstone,
        getTombstone,
        removeTombstone,
      };
      const serverWithTombstone = new LWWServer(storeWithTombstone);

      setAuthContext({ clientId: 'client1', metadata: {} });
      try {
        await serverWithTombstone.deleteDoc('doc1');

        expect(createTombstone).toHaveBeenCalledWith({
          docId: 'doc1',
          deletedAt: expect.any(Number),
          lastRev: 5,
          deletedByClientId: 'client1',
        });
      } finally {
        clearAuthContext();
      }
    });
  });

  describe('undeleteDoc', () => {
    it('should return false if store does not support tombstones', async () => {
      const result = await server.undeleteDoc('doc1');
      expect(result).toBe(false);
    });

    it('should remove tombstone and return true', async () => {
      const storeWithTombstone = {
        ...mockStore,
        createTombstone: vi.fn(),
        getTombstone: vi.fn(async () => ({ docId: 'doc1', deletedAt: 1000 })),
        removeTombstone: vi.fn(),
      };
      const serverWithTombstone = new LWWServer(storeWithTombstone);

      const result = await serverWithTombstone.undeleteDoc('doc1');

      expect(result).toBe(true);
      expect(storeWithTombstone.removeTombstone).toHaveBeenCalledWith('doc1');
    });
  });

  describe('captureCurrentVersion', () => {
    it('should throw error when store does not support versioning', async () => {
      await expect(server.captureCurrentVersion('doc1')).rejects.toThrow(
        'LWW versioning requires a store that implements LWWVersioningStoreBackend'
      );
    });

    describe('with versioning store', () => {
      let versioningStore: LWWVersioningStoreBackend;
      let versioningServer: LWWServer;

      beforeEach(() => {
        versioningStore = {
          ...mockStore,
          createVersion: vi.fn(),
        };
        versioningServer = new LWWServer(versioningStore);
      });

      it('should return null for non-existent document', async () => {
        const result = await versioningServer.captureCurrentVersion('nonexistent');
        expect(result).toBeNull();
      });

      it('should create version with state', async () => {
        mockStore.snapshots.set('doc1', { state: { name: 'Alice' }, rev: 2 });

        const versionId = await versioningServer.captureCurrentVersion('doc1');

        expect(versionId).toBeDefined();
        expect(versioningStore.createVersion).toHaveBeenCalledWith('doc1', versionId, { name: 'Alice' }, 2, undefined);
      });

      it('should accept optional metadata', async () => {
        mockStore.snapshots.set('doc1', { state: { name: 'Alice' }, rev: 1 });

        const metadata: EditableVersionMetadata = { name: 'My Version' };
        await versioningServer.captureCurrentVersion('doc1', metadata);

        expect(versioningStore.createVersion).toHaveBeenCalledWith(
          'doc1',
          expect.any(String),
          expect.any(Object),
          expect.any(Number),
          metadata
        );
      });
    });
  });

  describe('concurrent edits scenario', () => {
    it('should resolve concurrent edits with timestamps', async () => {
      // Client A's change arrives first
      const changeA: ChangeInput = {
        id: 'concurrent-A',
        ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
      };

      await server.commitChanges('doc1', [changeA]);
      expect(mockStore.fields.get('doc1:/name')?.value).toBe('Alice');

      // Client B's change arrives second but has higher timestamp
      const changeB: ChangeInput = {
        id: 'concurrent-B',
        ops: [{ op: 'replace', path: '/name', value: 'Bob', ts: 1500 }],
      };

      await server.commitChanges('doc1', [changeB]);
      expect(mockStore.fields.get('doc1:/name')?.value).toBe('Bob');
    });

    it('should handle concurrent edits to different fields', async () => {
      const changeA: ChangeInput = {
        id: 'diff-A',
        ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
      };

      const changeB: ChangeInput = {
        id: 'diff-B',
        ops: [{ op: 'replace', path: '/age', value: 30, ts: 1500 }],
      };

      await server.commitChanges('doc1', [changeA]);
      await server.commitChanges('doc1', [changeB]);

      expect(mockStore.fields.get('doc1:/name')?.value).toBe('Alice');
      expect(mockStore.fields.get('doc1:/age')?.value).toBe(30);
    });
  });

  describe('compaction', () => {
    it('should save snapshot every N revisions', async () => {
      const serverWith10 = new LWWServer(mockStore, { snapshotInterval: 10 });

      // Make 10 commits
      for (let i = 1; i <= 10; i++) {
        await serverWith10.commitChanges('doc1', [
          {
            id: `change${i}`,
            ops: [{ op: 'replace', path: `/field${i}`, value: i, ts: i * 1000 }],
          },
        ]);
      }

      // Should have saved snapshot at rev 10
      expect(mockStore.saveSnapshot).toHaveBeenCalledWith('doc1', expect.any(Object), 10);
    });
  });
});
