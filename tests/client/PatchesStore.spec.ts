import { describe, it, expect } from 'vitest';
import type { PatchesStore, TrackedDoc } from '../../src/client/PatchesStore';
import type { Change, PatchesSnapshot, PatchesState } from '../../src/types';

describe('PatchesStore interface', () => {
  describe('TrackedDoc interface', () => {
    it('should define correct structure for TrackedDoc', () => {
      const trackedDoc: TrackedDoc = {
        docId: 'doc1',
        committedRev: 5,
      };

      expect(trackedDoc.docId).toBe('doc1');
      expect(trackedDoc.committedRev).toBe(5);
      expect(trackedDoc.deleted).toBeUndefined();
    });

    it('should support optional deleted flag', () => {
      const deletedDoc: TrackedDoc = {
        docId: 'doc1',
        committedRev: 5,
        deleted: true,
      };

      expect(deletedDoc.deleted).toBe(true);
    });

    it('should enforce required fields', () => {
      // These should compile - all required fields present
      const validDoc: TrackedDoc = {
        docId: 'test',
        committedRev: 0,
      };

      expect(validDoc.docId).toBe('test');
      expect(validDoc.committedRev).toBe(0);
    });
  });

  describe('PatchesStore interface contract', () => {
    // Create a mock implementation to test interface compliance
    const createMockStore = (): PatchesStore => ({
      trackDocs: async (docIds: string[]) => {
        expect(Array.isArray(docIds)).toBe(true);
      },
      untrackDocs: async (docIds: string[]) => {
        expect(Array.isArray(docIds)).toBe(true);
      },
      listDocs: async (includeDeleted?: boolean): Promise<TrackedDoc[]> => {
        expect(typeof includeDeleted === 'boolean' || includeDeleted === undefined).toBe(true);
        return [];
      },
      getDoc: async (docId: string): Promise<PatchesSnapshot | undefined> => {
        expect(typeof docId).toBe('string');
        return undefined;
      },
      getPendingChanges: async (docId: string): Promise<Change[]> => {
        expect(typeof docId).toBe('string');
        return [];
      },
      getLastRevs: async (docId: string): Promise<[number, number]> => {
        expect(typeof docId).toBe('string');
        return [0, 0];
      },
      saveDoc: async (docId: string, docState: PatchesState) => {
        expect(typeof docId).toBe('string');
        expect(typeof docState).toBe('object');
      },
      savePendingChanges: async (docId: string, changes: Change[]) => {
        expect(typeof docId).toBe('string');
        expect(Array.isArray(changes)).toBe(true);
      },
      saveCommittedChanges: async (docId: string, changes: Change[], sentPendingRange?: [number, number]) => {
        expect(typeof docId).toBe('string');
        expect(Array.isArray(changes)).toBe(true);
        if (sentPendingRange) {
          expect(Array.isArray(sentPendingRange)).toBe(true);
          expect(sentPendingRange).toHaveLength(2);
        }
      },
      replacePendingChanges: async (docId: string, changes: Change[]) => {
        expect(typeof docId).toBe('string');
        expect(Array.isArray(changes)).toBe(true);
      },
      deleteDoc: async (docId: string) => {
        expect(typeof docId).toBe('string');
      },
      confirmDeleteDoc: async (docId: string) => {
        expect(typeof docId).toBe('string');
      },
      close: async () => {
        // No parameters expected
      },
    });

    it('should implement all required methods', () => {
      const store = createMockStore();

      // Verify all methods exist
      expect(typeof store.trackDocs).toBe('function');
      expect(typeof store.untrackDocs).toBe('function');
      expect(typeof store.listDocs).toBe('function');
      expect(typeof store.getDoc).toBe('function');
      expect(typeof store.getPendingChanges).toBe('function');
      expect(typeof store.getLastRevs).toBe('function');
      expect(typeof store.saveDoc).toBe('function');
      expect(typeof store.savePendingChanges).toBe('function');
      expect(typeof store.saveCommittedChanges).toBe('function');
      expect(typeof store.replacePendingChanges).toBe('function');
      expect(typeof store.deleteDoc).toBe('function');
      expect(typeof store.confirmDeleteDoc).toBe('function');
      expect(typeof store.close).toBe('function');
    });

    it('should define trackDocs method signature', async () => {
      const store = createMockStore();
      await store.trackDocs(['doc1', 'doc2']);
    });

    it('should define untrackDocs method signature', async () => {
      const store = createMockStore();
      await store.untrackDocs(['doc1', 'doc2']);
    });

    it('should define listDocs method signature', async () => {
      const store = createMockStore();

      // Test without parameter
      await store.listDocs();

      // Test with includeDeleted parameter
      await store.listDocs(true);
      await store.listDocs(false);
    });

    it('should define getDoc method signature', async () => {
      const store = createMockStore();
      const result = await store.getDoc('doc1');

      expect(result === undefined || typeof result === 'object').toBe(true);
    });

    it('should define getPendingChanges method signature', async () => {
      const store = createMockStore();
      const result = await store.getPendingChanges('doc1');

      expect(Array.isArray(result)).toBe(true);
    });

    it('should define getLastRevs method signature', async () => {
      const store = createMockStore();
      const result = await store.getLastRevs('doc1');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(typeof result[0]).toBe('number');
      expect(typeof result[1]).toBe('number');
    });

    it('should define saveDoc method signature', async () => {
      const store = createMockStore();
      const docState: PatchesState = { state: { test: 'data' }, rev: 5 };

      await store.saveDoc('doc1', docState);
    });

    it('should define savePendingChanges method signature', async () => {
      const store = createMockStore();
      const changes: Change[] = [
        {
          id: 'c1',
          rev: 1,
          baseRev: 0,
          ops: [{ op: 'add', path: '/test', value: 'data' }],
          created: Date.now(),
        },
      ];

      await store.savePendingChanges('doc1', changes);
    });

    it('should define saveCommittedChanges method signature', async () => {
      const store = createMockStore();
      const changes: Change[] = [
        {
          id: 'c1',
          rev: 1,
          baseRev: 0,
          ops: [{ op: 'add', path: '/test', value: 'data' }],
          created: Date.now(),
        },
      ];

      // Without sentPendingRange
      await store.saveCommittedChanges('doc1', changes);

      // With sentPendingRange
      await store.saveCommittedChanges('doc1', changes, [1, 5]);
    });

    it('should define replacePendingChanges method signature', async () => {
      const store = createMockStore();
      const changes: Change[] = [
        {
          id: 'c1',
          rev: 1,
          baseRev: 0,
          ops: [{ op: 'add', path: '/test', value: 'data' }],
          created: Date.now(),
        },
      ];

      await store.replacePendingChanges('doc1', changes);
    });

    it('should define deleteDoc method signature', async () => {
      const store = createMockStore();
      await store.deleteDoc('doc1');
    });

    it('should define confirmDeleteDoc method signature', async () => {
      const store = createMockStore();
      await store.confirmDeleteDoc('doc1');
    });

    it('should define close method signature', async () => {
      const store = createMockStore();
      await store.close();
    });

    it('should accept correct parameter types', () => {
      // This test verifies TypeScript compilation - if it compiles, types are correct
      const mockImplementation: PatchesStore = {
        trackDocs: async (docIds: string[]) => {},
        untrackDocs: async (docIds: string[]) => {},
        listDocs: async (includeDeleted?: boolean) => [],
        getDoc: async (docId: string) => undefined,
        getPendingChanges: async (docId: string) => [],
        getLastRevs: async (docId: string) => [0, 0],
        saveDoc: async (docId: string, docState: PatchesState) => {},
        savePendingChanges: async (docId: string, changes: Change[]) => {},
        saveCommittedChanges: async (docId: string, changes: Change[], sentPendingRange?: [number, number]) => {},
        replacePendingChanges: async (docId: string, changes: Change[]) => {},
        deleteDoc: async (docId: string) => {},
        confirmDeleteDoc: async (docId: string) => {},
        close: async () => {},
      };

      expect(mockImplementation).toBeDefined();
    });
  });

  describe('interface type safety', () => {
    it('should ensure TrackedDoc type safety', () => {
      // Valid TrackedDoc objects
      const doc1: TrackedDoc = { docId: 'test', committedRev: 5 };
      const doc2: TrackedDoc = { docId: 'test', committedRev: 0, deleted: true };

      expect(doc1.docId).toBe('test');
      expect(doc2.deleted).toBe(true);
    });

    it('should ensure PatchesStore method return types', async () => {
      const store: PatchesStore = createMockStore();

      // Test return types are as expected
      const docs: TrackedDoc[] = await store.listDocs();
      const snapshot: PatchesSnapshot | undefined = await store.getDoc('test');
      const pending: Change[] = await store.getPendingChanges('test');
      const revs: [number, number] = await store.getLastRevs('test');

      expect(Array.isArray(docs)).toBe(true);
      expect(snapshot === undefined || typeof snapshot === 'object').toBe(true);
      expect(Array.isArray(pending)).toBe(true);
      expect(Array.isArray(revs)).toBe(true);
      expect(revs).toHaveLength(2);
    });
  });

  describe('interface semantics', () => {
    it('should define interface for pluggable persistence layer', () => {
      // The interface should be implementable by different storage backends
      const memoryStore: PatchesStore = createMockStore();
      const indexedDBStore: PatchesStore = createMockStore();

      expect(memoryStore).toBeDefined();
      expect(indexedDBStore).toBeDefined();
    });

    it('should support document tracking lifecycle', async () => {
      const store = createMockStore();

      // Track documents
      await store.trackDocs(['doc1', 'doc2']);

      // List tracked documents
      const docs = await store.listDocs();
      expect(Array.isArray(docs)).toBe(true);

      // Untrack documents
      await store.untrackDocs(['doc1']);
    });

    it('should support document state management', async () => {
      const store = createMockStore();

      // Save document state
      const state: PatchesState = { state: { content: 'test' }, rev: 1 };
      await store.saveDoc('doc1', state);

      // Get document snapshot
      await store.getDoc('doc1');

      // Manage pending changes
      const changes: Change[] = [
        {
          id: 'c1',
          rev: 2,
          baseRev: 1,
          ops: [{ op: 'replace', path: '/content', value: 'updated' }],
          created: Date.now(),
        },
      ];

      await store.savePendingChanges('doc1', changes);
      await store.getPendingChanges('doc1');
      await store.replacePendingChanges('doc1', []);
    });

    it('should support document deletion lifecycle', async () => {
      const store = createMockStore();

      // Delete document (create tombstone)
      await store.deleteDoc('doc1');

      // Confirm deletion (remove tombstone)
      await store.confirmDeleteDoc('doc1');
    });
  });

  const createMockStore = (): PatchesStore => ({
    trackDocs: async () => {},
    untrackDocs: async () => {},
    listDocs: async () => [],
    getDoc: async () => undefined,
    getPendingChanges: async () => [],
    getLastRevs: async () => [0, 0],
    saveDoc: async () => {},
    savePendingChanges: async () => {},
    saveCommittedChanges: async () => {},
    replacePendingChanges: async () => {},
    deleteDoc: async () => {},
    confirmDeleteDoc: async () => {},
    close: async () => {},
  });
});
