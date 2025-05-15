import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexedDBStore } from '../../src/client/IndexedDBStore';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change } from '../../src/types';

const TEST_DB_NAME = 'test-db';
const TEST_TIMEOUT = 1000; // Increased timeout

describe('IndexedDBStore', () => {
  let store: IndexedDBStore;

  beforeEach(async () => {
    // Reset IndexedDB for a fresh state
    indexedDB = new IDBFactory();

    // Create a new store instance
    store = new IndexedDBStore(TEST_DB_NAME);

    // Wait for initialization
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Database initialization timeout'));
      }, TEST_TIMEOUT);

      (store as any).dbPromise.promise
        .then(() => {
          clearTimeout(timeout);
          resolve();
        })
        .catch(reject);
    });
  });

  afterEach(async () => {
    // Close the database connection
    if (store) {
      await store.close();
    }

    // Delete test database
    try {
      await store.deleteDB();
    } catch (error) {
      // console.warn('Failed to delete database, continuing anyway');
      indexedDB = new IDBFactory();
    }
  });

  describe('Document Operations', () => {
    it('should store and retrieve document snapshots', async () => {
      const docId = 'test-doc';
      const snapshot = { content: 'test content' };
      const change: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '', value: snapshot } as JSONPatchOp],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
        metadata: {},
      };

      await store.saveCommittedChanges(docId, [change]);
      const retrieved = await store.getDoc(docId);

      expect(retrieved?.state).toEqual(snapshot);
    });

    it('should handle document deletion', async () => {
      const docId = 'test-doc';
      const snapshot = { content: 'test content' };
      const change: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/', value: snapshot } as JSONPatchOp],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
        metadata: {},
      };

      await store.saveCommittedChanges(docId, [change]);
      await store.deleteDoc(docId);
      const retrieved = await store.getDoc(docId);

      expect(retrieved).toBeUndefined();
    });
  });

  describe('Change Management', () => {
    it('should store and retrieve pending changes', async () => {
      const docId = 'test-doc';
      const change: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/content', value: 'new content' } as JSONPatchOp],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
        metadata: {},
      };

      await store.savePendingChange(docId, change);
      const changes = await store.getPendingChanges(docId);

      expect(changes).toHaveLength(1);
      // Remove docId from the returned change for comparison
      const { docId: _, ...returnedChange } = changes[0] as any;
      expect(returnedChange).toEqual(change);
    });

    it('should handle committed changes', async () => {
      const docId = 'test-doc';
      const change: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/content', value: 'new content' } as JSONPatchOp],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
        metadata: {},
      };

      await store.savePendingChange(docId, change);
      await store.saveCommittedChanges(docId, [change], [1, 1]);
      const pending = await store.getPendingChanges(docId);

      expect(pending).toHaveLength(0);
    });

    it('should track revisions correctly', async () => {
      const docId = 'test-doc';
      const changes: Change[] = [
        {
          id: 'change-1',
          ops: [{ op: 'add', path: '/content', value: 'content 1' } as JSONPatchOp],
          rev: 1,
          baseRev: 0,
          created: Date.now(),
          metadata: {},
        },
        {
          id: 'change-2',
          ops: [{ op: 'replace', path: '/content', value: 'content 2' } as JSONPatchOp],
          rev: 2,
          baseRev: 1,
          created: Date.now(),
          metadata: {},
        },
      ];

      await store.savePendingChange(docId, changes[0]);
      await store.savePendingChange(docId, changes[1]);
      await store.saveCommittedChanges(docId, changes, [1, 2]);

      const pending = await store.getPendingChanges(docId);
      expect(pending).toHaveLength(0);
    });
  });

  describe('Document Tracking', () => {
    it('should track and list documents', async () => {
      const docIds = ['doc-1', 'doc-2', 'doc-3'];

      await store.trackDocs(docIds);
      const docs = await store.listDocs();

      expect(docs).toHaveLength(3);
      expect(docs.map(d => d.docId)).toEqual(expect.arrayContaining(docIds));
    });

    it('should untrack documents', async () => {
      const docIds = ['doc-1', 'doc-2', 'doc-3'];

      await store.trackDocs(docIds);
      await store.untrackDocs(['doc-2']);
      const docs = await store.listDocs();

      expect(docs).toHaveLength(2);
      expect(docs.map(d => d.docId)).toEqual(expect.arrayContaining(['doc-1', 'doc-3']));
    });

    it('should handle deleted documents in listing', async () => {
      const docIds = ['doc-1', 'doc-2', 'doc-3'];

      await store.trackDocs(docIds);
      await store.deleteDoc('doc-2');

      const activeDocs = await store.listDocs(false);
      const allDocs = await store.listDocs(true);

      expect(activeDocs).toHaveLength(2);
      expect(allDocs).toHaveLength(3);
      expect(allDocs.find(d => d.docId === 'doc-2')?.deleted).toBe(true);
    });
  });

  describe('Revision Management', () => {
    it('should return correct revision numbers', async () => {
      const docId = 'test-doc';
      const changes: Change[] = [
        {
          id: 'change-1',
          ops: [{ op: 'add', path: '/content', value: 'content 1' } as JSONPatchOp],
          rev: 1,
          baseRev: 0,
          created: Date.now(),
          metadata: {},
        },
        {
          id: 'change-2',
          ops: [{ op: 'replace', path: '/content', value: 'content 2' } as JSONPatchOp],
          rev: 2,
          baseRev: 1,
          created: Date.now(),
          metadata: {},
        },
      ];

      await store.saveCommittedChanges(docId, changes);
      const [committedRev, pendingRev] = await store.getLastRevs(docId);

      expect(committedRev).toBe(2);
      expect(pendingRev).toBe(2);
    });

    it('should track pending revisions separately', async () => {
      const docId = 'test-doc';
      const committedChange: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/content', value: 'content 1' } as JSONPatchOp],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
        metadata: {},
      };

      const pendingChange: Change = {
        id: 'change-2',
        ops: [{ op: 'replace', path: '/content', value: 'content 2' } as JSONPatchOp],
        rev: 2,
        baseRev: 1,
        created: Date.now(),
        metadata: {},
      };

      await store.saveCommittedChanges(docId, [committedChange]);
      await store.savePendingChange(docId, pendingChange);

      const [committedRev, pendingRev] = await store.getLastRevs(docId);

      expect(committedRev).toBe(1);
      expect(pendingRev).toBe(2);
    });
  });
});
