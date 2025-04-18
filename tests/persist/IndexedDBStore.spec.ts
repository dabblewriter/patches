import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSONPatchOp } from '../../src/json-patch/types';
import { IndexedDBStore } from '../../src/persist/IndexedDBStore';
import { Change } from '../../src/types';

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

      (store as any).dbPromise
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
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(TEST_DB_NAME);
      const timeout = setTimeout(() => {
        reject(new Error('Database deletion timeout'));
      }, TEST_TIMEOUT);

      request.onsuccess = () => {
        clearTimeout(timeout);
        resolve();
      };

      request.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to delete database'));
      };

      request.onblocked = () => {
        clearTimeout(timeout);
        reject(new Error('Database deletion blocked - connections still open'));
      };
    });
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

      await store.savePendingChanges(docId, [change]);
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

      await store.savePendingChanges(docId, [change]);
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

      await store.savePendingChanges(docId, [changes[0]]);
      await store.savePendingChanges(docId, [changes[1]]);
      await store.saveCommittedChanges(docId, changes, [1, 2]);

      const pending = await store.getPendingChanges(docId);
      expect(pending).toHaveLength(0);
    });
  });

  describe('Event Handling', () => {
    it('should emit events when pending changes are saved', async () => {
      const docId = 'test-doc';
      const change: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/content', value: 'new content' } as JSONPatchOp],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
        metadata: {},
      };

      const handler = vi.fn();
      store.onPendingChanges(handler);

      await store.savePendingChanges(docId, [change]);

      // Wait for event to be processed
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(handler).toHaveBeenCalledWith(docId, [change]);
      expect(handler).toHaveBeenCalledTimes(1);

      // Test multiple changes
      const change2: Change = {
        id: 'change-2',
        ops: [{ op: 'replace', path: '/content', value: 'updated content' } as JSONPatchOp],
        rev: 2,
        baseRev: 1,
        created: Date.now(),
        metadata: {},
      };

      await store.savePendingChanges(docId, [change2]);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(handler).toHaveBeenCalledWith(docId, [change2]);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
