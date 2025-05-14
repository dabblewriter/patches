import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '../../src/client/InMemoryStore';
import type { Change } from '../../src/types';

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  describe('Document Operations', () => {
    it('should store and retrieve document state', async () => {
      const docId = 'test-doc';
      const change: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/content', value: 'test content' }],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
      };

      await store.saveCommittedChanges(docId, [change]);
      const doc = await store.getDoc(docId);

      expect(doc).toBeDefined();
      expect(doc?.state).toEqual({ content: 'test content' });
      expect(doc?.rev).toBe(1);
    });

    it('should handle empty document state', async () => {
      const docId = 'empty-doc';
      const doc = await store.getDoc(docId);

      expect(doc).toBeUndefined();
    });

    it('should not return deleted documents', async () => {
      const docId = 'deleted-doc';
      const change: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/content', value: 'test content' }],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
      };

      await store.saveCommittedChanges(docId, [change]);
      await store.deleteDoc(docId);
      const doc = await store.getDoc(docId);

      expect(doc).toBeUndefined();
    });
  });

  describe('Change Management', () => {
    it('should store and retrieve pending changes', async () => {
      const docId = 'test-doc';
      const change: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/content', value: 'test content' }],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
      };

      await store.savePendingChanges(docId, [change]);
      const pendingChanges = await store.getPendingChanges(docId);

      expect(pendingChanges).toHaveLength(1);
      expect(pendingChanges[0]).toEqual(change);
    });

    it('should handle committed changes and remove pending changes', async () => {
      const docId = 'test-doc';
      const pendingChange: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/content', value: 'test content' }],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
      };

      await store.savePendingChanges(docId, [pendingChange]);
      await store.saveCommittedChanges(docId, [pendingChange], [1, 1]);
      const pendingChanges = await store.getPendingChanges(docId);

      expect(pendingChanges).toHaveLength(0);
    });

    it('should track revisions correctly', async () => {
      const docId = 'test-doc';
      const changes: Change[] = [
        {
          id: 'change-1',
          ops: [{ op: 'add', path: '/content', value: 'content 1' }],
          rev: 1,
          baseRev: 0,
          created: Date.now(),
        },
        {
          id: 'change-2',
          ops: [{ op: 'replace', path: '/content', value: 'content 2' }],
          rev: 2,
          baseRev: 1,
          created: Date.now(),
        },
      ];

      await store.saveCommittedChanges(docId, changes);
      const [committedRev, pendingRev] = await store.getLastRevs(docId);

      expect(committedRev).toBe(2);
      expect(pendingRev).toBe(2);
    });

    it('should rebase pending changes when committed changes arrive', async () => {
      const docId = 'test-doc';

      // First, save a committed change
      const committedChange: Change = {
        id: 'committed-1',
        ops: [{ op: 'add', path: '/content', value: 'initial content' }],
        rev: 1,
        baseRev: 0,
        created: Date.now() - 1000,
      };
      await store.saveCommittedChanges(docId, [committedChange]);

      // Then save a pending change based on the initial state
      const pendingChange: Change = {
        id: 'pending-1',
        ops: [{ op: 'replace', path: '/content', value: 'updated content' }],
        rev: 2,
        baseRev: 1,
        created: Date.now(),
      };
      await store.savePendingChanges(docId, [pendingChange]);

      // Now save a new committed change that would conflict
      const newCommittedChange: Change = {
        id: 'committed-2',
        ops: [{ op: 'replace', path: '/content', value: 'server content' }],
        rev: 2,
        baseRev: 1,
        created: Date.now() - 500,
      };
      await store.saveCommittedChanges(docId, [newCommittedChange]);

      // Get the document - pending changes should be rebased
      const doc = await store.getDoc(docId);

      expect(doc).toBeDefined();
      expect(doc?.state).toEqual({ content: 'server content' });
      expect(doc?.changes).toHaveLength(1); // The rebased pending change
      expect(doc?.changes[0].rev).toBe(3); // Rev should be incremented
      expect(doc?.changes[0].baseRev).toBe(1); // BaseRev should remain the same
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

  describe('Event Handling', () => {
    it('should emit events when pending changes are saved', async () => {
      const docId = 'test-doc';
      const change: Change = {
        id: 'change-1',
        ops: [{ op: 'add', path: '/content', value: 'test content' }],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
      };

      const handler = vi.fn();
      store.onPendingChanges(handler);

      await store.savePendingChanges(docId, [change]);

      expect(handler).toHaveBeenCalledWith(docId, [change]);
    });
  });

  describe('Lifecycle', () => {
    it('should have a no-op close method', async () => {
      // This is just for API compatibility with other stores
      await expect(store.close()).resolves.toBeUndefined();
    });
  });
});
