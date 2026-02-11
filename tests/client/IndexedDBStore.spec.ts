import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import type { Change, PatchesState } from '../../src/types';

// Mock the dependencies
vi.mock('../../src/algorithms/ot/shared/applyChanges');
vi.mock('../../src/json-patch/transformPatch');
vi.mock('../../src/utils/concurrency');

// Create a simplified mock for IndexedDB operations
const createMockIDBStore = () => {
  const data = new Map<string, any>();

  return {
    get: vi.fn().mockImplementation((key: any) => Promise.resolve(data.get(JSON.stringify(key)))),
    getAll: vi.fn().mockImplementation(() => Promise.resolve(Array.from(data.values()))),
    getAllByIndex: vi.fn().mockImplementation((indexName: string, query?: any) => {
      // Simple mock that filters by algorithm field
      const values = Array.from(data.values());
      if (indexName === 'algorithm' && query) {
        return Promise.resolve(values.filter((v: any) => v.algorithm === query));
      }
      return Promise.resolve(values);
    }),
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

describe('OTIndexedDBStore', () => {
  let store: OTIndexedDBStore;
  let mockStores: Map<string, any>;

  const createChange = (id: string, rev: number, baseRev = rev - 1): Change => ({
    id,
    rev,
    baseRev,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    createdAt: 0,
    committedAt: 1000,
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
    const { applyChanges } = await import('../../src/algorithms/ot/shared/applyChanges');
    vi.mocked(applyChanges).mockImplementation((state: any, changes: any) => ({
      ...(state || {}),
      appliedChanges: changes?.length || 0,
    }));

    const { transformPatch } = await import('../../src/json-patch/transformPatch');
    vi.mocked(transformPatch).mockImplementation((state, patch, ops) => ops);

    const { blockable } = await import('../../src/utils/concurrency');
    vi.mocked(blockable).mockImplementation(
      (() => (target: any, propertyKey: any, descriptor: any) => descriptor) as any
    );

    // Mock the transaction method to return our mocked stores
    store = new OTIndexedDBStore('test-db');

    // Override methods on the internal db instance
    (store as any).db.transaction = vi.fn().mockImplementation((storeNames: string[]) => {
      const tx = { complete: vi.fn().mockResolvedValue(undefined) };
      const stores = storeNames.map(name => {
        if (!mockStores.has(name)) {
          mockStores.set(name, createMockIDBStore());
        }
        return mockStores.get(name);
      });
      return Promise.resolve([tx, ...stores]);
    });

    // Mock other delegated methods
    (store as any).db.close = vi.fn().mockResolvedValue(undefined);
    (store as any).db.deleteDB = vi.fn().mockResolvedValue(undefined);
    (store as any).db.setName = vi.fn();
    (store as any).db.listDocs = vi.fn().mockResolvedValue([]);
    (store as any).db.trackDocs = vi.fn().mockResolvedValue(undefined);
    (store as any).db.confirmDeleteDoc = vi.fn().mockResolvedValue(undefined);
    (store as any).db.getCommittedRev = vi.fn().mockResolvedValue(0);
  });

  describe('constructor and initialization', () => {
    it('should create store without database name', () => {
      const emptyStore = new OTIndexedDBStore();
      expect(emptyStore).toBeInstanceOf(OTIndexedDBStore);
    });

    it('should create store with database name', () => {
      const namedStore = new OTIndexedDBStore('test-db');
      expect(namedStore).toBeInstanceOf(OTIndexedDBStore);
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
      const emptyStore = new OTIndexedDBStore();
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

  describe('applyServerChanges', () => {
    it('should save committed changes and replace pending', async () => {
      const serverChanges = [createChange('c1', 1), createChange('c2', 2)];
      const rebasedPending = [createChange('p1', 3)];
      await store.applyServerChanges('doc1', serverChanges, rebasedPending);

      const committedStore = mockStores.get('committedChanges');
      expect(committedStore?.put).toHaveBeenCalledTimes(2);

      const pendingStore = mockStores.get('pendingChanges');
      expect(pendingStore?.delete).toHaveBeenCalled();
      expect(pendingStore?.put).toHaveBeenCalledWith({ ...rebasedPending[0], docId: 'doc1' });
    });

    it('should handle empty rebased pending changes', async () => {
      const serverChanges = [createChange('c1', 1)];
      await store.applyServerChanges('doc1', serverChanges, []);

      const committedStore = mockStores.get('committedChanges');
      expect(committedStore?.put).toHaveBeenCalledTimes(1);

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
      // confirmDeleteDoc is delegated to db
      (store as any).db.confirmDeleteDoc = vi.fn().mockResolvedValue(undefined);

      await store.confirmDeleteDoc('doc1');

      expect((store as any).db.confirmDeleteDoc).toHaveBeenCalledWith('doc1');
    });
  });

  describe('listDocs', () => {
    it('should return all non-deleted documents', async () => {
      // listDocs is delegated to db
      (store as any).db.listDocs = vi.fn().mockResolvedValue([
        { docId: 'doc1', committedRev: 5 },
        { docId: 'doc3', committedRev: 1 },
      ]);

      const result = await store.listDocs();

      expect(result).toHaveLength(2);
      expect(result.map(d => d.docId)).toEqual(['doc1', 'doc3']);
      expect((store as any).db.listDocs).toHaveBeenCalledWith(false, 'ot');
    });

    it('should include deleted documents when requested', async () => {
      // listDocs is delegated to db
      (store as any).db.listDocs = vi.fn().mockResolvedValue([
        { docId: 'doc1', committedRev: 5 },
        { docId: 'doc2', committedRev: 3, deleted: true },
      ]);

      const result = await store.listDocs(true);

      expect(result).toHaveLength(2);
      expect((store as any).db.listDocs).toHaveBeenCalledWith(true, 'ot');
    });
  });

  describe('trackDocs', () => {
    it('should track new documents', async () => {
      // trackDocs is delegated to db
      (store as any).db.trackDocs = vi.fn().mockResolvedValue(undefined);

      await store.trackDocs(['doc1', 'doc2']);

      expect((store as any).db.trackDocs).toHaveBeenCalledWith(['doc1', 'doc2'], 'ot');
    });
  });

  describe('untrackDocs', () => {
    it('should remove documents from tracking', async () => {
      await store.untrackDocs(['doc1', 'doc2']);

      const docsStore = mockStores.get('docs');
      expect(docsStore?.delete).toHaveBeenCalledTimes(2);
    });
  });

  describe('getCommittedRev', () => {
    it('should return committed revision from docs store', async () => {
      // getCommittedRev is delegated to db
      (store as any).db.getCommittedRev = vi.fn().mockResolvedValue(4);

      const result = await store.getCommittedRev('doc1');

      expect(result).toBe(4);
      expect((store as any).db.getCommittedRev).toHaveBeenCalledWith('doc1');
    });

    it('should return 0 for non-existent document', async () => {
      // getCommittedRev is delegated to db
      (store as any).db.getCommittedRev = vi.fn().mockResolvedValue(0);

      const result = await store.getCommittedRev('doc1');

      expect(result).toBe(0);
      expect((store as any).db.getCommittedRev).toHaveBeenCalledWith('doc1');
    });
  });

  describe('Shared Database Integration', () => {
    it('should allow OT and LWW stores to use the same IndexedDBStore', async () => {
      const { IndexedDBStore } = await import('../../src/client/IndexedDBStore.js');
      const { LWWIndexedDBStore } = await import('../../src/client/LWWIndexedDBStore.js');

      const baseStore = new IndexedDBStore('test-db');
      const otStore = new OTIndexedDBStore(baseStore);
      const lwwStore = new LWWIndexedDBStore(baseStore);

      // Both stores should be created successfully without errors
      expect(otStore).toBeDefined();
      expect(lwwStore).toBeDefined();
    });

    it('should track OT documents with algorithm field', async () => {
      await store.trackDocs(['doc1']);

      // trackDocs is delegated to db, so check the mock on db
      expect((store as any).db.trackDocs).toHaveBeenCalledWith(['doc1'], 'ot');
    });

    it('should filter documents by algorithm in listDocs', async () => {
      // listDocs is delegated to db with 'ot' parameter
      (store as any).db.listDocs = vi.fn().mockResolvedValue([{ docId: 'doc1', committedRev: 0, algorithm: 'ot' }]);

      const result = await store.listDocs(false);

      // Should delegate to db with 'ot' algorithm
      expect((store as any).db.listDocs).toHaveBeenCalledWith(false, 'ot');
      expect(result).toHaveLength(1);
    });

    it('should set algorithm field when creating doc via savePendingChanges', async () => {
      const docsStore = createMockIDBStore();
      docsStore.get.mockResolvedValue(undefined); // Doc doesn't exist yet
      mockStores.set('docs', docsStore);
      mockStores.set('pendingChanges', createMockIDBStore());

      const changes = [createChange('p1', 1)];
      await store.savePendingChanges('doc1', changes);

      // Should set algorithm field
      expect(docsStore.put).toHaveBeenCalledWith({
        docId: 'doc1',
        committedRev: 0,
        algorithm: 'ot',
      });
    });
  });
});
