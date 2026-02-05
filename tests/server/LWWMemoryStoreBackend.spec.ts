import { beforeEach, describe, expect, it } from 'vitest';
import { LWWMemoryStoreBackend } from '../../src/server/LWWMemoryStoreBackend.js';
import type { Branch } from '../../src/types.js';

describe('LWWMemoryStoreBackend', () => {
  let store: LWWMemoryStoreBackend;

  beforeEach(() => {
    store = new LWWMemoryStoreBackend();
  });

  describe('snapshots', () => {
    it('returns null for non-existent document', async () => {
      const snapshot = await store.getSnapshot('doc1');
      expect(snapshot).toBeNull();
    });

    it('saves and retrieves a snapshot', async () => {
      await store.saveSnapshot('doc1', { name: 'Alice' }, 5);
      const snapshot = await store.getSnapshot('doc1');
      expect(snapshot).toEqual({ state: { name: 'Alice' }, rev: 5 });
    });

    it('overwrites previous snapshot', async () => {
      await store.saveSnapshot('doc1', { name: 'Alice' }, 5);
      await store.saveSnapshot('doc1', { name: 'Bob' }, 10);
      const snapshot = await store.getSnapshot('doc1');
      expect(snapshot).toEqual({ state: { name: 'Bob' }, rev: 10 });
    });

    it('removes fields up to snapshot rev after save', async () => {
      // Save some fields at different revs
      await store.saveOps('doc1', [{ op: 'replace', path: '/a', ts: 100, rev: 0, value: 1 }]);
      await store.saveOps('doc1', [{ op: 'replace', path: '/b', ts: 200, rev: 0, value: 2 }]);
      await store.saveOps('doc1', [{ op: 'replace', path: '/c', ts: 300, rev: 0, value: 3 }]);

      // Now fields have revs 1, 2, 3
      const allFields = await store.listOps('doc1');
      expect(allFields).toHaveLength(3);

      // Save snapshot at rev 2 - should remove fields with rev <= 2
      await store.saveSnapshot('doc1', { a: 1, b: 2 }, 2);

      const remainingFields = await store.listOps('doc1');
      expect(remainingFields).toHaveLength(1);
      expect(remainingFields[0].path).toBe('/c');
    });
  });

  describe('fields', () => {
    describe('saveFields', () => {
      it('returns incremented revision', async () => {
        const rev1 = await store.saveOps('doc1', [{ op: 'replace', path: '/name', ts: 100, rev: 0, value: 'Alice' }]);
        expect(rev1).toBe(1);

        const rev2 = await store.saveOps('doc1', [{ op: 'replace', path: '/age', ts: 200, rev: 0, value: 30 }]);
        expect(rev2).toBe(2);
      });

      it('sets rev on saved fields', async () => {
        await store.saveOps('doc1', [
          { op: 'replace', path: '/name', ts: 100, rev: 0, value: 'Alice' },
          { op: 'replace', path: '/age', ts: 100, rev: 0, value: 30 },
        ]);

        const fields = await store.listOps('doc1');
        expect(fields).toHaveLength(2);
        expect(fields.every(f => f.rev === 1)).toBe(true);
      });

      it('deletes existing field at same path', async () => {
        await store.saveOps('doc1', [{ op: 'replace', path: '/name', ts: 100, rev: 0, value: 'Alice' }]);
        await store.saveOps('doc1', [{ op: 'replace', path: '/name', ts: 200, rev: 0, value: 'Bob' }]);

        const fields = await store.listOps('doc1');
        expect(fields).toHaveLength(1);
        expect(fields[0].value).toBe('Bob');
        expect(fields[0].rev).toBe(2);
      });

      it('deletes children atomically when saving parent', async () => {
        // Set up nested fields
        await store.saveOps('doc1', [
          { op: 'replace', path: '/obj/name', ts: 100, rev: 0, value: 'Alice' },
          { op: 'replace', path: '/obj/age', ts: 100, rev: 0, value: 30 },
          { op: 'replace', path: '/other', ts: 100, rev: 0, value: 'keep' },
        ]);

        // Overwrite parent
        await store.saveOps('doc1', [{ op: 'replace', path: '/obj', ts: 200, rev: 0, value: { replaced: true } }]);

        const fields = await store.listOps('doc1');
        expect(fields).toHaveLength(2);

        const paths = fields.map(f => f.path).sort();
        expect(paths).toEqual(['/obj', '/other']);

        const objField = fields.find(f => f.path === '/obj');
        expect(objField?.value).toEqual({ replaced: true });
      });

      it('handles deeply nested child deletion', async () => {
        await store.saveOps('doc1', [
          { op: 'replace', path: '/a/b/c/d', ts: 100, rev: 0, value: 'deep' },
          { op: 'replace', path: '/a/b/c', ts: 100, rev: 0, value: { d: 'deep' } },
          { op: 'replace', path: '/a/b', ts: 100, rev: 0, value: { c: {} } },
        ]);

        // Overwrite /a - should delete all children
        await store.saveOps('doc1', [{ op: 'replace', path: '/a', ts: 200, rev: 0, value: 'replaced' }]);

        const fields = await store.listOps('doc1');
        expect(fields).toHaveLength(1);
        expect(fields[0].path).toBe('/a');
        expect(fields[0].value).toBe('replaced');
      });
    });

    describe('listFields', () => {
      beforeEach(async () => {
        // Set up test fields at different revs
        await store.saveOps('doc1', [{ op: 'replace', path: '/a', ts: 100, rev: 0, value: 1 }]);
        await store.saveOps('doc1', [{ op: 'replace', path: '/b', ts: 200, rev: 0, value: 2 }]);
        await store.saveOps('doc1', [{ op: 'replace', path: '/c', ts: 300, rev: 0, value: 3 }]);
      });

      it('returns empty array for non-existent document', async () => {
        const fields = await store.listOps('nonexistent');
        expect(fields).toEqual([]);
      });

      it('returns all fields when no options provided', async () => {
        const fields = await store.listOps('doc1');
        expect(fields).toHaveLength(3);
      });

      it('filters by sinceRev', async () => {
        const fields = await store.listOps('doc1', { sinceRev: 1 });
        expect(fields).toHaveLength(2);

        const paths = fields.map(f => f.path).sort();
        expect(paths).toEqual(['/b', '/c']);
      });

      it('returns empty when sinceRev is current rev', async () => {
        const fields = await store.listOps('doc1', { sinceRev: 3 });
        expect(fields).toEqual([]);
      });

      it('filters by paths', async () => {
        const fields = await store.listOps('doc1', { paths: ['/a', '/c'] });
        expect(fields).toHaveLength(2);

        const paths = fields.map(f => f.path).sort();
        expect(paths).toEqual(['/a', '/c']);
      });

      it('returns empty for non-matching paths', async () => {
        const fields = await store.listOps('doc1', { paths: ['/nonexistent'] });
        expect(fields).toEqual([]);
      });

      it('returns copy of fields array (not reference)', async () => {
        const fields1 = await store.listOps('doc1');
        const fields2 = await store.listOps('doc1');

        expect(fields1).not.toBe(fields2);
        expect(fields1).toEqual(fields2);
      });
    });
  });

  describe('deleteDoc', () => {
    it('removes document data', async () => {
      await store.saveOps('doc1', [{ op: 'replace', path: '/name', ts: 100, rev: 0, value: 'Alice' }]);
      await store.saveSnapshot('doc1', { name: 'Alice' }, 1);

      await store.deleteDoc('doc1');

      const snapshot = await store.getSnapshot('doc1');
      const fields = await store.listOps('doc1');

      expect(snapshot).toBeNull();
      expect(fields).toEqual([]);
    });

    it('does nothing for non-existent document', async () => {
      // Should not throw
      await store.deleteDoc('nonexistent');
    });
  });

  describe('tombstones', () => {
    it('creates and retrieves a tombstone', async () => {
      await store.createTombstone({
        docId: 'doc1',
        deletedAt: 1000,
        lastRev: 5,
        deletedByClientId: 'client1',
      });

      const tombstone = await store.getTombstone('doc1');
      expect(tombstone).toEqual({
        docId: 'doc1',
        deletedAt: 1000,
        lastRev: 5,
        deletedByClientId: 'client1',
      });
    });

    it('returns undefined for non-existent tombstone', async () => {
      const tombstone = await store.getTombstone('nonexistent');
      expect(tombstone).toBeUndefined();
    });

    it('removes a tombstone', async () => {
      await store.createTombstone({
        docId: 'doc1',
        deletedAt: 1000,
        lastRev: 5,
      });

      await store.removeTombstone('doc1');

      const tombstone = await store.getTombstone('doc1');
      expect(tombstone).toBeUndefined();
    });

    it('removing non-existent tombstone does not throw', async () => {
      // Should not throw
      await store.removeTombstone('nonexistent');
    });
  });

  describe('testing utilities', () => {
    it('clear() removes all data', async () => {
      await store.saveOps('doc1', [{ op: 'replace', path: '/a', ts: 100, rev: 0, value: 1 }]);
      await store.createTombstone({
        docId: 'doc2',
        deletedAt: 1000,
        lastRev: 5,
      });

      store.clear();

      const fields = await store.listOps('doc1');
      const tombstone = await store.getTombstone('doc2');

      expect(fields).toEqual([]);
      expect(tombstone).toBeUndefined();
    });

    it('getDocData() returns raw doc data', async () => {
      await store.saveOps('doc1', [{ op: 'replace', path: '/name', ts: 100, rev: 0, value: 'Alice' }]);

      const data = store.getDocData('doc1');
      expect(data).toBeDefined();
      expect(data?.rev).toBe(1);
      expect(data?.ops).toHaveLength(1);
      expect(data?.snapshot).toBeNull();
    });

    it('getDocData() returns undefined for non-existent doc', () => {
      const data = store.getDocData('nonexistent');
      expect(data).toBeUndefined();
    });
  });

  describe('integration with LWWServer patterns', () => {
    it('supports typical getDoc flow (snapshot + fields since)', async () => {
      // Build up some changes first (realistic flow)
      await store.saveOps('doc1', [{ op: 'replace', path: '/name', ts: 100, rev: 0, value: 'Alice' }]);
      await store.saveOps('doc1', [{ op: 'replace', path: '/email', ts: 150, rev: 0, value: 'alice@example.com' }]);

      // Simulate compaction: save snapshot at current rev
      await store.saveSnapshot('doc1', { name: 'Alice', email: 'alice@example.com' }, 2);

      // New changes after snapshot
      await store.saveOps('doc1', [{ op: 'replace', path: '/age', ts: 200, rev: 0, value: 30 }]);

      // getDoc flow: load snapshot, then fields since snapshot
      const snapshot = await store.getSnapshot('doc1');
      expect(snapshot).toEqual({ state: { name: 'Alice', email: 'alice@example.com' }, rev: 2 });

      const fieldsSince = await store.listOps('doc1', { sinceRev: snapshot!.rev });
      expect(fieldsSince).toHaveLength(1);
      expect(fieldsSince[0].path).toBe('/age');
      expect(fieldsSince[0].rev).toBe(3);
    });

    it('supports typical commitChanges flow (load paths, save updates)', async () => {
      // Existing state
      await store.saveOps('doc1', [
        { op: 'replace', path: '/name', ts: 100, rev: 0, value: 'Alice' },
        { op: 'replace', path: '/count', ts: 100, rev: 0, value: 5 },
      ]);

      // commitChanges flow: load paths being modified
      const existing = await store.listOps('doc1', { paths: ['/name', '/count'] });
      expect(existing).toHaveLength(2);

      // Apply changes (simulating LWW resolution)
      const newRev = await store.saveOps('doc1', [{ op: 'replace', path: '/name', ts: 200, rev: 0, value: 'Bob' }]);

      expect(newRev).toBe(2);

      // Verify state
      const allFields = await store.listOps('doc1');
      expect(allFields).toHaveLength(2);

      const nameField = allFields.find(f => f.path === '/name');
      expect(nameField?.value).toBe('Bob');
      expect(nameField?.rev).toBe(2);
    });

    it('supports catchup flow (get fields since client rev)', async () => {
      // Build up history
      await store.saveOps('doc1', [{ op: 'replace', path: '/a', ts: 100, rev: 0, value: 1 }]);
      await store.saveOps('doc1', [{ op: 'replace', path: '/b', ts: 200, rev: 0, value: 2 }]);
      await store.saveOps('doc1', [{ op: 'replace', path: '/c', ts: 300, rev: 0, value: 3 }]);
      await store.saveOps('doc1', [{ op: 'replace', path: '/d', ts: 400, rev: 0, value: 4 }]);

      // Client is at rev 2, needs catchup
      const catchupFields = await store.listOps('doc1', { sinceRev: 2 });
      expect(catchupFields).toHaveLength(2);

      const paths = catchupFields.map(f => f.path).sort();
      expect(paths).toEqual(['/c', '/d']);
    });
  });

  describe('versioning', () => {
    describe('createVersion', () => {
      it('stores version metadata and state', async () => {
        await store.createVersion('doc1', 'v1', { name: 'Alice' }, 5);

        const versions = store.getVersions('doc1');
        expect(versions).toHaveLength(1);
        expect(versions![0].metadata.id).toBe('v1');
        expect(versions![0].metadata.endRev).toBe(5);
        expect(versions![0].state).toEqual({ name: 'Alice' });
      });

      it('stores multiple versions', async () => {
        await store.createVersion('doc1', 'v1', { name: 'Alice' }, 5);
        await store.createVersion('doc1', 'v2', { name: 'Bob' }, 10);

        const versions = store.getVersions('doc1');
        expect(versions).toHaveLength(2);
      });

      it('accepts optional metadata', async () => {
        await store.createVersion('doc1', 'v1', { name: 'Alice' }, 5, { name: 'My Version' });

        const versions = store.getVersions('doc1');
        expect(versions![0].metadata.name).toBe('My Version');
      });
    });

    describe('listVersions', () => {
      beforeEach(async () => {
        // Create versions at different revs
        await store.createVersion('doc1', 'v1', { v: 1 }, 5, { name: 'Version 1' });
        await store.createVersion('doc1', 'v2', { v: 2 }, 10, { name: 'Version 2' });
        await store.createVersion('doc1', 'v3', { v: 3 }, 15, { name: 'Version 3' });
      });

      it('returns all versions for a document', async () => {
        const versions = await store.listVersions('doc1');
        expect(versions).toHaveLength(3);
      });

      it('returns empty array for non-existent document', async () => {
        const versions = await store.listVersions('nonexistent');
        expect(versions).toEqual([]);
      });

      it('filters by origin', async () => {
        // All versions default to 'main' origin
        const mainVersions = await store.listVersions('doc1', { origin: 'main' });
        expect(mainVersions).toHaveLength(3);

        const branchVersions = await store.listVersions('doc1', { origin: 'branch' });
        expect(branchVersions).toEqual([]);
      });

      it('filters by groupId', async () => {
        // Add a version with groupId
        const versionsData = store.getVersions('doc1')!;
        versionsData[0].metadata.groupId = 'group1';

        const grouped = await store.listVersions('doc1', { groupId: 'group1' });
        expect(grouped).toHaveLength(1);
        expect(grouped[0].id).toBe('v1');
      });

      it('sorts by orderBy field (default: endRev)', async () => {
        const versions = await store.listVersions('doc1');
        expect(versions[0].endRev).toBe(5);
        expect(versions[1].endRev).toBe(10);
        expect(versions[2].endRev).toBe(15);
      });

      it('handles reverse option', async () => {
        const versions = await store.listVersions('doc1', { reverse: true });
        expect(versions[0].endRev).toBe(15);
        expect(versions[1].endRev).toBe(10);
        expect(versions[2].endRev).toBe(5);
      });

      it('handles startAfter filter', async () => {
        const versions = await store.listVersions('doc1', { startAfter: 5 });
        expect(versions).toHaveLength(2);
        expect(versions[0].endRev).toBe(10);
      });

      it('handles endBefore filter', async () => {
        const versions = await store.listVersions('doc1', { endBefore: 15 });
        expect(versions).toHaveLength(2);
        expect(versions[1].endRev).toBe(10);
      });

      it('handles limit option', async () => {
        const versions = await store.listVersions('doc1', { limit: 2 });
        expect(versions).toHaveLength(2);
      });

      it('combines multiple options', async () => {
        const versions = await store.listVersions('doc1', {
          startAfter: 5,
          limit: 1,
        });
        expect(versions).toHaveLength(1);
        expect(versions[0].endRev).toBe(10);
      });
    });

    describe('loadVersionState', () => {
      it('returns state for existing version', async () => {
        await store.createVersion('doc1', 'v1', { name: 'Alice' }, 5);

        const state = await store.loadVersionState('doc1', 'v1');
        expect(state).toEqual({ name: 'Alice' });
      });

      it('returns undefined for non-existent version', async () => {
        const state = await store.loadVersionState('doc1', 'nonexistent');
        expect(state).toBeUndefined();
      });

      it('returns undefined for non-existent document', async () => {
        const state = await store.loadVersionState('nonexistent', 'v1');
        expect(state).toBeUndefined();
      });
    });

    describe('updateVersion', () => {
      it('modifies version metadata', async () => {
        await store.createVersion('doc1', 'v1', { name: 'Alice' }, 5);

        await store.updateVersion('doc1', 'v1', { name: 'Updated Name' });

        const versions = await store.listVersions('doc1');
        expect(versions[0].name).toBe('Updated Name');
      });

      it('does nothing for non-existent version', async () => {
        // Should not throw
        await store.updateVersion('doc1', 'nonexistent', { name: 'New Name' });
      });
    });
  });

  describe('branching', () => {
    const createTestBranch = (id: string, docId: string): Branch => ({
      id,
      docId,
      branchedAtRev: 5,
      createdAt: Date.now(),
      status: 'open',
    });

    describe('createBranch', () => {
      it('stores a branch', async () => {
        const branch = createTestBranch('branch1', 'doc1');
        await store.createBranch(branch);

        const branches = store.getBranches();
        expect(branches.has('branch1')).toBe(true);
        expect(branches.get('branch1')).toEqual(branch);
      });
    });

    describe('listBranches', () => {
      it('returns branches for a document', async () => {
        await store.createBranch(createTestBranch('branch1', 'doc1'));
        await store.createBranch(createTestBranch('branch2', 'doc1'));
        await store.createBranch(createTestBranch('branch3', 'doc2'));

        const branches = await store.listBranches('doc1');
        expect(branches).toHaveLength(2);
        expect(branches.map(b => b.id).sort()).toEqual(['branch1', 'branch2']);
      });

      it('returns empty array for document with no branches', async () => {
        const branches = await store.listBranches('nonexistent');
        expect(branches).toEqual([]);
      });
    });

    describe('loadBranch', () => {
      it('returns branch by id', async () => {
        const branch = createTestBranch('branch1', 'doc1');
        await store.createBranch(branch);

        const loaded = await store.loadBranch('branch1');
        expect(loaded).toEqual(branch);
      });

      it('returns null for non-existent branch', async () => {
        const loaded = await store.loadBranch('nonexistent');
        expect(loaded).toBeNull();
      });
    });

    describe('updateBranch', () => {
      it('updates branch status', async () => {
        await store.createBranch(createTestBranch('branch1', 'doc1'));

        await store.updateBranch('branch1', { status: 'merged' });

        const branch = await store.loadBranch('branch1');
        expect(branch?.status).toBe('merged');
      });

      it('updates branch name', async () => {
        await store.createBranch(createTestBranch('branch1', 'doc1'));

        await store.updateBranch('branch1', { name: 'Feature Branch' });

        const branch = await store.loadBranch('branch1');
        expect(branch?.name).toBe('Feature Branch');
      });

      it('does nothing for non-existent branch', async () => {
        // Should not throw
        await store.updateBranch('nonexistent', { status: 'closed' });
      });
    });

    describe('closeBranch', () => {
      it('sets status to closed', async () => {
        await store.createBranch(createTestBranch('branch1', 'doc1'));

        await store.closeBranch('branch1');

        const branch = await store.loadBranch('branch1');
        expect(branch?.status).toBe('closed');
      });
    });
  });

  describe('testing utilities (extended)', () => {
    it('clear() also removes versions and branches', async () => {
      await store.createVersion('doc1', 'v1', { name: 'Alice' }, 5);
      await store.createBranch({
        id: 'branch1',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: Date.now(),
        status: 'open',
      });

      store.clear();

      const versions = await store.listVersions('doc1');
      const branches = await store.listBranches('doc1');

      expect(versions).toEqual([]);
      expect(branches).toEqual([]);
    });

    it('getVersions() returns versions for inspection', async () => {
      await store.createVersion('doc1', 'v1', { name: 'Alice' }, 5);

      const versions = store.getVersions('doc1');
      expect(versions).toHaveLength(1);
      expect(versions![0].metadata.id).toBe('v1');
    });

    it('getVersions() returns undefined for non-existent doc', () => {
      const versions = store.getVersions('nonexistent');
      expect(versions).toBeUndefined();
    });

    it('getBranches() returns all branches', async () => {
      await store.createBranch({
        id: 'branch1',
        docId: 'doc1',
        branchedAtRev: 5,
        createdAt: Date.now(),
        status: 'open',
      });

      const branches = store.getBranches();
      expect(branches.size).toBe(1);
      expect(branches.has('branch1')).toBe(true);
    });
  });
});
