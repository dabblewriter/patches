import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryStore } from '../../src/client/InMemoryStore';
import type { Change, PatchesState } from '../../src/types';

// Mock the dependencies
vi.mock('../../src/algorithms/shared/applyChanges');
vi.mock('../../src/json-patch/transformPatch');

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  const createChange = (id: string, rev: number, baseRev = rev - 1): Change => ({
    id,
    rev,
    baseRev,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    createdAt: new Date().toISOString(),
    committedAt: new Date().toISOString(),
  });

  const createState = (data: any, rev: number): PatchesState => ({
    state: data,
    rev,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    store = new InMemoryStore();

    // Mock applyChanges
    const { applyChanges } = await import('../../src/algorithms/shared/applyChanges');
    vi.mocked(applyChanges).mockImplementation((state: any, changes: any) => ({
      ...(state || {}),
      appliedChanges: changes.length,
    }));

    // Mock transformPatch
    const { transformPatch } = await import('../../src/json-patch/transformPatch');
    vi.mocked(transformPatch).mockImplementation((state, patch, ops) => ops);
  });

  describe('getDoc', () => {
    it('should return undefined for non-existent document', async () => {
      const result = await store.getDoc('non-existent');
      expect(result).toBeUndefined();
    });

    it('should return undefined for deleted document', async () => {
      await store.deleteDoc('doc1');
      const result = await store.getDoc('doc1');
      expect(result).toBeUndefined();
    });

    it('should return document with snapshot only', async () => {
      const snapshot = createState({ text: 'hello' }, 5);
      await store.saveDoc('doc1', snapshot);

      const result = await store.getDoc('doc1');

      expect(result).toEqual({
        state: { text: 'hello', appliedChanges: 0 },
        rev: 5,
        changes: [],
      });
    });

    it('should return document with committed changes applied', async () => {
      const snapshot = createState({ text: 'hello' }, 5);
      const changes = [createChange('c1', 6), createChange('c2', 7)];

      await store.saveDoc('doc1', snapshot);
      await store.saveCommittedChanges('doc1', changes);

      const result = await store.getDoc('doc1');

      expect(result).toEqual({
        state: { text: 'hello', appliedChanges: 2 },
        rev: 7,
        changes: [],
      });
    });

    it('should include pending changes in result', async () => {
      const snapshot = createState({ text: 'hello' }, 5);
      const pending = [createChange('p1', 6), createChange('p2', 7)];

      await store.saveDoc('doc1', snapshot);
      await store.savePendingChanges('doc1', pending);

      const result = await store.getDoc('doc1');

      expect(result?.changes).toEqual(pending);
    });

    it('should rebase stale pending changes', async () => {
      const snapshot = createState({ text: 'hello' }, 5);
      const committed = [createChange('c1', 6), createChange('c2', 7)];
      const pending = [createChange('p1', 6, 5)]; // Based on old revision

      await store.saveDoc('doc1', snapshot);
      await store.saveCommittedChanges('doc1', committed);
      await store.savePendingChanges('doc1', pending);

      const result = await store.getDoc('doc1');

      expect(result?.changes[0].rev).toBe(8); // Should be rebased
      expect(result?.changes[0].baseRev).toBe(5);
    });

    it('should handle document with no snapshot', async () => {
      const committed = [createChange('c1', 1), createChange('c2', 2)];
      await store.saveCommittedChanges('doc1', committed);

      const result = await store.getDoc('doc1');

      expect(result).toEqual({
        state: { appliedChanges: 2 },
        rev: 2,
        changes: [],
      });
    });
  });

  describe('getPendingChanges', () => {
    it('should return empty array for non-existent document', async () => {
      const result = await store.getPendingChanges('non-existent');
      expect(result).toEqual([]);
    });

    it('should return pending changes', async () => {
      const pending = [createChange('p1', 6), createChange('p2', 7)];
      await store.savePendingChanges('doc1', pending);

      const result = await store.getPendingChanges('doc1');
      expect(result).toEqual(pending);
    });

    it('should return copy of pending changes array', async () => {
      const pending = [createChange('p1', 6)];
      await store.savePendingChanges('doc1', pending);

      const result = await store.getPendingChanges('doc1');
      result.push(createChange('extra', 999));

      const result2 = await store.getPendingChanges('doc1');
      expect(result2).toHaveLength(1); // Array should not be modified
      expect(result2[0].id).toBe('p1');
    });
  });

  describe('getLastRevs', () => {
    it('should return [0, 0] for non-existent document', async () => {
      const result = await store.getLastRevs('non-existent');
      expect(result).toEqual([0, 0]);
    });

    it('should return revision from snapshot only', async () => {
      const snapshot = createState({ text: 'hello' }, 5);
      await store.saveDoc('doc1', snapshot);

      const result = await store.getLastRevs('doc1');
      expect(result).toEqual([5, 5]);
    });

    it('should return committed and pending revisions', async () => {
      const committed = [createChange('c1', 3), createChange('c2', 4)];
      const pending = [createChange('p1', 5), createChange('p2', 6)];

      await store.saveCommittedChanges('doc1', committed);
      await store.savePendingChanges('doc1', pending);

      const result = await store.getLastRevs('doc1');
      expect(result).toEqual([4, 6]);
    });

    it('should handle empty buffers', async () => {
      await store.trackDocs(['doc1']);

      const result = await store.getLastRevs('doc1');
      expect(result).toEqual([0, 0]);
    });
  });

  describe('listDocs', () => {
    it('should return empty array when no documents', async () => {
      const result = await store.listDocs();
      expect(result).toEqual([]);
    });

    it('should list tracked documents', async () => {
      const snapshot = createState({ text: 'hello' }, 5);
      await store.saveDoc('doc1', snapshot);
      await store.trackDocs(['doc2']);

      const result = await store.listDocs();
      expect(result).toHaveLength(2);
      expect(result.find(d => d.docId === 'doc1')?.committedRev).toBe(5);
      expect(result.find(d => d.docId === 'doc2')?.committedRev).toBe(0);
    });

    it('should exclude deleted documents by default', async () => {
      await store.trackDocs(['doc1', 'doc2']);
      await store.deleteDoc('doc1');

      const result = await store.listDocs();
      expect(result).toHaveLength(1);
      expect(result[0].docId).toBe('doc2');
    });

    it('should include deleted documents when requested', async () => {
      await store.trackDocs(['doc1', 'doc2']);
      await store.deleteDoc('doc1');

      const result = await store.listDocs(true);
      expect(result).toHaveLength(2);
      expect(result.find(d => d.docId === 'doc1')?.deleted).toBe(true);
    });
  });

  describe('saveDoc', () => {
    it('should save document snapshot', async () => {
      const snapshot = createState({ text: 'hello' }, 5);
      await store.saveDoc('doc1', snapshot);

      const result = await store.getDoc('doc1');
      expect(result?.rev).toBe(5);
    });

    it('should reset committed and pending changes', async () => {
      await store.savePendingChanges('doc1', [createChange('p1', 1)]);
      await store.saveCommittedChanges('doc1', [createChange('c1', 2)]);

      const snapshot = createState({ text: 'hello' }, 5);
      await store.saveDoc('doc1', snapshot);

      const result = await store.getDoc('doc1');
      expect(result?.changes).toEqual([]);
    });
  });

  describe('savePendingChanges', () => {
    it('should save pending changes to new document', async () => {
      const changes = [createChange('p1', 1), createChange('p2', 2)];
      await store.savePendingChanges('doc1', changes);

      const result = await store.getPendingChanges('doc1');
      expect(result).toEqual(changes);
    });

    it('should append to existing pending changes', async () => {
      const initial = [createChange('p1', 1)];
      const additional = [createChange('p2', 2)];

      await store.savePendingChanges('doc1', initial);
      await store.savePendingChanges('doc1', additional);

      const result = await store.getPendingChanges('doc1');
      expect(result).toEqual([...initial, ...additional]);
    });
  });

  describe('saveCommittedChanges', () => {
    it('should save committed changes', async () => {
      const changes = [createChange('c1', 1), createChange('c2', 2)];
      await store.saveCommittedChanges('doc1', changes);

      const [committedRev] = await store.getLastRevs('doc1');
      expect(committedRev).toBe(2);
    });

    it('should remove sent pending changes when range provided', async () => {
      const pending = [createChange('p1', 1), createChange('p2', 2), createChange('p3', 3)];
      const committed = [createChange('c1', 4)];

      await store.savePendingChanges('doc1', pending);
      await store.saveCommittedChanges('doc1', committed, [1, 2]); // Remove p1 and p2

      const remainingPending = await store.getPendingChanges('doc1');
      expect(remainingPending).toHaveLength(1);
      expect(remainingPending[0].id).toBe('p3');
    });
  });

  describe('replacePendingChanges', () => {
    it('should replace all pending changes', async () => {
      const initial = [createChange('p1', 1), createChange('p2', 2)];
      const replacement = [createChange('p3', 3)];

      await store.savePendingChanges('doc1', initial);
      await store.replacePendingChanges('doc1', replacement);

      const result = await store.getPendingChanges('doc1');
      expect(result).toEqual(replacement);
    });
  });

  describe('trackDocs', () => {
    it('should track new documents', async () => {
      await store.trackDocs(['doc1', 'doc2']);

      const docs = await store.listDocs();
      expect(docs).toHaveLength(2);
    });

    it('should unmark deleted documents', async () => {
      await store.deleteDoc('doc1');
      await store.trackDocs(['doc1']);

      const docs = await store.listDocs();
      expect(docs.find(d => d.docId === 'doc1')?.deleted).toBeUndefined();
    });
  });

  describe('untrackDocs', () => {
    it('should remove documents from tracking', async () => {
      await store.trackDocs(['doc1', 'doc2', 'doc3']);
      await store.untrackDocs(['doc1', 'doc3']);

      const docs = await store.listDocs();
      expect(docs).toHaveLength(1);
      expect(docs[0].docId).toBe('doc2');
    });
  });

  describe('deleteDoc', () => {
    it('should mark document as deleted', async () => {
      await store.trackDocs(['doc1']);
      await store.deleteDoc('doc1');

      const result = await store.getDoc('doc1');
      expect(result).toBeUndefined();

      const docs = await store.listDocs(true);
      expect(docs.find(d => d.docId === 'doc1')?.deleted).toBe(true);
    });

    it('should clear document data', async () => {
      const snapshot = createState({ text: 'hello' }, 5);
      await store.saveDoc('doc1', snapshot);
      await store.savePendingChanges('doc1', [createChange('p1', 6)]);
      await store.saveCommittedChanges('doc1', [createChange('c1', 7)]);

      await store.deleteDoc('doc1');

      const docs = await store.listDocs(true);
      const doc = docs.find(d => d.docId === 'doc1');
      expect(doc?.committedRev).toBe(0);
    });
  });

  describe('confirmDeleteDoc', () => {
    it('should permanently remove document', async () => {
      await store.trackDocs(['doc1']);
      await store.deleteDoc('doc1');
      await store.confirmDeleteDoc('doc1');

      const docs = await store.listDocs(true);
      expect(docs.find(d => d.docId === 'doc1')).toBeUndefined();
    });
  });

  describe('close', () => {
    it('should clear all documents', async () => {
      await store.trackDocs(['doc1', 'doc2']);
      await store.close();

      const docs = await store.listDocs();
      expect(docs).toEqual([]);
    });
  });
});
