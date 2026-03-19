import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchClientStore } from '../../src/client/BranchClientStore';
import { PatchesBranchClient } from '../../src/client/PatchesBranchClient';
import type { BranchAPI } from '../../src/net/protocol/types';
import type { Branch } from '../../src/types';

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    id: 'branch-1',
    docId: 'doc1',
    branchedAtRev: 5,
    createdAt: 1000,
    modifiedAt: 1000,
    status: 'open',
    contentStartRev: 2,
    ...overrides,
  };
}

describe('PatchesBranchClient', () => {
  let api: {
    [K in keyof BranchAPI]: ReturnType<typeof vi.fn>;
  };
  let localStore: {
    [K in keyof BranchClientStore]: ReturnType<typeof vi.fn>;
  };
  let patches: any;
  let mockAlgorithm: any;

  beforeEach(() => {
    api = {
      listBranches: vi.fn().mockResolvedValue([]),
      createBranch: vi.fn().mockResolvedValue('server-branch-id'),
      closeBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      mergeBranch: vi.fn().mockResolvedValue(undefined),
    };
    localStore = {
      listBranches: vi.fn().mockResolvedValue([]),
      loadBranch: vi.fn().mockResolvedValue(undefined),
      saveBranches: vi.fn().mockResolvedValue(undefined),
      deleteBranches: vi.fn().mockResolvedValue(undefined),
      listPendingBranches: vi.fn().mockResolvedValue([]),
      getLastModifiedAt: vi.fn().mockResolvedValue(undefined),
    };
    mockAlgorithm = {
      handleDocChange: vi.fn().mockResolvedValue([]),
    };
    patches = {
      defaultAlgorithm: 'ot',
      algorithms: { ot: mockAlgorithm },
      trackDocs: vi.fn().mockResolvedValue(undefined),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      onChange: { emit: vi.fn() },
    };
  });

  describe('loadCached', () => {
    it('should return empty array without local store', async () => {
      const client = new PatchesBranchClient('doc1', api, patches);
      expect(await client.loadCached()).toEqual([]);
    });

    it('should load from local store and set branches state', async () => {
      const cached = [makeBranch()];
      localStore.listBranches.mockResolvedValue(cached);
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      const result = await client.loadCached();

      expect(result).toEqual(cached);
      expect(client.branches.state).toEqual(cached);
      expect(localStore.listBranches).toHaveBeenCalledWith('doc1');
    });
  });

  describe('listBranches', () => {
    it('should do full fetch without local store', async () => {
      const branches = [makeBranch()];
      api.listBranches.mockResolvedValue(branches);
      const client = new PatchesBranchClient('doc1', api, patches);

      const result = await client.listBranches();

      expect(result).toEqual(branches);
      expect(api.listBranches).toHaveBeenCalledWith('doc1', undefined);
    });

    it('should do full fetch and save to local store on first sync', async () => {
      const branches = [makeBranch()];
      api.listBranches.mockResolvedValue(branches);
      localStore.getLastModifiedAt.mockResolvedValue(undefined);
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      await client.listBranches();

      expect(api.listBranches).toHaveBeenCalledWith('doc1', undefined);
      expect(localStore.saveBranches).toHaveBeenCalledWith('doc1', branches);
    });

    it('should use incremental sync when local store has data', async () => {
      const existing = [makeBranch({ modifiedAt: 5000 })];
      localStore.getLastModifiedAt.mockResolvedValue(5000);
      api.listBranches.mockResolvedValue([makeBranch({ id: 'branch-2', modifiedAt: 6000 })]);
      localStore.listBranches.mockResolvedValue([...existing, makeBranch({ id: 'branch-2', modifiedAt: 6000 })]);
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      await client.listBranches();

      expect(api.listBranches).toHaveBeenCalledWith('doc1', { since: 5000 });
      expect(localStore.saveBranches).toHaveBeenCalledWith('doc1', [makeBranch({ id: 'branch-2', modifiedAt: 6000 })]);
    });

    it('should handle tombstones during incremental sync', async () => {
      localStore.getLastModifiedAt.mockResolvedValue(5000);
      const tombstone = makeBranch({ id: 'deleted-branch', modifiedAt: 6000, deleted: true });
      const live = makeBranch({ id: 'live-branch', modifiedAt: 6000 });
      api.listBranches.mockResolvedValue([tombstone, live]);
      localStore.listBranches.mockResolvedValue([live]);
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      await client.listBranches();

      expect(localStore.deleteBranches).toHaveBeenCalledWith(['deleted-branch']);
      expect(localStore.saveBranches).toHaveBeenCalledWith('doc1', [live]);
    });

    it('should not call save/delete when no incremental updates', async () => {
      localStore.getLastModifiedAt.mockResolvedValue(5000);
      api.listBranches.mockResolvedValue([]);
      localStore.listBranches.mockResolvedValue([makeBranch()]);
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      await client.listBranches();

      expect(localStore.saveBranches).not.toHaveBeenCalled();
      expect(localStore.deleteBranches).not.toHaveBeenCalled();
    });

    it('should pass explicit since option directly to API', async () => {
      api.listBranches.mockResolvedValue([]);
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      await client.listBranches({ since: 9999 });

      expect(api.listBranches).toHaveBeenCalledWith('doc1', { since: 9999 });
      expect(localStore.getLastModifiedAt).not.toHaveBeenCalled();
    });
  });

  describe('createBranch (online)', () => {
    it('should call API and refresh branches', async () => {
      api.createBranch.mockResolvedValue('new-branch');
      api.listBranches.mockResolvedValue([]);
      const client = new PatchesBranchClient('doc1', api, patches);

      const id = await client.createBranch(5, { name: 'Feature' });

      expect(id).toBe('new-branch');
      expect(api.createBranch).toHaveBeenCalledWith('doc1', 5, { name: 'Feature' });
      expect(api.listBranches).toHaveBeenCalled();
    });
  });

  describe('createBranch (offline with initialState)', () => {
    it('should throw when metadata.id is missing', async () => {
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      await expect(client.createBranch(5, { name: 'No ID' }, { title: 'Test' })).rejects.toThrow(
        'metadata.id is required'
      );
    });

    it('should create branch offline with initial state', async () => {
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      const id = await client.createBranch(5, { id: 'my-branch', name: 'Feature' }, { title: 'Hello' });

      expect(id).toBe('my-branch');

      // Should save pending branch meta to local store
      expect(localStore.saveBranches).toHaveBeenCalledWith('doc1', [
        expect.objectContaining({
          id: 'my-branch',
          docId: 'doc1',
          branchedAtRev: 5,
          name: 'Feature',
          status: 'open',
          pending: true,
          contentStartRev: 2, // one init change at rev 1, so content starts at 2
        }),
      ]);

      // Should track the branch document
      expect(patches.trackDocs).toHaveBeenCalledWith(['my-branch'], 'ot');

      // Should call handleDocChange with the root-replace ops
      expect(mockAlgorithm.handleDocChange).toHaveBeenCalledWith(
        'my-branch',
        [{ op: 'replace', path: '', value: { title: 'Hello' } }],
        undefined,
        {}
      );

      // Should emit onChange for sync
      expect(patches.onChange.emit).toHaveBeenCalledWith('my-branch');

      // Should NOT call API
      expect(api.createBranch).not.toHaveBeenCalled();
    });

    it('should update branches store with new branch', async () => {
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      await client.createBranch(5, { id: 'b1' }, { data: 'test' });

      expect(client.branches.state).toHaveLength(1);
      expect(client.branches.state[0].id).toBe('b1');
      expect(client.branches.state[0].pending).toBe(true);
    });

    it('should use specified algorithm', async () => {
      const lwwAlgorithm = { handleDocChange: vi.fn().mockResolvedValue([]) };
      patches.algorithms.lww = lwwAlgorithm;
      const client = new PatchesBranchClient('doc1', api, patches, localStore, { algorithm: 'lww' });

      await client.createBranch(3, { id: 'lww-branch' }, { foo: 'bar' });

      expect(patches.trackDocs).toHaveBeenCalledWith(['lww-branch'], 'lww');
      expect(lwwAlgorithm.handleDocChange).toHaveBeenCalled();
      expect(mockAlgorithm.handleDocChange).not.toHaveBeenCalled();
    });

    it('should throw when algorithm not found', async () => {
      const client = new PatchesBranchClient('doc1', api, patches, localStore, { algorithm: 'lww' });

      await expect(client.createBranch(3, { id: 'bad' }, { x: 1 })).rejects.toThrow("Algorithm 'lww' not found");
    });

    it('should reject branching from a branch', async () => {
      // Simulate doc1 being a branch itself by having loadBranch return a record
      localStore.loadBranch.mockResolvedValue(makeBranch({ id: 'doc1', docId: 'original-doc' }));
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      await expect(client.createBranch(5, { id: 'nested-branch' }, { data: 'test' })).rejects.toThrow(
        'Cannot create a branch from another branch.'
      );

      expect(localStore.saveBranches).not.toHaveBeenCalled();
      expect(patches.trackDocs).not.toHaveBeenCalled();
    });

    it('should allow branching when document is not a branch', async () => {
      localStore.loadBranch.mockResolvedValue(undefined);
      const client = new PatchesBranchClient('doc1', api, patches, localStore);

      const id = await client.createBranch(5, { id: 'ok-branch' }, { data: 'test' });

      expect(id).toBe('ok-branch');
      expect(localStore.loadBranch).toHaveBeenCalledWith('doc1');
    });
  });

  describe('deleteBranch', () => {
    it('should save pending-deleted tombstone to local store and update branches state', async () => {
      const client = new PatchesBranchClient('doc1', api, patches, localStore);
      const b1 = makeBranch({ id: 'b1' });
      const b2 = makeBranch({ id: 'b2' });
      client.branches.state = [b1, b2];

      await client.deleteBranch('b1');

      // Should NOT call server API
      expect(api.deleteBranch).not.toHaveBeenCalled();
      // Should save tombstone with pending + deleted flags
      expect(localStore.saveBranches).toHaveBeenCalledWith('doc1', [
        expect.objectContaining({
          id: 'b1',
          pending: true,
          deleted: true,
        }),
      ]);
      expect(client.branches.state).toEqual([b2]);
    });

    it('should directly remove pending (unsynced) branch from local store', async () => {
      const client = new PatchesBranchClient('doc1', api, patches, localStore);
      const pendingBranch = makeBranch({ id: 'b1', pending: true });
      client.branches.state = [pendingBranch];

      await client.deleteBranch('b1');

      // Should physically delete — no tombstone needed since server doesn't know about it
      expect(localStore.deleteBranches).toHaveBeenCalledWith(['b1']);
      expect(localStore.saveBranches).not.toHaveBeenCalled();
      expect(api.deleteBranch).not.toHaveBeenCalled();
      expect(client.branches.state).toEqual([]);
    });

    it('should call API directly without local store', async () => {
      const client = new PatchesBranchClient('doc1', api, patches);
      client.branches.state = [makeBranch({ id: 'b1' })];

      await client.deleteBranch('b1');

      expect(api.deleteBranch).toHaveBeenCalledWith('b1');
      expect(client.branches.state).toEqual([]);
    });
  });

  describe('deleteBranchWithDoc', () => {
    it('should delete both the branch record and the branch document', async () => {
      const client = new PatchesBranchClient('doc1', api, patches, localStore);
      const b1 = makeBranch({ id: 'b1' });
      client.branches.state = [b1];

      await client.deleteBranchWithDoc('b1');

      // Should have saved tombstone for branch record
      expect(localStore.saveBranches).toHaveBeenCalledWith('doc1', [
        expect.objectContaining({ id: 'b1', pending: true, deleted: true }),
      ]);
      // Should have called deleteDoc on the branch document
      expect(patches.deleteDoc).toHaveBeenCalledWith('b1');
      expect(client.branches.state).toEqual([]);
    });
  });

  describe('closeBranch', () => {
    it('should call API and refresh branches', async () => {
      api.listBranches.mockResolvedValue([]);
      const client = new PatchesBranchClient('doc1', api, patches);

      await client.closeBranch('branch-1');

      expect(api.closeBranch).toHaveBeenCalledWith('branch-1');
      expect(api.listBranches).toHaveBeenCalled();
    });
  });

  describe('mergeBranch', () => {
    it('should call API and refresh branches', async () => {
      api.listBranches.mockResolvedValue([]);
      const client = new PatchesBranchClient('doc1', api, patches);

      await client.mergeBranch('branch-1');

      expect(api.mergeBranch).toHaveBeenCalledWith('branch-1');
      expect(api.listBranches).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should reset branches state', () => {
      const client = new PatchesBranchClient('doc1', api, patches);
      client.branches.state = [makeBranch()];

      client.clear();

      expect(client.branches.state).toEqual([]);
    });
  });
});
