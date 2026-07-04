import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONPatchOp } from '../../src/json-patch/types';
import { clearAuthContext, setAuthContext } from '../../src/net/serverContext';
import { jsonReadable, readStreamAsString } from '../../src/server/jsonReadable';
import { LWWMemoryStoreBackend } from '../../src/server/LWWMemoryStoreBackend';
import { LWWServer } from '../../src/server/LWWServer';
import type { LWWStoreBackend, ListFieldsOptions, VersioningStoreBackend } from '../../src/server/types';
import type { ChangeInput, EditableVersionMetadata } from '../../src/types';

/**
 * Creates a mock LWWStoreBackend for testing.
 * Uses in-memory storage for snapshots, ops, and revisions.
 */
function createMockStore(): LWWStoreBackend & {
  snapshots: Map<string, { state: any; rev: number }>;
  ops: Map<string, JSONPatchOp>;
  revs: Map<string, number>;
} {
  const snapshots = new Map<string, { state: any; rev: number }>();
  const ops = new Map<string, JSONPatchOp>(); // key = `${docId}:${path}`
  const revs = new Map<string, number>();

  return {
    snapshots,
    ops,
    revs,

    getCurrentRev: vi.fn(async (docId: string) => {
      return revs.get(docId) || 0;
    }),

    getSnapshot: vi.fn(async (docId: string) => {
      const snapshot = snapshots.get(docId);
      if (!snapshot) return null;
      return { rev: snapshot.rev, state: jsonReadable(JSON.stringify(snapshot.state)) };
    }),

    saveSnapshot: vi.fn(async (docId: string, state: any, rev: number) => {
      snapshots.set(docId, { state, rev });
    }),

    listOps: vi.fn(async (docId: string, options?: ListFieldsOptions) => {
      const result: JSONPatchOp[] = [];

      if (!options) {
        // Return all ops for this doc
        for (const [key, op] of ops.entries()) {
          if (key.startsWith(`${docId}:`)) {
            result.push(op);
          }
        }
        return result;
      }

      if ('sinceRev' in options) {
        // Return ops changed since rev
        for (const [key, op] of ops.entries()) {
          if (key.startsWith(`${docId}:`) && (op.rev ?? 0) > options.sinceRev) {
            result.push(op);
          }
        }
        return result;
      }

      if ('paths' in options) {
        // Return ops at specific paths
        for (const path of options.paths) {
          const key = `${docId}:${path}`;
          const op = ops.get(key);
          if (op) {
            result.push(op);
          }
        }
        return result;
      }

      return result;
    }),

    saveOps: vi.fn(async (docId: string, newOps: JSONPatchOp[], pathsToDelete?: string[]) => {
      // Atomically increment revision
      const current = revs.get(docId) || 0;
      const newRev = current + 1;
      revs.set(docId, newRev);

      // Delete specified paths
      if (pathsToDelete) {
        for (const path of pathsToDelete) {
          ops.delete(`${docId}:${path}`);
        }
      }

      for (const op of newOps) {
        const key = `${docId}:${op.path}`;

        // Delete children (simulate atomic child deletion)
        for (const [existingKey] of ops.entries()) {
          if (existingKey.startsWith(`${key}/`)) {
            ops.delete(existingKey);
          }
        }

        // Set the rev on the op
        op.rev = newRev;
        ops.set(key, op);
      }

      return newRev;
    }),

    deleteDoc: vi.fn(async (docId: string) => {
      snapshots.delete(docId);
      revs.delete(docId);
      for (const key of [...ops.keys()]) {
        if (key.startsWith(`${docId}:`)) {
          ops.delete(key);
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

    it('should create server with custom changeIdTTL', () => {
      const server = new LWWServer(mockStore, { changeIdTTL: 1000 });
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
        commitChanges: { access: 'write', params: ['docId', 'changes', 'options'] },
        deleteDoc: 'write',
        undeleteDoc: 'write',
      });
    });
  });

  describe('getDoc', () => {
    it('should return empty state for non-existent document', async () => {
      const json = await readStreamAsString(await server.getDoc('nonexistent'));
      const result = JSON.parse(json);
      expect(result.state).toEqual({});
      expect(result.rev).toBe(0);
    });

    it('should reject reading at a specific revision', async () => {
      await expect(server.getDoc('doc1', { rev: 5 })).rejects.toThrow(/specific revision/);
    });

    it('should return state from snapshot when no fields', async () => {
      mockStore.snapshots.set('doc1', { state: { name: 'Alice' }, rev: 5 });

      const json = await readStreamAsString(await server.getDoc('doc1'));
      const result = JSON.parse(json);

      expect(result.state).toEqual({ name: 'Alice' });
      expect(result.rev).toBe(5);
    });

    it('should reconstruct state from snapshot + fields', async () => {
      mockStore.snapshots.set('doc1', { state: { name: 'Alice' }, rev: 5 });
      mockStore.ops.set('doc1:/age', { op: 'replace', path: '/age', ts: 1000, rev: 6, value: 30 });

      const json = await readStreamAsString(await server.getDoc('doc1'));
      const result = JSON.parse(json);

      // State is the snapshot state (not applied with changes yet — changes come separately)
      expect(result.state).toEqual({ name: 'Alice' });
      expect(result.rev).toBe(6); // current rev = max op rev, not snapshot rev
      // Changes include the ops since snapshot
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].ops).toContainEqual(expect.objectContaining({ path: '/age', value: 30 }));
    });
  });

  describe('getChangesSince', () => {
    it('should return empty array when no fields since rev', async () => {
      const result = await server.getChangesSince('doc1', 5);
      expect(result).toEqual([]);
    });

    it('should synthesize change from fields since rev', async () => {
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 1000, rev: 2, value: 'Alice' });
      mockStore.ops.set('doc1:/age', { op: 'replace', path: '/age', ts: 1500, rev: 3, value: 30 });

      const result = await server.getChangesSince('doc1', 1);

      expect(result).toHaveLength(1);
      expect(result[0].ops).toHaveLength(2);
      expect(result[0].rev).toBe(3);
    });

    it('should sort ops in commit (rev) order so catch-up matches live application order', async () => {
      // /name committed first (rev 2) even though its writer's clock was ahead (higher ts).
      // Live clients applied rev 2 then rev 3, so catch-up must deliver the same order.
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 2000, rev: 2, value: 'Alice' });
      mockStore.ops.set('doc1:/age', { op: 'replace', path: '/age', ts: 1000, rev: 3, value: 30 });

      const result = await server.getChangesSince('doc1', 0);

      expect(result[0].ops[0].path).toBe('/name');
      expect(result[0].ops[1].path).toBe('/age');
    });

    it('should tiebreak equal revs by timestamp', async () => {
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 2000, rev: 2, value: 'Alice' });
      mockStore.ops.set('doc1:/age', { op: 'replace', path: '/age', ts: 1000, rev: 2, value: 30 });

      const result = await server.getChangesSince('doc1', 0);

      expect(result[0].ops[0].path).toBe('/age');
      expect(result[0].ops[1].path).toBe('/name');
    });
  });

  describe('commitChanges - LWW conflict resolution', () => {
    it('should return empty array for empty changes', async () => {
      const result = await server.commitChanges('doc1', []);
      expect(result.changes).toEqual([]);
    });

    it('should apply first write when no existing field', async () => {
      const change: ChangeInput = {
        id: 'change1',
        ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].rev).toBe(1);
      expect(mockStore.ops.get('doc1:/name')?.value).toBe('Alice');
    });

    it('should apply write with higher timestamp', async () => {
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 1000, rev: 1, value: 'Alice' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'change2',
        ops: [{ op: 'replace', path: '/name', value: 'Bob', ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result.changes).toHaveLength(1);
      expect(mockStore.ops.get('doc1:/name')?.value).toBe('Bob');
    });

    it('should reject write with lower timestamp', async () => {
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 2000, rev: 1, value: 'Bob' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'change3',
        ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result.changes).toHaveLength(1);
      // Rev should not change since no updates were made
      expect(result.changes[0].rev).toBe(1);
      // State should remain unchanged
      expect(mockStore.ops.get('doc1:/name')?.value).toBe('Bob');
    });

    it('should apply write with equal timestamp (incoming wins on tie)', async () => {
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 1000, rev: 1, value: 'Alice' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'change4',
        ops: [{ op: 'replace', path: '/name', value: 'Bob', ts: 1000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result.changes).toHaveLength(1);
      expect(mockStore.ops.get('doc1:/name')?.value).toBe('Bob');
    });

    it('should use change.createdAt when op has no ts', async () => {
      const change: ChangeInput = {
        id: 'change5',
        createdAt: 5000, // Explicit createdAt
        ops: [{ op: 'replace', path: '/name', value: 'Alice' }], // No ts on op
      };

      await server.commitChanges('doc1', [change]);

      const field = mockStore.ops.get('doc1:/name');
      expect(field?.ts).toBe(5000); // Should use change.createdAt
    });

    it('should use serverNow when op and change both lack ts', async () => {
      const now = Date.now();
      const change: ChangeInput = {
        id: 'change6',
        // No createdAt on change
        ops: [{ op: 'replace', path: '/name', value: 'Alice' }], // No ts on op
      };

      await server.commitChanges('doc1', [change]);

      const field = mockStore.ops.get('doc1:/name');
      expect(field?.ts).toBeGreaterThanOrEqual(now); // Should fallback to Date.now()
    });
  });

  describe('commitChanges - special operations', () => {
    describe('@inc operations', () => {
      it('should always apply @inc regardless of timestamp', async () => {
        mockStore.ops.set('doc1:/count', { op: 'replace', path: '/count', ts: 2000, rev: 1, value: 10 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'inc1',
          ops: [{ op: '@inc', path: '/count', value: 5, ts: 1000 }], // Lower timestamp
        };

        const result = await server.commitChanges('doc1', [change]);

        expect(result.changes).toHaveLength(1);
        expect(mockStore.ops.get('doc1:/count')?.value).toBe(15);
      });

      it('should initialize to value if field does not exist', async () => {
        const change: ChangeInput = {
          id: 'inc2',
          ops: [{ op: '@inc', path: '/count', value: 5 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.ops.get('doc1:/count')?.value).toBe(5);
      });
    });

    describe('@bit operations', () => {
      it('should always apply @bit regardless of timestamp', async () => {
        mockStore.ops.set('doc1:/flags', { op: 'replace', path: '/flags', ts: 2000, rev: 1, value: 0b0001 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'bit1',
          ops: [{ op: '@bit', path: '/flags', value: 0b0010, ts: 1000 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.ops.get('doc1:/flags')?.value).toBe(0b0011);
      });
    });

    describe('@max operations', () => {
      it('should update if value is greater', async () => {
        mockStore.ops.set('doc1:/lastSeen', { op: 'replace', path: '/lastSeen', ts: 1000, rev: 1, value: 100 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'max1',
          ops: [{ op: '@max', path: '/lastSeen', value: 200 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.ops.get('doc1:/lastSeen')?.value).toBe(200);
      });

      it('should not update if value is smaller', async () => {
        mockStore.ops.set('doc1:/lastSeen', { op: 'replace', path: '/lastSeen', ts: 1000, rev: 1, value: 200 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'max2',
          ops: [{ op: '@max', path: '/lastSeen', value: 100 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.ops.get('doc1:/lastSeen')?.value).toBe(200);
      });
    });

    describe('@min operations', () => {
      it('should update if value is smaller', async () => {
        mockStore.ops.set('doc1:/minPrice', { op: 'replace', path: '/minPrice', ts: 1000, rev: 1, value: 100 });
        mockStore.revs.set('doc1', 1);

        const change: ChangeInput = {
          id: 'min1',
          ops: [{ op: '@min', path: '/minPrice', value: 50 }],
        };

        await server.commitChanges('doc1', [change]);

        expect(mockStore.ops.get('doc1:/minPrice')?.value).toBe(50);
      });
    });
  });

  describe('commitChanges - remove operations', () => {
    it('should store field with undefined value for remove', async () => {
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 1000, rev: 1, value: 'Alice' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'remove1',
        ops: [{ op: 'remove', path: '/name', ts: 2000 }],
      };

      await server.commitChanges('doc1', [change]);

      expect(mockStore.ops.get('doc1:/name')?.value).toBeUndefined();
    });
  });

  describe('commitChanges - hierarchy handling', () => {
    it('should delete children when setting parent', async () => {
      mockStore.ops.set('doc1:/obj/name', { op: 'replace', path: '/obj/name', ts: 1000, rev: 1, value: 'Alice' });
      mockStore.ops.set('doc1:/obj/age', { op: 'replace', path: '/obj/age', ts: 1000, rev: 1, value: 30 });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'parent1',
        ops: [{ op: 'replace', path: '/obj', value: { newProp: true }, ts: 2000 }],
      };

      await server.commitChanges('doc1', [change]);

      // Children should be deleted
      expect(mockStore.ops.has('doc1:/obj/name')).toBe(false);
      expect(mockStore.ops.has('doc1:/obj/age')).toBe(false);
      // Parent should have new value
      expect(mockStore.ops.get('doc1:/obj')?.value).toEqual({ newProp: true });
    });

    it('should self-heal when setting child on primitive parent', async () => {
      mockStore.ops.set('doc1:/obj', { op: 'replace', path: '/obj', ts: 1000, rev: 1, value: 'primitive' });
      mockStore.revs.set('doc1', 1);

      const change: ChangeInput = {
        id: 'child1',
        rev: 0, // Request catchup
        ops: [{ op: 'replace', path: '/obj/name', value: 'Alice', ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      // Op should be skipped, but parent should be in response for correction
      expect(result.changes[0].ops).toContainEqual(expect.objectContaining({ path: '/obj', value: 'primitive' }));
    });
  });

  describe('commitChanges - catchup', () => {
    // Clients mint changes with baseRev = last known rev and rev = baseRev + 1 (see
    // LWWAlgorithm.getPendingToSend); baseRev is the catchup floor, not the optimistic rev.
    it('should include fields since client rev in response', async () => {
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 1000, rev: 2, value: 'Alice' });
      mockStore.ops.set('doc1:/age', { op: 'replace', path: '/age', ts: 1500, rev: 3, value: 30 });
      mockStore.revs.set('doc1', 3);

      const change: ChangeInput = {
        id: 'catchup1',
        baseRev: 1, // Client has rev 1, wants catchup
        rev: 2,
        ops: [{ op: 'replace', path: '/status', value: 'online', ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      // Response should include /name and /age as catchup ops
      expect(result.changes[0].ops).toContainEqual(expect.objectContaining({ path: '/name' }));
      expect(result.changes[0].ops).toContainEqual(expect.objectContaining({ path: '/age' }));
    });

    it('should include ops committed at exactly baseRev + 1 by another client', async () => {
      // Another client committed /other at rev 2; this client last saw rev 1 and mints
      // rev = baseRev + 1 = 2. Using rev as the floor would skip /other forever.
      mockStore.ops.set('doc1:/other', { op: 'replace', path: '/other', ts: 1500, rev: 2, value: 'from-other' });
      mockStore.revs.set('doc1', 2);

      const change: ChangeInput = {
        id: 'catchup4',
        baseRev: 1,
        rev: 2,
        ops: [{ op: 'replace', path: '/mine', value: 1, ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result.changes[0].ops).toContainEqual(expect.objectContaining({ path: '/other', value: 'from-other' }));
      expect(result.changes[0].baseRev).toBe(1);
    });

    it('should fall back to rev - 1 as the catchup floor when baseRev is absent', async () => {
      mockStore.ops.set('doc1:/other', { op: 'replace', path: '/other', ts: 1500, rev: 2, value: 'from-other' });
      mockStore.revs.set('doc1', 2);

      const change: ChangeInput = {
        id: 'catchup5',
        rev: 2,
        ops: [{ op: 'replace', path: '/mine', value: 1, ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result.changes[0].ops).toContainEqual(expect.objectContaining({ path: '/other', value: 'from-other' }));
    });

    it('should echo the stored resolution for paths the client just sent', async () => {
      // The client confirms sent ops optimistically (rev-less); the echoed stored row
      // (rev-stamped) is what lets the client's committed layer mirror the server's table.
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 1000, rev: 2, value: 'Alice' });
      mockStore.revs.set('doc1', 2);

      const change: ChangeInput = {
        id: 'catchup2',
        baseRev: 1,
        rev: 2,
        ops: [{ op: 'replace', path: '/name', value: 'Bob', ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      // The client's newer-ts write won; the response echoes the stored (committed) row.
      expect(result.changes[0].ops).toContainEqual(expect.objectContaining({ path: '/name', value: 'Bob', rev: 3 }));
    });

    it('should not echo children of a sent parent that the winning parent pruned', async () => {
      mockStore.ops.set('doc1:/obj/child', { op: 'replace', path: '/obj/child', ts: 1000, rev: 2, value: 'x' });
      mockStore.revs.set('doc1', 2);

      const change: ChangeInput = {
        id: 'catchup3',
        baseRev: 1,
        rev: 2,
        ops: [{ op: 'replace', path: '/obj', value: { new: true }, ts: 2000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      // The committed parent write deleted /obj/child from the table, so it isn't echoed —
      // but the stored parent itself is.
      expect(result.changes[0].ops).not.toContainEqual(expect.objectContaining({ path: '/obj/child' }));
      expect(result.changes[0].ops).toContainEqual(
        expect.objectContaining({ path: '/obj', value: { new: true }, rev: 3 })
      );
    });

    it('should echo surviving newer children when a sent parent write loses', async () => {
      // FINDING-6 shape: the client already has the child row committed, but its own
      // parent write (older ts) loses to the stored parent. confirmSent's optimistic prune
      // dropped the child locally, and the child's rev is behind the client's committedRev,
      // so ONLY this echo can restore it — in commit order (parent row before child row).
      mockStore.ops.set('doc1:/obj', { op: 'replace', path: '/obj', ts: 3000, rev: 2, value: { child: 0 } });
      mockStore.ops.set('doc1:/obj/child', { op: 'replace', path: '/obj/child', ts: 1500, rev: 3, value: 2 });
      mockStore.revs.set('doc1', 3);

      const change: ChangeInput = {
        id: 'catchup6',
        baseRev: 3,
        rev: 4,
        ops: [{ op: 'replace', path: '/obj', value: { child: -1 }, ts: 2000 }], // older ts → loses
      };

      const result = await server.commitChanges('doc1', [change]);

      const ops = result.changes[0].ops;
      const parentIndex = ops.findIndex(op => op.path === '/obj');
      const childIndex = ops.findIndex(op => op.path === '/obj/child');
      expect(ops[parentIndex]).toEqual(expect.objectContaining({ value: { child: 0 }, rev: 2 }));
      expect(ops[childIndex]).toEqual(expect.objectContaining({ value: 2, rev: 3 }));
      // Commit order end to end: the doc applies response ops in array order.
      expect(parentIndex).toBeLessThan(childIndex);
    });
  });

  describe('commitChanges - concurrent commits', () => {
    it('should not lose @inc increments across concurrent commits', async () => {
      const inc = (id: string): ChangeInput => ({
        id,
        ops: [{ op: '@inc', path: '/count', value: 1, ts: 1000 }],
      });

      await Promise.all([server.commitChanges('doc1', [inc('c1')]), server.commitChanges('doc1', [inc('c2')])]);

      expect(mockStore.ops.get('doc1:/count')?.value).toBe(2);
    });

    it('should not let an older-ts concurrent commit overwrite a newer one', async () => {
      const newer: ChangeInput = { id: 'newer', ops: [{ op: 'replace', path: '/name', value: 'NEWER', ts: 200 }] };
      const older: ChangeInput = { id: 'older', ops: [{ op: 'replace', path: '/name', value: 'older', ts: 100 }] };

      await Promise.all([server.commitChanges('doc1', [newer]), server.commitChanges('doc1', [older])]);

      expect(mockStore.ops.get('doc1:/name')).toEqual(expect.objectContaining({ value: 'NEWER', ts: 200 }));
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

        expect(emitSpy).toHaveBeenCalledWith('doc1', expect.any(Array), undefined, 'client1');
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
      mockStore.revs.set('doc1', 5);

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
        'LWW versioning requires a store that implements VersioningStoreBackend'
      );
    });

    describe('with versioning store', () => {
      let versioningStore: LWWStoreBackend & VersioningStoreBackend;
      let versioningServer: LWWServer;

      beforeEach(() => {
        versioningStore = {
          ...mockStore,
          createVersion: vi.fn(),
          listVersions: vi.fn(),
          loadVersion: vi.fn(),
          loadVersionState: vi.fn(),
          updateVersion: vi.fn(),
        };
        versioningServer = new LWWServer(versioningStore);
      });

      it('should return null for non-existent document', async () => {
        const result = await versioningServer.captureCurrentVersion('nonexistent');
        expect(result).toBeNull();
      });

      it('should create version with metadata only', async () => {
        mockStore.revs.set('doc1', 2);

        const versionId = await versioningServer.captureCurrentVersion('doc1');

        expect(versionId).toBeDefined();
        expect(versioningStore.createVersion).toHaveBeenCalledWith(
          'doc1',
          expect.objectContaining({ id: versionId, origin: 'main', startRev: 2, endRev: 2 })
        );
      });

      it('should accept optional metadata', async () => {
        mockStore.revs.set('doc1', 1);

        const metadata: EditableVersionMetadata = { name: 'My Version' };
        await versioningServer.captureCurrentVersion('doc1', metadata);

        expect(versioningStore.createVersion).toHaveBeenCalledWith(
          'doc1',
          expect.objectContaining({ origin: 'main', name: 'My Version' })
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
      expect(mockStore.ops.get('doc1:/name')?.value).toBe('Alice');

      // Client B's change arrives second but has higher timestamp
      const changeB: ChangeInput = {
        id: 'concurrent-B',
        ops: [{ op: 'replace', path: '/name', value: 'Bob', ts: 1500 }],
      };

      await server.commitChanges('doc1', [changeB]);
      expect(mockStore.ops.get('doc1:/name')?.value).toBe('Bob');
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

      expect(mockStore.ops.get('doc1:/name')?.value).toBe('Alice');
      expect(mockStore.ops.get('doc1:/age')?.value).toBe(30);
    });
  });

  describe('committedAt field', () => {
    it('should set committedAt on response changes from commitChanges', async () => {
      const before = Date.now();

      const change: ChangeInput = {
        id: 'commit1',
        ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      const after = Date.now();

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].committedAt).toBeGreaterThanOrEqual(before);
      expect(result.changes[0].committedAt).toBeLessThanOrEqual(after);
    });

    it('should set committedAt on broadcast changes', async () => {
      const before = Date.now();
      let broadcastedChange: any;

      const emitSpy = vi
        .spyOn(server.onChangesCommitted, 'emit')
        .mockImplementation(async (_docId, changes, _options) => {
          broadcastedChange = changes[0];
        });

      const change: ChangeInput = {
        id: 'broadcast1',
        ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }],
      };

      await server.commitChanges('doc1', [change]);

      const after = Date.now();

      expect(broadcastedChange).toBeDefined();
      expect(broadcastedChange.committedAt).toBeGreaterThanOrEqual(before);
      expect(broadcastedChange.committedAt).toBeLessThanOrEqual(after);

      emitSpy.mockRestore();
    });

    it('should set committedAt on changes from getChangesSince', async () => {
      // Set up some ops with timestamps
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', ts: 1000, rev: 2, value: 'Alice' });
      mockStore.ops.set('doc1:/age', { op: 'replace', path: '/age', ts: 1500, rev: 3, value: 30 });

      const result = await server.getChangesSince('doc1', 1);

      expect(result).toHaveLength(1);
      // committedAt should be max timestamp from ops (1500)
      expect(result[0].committedAt).toBe(1500);
    });

    it('should use Date.now() for getChangesSince when ops have no timestamps', async () => {
      const before = Date.now();

      // Set up ops without timestamps
      mockStore.ops.set('doc1:/name', { op: 'replace', path: '/name', rev: 2, value: 'Alice' });

      const result = await server.getChangesSince('doc1', 1);

      const after = Date.now();

      expect(result).toHaveLength(1);
      // Should use Date.now() as fallback
      expect(result[0].committedAt).toBeGreaterThanOrEqual(before);
      expect(result[0].committedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('commitChanges - delta merge echo', () => {
    it('echoes the stored concrete value when a sent delta combined with a concurrent write', async () => {
      // Client B is at rev 1 (counter=10); client C committed replace 100 at rev 2 which B never saw
      mockStore.ops.set('doc1:/counter', { op: 'replace', path: '/counter', ts: 2000, rev: 2, value: 100 });
      mockStore.revs.set('doc1', 2);

      const change: ChangeInput = {
        id: 'delta1',
        rev: 1,
        ops: [{ op: '@inc', path: '/counter', value: 5, ts: 3000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      // The stored value merged to 105; without the echo the sender applies +5 to its stale 10
      expect(result.changes[0].ops).toContainEqual(
        expect.objectContaining({ path: '/counter', op: 'replace', value: 105 })
      );
      expect(mockStore.ops.get('doc1:/counter')).toEqual(expect.objectContaining({ op: 'replace', value: 105 }));
    });

    it('echoes the stored value for a fresh delta so the sender converges with the server', async () => {
      const change: ChangeInput = {
        id: 'delta2',
        rev: 0,
        ops: [{ op: '@inc', path: '/counter', value: 5, ts: 3000 }],
      };

      const result = await server.commitChanges('doc1', [change]);

      expect(result.changes[0].ops).toContainEqual(
        expect.objectContaining({ path: '/counter', op: 'replace', value: 5 })
      );
    });
  });

  describe('commitChanges - multi-change batches', () => {
    it('processes ops from every change in the batch, not just the first', async () => {
      const changes: ChangeInput[] = [
        { id: 'c1', rev: 0, ops: [{ op: 'replace', path: '/a', value: 1, ts: 1000 }] },
        { id: 'c2', rev: 0, ops: [{ op: 'replace', path: '/b', value: 2, ts: 1000 }] },
      ];

      await server.commitChanges('doc1', changes);

      expect(mockStore.ops.get('doc1:/a')).toEqual(expect.objectContaining({ value: 1 }));
      expect(mockStore.ops.get('doc1:/b')).toEqual(expect.objectContaining({ value: 2 }));
    });
  });

  describe('commitChanges - timestamp clamping', () => {
    const T = 1700000000000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(T);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('clamps a future-dated op ts to server time', async () => {
      await server.commitChanges('doc1', [
        { id: 'future1', ops: [{ op: 'replace', path: '/name', value: 'Fast', ts: T + 60_000 }] },
      ]);

      expect(mockStore.ops.get('doc1:/name')?.ts).toBe(T);
    });

    it('clamps a future-dated createdAt fallback to server time', async () => {
      await server.commitChanges('doc1', [
        { id: 'future2', createdAt: T + 60_000, ops: [{ op: 'replace', path: '/name', value: 'Fast' }] },
      ]);

      expect(mockStore.ops.get('doc1:/name')?.ts).toBe(T);
    });

    it('lets a later normal write from another client win over a clamped future-dated write', async () => {
      await server.commitChanges('doc1', [
        { id: 'future3', ops: [{ op: 'replace', path: '/name', value: 'Fast clock', ts: T + 60_000 }] },
      ]);

      vi.setSystemTime(T + 5000);
      await server.commitChanges('doc1', [
        { id: 'normal1', ops: [{ op: 'replace', path: '/name', value: 'Normal clock', ts: T + 5000 }] },
      ]);

      expect(mockStore.ops.get('doc1:/name')).toEqual(expect.objectContaining({ value: 'Normal clock', ts: T + 5000 }));
    });

    it('breaks equal-clamp ties by the existing tie rule (incoming wins)', async () => {
      await server.commitChanges('doc1', [
        { id: 'tie1', ops: [{ op: 'replace', path: '/name', value: 'First', ts: T + 60_000 }] },
      ]);
      await server.commitChanges('doc1', [
        { id: 'tie2', ops: [{ op: 'replace', path: '/name', value: 'Second', ts: T + 90_000 }] },
      ]);

      expect(mockStore.ops.get('doc1:/name')).toEqual(expect.objectContaining({ value: 'Second', ts: T }));
    });
  });

  describe('commitChanges - change id idempotency', () => {
    let backend: LWWMemoryStoreBackend;

    const inc = (id = 'retry1'): ChangeInput => ({
      id,
      rev: 1,
      ops: [{ op: '@inc', path: '/count', value: 5, ts: 1000 }],
    });

    beforeEach(() => {
      backend = new LWWMemoryStoreBackend();
      server = new LWWServer(backend);
    });

    it('does not double-apply a retried @inc after a lost ack', async () => {
      await server.commitChanges('doc1', [inc()]);
      const retry = await server.commitChanges('doc1', [inc()]);

      const ops = backend.getDocData('doc1')?.ops ?? [];
      expect(ops).toContainEqual(expect.objectContaining({ path: '/count', op: 'replace', value: 5 }));
      // The retry response still echoes the committed op so the client converges
      expect(retry.changes).toHaveLength(1);
      expect(retry.changes[0].ops).toContainEqual(expect.objectContaining({ path: '/count', op: 'replace', value: 5 }));
    });

    it('does not re-broadcast a fully deduped retry', async () => {
      const emitSpy = vi.spyOn(server.onChangesCommitted, 'emit').mockResolvedValue();

      await server.commitChanges('doc1', [inc()]);
      await server.commitChanges('doc1', [inc()]);

      expect(emitSpy).toHaveBeenCalledTimes(1);
    });

    it('applies fresh changes in a batch alongside deduped ones', async () => {
      await server.commitChanges('doc1', [inc()]);

      const fresh: ChangeInput = {
        id: 'fresh1',
        rev: 1,
        ops: [{ op: 'replace', path: '/other', value: 'new', ts: 2000 }],
      };
      await server.commitChanges('doc1', [inc(), fresh]);

      const ops = backend.getDocData('doc1')?.ops ?? [];
      expect(ops).toContainEqual(expect.objectContaining({ path: '/count', value: 5 }));
      expect(ops).toContainEqual(expect.objectContaining({ path: '/other', value: 'new' }));
    });

    it('expires change ids after the TTL, re-enabling the retry', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1700000000000);
      try {
        server = new LWWServer(backend, { changeIdTTL: 1000 });

        await server.commitChanges('doc1', [inc()]);
        vi.setSystemTime(1700000000000 + 2000);
        await server.commitChanges('doc1', [inc()]);

        // Past the TTL the id is gone, so the retry re-applies (the documented limit)
        const ops = backend.getDocData('doc1')?.ops ?? [];
        expect(ops).toContainEqual(expect.objectContaining({ path: '/count', value: 10 }));
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps old behavior when the backend does not implement seenChangeIds', async () => {
      server = new LWWServer(mockStore);

      await server.commitChanges('doc1', [inc()]);
      await server.commitChanges('doc1', [inc()]);

      expect(mockStore.ops.get('doc1:/count')?.value).toBe(10);
    });
  });
});

describe('LWWServer — response ops are rev-stamped by the server (DAB-601)', () => {
  it('stamps the committed rev itself so a copying backend still yields sortable response ops', async () => {
    // A contract-compliant backend that never mutates the caller's ops (as any SQL/HTTP
    // store would behave). Before DAB-601 the response relied on the memory backend
    // leaking rev stamps into the input, and a copying backend broke commit-order sorting.
    const copying = new LWWMemoryStoreBackend();
    const inner = copying.saveOps.bind(copying);
    copying.saveOps = (docId, ops, pathsToDelete, changeIds) =>
      inner(
        docId,
        ops.map(op => ({ ...op })),
        pathsToDelete,
        changeIds
      );
    const server = new LWWServer(copying);

    const result = await server.commitChanges('doc-rev-stamp', [
      { id: 'c1', rev: 1, ops: [{ op: 'replace', path: '/a', value: 1, ts: 5 }] },
    ]);

    const echoed = result.changes[0].ops.filter(op => op.path === '/a');
    expect(echoed).not.toHaveLength(0);
    for (const op of echoed) expect(op.rev).toBe(1);
  });
});
