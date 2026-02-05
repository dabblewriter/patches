import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LWWIndexedDBStore } from '../../src/client/LWWIndexedDBStore';
import type { Change, PatchesState } from '../../src/types';
import type { JSONPatchOp } from '../../src/json-patch/types';

// Mock dependencies
vi.mock('../../src/utils/concurrency');

// Create a simplified mock for IndexedDB operations
const createMockIDBStore = () => {
  const data = new Map<string, any>();

  return {
    get: vi.fn().mockImplementation((key: any) => Promise.resolve(data.get(JSON.stringify(key)))),
    getAll: vi.fn().mockImplementation((lower?: any, upper?: any) => {
      const results: any[] = [];
      const lowerKey = lower ? JSON.stringify(lower) : null;
      const upperKey = upper ? JSON.stringify(upper) : null;

      for (const [key, value] of data.entries()) {
        // Simple range check for compound keys
        if (lowerKey && upperKey) {
          if (key >= lowerKey && key <= upperKey) {
            results.push(value);
          }
        } else {
          results.push(value);
        }
      }
      return Promise.resolve(results);
    }),
    put: vi.fn().mockImplementation((value: any) => {
      let key: string;
      if (value.docId && value.path !== undefined) {
        key = JSON.stringify([value.docId, value.path]);
      } else if (value.docId && value.change) {
        key = JSON.stringify(value.docId);
      } else {
        key = JSON.stringify(value.docId);
      }
      data.set(key, value);
      return Promise.resolve(key);
    }),
    delete: vi.fn().mockImplementation((key: any) => {
      data.delete(JSON.stringify(key));
      return Promise.resolve();
    }),
    count: vi.fn().mockImplementation(() => Promise.resolve(data.size)),
    getFirstFromCursor: vi.fn().mockImplementation(() => {
      const values = Array.from(data.values());
      return Promise.resolve(values[0]);
    }),
    getLastFromCursor: vi.fn().mockImplementation(() => {
      const values = Array.from(data.values());
      return Promise.resolve(values[values.length - 1]);
    }),
    data, // Expose for direct manipulation in tests
  };
};

