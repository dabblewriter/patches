import { describe, it, expect, beforeEach } from 'vitest';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import type { Change, PatchesState } from '../../src/types';
import type { JSONPatchOp } from '../../src/json-patch/types';

describe('LWWInMemoryStore', () => {
  let store: LWWInMemoryStore;

  const createChange = (
    id: string,
    rev: number,
    baseRev = rev - 1,
    ops: JSONPatchOp[] = [{ op: 'replace', path: `/field-${id}`, value: `data-${id}`, ts: Date.now() }]
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

  beforeEach(() => {
    store = new LWWInMemoryStore();
  });

  describe('constructor and initialization', () => {
    it('should create store instance', () => {
      expect(store).toBeInstanceOf(LWWInMemoryStore);
    });
  });

  describe('getDoc', () => {
    it('should return undefined for non-existent document', async () => {
      const result = await store.getDoc('non-existent');
      expect(result).toBeUndefined();
    });

    it('should return undefined for deleted document', async () => {
      await store.saveDoc('doc1', createState({ title: 'Hello' }, 5));
      await store.deleteDoc('doc1');
      const result = await store.getDoc('doc1');
      expect(result).toBeUndefined();
    });

    it('should reconstruct document from snapshot only', async () => {
      await store.saveDoc('doc1', createState({ title: 'Hello' }, 5));
      const result = await store.getDoc('doc1');

      expect(result).toBeDefined();
      expect(result?.state).toEqual({ title: 'Hello' });
      expect(result?.rev).toBe(5);
      expect(result?.changes).toEqual([]);
    });

    it('should apply committed fields to snapshot', async () => {
      await store.saveDoc('doc1', createState({ title: 'Hello' }, 5));
      await store.applyServerChanges('doc1', [
        createChange('c1', 6, 5, [{ op: 'replace', path: '/name', value: 'World', ts: Date.now() }]),
      ]);

      const result = await store.getDoc('doc1');
      expect(result?.state).toEqual({ title: 'Hello', name: 'World' });
      expect(result?.rev).toBe(6);
    });

    it('should apply sending change ops', async () => {
      await store.saveDoc('doc1', createState({ count: 10 }, 5));
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }]);

      // Create and save sending change
      const pendingOps = await store.getPendingOps('doc1');
      const change = createChange('send1', 6, 5, pendingOps);
      await store.saveSendingChange('doc1', change);

      const result = await store.getDoc('doc1');
      expect(result?.state.count).toBe(15);
    });

    it('should apply pending ops', async () => {
      await store.saveDoc('doc1', createState({ count: 10 }, 5));
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/count', value: 3, ts: Date.now() }]);

      const result = await store.getDoc('doc1');
      expect(result?.state.count).toBe(13);
      expect(result?.changes).toHaveLength(1);
    });

    it('should handle @inc operation', async () => {
      await store.saveDoc('doc1', createState({ count: 0 }, 0));
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }]);

      const result = await store.getDoc('doc1');
      expect(result?.state.count).toBe(5);
    });

    it('should handle @bit operation', async () => {
      await store.saveDoc('doc1', createState({ flags: 0b0101 }, 0));
      await store.savePendingOps('doc1', [{ op: '@bit', path: '/flags', value: 0b1010, ts: Date.now() }]);

      const result = await store.getDoc('doc1');
      expect(result?.state.flags).toBe(0b1111);
    });

    it('should handle @max operation', async () => {
      await store.saveDoc('doc1', createState({ score: 50 }, 0));
      await store.savePendingOps('doc1', [{ op: '@max', path: '/score', value: 100, ts: Date.now() }]);

      const result = await store.getDoc('doc1');
      expect(result?.state.score).toBe(100);
    });

    it('should not apply @max if value is lower', async () => {
      await store.saveDoc('doc1', createState({ score: 100 }, 0));
      await store.savePendingOps('doc1', [{ op: '@max', path: '/score', value: 50, ts: Date.now() }]);

      const result = await store.getDoc('doc1');
      expect(result?.state.score).toBe(100);
    });

    it('should handle nested paths correctly', async () => {
      await store.saveDoc('doc1', createState({ user: { name: 'Alice' } }, 5));
      await store.savePendingOps('doc1', [
        { op: 'replace', path: '/user/email', value: 'alice@example.com', ts: Date.now() },
      ]);

      const result = await store.getDoc('doc1');
      expect(result?.state).toEqual({
        user: {
          name: 'Alice',
          email: 'alice@example.com',
        },
      });
    });

    it('should create intermediate objects for deeply nested paths', async () => {
      await store.saveDoc('doc1', createState({}, 0));
      await store.savePendingOps('doc1', [{ op: 'replace', path: '/a/b/c', value: 'deep', ts: Date.now() }]);

      const result = await store.getDoc('doc1');
      expect(result?.state).toEqual({ a: { b: { c: 'deep' } } });
    });
  });

  describe('saveDoc', () => {
    it('should save document snapshot', async () => {
      await store.saveDoc('doc1', createState({ title: 'Hello' }, 5));
      const result = await store.getDoc('doc1');
      expect(result?.state).toEqual({ title: 'Hello' });
      expect(result?.rev).toBe(5);
    });

    it('should preserve pending ops across saveDoc (DAB-507 Bug 1)', async () => {
      // saveDoc updates the committed snapshot but must keep local edits the user
      // hasn't sent yet — otherwise PatchesSync's fresh-fetch / docReloadRequired
      // paths silently drop concurrent local writes.
      await store.saveDoc('doc1', createState({ count: 10 }, 5));
      const op: JSONPatchOp = { op: '@inc', path: '/count', value: 5, ts: Date.now() };
      await store.savePendingOps('doc1', [op]);

      // Server delivers a fresher snapshot; PatchesSync re-saves it via saveDoc.
      await store.saveDoc('doc1', createState({ count: 20 }, 6));

      const result = await store.getDoc('doc1');
      // Snapshot bumped, pending op preserved and re-applied on top.
      expect(result?.rev).toBe(6);
      expect(result?.changes).toHaveLength(1);
      const pending = await store.getPendingOps('doc1');
      expect(pending).toHaveLength(1);
      expect(pending[0].path).toBe('/count');
    });

    it('should preserve sending change across saveDoc (DAB-507 Bug 1)', async () => {
      await store.saveDoc('doc1', createState({ count: 10 }, 5));
      const change = createChange('send1', 6, 5, [{ op: 'replace', path: '/count', value: 15, ts: Date.now() }]);
      await store.saveSendingChange('doc1', change);

      await store.saveDoc('doc1', createState({ count: 20 }, 6));

      const sending = await store.getSendingChange('doc1');
      expect(sending).not.toBeNull();
      expect(sending?.id).toBe('send1');
    });
  });

  describe('getPendingOps', () => {
    it('should return empty array for non-existent document', async () => {
      const result = await store.getPendingOps('non-existent');
      expect(result).toEqual([]);
    });

    it('should return all pending ops when no filter', async () => {
      await store.trackDocs(['doc1']);
      await store.savePendingOps('doc1', [
        { op: 'replace', path: '/title', value: 'Test', ts: Date.now() },
        { op: '@inc', path: '/count', value: 5, ts: Date.now() },
      ]);

      const result = await store.getPendingOps('doc1');
      expect(result).toHaveLength(2);
    });

    it('should filter by path prefixes', async () => {
      await store.trackDocs(['doc1']);
      await store.savePendingOps('doc1', [
        { op: 'replace', path: '/user/name', value: 'Alice', ts: Date.now() },
        { op: 'replace', path: '/user/email', value: 'alice@test.com', ts: Date.now() },
        { op: '@inc', path: '/count', value: 5, ts: Date.now() },
      ]);

      const result = await store.getPendingOps('doc1', ['/user']);
      expect(result).toHaveLength(2);
      expect(result.every(op => op.path.startsWith('/user'))).toBe(true);
    });

    it('should match exact paths in prefix filter', async () => {
      await store.trackDocs(['doc1']);
      await store.savePendingOps('doc1', [
        { op: 'replace', path: '/user', value: { name: 'Alice' }, ts: Date.now() },
        { op: 'replace', path: '/userCount', value: 10, ts: Date.now() },
      ]);

      const result = await store.getPendingOps('doc1', ['/user']);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/user');
    });
  });

  describe('savePendingOps', () => {
    it('should save new pending ops', async () => {
      await store.trackDocs(['doc1']);
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }]);

      const result = await store.getDoc('doc1');
      expect(result?.state.count).toBe(5);
    });

    it('should overwrite existing ops at same path', async () => {
      await store.trackDocs(['doc1']);
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/count', value: 3, ts: Date.now() }]);
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }]);

      // Only the last op is stored (keyed by path)
      const ops = await store.getPendingOps('doc1');
      expect(ops).toHaveLength(1);
      expect(ops[0].value).toBe(5);
    });

    it('should delete specified paths', async () => {
      await store.trackDocs(['doc1']);
      await store.savePendingOps('doc1', [
        { op: 'replace', path: '/user/name', value: 'Alice', ts: Date.now() },
        { op: 'replace', path: '/user/email', value: 'alice@test.com', ts: Date.now() },
      ]);

      await store.savePendingOps(
        'doc1',
        [{ op: 'replace', path: '/user', value: { full: 'Bob' }, ts: Date.now() }],
        ['/user/name', '/user/email']
      );

      const ops = await store.getPendingOps('doc1');
      expect(ops).toHaveLength(1);
      expect(ops[0].path).toBe('/user');
    });

    it('should create doc if not exists', async () => {
      await store.savePendingOps('doc1', [{ op: 'replace', path: '/title', value: 'Test', ts: Date.now() }]);

      const docs = await store.listDocs();
      expect(docs.find(d => d.docId === 'doc1')).toBeDefined();
    });
  });

  describe('getSendingChange', () => {
    it('should return null for non-existent document', async () => {
      const result = await store.getSendingChange('non-existent');
      expect(result).toBeNull();
    });

    it('should return null when no sending change', async () => {
      await store.trackDocs(['doc1']);
      const result = await store.getSendingChange('doc1');
      expect(result).toBeNull();
    });

    it('should return the saved sending change', async () => {
      await store.trackDocs(['doc1']);
      const change = createChange('send1', 1, 0, [{ op: 'replace', path: '/title', value: 'Test', ts: Date.now() }]);
      await store.saveSendingChange('doc1', change);

      const result = await store.getSendingChange('doc1');
      expect(result?.id).toBe('send1');
    });
  });

  describe('saveSendingChange', () => {
    it('should save sending change', async () => {
      await store.trackDocs(['doc1']);
      const change = createChange('send1', 1, 0, [{ op: 'replace', path: '/title', value: 'Test', ts: Date.now() }]);
      await store.saveSendingChange('doc1', change);

      const result = await store.getSendingChange('doc1');
      expect(result?.id).toBe('send1');
    });

    it('should clear all pending ops atomically', async () => {
      await store.trackDocs(['doc1']);
      await store.savePendingOps('doc1', [
        { op: 'replace', path: '/title', value: 'Test', ts: Date.now() },
        { op: '@inc', path: '/count', value: 5, ts: Date.now() },
      ]);

      const change = createChange('send1', 1, 0, await store.getPendingOps('doc1'));
      await store.saveSendingChange('doc1', change);

      const remainingOps = await store.getPendingOps('doc1');
      expect(remainingOps).toHaveLength(0);
    });

    it('should do nothing for non-existent document', async () => {
      const change = createChange('send1', 1, 0, []);
      await store.saveSendingChange('non-existent', change);
      // Should not throw
    });
  });

  describe('confirmSendingChange', () => {
    it('should do nothing if no sending change', async () => {
      await store.trackDocs(['doc1']);
      await store.confirmSendingChange('doc1');
      // Should complete without error
    });

    it('should move ops to committed fields', async () => {
      await store.saveDoc('doc1', createState({}, 5));
      const change = createChange('send1', 6, 5, [
        { op: 'replace', path: '/title', value: 'Confirmed', ts: Date.now() },
      ]);
      await store.saveSendingChange('doc1', change);
      await store.confirmSendingChange('doc1');

      const result = await store.getDoc('doc1');
      expect(result?.state.title).toBe('Confirmed');
      expect(result?.changes).toHaveLength(0);
    });

    it('does not advance committedRev (applyServerChanges owns it using the server rev)', async () => {
      // The sending change's rev is client-minted. On a noop commit the server head
      // does not advance, so bumping here would make the client skip the next real
      // revision on catchup. The server's echoed response (applied after confirm via
      // applyServerChanges) carries the true head rev.
      await store.saveDoc('doc1', createState({}, 5));
      const change = createChange('send1', 6, 5, [{ op: 'replace', path: '/title', value: 'Test', ts: Date.now() }]);
      await store.saveSendingChange('doc1', change);
      await store.confirmSendingChange('doc1');

      const rev = await store.getCommittedRev('doc1');
      expect(rev).toBe(5);
    });

    it('should delete sending change', async () => {
      await store.trackDocs(['doc1']);
      const change = createChange('send1', 1, 0, [{ op: 'replace', path: '/title', value: 'Test', ts: Date.now() }]);
      await store.saveSendingChange('doc1', change);
      await store.confirmSendingChange('doc1');

      const sendingChange = await store.getSendingChange('doc1');
      expect(sendingChange).toBeNull();
    });
  });

  describe('applyServerChanges', () => {
    it('should save server changes as committed fields', async () => {
      await store.saveDoc('doc1', createState({ title: 'Old' }, 5));
      await store.applyServerChanges('doc1', [
        createChange('c1', 6, 5, [{ op: 'replace', path: '/title', value: 'Server Title', ts: Date.now() }]),
      ]);

      const result = await store.getDoc('doc1');
      expect(result?.state.title).toBe('Server Title');
    });

    it('should preserve sending change (not clear it)', async () => {
      // Server changes are from other clients, not confirmation of our own change.
      // Only confirmSendingChange should clear sendingChange.
      await store.saveDoc('doc1', createState({ count: 10 }, 5));
      const change = createChange('send1', 6, 5, [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }]);
      await store.saveSendingChange('doc1', change);

      await store.applyServerChanges('doc1', [
        createChange('s1', 6, 5, [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }]),
      ]);

      const sendingChange = await store.getSendingChange('doc1');
      expect(sendingChange).not.toBeNull();
      expect(sendingChange?.id).toBe('send1');
    });

    it('should update committed rev', async () => {
      await store.saveDoc('doc1', createState({}, 5));
      await store.applyServerChanges('doc1', [createChange('c1', 6), createChange('c2', 7)]);

      const rev = await store.getCommittedRev('doc1');
      expect(rev).toBe(7);
    });

    it('should preserve pending ops (not clear them)', async () => {
      await store.saveDoc('doc1', createState({}, 5));
      await store.savePendingOps('doc1', [{ op: 'replace', path: '/local', value: 'Pending', ts: Date.now() }]);

      await store.applyServerChanges('doc1', [
        createChange('c1', 6, 5, [{ op: 'replace', path: '/server', value: 'Server', ts: Date.now() }]),
      ]);

      const pendingOps = await store.getPendingOps('doc1');
      expect(pendingOps).toHaveLength(1);
      expect(pendingOps[0].path).toBe('/local');
    });

    it('applies ops in commit order so an older parent op cannot prune a newer child op', async () => {
      // A flush response carries corrections before catchup ops, so a child
      // correction (rev 3) can precede a parent catchup op (rev 2). Applied
      // as-delivered, the parent's child-pruning would delete the newer value.
      await store.applyServerChanges('doc1', [
        createChange('c1', 3, 0, [
          { op: 'replace', path: '/settings/theme', value: 'dark', ts: 200, rev: 3 },
          { op: 'replace', path: '/settings', value: { theme: 'old', font: 'serif' }, ts: 100, rev: 2 },
        ]),
      ]);

      const doc = await store.getDoc('doc1');
      expect(doc?.state.settings).toEqual({ theme: 'dark', font: 'serif' });
    });

    it('applies ops in commit order so a newer parent op prunes an older child op', async () => {
      await store.applyServerChanges('doc1', [
        createChange('c1', 5, 0, [
          { op: 'replace', path: '/settings', value: { font: 'serif' }, ts: 500, rev: 5 },
          { op: 'replace', path: '/settings/theme', value: 'stale', ts: 300, rev: 3 },
        ]),
      ]);

      const doc = await store.getDoc('doc1');
      expect(doc?.state.settings).toEqual({ font: 'serif' });
    });
  });

  describe('deleteDoc', () => {
    it('should mark document as deleted', async () => {
      await store.saveDoc('doc1', createState({ title: 'Hello' }, 5));
      await store.deleteDoc('doc1');

      const docs = await store.listDocs(true);
      expect(docs.find(d => d.docId === 'doc1')?.deleted).toBe(true);
    });

    it('should clear all document data', async () => {
      await store.saveDoc('doc1', createState({ title: 'Hello' }, 5));
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }]);

      await store.deleteDoc('doc1');

      const result = await store.getDoc('doc1');
      expect(result).toBeUndefined();
    });
  });

  describe('confirmDeleteDoc', () => {
    it('should remove document entirely', async () => {
      await store.saveDoc('doc1', createState({ title: 'Hello' }, 5));
      await store.deleteDoc('doc1');
      await store.confirmDeleteDoc('doc1');

      const docs = await store.listDocs(true);
      expect(docs.find(d => d.docId === 'doc1')).toBeUndefined();
    });
  });

  describe('untrackDocs', () => {
    it('should remove all document data', async () => {
      await store.saveDoc('doc1', createState({ title: 'Hello' }, 5));
      await store.saveDoc('doc2', createState({ title: 'World' }, 5));

      await store.untrackDocs(['doc1', 'doc2']);

      const docs = await store.listDocs();
      expect(docs).toHaveLength(0);
    });
  });

  describe('trackDocs and listDocs', () => {
    it('should track new documents', async () => {
      await store.trackDocs(['doc1', 'doc2']);

      const docs = await store.listDocs();
      expect(docs).toHaveLength(2);
    });

    it('should unmark deleted documents', async () => {
      await store.saveDoc('doc1', createState({}, 0));
      await store.deleteDoc('doc1');
      await store.trackDocs(['doc1']);

      const docs = await store.listDocs();
      expect(docs.find(d => d.docId === 'doc1')?.deleted).toBeUndefined();
    });

    it('should list active documents', async () => {
      await store.saveDoc('doc1', createState({}, 0));
      await store.saveDoc('doc2', createState({}, 0));
      await store.deleteDoc('doc2');

      const docs = await store.listDocs();
      expect(docs).toHaveLength(1);
      expect(docs[0].docId).toBe('doc1');
    });

    it('should optionally include deleted', async () => {
      await store.saveDoc('doc1', createState({}, 0));
      await store.saveDoc('doc2', createState({}, 0));
      await store.deleteDoc('doc2');

      const docs = await store.listDocs(true);
      expect(docs).toHaveLength(2);
    });
  });

  describe('getCommittedRev', () => {
    it('should return 0 for non-existent document', async () => {
      const rev = await store.getCommittedRev('non-existent');
      expect(rev).toBe(0);
    });

    it('should return committed rev', async () => {
      await store.saveDoc('doc1', createState({}, 5));
      const rev = await store.getCommittedRev('doc1');
      expect(rev).toBe(5);
    });
  });

  describe('close', () => {
    it('should clear all documents', async () => {
      await store.saveDoc('doc1', createState({}, 0));
      await store.saveDoc('doc2', createState({}, 0));

      await store.close();

      const docs = await store.listDocs();
      expect(docs).toHaveLength(0);
    });
  });

  describe('complete workflow', () => {
    it('should handle full edit -> send -> confirm cycle', async () => {
      // Initialize document
      await store.saveDoc('doc1', createState({ count: 0, title: 'Start' }, 0));

      // Make local edits using savePendingOps
      await store.savePendingOps('doc1', [
        { op: '@inc', path: '/count', value: 5, ts: Date.now() },
        { op: 'replace', path: '/title', value: 'Updated', ts: Date.now() },
      ]);

      // Verify pending state
      let doc = await store.getDoc('doc1');
      expect(doc?.state.count).toBe(5);
      expect(doc?.state.title).toBe('Updated');
      expect(doc?.changes).toHaveLength(1);

      // Prepare to send: get pending, create change, save as sending
      const pendingOps = await store.getPendingOps('doc1');
      const sendingChange = createChange('send1', 1, 0, pendingOps);
      await store.saveSendingChange('doc1', sendingChange);

      // Verify state still reflects changes
      doc = await store.getDoc('doc1');
      expect(doc?.state.count).toBe(5);
      expect(doc?.state.title).toBe('Updated');

      // Confirm send, then apply the server's echoed response (flush order) —
      // applyServerChanges advances committedRev using the server's rev
      await store.confirmSendingChange('doc1');
      await store.applyServerChanges('doc1', [createChange('send1', 1, 0, pendingOps)]);

      // Verify committed state
      doc = await store.getDoc('doc1');
      expect(doc?.state.count).toBe(5);
      expect(doc?.state.title).toBe('Updated');
      expect(doc?.changes).toHaveLength(0);
      expect(doc?.rev).toBe(1);
    });

    it('should handle sending change persisting until acked (idempotency)', async () => {
      await store.saveDoc('doc1', createState({ count: 0 }, 0));

      // Make edits and prepare send
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }]);
      const pendingOps = await store.getPendingOps('doc1');
      const sendingChange = createChange('send1', 1, 0, pendingOps);
      await store.saveSendingChange('doc1', sendingChange);

      // Simulate retry: getSendingChange should return the same change
      const retryChange = await store.getSendingChange('doc1');
      expect(retryChange?.id).toBe('send1');

      // State should still be correct
      let doc = await store.getDoc('doc1');
      expect(doc?.state.count).toBe(5);

      // Eventually confirm
      await store.confirmSendingChange('doc1');

      // Verify final state
      doc = await store.getDoc('doc1');
      expect(doc?.state.count).toBe(5);
      expect(doc?.changes).toHaveLength(0);
    });

    it('should allow new pending ops while sending', async () => {
      await store.saveDoc('doc1', createState({ count: 0, score: 0 }, 0));

      // First batch of edits
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/count', value: 5, ts: Date.now() }]);
      const pendingOps = await store.getPendingOps('doc1');
      const sendingChange = createChange('send1', 1, 0, pendingOps);
      await store.saveSendingChange('doc1', sendingChange);

      // Add new pending while sending
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/score', value: 10, ts: Date.now() }]);

      // Verify state includes both
      const doc = await store.getDoc('doc1');
      expect(doc?.state.count).toBe(5); // from sending
      expect(doc?.state.score).toBe(10); // from pending

      // Confirm the sending change
      await store.confirmSendingChange('doc1');

      // Pending ops should still be there
      const remainingOps = await store.getPendingOps('doc1');
      expect(remainingOps).toHaveLength(1);
      expect(remainingOps[0].path).toBe('/score');
    });
  });

  describe('committed op fidelity', () => {
    it('rebuilds confirmed delta ops as deltas over the snapshot base', async () => {
      await store.saveDoc('doc1', createState({ counter: 10 }, 3));
      await store.savePendingOps('doc1', [{ op: '@inc', path: '/counter', value: 5, ts: 1000 }]);
      const pendingOps = await store.getPendingOps('doc1');
      await store.saveSendingChange('doc1', createChange('send1', 4, 3, pendingOps));
      await store.confirmSendingChange('doc1');

      const doc = await store.getDoc('doc1');
      expect(doc?.state.counter).toBe(15);
    });

    it('replays confirmed removes as removes so deleted fields stay deleted', async () => {
      await store.saveDoc('doc1', createState({ counter: 10, obsolete: 'x' }, 3));
      await store.savePendingOps('doc1', [{ op: 'remove', path: '/obsolete', ts: 1000 }]);
      const pendingOps = await store.getPendingOps('doc1');
      await store.saveSendingChange('doc1', createChange('send1', 4, 3, pendingOps));
      await store.confirmSendingChange('doc1');

      const doc = await store.getDoc('doc1');
      expect(doc?.state).toEqual({ counter: 10 });
    });
  });

  describe('saveDoc with a server getDoc envelope', () => {
    it('persists the envelope changes so uncompacted server fields survive', async () => {
      // A server with no snapshot streams {state:{}, rev:1, changes:[all the ops]}
      const envelope = {
        state: {},
        rev: 1,
        changes: [
          createChange('srv1', 1, 0, [
            { op: 'replace', path: '/theme', value: 'dark', ts: 500 },
            { op: 'replace', path: '/lang', value: 'en', ts: 500 },
          ]),
        ],
      };
      await store.saveDoc('doc1', envelope as PatchesState);

      const doc = await store.getDoc('doc1');
      expect(doc?.state).toEqual({ theme: 'dark', lang: 'en' });
      expect(doc?.rev).toBe(1);
    });
  });

  /**
   * confirmSendingChange promotes sent ops into committed fields through the SAME per-path
   * LWW rule the server applies (consolidateFieldOp). The unguarded promotion relied on the
   * commit response's correction ops (applied right after, in a separate store transaction)
   * to repair fields the server resolved differently — and when that apply died (the
   * ack-persist crash window), the losing value was baked into committed state with
   * committedRev already past the winner's rev, where no catch-up ever redelivers it.
   * Silent, permanent divergence. Found by LWW substrate fault injection (fuzz seed
   * 1000374: a removed flag resurrected; 1000422/1000910: stale replaced values).
   */
  describe('confirmSendingChange — LWW-guarded promotion', () => {
    it('does not let an older sent op overwrite a newer committed row (seed-1000374 shape)', async () => {
      // The newer foreign remove is already committed locally...
      await store.applyServerChanges('doc1', [
        createChange('foreign', 6, 5, [{ op: 'remove', path: '/flags/autosave', ts: 200 }]),
      ]);
      // ...while an OLDER local write to the same path flushes.
      const ops: JSONPatchOp[] = [{ op: 'replace', path: '/flags/autosave', value: true, ts: 100 }];
      await store.saveSendingChange('doc1', createChange('mine', 7, 6, ops));

      await store.confirmSendingChange('doc1', ops);

      // The remove (newer) survives in committed state even though the correction echo
      // never arrives; the sending slot still clears.
      expect((await store.getCommittedState('doc1')).state).toEqual({});
      expect(await store.getSendingChange('doc1')).toBeNull();
    });

    it('promotes a sent op that wins by timestamp', async () => {
      await store.applyServerChanges('doc1', [
        createChange('foreign', 6, 5, [{ op: 'remove', path: '/flags/autosave', ts: 200 }]),
      ]);
      const ops: JSONPatchOp[] = [{ op: 'replace', path: '/flags/autosave', value: true, ts: 300 }];
      await store.saveSendingChange('doc1', createChange('mine', 7, 6, ops));

      await store.confirmSendingChange('doc1', ops);

      expect((await store.getCommittedState('doc1')).state).toEqual({ flags: { autosave: true } });
    });

    it('a losing parent write does not prune the newer committed children it lost to', async () => {
      await store.applyServerChanges('doc1', [
        createChange('foreign', 6, 5, [
          { op: 'replace', path: '/counters', value: {}, ts: 200 },
          { op: 'replace', path: '/counters/words', value: 42, ts: 300 },
        ]),
      ]);
      const ops: JSONPatchOp[] = [{ op: 'replace', path: '/counters', value: { words: 0 }, ts: 150 }];
      await store.saveSendingChange('doc1', createChange('mine', 7, 6, ops));

      await store.confirmSendingChange('doc1', ops);

      expect((await store.getCommittedState('doc1')).state).toEqual({ counters: { words: 42 } });
    });

    it('folds a sent delta op into the committed row instead of storing the raw delta', async () => {
      await store.applyServerChanges('doc1', [
        createChange('foreign', 6, 5, [{ op: 'replace', path: '/count', value: 5, ts: 200 }]),
      ]);
      const ops: JSONPatchOp[] = [{ op: '@inc', path: '/count', value: 3, ts: 100 }];
      await store.saveSendingChange('doc1', createChange('mine', 7, 6, ops));

      await store.confirmSendingChange('doc1', ops);

      // Same fold the server performs: apply the delta to the stored value.
      expect((await store.getCommittedState('doc1')).state).toEqual({ count: 8 });
    });
  });

  describe('partial confirmSendingChange', () => {
    it('keeps unconfirmed ops in the sending slot until every batch is confirmed', async () => {
      const ops: JSONPatchOp[] = [
        { op: 'replace', path: '/a', value: 1, ts: 1000 },
        { op: 'replace', path: '/b', value: 2, ts: 1000 },
      ];
      await store.savePendingOps('doc1', ops);
      await store.saveSendingChange('doc1', createChange('send1', 4, 3, ops));

      await store.confirmSendingChange('doc1', [ops[0]]);
      const partiallyConfirmed = await store.getSendingChange('doc1');
      expect(partiallyConfirmed?.ops).toEqual([ops[1]]);

      await store.confirmSendingChange('doc1', [ops[1]]);
      expect(await store.getSendingChange('doc1')).toBeNull();

      const doc = await store.getDoc('doc1');
      expect(doc?.state).toEqual({ a: 1, b: 2 });
    });
  });
});
