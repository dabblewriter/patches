import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IndexedDBStore } from '../../src/client/IndexedDBStore';
import type { Change, PatchesState } from '../../src/types';

// Mock the dependencies
vi.mock('../../src/algorithms/shared/applyChanges');
vi.mock('../../src/json-patch/transformPatch');
vi.mock('../../src/utils/concurrency');

// Create a simplified mock for IndexedDB operations
const createMockIDBStore = () => {
  const data = new Map<string, any>();

  return {
    get: vi.fn().mockImplementation((key: any) => Promise.resolve(data.get(JSON.stringify(key)))),
    getAll: vi.fn().mockImplementation(() => Promise.resolve(Array.from(data.values()))),
    put: vi.fn().mockImplementation((value: any) => {
      const key = value.docId || `${value.docId}-${value.rev}`;
      data.set(JSON.stringify(key), value);
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

describe('IndexedDBStore', () => {
  let store: IndexedDBStore;
  let mockStores: Map<string, any>;

  const createChange = (id: string, rev: number, baseRev = rev - 1): Change => ({
    id,
    rev,
    baseRev,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    created: Date.now(),
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

    // Mock dependencies
    const { applyChanges } = await import('../../src/algorithms/shared/applyChanges');
    vi.mocked(applyChanges).mockImplementation((state: any, changes: any) => ({
      ...(state || {}),
      appliedChanges: changes?.length || 0,
    }));

    const { transformPatch } = await import('../../src/json-patch/transformPatch');
    vi.mocked(transformPatch).mockImplementation((state, patch, ops) => ops);

    const { blockable } = await import('../../src/utils/concurrency');
    vi.mocked(blockable).mockImplementation((() => (target: any, propertyKey: any, descriptor: any) => descriptor) as any);

    // Mock the transaction method to return our mocked stores
    store = new IndexedDBStore('test-db');

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
      const emptyStore = new IndexedDBStore();
      expect(emptyStore).toBeInstanceOf(IndexedDBStore);
    });

    it('should create store with database name', () => {
      const namedStore = new IndexedDBStore('test-db');
      expect(namedStore).toBeInstanceOf(IndexedDBStore);
    });
  });

  describe('setName', () => {
    it('should set new database name', () => {
      store.setName('new-test-db');
      // Test passes if no errors thrown
    });
  });

  describe('close', () => {
    it('should close database connection', async () => {
      // Mock the database promise to resolve immediately
      (store as any).dbPromise = { promise: Promise.resolve({ close: vi.fn() }) };
      await store.close();
      // Test passes if no errors thrown
    });
  });

  describe('deleteDB', () => {
    it('should delete the database', async () => {
      // Mock the promises to resolve immediately
      (store as any).dbPromise = { promise: Promise.resolve({ close: vi.fn() }) };

      // Mock indexedDB.deleteDatabase to call callbacks immediately
      const mockDeleteRequest = {
        onsuccess: null as any,
        onerror: null as any,
        onblocked: null as any,
      };
      (global as any).indexedDB.deleteDatabase.mockReturnValue(mockDeleteRequest);

      // Trigger success callback immediately
      setTimeout(() => mockDeleteRequest.onsuccess?.(), 0);

      await store.deleteDB();
      // Test passes if no errors thrown
    });

    it('should handle missing database name', async () => {
      const emptyStore = new IndexedDBStore();
      await emptyStore.deleteDB();
      // Test passes if no errors thrown
    });
  });

  describe('getDoc', () => {
    it('should return undefined for non-existent document', async () => {
      const result = await store.getDoc('non-existent');
      expect(result).toBeUndefined();
    });

    it('should return document with applied changes', async () => {
      // Setup mock data
      const docsStore = mockStores.get('docs') || createMockIDBStore();
      const snapshotsStore = mockStores.get('snapshots') || createMockIDBStore();

      docsStore.data.set('"doc1"', { docId: 'doc1', committedRev: 5 });
      snapshotsStore.data.set('"doc1"', { docId: 'doc1', state: { text: 'hello' }, rev: 5 });

      mockStores.set('docs', docsStore);
      mockStores.set('snapshots', snapshotsStore);
      mockStores.set('committedChanges', createMockIDBStore());
      mockStores.set('pendingChanges', createMockIDBStore());

      const result = await store.getDoc('doc1');

      expect(result).toEqual({
        state: { text: 'hello', appliedChanges: 0 },
        rev: 5,
        changes: [],
      });
    });
  });

  describe('saveDoc', () => {
    it('should save document snapshot', async () => {
      const snapshot = createState({ text: 'hello' }, 5);
      await store.saveDoc('doc1', snapshot);

      const snapshotsStore = mockStores.get('snapshots');
      expect(snapshotsStore?.put).toHaveBeenCalledWith({
        docId: 'doc1',
        state: { text: 'hello' },
        rev: 5,
      });
    });
  });

  describe('savePendingChanges', () => {
    it('should save pending changes', async () => {
      const changes = [createChange('p1', 1), createChange('p2', 2)];
      await store.savePendingChanges('doc1', changes);

      const pendingStore = mockStores.get('pendingChanges');
      expect(pendingStore?.put).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPendingChanges', () => {
    it('should return pending changes', async () => {
      const pendingStore = createMockIDBStore();
      const changes = [createChange('p1', 1), createChange('p2', 2)];
      pendingStore.getAll.mockResolvedValue(changes);
      mockStores.set('pendingChanges', pendingStore);

      const result = await store.getPendingChanges('doc1');

      expect(pendingStore.getAll).toHaveBeenCalled();
      expect(result).toEqual(changes);
    });
  });

  describe('replacePendingChanges', () => {
    it('should replace all pending changes', async () => {
      const changes = [createChange('p3', 3)];
      await store.replacePendingChanges('doc1', changes);

      const pendingStore = mockStores.get('pendingChanges');
      expect(pendingStore?.delete).toHaveBeenCalled();
      expect(pendingStore?.put).toHaveBeenCalledWith({ ...changes[0], docId: 'doc1' });
    });
  });

  describe('saveCommittedChanges', () => {
    it('should save committed changes', async () => {
      const changes = [createChange('c1', 1), createChange('c2', 2)];
      await store.saveCommittedChanges('doc1', changes);

      const committedStore = mockStores.get('committedChanges');
      expect(committedStore?.put).toHaveBeenCalledTimes(2);
    });

    it('should remove sent pending changes when range provided', async () => {
      const changes = [createChange('c1', 4)];
      await store.saveCommittedChanges('doc1', changes, [1, 2]);

      const pendingStore = mockStores.get('pendingChanges');
      expect(pendingStore?.delete).toHaveBeenCalled();
    });
  });

  describe('deleteDoc', () => {
    it('should mark document as deleted', async () => {
      await store.deleteDoc('doc1');

      const docsStore = mockStores.get('docs');
      expect(docsStore?.put).toHaveBeenCalledWith({
        docId: 'doc1',
        committedRev: 0,
        deleted: true,
      });
    });
  });

  describe('confirmDeleteDoc', () => {
    it('should permanently remove document', async () => {
      await store.confirmDeleteDoc('doc1');

      const docsStore = mockStores.get('docs');
      expect(docsStore?.delete).toHaveBeenCalledWith('doc1');
    });
  });

  describe('listDocs', () => {
    it('should return all non-deleted documents', async () => {
      const docsStore = createMockIDBStore();
      const docs = [
        { docId: 'doc1', committedRev: 5 },
        { docId: 'doc2', committedRev: 3, deleted: true },
        { docId: 'doc3', committedRev: 1 },
      ];
      docsStore.getAll.mockResolvedValue(docs);
      mockStores.set('docs', docsStore);

      const result = await store.listDocs();

      expect(result).toHaveLength(2);
      expect(result.map(d => d.docId)).toEqual(['doc1', 'doc3']);
    });

    it('should include deleted documents when requested', async () => {
      const docsStore = createMockIDBStore();
      const docs = [
        { docId: 'doc1', committedRev: 5 },
        { docId: 'doc2', committedRev: 3, deleted: true },
      ];
      docsStore.getAll.mockResolvedValue(docs);
      mockStores.set('docs', docsStore);

      const result = await store.listDocs(true);

      expect(result).toHaveLength(2);
    });
  });

  describe('trackDocs', () => {
    it('should track new documents', async () => {
      await store.trackDocs(['doc1', 'doc2']);

      const docsStore = mockStores.get('docs');
      expect(docsStore?.put).toHaveBeenCalledTimes(2);
    });
  });

  describe('untrackDocs', () => {
    it('should remove documents from tracking', async () => {
      await store.untrackDocs(['doc1', 'doc2']);

      const docsStore = mockStores.get('docs');
      expect(docsStore?.delete).toHaveBeenCalledTimes(2);
    });
  });

  describe('getLastRevs', () => {
    it('should return last committed and pending revisions', async () => {
      const committedStore = createMockIDBStore();
      const pendingStore = createMockIDBStore();

      committedStore.getLastFromCursor.mockResolvedValue({ rev: 4 });
      pendingStore.getLastFromCursor.mockResolvedValue({ rev: 6 });

      mockStores.set('committedChanges', committedStore);
      mockStores.set('pendingChanges', pendingStore);

      const result = await store.getLastRevs('doc1');

      expect(result).toEqual([4, 6]);
    });

    it('should return [0, 0] for empty document', async () => {
      const committedStore = createMockIDBStore();
      const pendingStore = createMockIDBStore();

      committedStore.getLastFromCursor.mockResolvedValue(undefined);
      pendingStore.getLastFromCursor.mockResolvedValue(undefined);

      mockStores.set('committedChanges', committedStore);
      mockStores.set('pendingChanges', pendingStore);

      const result = await store.getLastRevs('doc1');

      expect(result).toEqual([0, 0]);
    });
  });
});