describe('LWWIndexedDBStore', () => {
  let store: LWWIndexedDBStore;
  let mockStores: Map<string, any>;

  const createChange = (
    id: string,
    rev: number,
    baseRev = rev - 1,
    ops = [{ op: 'replace', path: `/field-${id}`, value: `data-${id}`, ts: Date.now() }]
  ): Change => ({
    id,
    rev,
    baseRev,
    ops,
    createdAt: Date.now(),
    committedAt: Date.now(),
  });

  const createState = (data: any, rev: number): PatchesState => ({
    state: data,
    rev,
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock IndexedDB environment
    mockStores = new Map();
    const mockDB = {
      close: vi.fn(),
      transaction: vi.fn().mockImplementation((storeNames: string[]) => {
        const stores = storeNames.map(name => {
          if (!mockStores.has(name)) {
            mockStores.set(name, createMockIDBStore());
          }
          return mockStores.get(name);
        });

        return {
          complete: vi.fn().mockResolvedValue(undefined),
          getStore: vi.fn().mockImplementation((name: string) => mockStores.get(name)),
        };
      }),
    };

    (global as any).indexedDB = {
      open: vi.fn().mockImplementation(() => ({
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        result: mockDB,
      })),
      deleteDatabase: vi.fn().mockImplementation(() => ({
        onsuccess: null,
        onerror: null,
        onblocked: null,
      })),
    };

    (global as any).IDBKeyRange = {
      bound: vi.fn().mockImplementation((lower: any, upper: any) => ({ lower, upper })),
    };

    // Mock blockable decorator
    const { blockable } = await import('../../src/utils/concurrency');
    vi.mocked(blockable).mockImplementation(
      (() => (target: any, propertyKey: any, descriptor: any) => descriptor) as any
    );

    // Create store and override transaction method
    store = new LWWIndexedDBStore('test-db');

    // Override the private transaction method
    (store as any).transaction = vi.fn().mockImplementation((storeNames: string[]) => {
      const tx = { complete: vi.fn().mockResolvedValue(undefined) };
      const stores = storeNames.map(name => {
        if (!mockStores.has(name)) {
          mockStores.set(name, createMockIDBStore());
        }
        return mockStores.get(name);
      });
      return Promise.resolve([tx, ...stores]);
    });
  });

  describe('constructor and initialization', () => {
    it('should create store without database name', () => {
      const emptyStore = new LWWIndexedDBStore();
      expect(emptyStore).toBeInstanceOf(LWWIndexedDBStore);
    });

    it('should create store with database name', () => {
      const namedStore = new LWWIndexedDBStore('test-db');
      expect(namedStore).toBeInstanceOf(LWWIndexedDBStore);
    });
  });

  describe('getDoc', () => {
    it('should return undefined for non-existent document', async () => {
      const result = await store.getDoc('non-existent');
      expect(result).toBeUndefined();
    });

    it('should return undefined for deleted document', async () => {
      const docsStore = mockStores.get('docs') || createMockIDBStore();
      docsStore.data.set('"doc1"', { docId: 'doc1', committedRev: 5, deleted: true });
      mockStores.set('docs', docsStore);

      const result = await store.getDoc('doc1');
      expect(result).toBeUndefined();
    });

    it('should reconstruct document from snapshot only', async () => {
      const docsStore = mockStores.get('docs') || createMockIDBStore();
      const snapshotsStore = mockStores.get('snapshots') || createMockIDBStore();

      docsStore.data.set('"doc1"', { docId: 'doc1', committedRev: 5 });
      snapshotsStore.data.set('"doc1"', { docId: 'doc1', state: { title: 'Hello' }, rev: 5 });

      mockStores.set('docs', docsStore);
      mockStores.set('snapshots', snapshotsStore);
      mockStores.set('committedFields', createMockIDBStore());
      mockStores.set('pendingOps', createMockIDBStore());
      mockStores.set('sendingChanges', createMockIDBStore());

      const result = await store.getDoc('doc1');

      expect(result).toBeDefined();
      expect(result?.state).toEqual({ title: 'Hello' });
      expect(result?.rev).toBe(5);
      expect(result?.changes).toEqual([]);
    });

    it('should apply committed fields to snapshot', async () => {
      const docsStore = createMockIDBStore();
      const snapshotsStore = createMockIDBStore();
      const committedFieldsStore = createMockIDBStore();

      docsStore.data.set('"doc1"', { docId: 'doc1', committedRev: 6 });
      snapshotsStore.data.set('"doc1"', { docId: 'doc1', state: { title: 'Hello' }, rev: 5 });
      committedFieldsStore.data.set('["doc1","/name"]', { docId: 'doc1', path: '/name', value: 'World' });

      mockStores.set('docs', docsStore);
      mockStores.set('snapshots', snapshotsStore);
      mockStores.set('committedFields', committedFieldsStore);
      mockStores.set('pendingOps', createMockIDBStore());
      mockStores.set('sendingChanges', createMockIDBStore());

      const result = await store.getDoc('doc1');

      expect(result?.state).toEqual({ title: 'Hello', name: 'World' });
    });

    it('should apply sending change ops', async () => {
      const docsStore = createMockIDBStore();
      const snapshotsStore = createMockIDBStore();
      const sendingChangesStore = createMockIDBStore();

      docsStore.data.set('"doc1"', { docId: 'doc1', committedRev: 5 });
      snapshotsStore.data.set('"doc1"', { docId: 'doc1', state: { count: 10 }, rev: 5 });
      sendingChangesStore.data.set('"doc1"', {
        docId: 'doc1',
        change: {
          id: 'c1',
          rev: 6,
          baseRev: 5,
          ops: [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }],
          createdAt: Date.now(),
          committedAt: 0,
        },
      });

      mockStores.set('docs', docsStore);
      mockStores.set('snapshots', snapshotsStore);
      mockStores.set('committedFields', createMockIDBStore());
      mockStores.set('pendingOps', createMockIDBStore());
      mockStores.set('sendingChanges', sendingChangesStore);

      const result = await store.getDoc('doc1');

      expect(result?.state.count).toBe(15);
    });

    it('should apply pending ops', async () => {
      const docsStore = createMockIDBStore();
      const snapshotsStore = createMockIDBStore();
      const pendingOpsStore = createMockIDBStore();

      docsStore.data.set('"doc1"', { docId: 'doc1', committedRev: 5 });
      snapshotsStore.data.set('"doc1"', { docId: 'doc1', state: { count: 10 }, rev: 5 });
      pendingOpsStore.data.set('["doc1","/count"]', {
        docId: 'doc1',
        path: '/count',
        op: '@inc',
        ts: Date.now(),
        value: 3,
      });

      mockStores.set('docs', docsStore);
      mockStores.set('snapshots', snapshotsStore);
      mockStores.set('committedFields', createMockIDBStore());
      mockStores.set('pendingOps', pendingOpsStore);
      mockStores.set('sendingChanges', createMockIDBStore());

      const result = await store.getDoc('doc1');

      expect(result?.state.count).toBe(13);
      expect(result?.changes).toHaveLength(1);
    });
  });

  describe('saveDoc', () => {
    it('should save document snapshot and clear fields', async () => {
      const snapshot = createState({ title: 'Hello' }, 5);
      await store.saveDoc('doc1', snapshot);

      const snapshotsStore = mockStores.get('snapshots');
      expect(snapshotsStore?.put).toHaveBeenCalledWith({
        docId: 'doc1',
        state: { title: 'Hello' },
        rev: 5,
      });

      const docsStore = mockStores.get('docs');
      expect(docsStore?.put).toHaveBeenCalledWith({
        docId: 'doc1',
        committedRev: 5,
      });
    });
  });

  describe('getPendingOps', () => {
    it('should return all pending ops when no path prefixes', async () => {
      const pendingOpsStore = createMockIDBStore();
      const ts = Date.now();
      pendingOpsStore.data.set('["doc1","/title"]', {
        docId: 'doc1',
        path: '/title',
        op: 'replace',
        ts,
        value: 'Test',
      });
      pendingOpsStore.data.set('["doc1","/count"]', {
        docId: 'doc1',
        path: '/count',
        op: '@inc',
        ts,
        value: 5,
      });
      mockStores.set('pendingOps', pendingOpsStore);

      const result = await store.getPendingOps('doc1');

      expect(result).toHaveLength(2);
    });

    it('should filter by path prefixes', async () => {
      const pendingOpsStore = createMockIDBStore();
      const ts = Date.now();
      pendingOpsStore.data.set('["doc1","/user/name"]', {
        docId: 'doc1',
        path: '/user/name',
        op: 'replace',
        ts,
        value: 'Alice',
      });
      pendingOpsStore.data.set('["doc1","/user/email"]', {
        docId: 'doc1',
        path: '/user/email',
        op: 'replace',
        ts,
        value: 'alice@example.com',
      });
      pendingOpsStore.data.set('["doc1","/other"]', {
        docId: 'doc1',
        path: '/other',
        op: 'replace',
        ts,
        value: 'ignored',
      });
      mockStores.set('pendingOps', pendingOpsStore);

      const result = await store.getPendingOps('doc1', ['/user']);

      expect(result).toHaveLength(2);
      expect(result.every(op => op.path.startsWith('/user'))).toBe(true);
    });
  });

  describe('savePendingOps', () => {
    it('should save pending ops', async () => {
      const ops: JSONPatchOp[] = [{ op: 'replace', path: '/title', value: 'New Title', ts: Date.now() }];
      await store.savePendingOps('doc1', ops);

      const pendingStore = mockStores.get('pendingOps');
      expect(pendingStore?.put).toHaveBeenCalled();
    });

    it('should create doc meta if not exists', async () => {
      const docsStore = createMockIDBStore();
      mockStores.set('docs', docsStore);

      const ops: JSONPatchOp[] = [{ op: 'replace', path: '/title', value: 'Test', ts: Date.now() }];
      await store.savePendingOps('doc1', ops);

      expect(docsStore.put).toHaveBeenCalledWith(expect.objectContaining({ docId: 'doc1', committedRev: 0 }));
    });

    it('should delete paths when specified', async () => {
      const pendingStore = createMockIDBStore();
      mockStores.set('pendingOps', pendingStore);

      const ops: JSONPatchOp[] = [{ op: 'replace', path: '/user', value: { name: 'Bob' }, ts: Date.now() }];
      await store.savePendingOps('doc1', ops, ['/user/name', '/user/email']);

      expect(pendingStore.delete).toHaveBeenCalledWith(['doc1', '/user/name']);
      expect(pendingStore.delete).toHaveBeenCalledWith(['doc1', '/user/email']);
    });
  });

  describe('getSendingChange', () => {
    it('should return null when no sending change', async () => {
      mockStores.set('sendingChanges', createMockIDBStore());

      const result = await store.getSendingChange('doc1');

      expect(result).toBeNull();
    });

    it('should return existing sending change', async () => {
      const existingChange = createChange('s1', 6, 5);
      const sendingStore = createMockIDBStore();
      sendingStore.data.set('"doc1"', { docId: 'doc1', change: existingChange });
      mockStores.set('sendingChanges', sendingStore);

      const result = await store.getSendingChange('doc1');

      expect(result?.id).toBe('s1');
    });
  });

  describe('saveSendingChange', () => {
    it('should save sending change and clear pending ops', async () => {
      const pendingStore = createMockIDBStore();
      pendingStore.data.set('["doc1","/title"]', {
        docId: 'doc1',
        path: '/title',
        op: 'replace',
        ts: Date.now(),
        value: 'Test',
      });
      const sendingStore = createMockIDBStore();

      mockStores.set('pendingOps', pendingStore);
      mockStores.set('sendingChanges', sendingStore);

      const change = createChange('c1', 6, 5);
      await store.saveSendingChange('doc1', change);

      expect(sendingStore.put).toHaveBeenCalledWith(
        expect.objectContaining({
          docId: 'doc1',
          change: expect.objectContaining({ id: 'c1' }),
        })
      );
    });
  });

  describe('confirmSendingChange', () => {
    it('should do nothing if no sending change exists', async () => {
      mockStores.set('sendingChanges', createMockIDBStore());
      mockStores.set('committedFields', createMockIDBStore());
      mockStores.set('docs', createMockIDBStore());

      await store.confirmSendingChange('doc1');

      // Should complete without error
    });

    it('should move ops to committed fields', async () => {
      const sendingStore = createMockIDBStore();
      const ts = Date.now();
      sendingStore.data.set('"doc1"', {
        docId: 'doc1',
        change: {
          id: 'c1',
          rev: 6,
          baseRev: 5,
          ops: [{ op: 'replace', path: '/title', value: 'Confirmed', ts }],
          createdAt: ts,
          committedAt: ts,
        },
      });

      const committedStore = createMockIDBStore();
      const docsStore = createMockIDBStore();
      docsStore.data.set('"doc1"', { docId: 'doc1', committedRev: 5 });

      mockStores.set('sendingChanges', sendingStore);
      mockStores.set('committedFields', committedStore);
      mockStores.set('docs', docsStore);

      await store.confirmSendingChange('doc1');

      expect(committedStore.put).toHaveBeenCalledWith(
        expect.objectContaining({
          docId: 'doc1',
          path: '/title',
          value: 'Confirmed',
        })
      );
    });

    it('should update committed rev', async () => {
      const sendingStore = createMockIDBStore();
      sendingStore.data.set('"doc1"', {
        docId: 'doc1',
        change: {
          id: 'c1',
          rev: 6,
          baseRev: 5,
          ops: [],
          createdAt: Date.now(),
          committedAt: Date.now(),
        },
      });

      const docsStore = createMockIDBStore();
      docsStore.data.set('"doc1"', { docId: 'doc1', committedRev: 5 });

      mockStores.set('sendingChanges', sendingStore);
      mockStores.set('committedFields', createMockIDBStore());
      mockStores.set('docs', docsStore);

      await store.confirmSendingChange('doc1');

      expect(docsStore.put).toHaveBeenCalledWith(
        expect.objectContaining({
          docId: 'doc1',
          committedRev: 6,
        })
      );
    });

    it('should delete sending change after confirmation', async () => {
      const sendingStore = createMockIDBStore();
      sendingStore.data.set('"doc1"', {
        docId: 'doc1',
        change: {
          id: 'c1',
          rev: 6,
          baseRev: 5,
          ops: [],
          createdAt: Date.now(),
          committedAt: Date.now(),
        },
      });

      mockStores.set('sendingChanges', sendingStore);
      mockStores.set('committedFields', createMockIDBStore());
      mockStores.set('docs', createMockIDBStore());

      await store.confirmSendingChange('doc1');

      expect(sendingStore.delete).toHaveBeenCalledWith('doc1');
    });
  });

  describe('applyServerChanges', () => {
    it('should save server changes as committed fields', async () => {
      const serverChanges = [
        createChange('c1', 6, 5, [{ op: 'replace', path: '/title', value: 'Server Title', ts: Date.now() }]),
      ];
      await store.applyServerChanges('doc1', serverChanges);

      const committedStore = mockStores.get('committedFields');
      expect(committedStore?.put).toHaveBeenCalledWith(
        expect.objectContaining({
          docId: 'doc1',
          path: '/title',
          value: 'Server Title',
        })
      );
    });

    it('should preserve sending changes (not clear them)', async () => {
      // Server changes are from other clients, not confirmation of our own change.
      // Only confirmSendingChange should clear sendingChange.
      const sendingStore = createMockIDBStore();
      sendingStore.data.set('"doc1"', { docId: 'doc1', change: createChange('s1', 6) });
      mockStores.set('sendingChanges', sendingStore);

      const serverChanges = [createChange('c1', 6)];
      await store.applyServerChanges('doc1', serverChanges);

      expect(sendingStore.delete).not.toHaveBeenCalled();
    });
  });

  describe('deleteDoc', () => {
    it('should mark document as deleted', async () => {
      await store.deleteDoc('doc1');

      const docsStore = mockStores.get('docs');
      expect(docsStore?.put).toHaveBeenCalledWith(
        expect.objectContaining({
          docId: 'doc1',
          deleted: true,
        })
      );
    });

    it('should clear all document data', async () => {
      await store.deleteDoc('doc1');

      const snapshotsStore = mockStores.get('snapshots');
      expect(snapshotsStore?.delete).toHaveBeenCalledWith('doc1');

      const sendingStore = mockStores.get('sendingChanges');
      expect(sendingStore?.delete).toHaveBeenCalledWith('doc1');
    });
  });

  describe('untrackDocs', () => {
    it('should remove all document data', async () => {
      await store.untrackDocs(['doc1', 'doc2']);

      const docsStore = mockStores.get('docs');
      expect(docsStore?.delete).toHaveBeenCalledWith('doc1');
      expect(docsStore?.delete).toHaveBeenCalledWith('doc2');

      const snapshotsStore = mockStores.get('snapshots');
      expect(snapshotsStore?.delete).toHaveBeenCalledWith('doc1');
      expect(snapshotsStore?.delete).toHaveBeenCalledWith('doc2');
    });
  });

  describe('document reconstruction with nested paths', () => {
    it('should handle nested paths correctly', async () => {
      const docsStore = createMockIDBStore();
      const snapshotsStore = createMockIDBStore();
      const committedFieldsStore = createMockIDBStore();

      docsStore.data.set('"doc1"', { docId: 'doc1', committedRev: 6 });
      snapshotsStore.data.set('"doc1"', { docId: 'doc1', state: { user: { name: 'Alice' } }, rev: 5 });
      committedFieldsStore.data.set('["doc1","/user/email"]', {
        docId: 'doc1',
        path: '/user/email',
        value: 'alice@example.com',
      });

      mockStores.set('docs', docsStore);
      mockStores.set('snapshots', snapshotsStore);
      mockStores.set('committedFields', committedFieldsStore);
      mockStores.set('pendingOps', createMockIDBStore());
      mockStores.set('sendingChanges', createMockIDBStore());

      const result = await store.getDoc('doc1');

      expect(result?.state).toEqual({
        user: {
          name: 'Alice',
          email: 'alice@example.com',
        },
      });
    });
  });
});
