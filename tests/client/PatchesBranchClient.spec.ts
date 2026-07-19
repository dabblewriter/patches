import { beforeEach, describe, expect, it, vi } from 'vitest';
import { breakChangesIntoBatches } from '../../src/algorithms/ot/shared/changeBatching';
import type { BranchClientStore } from '../../src/client/BranchClientStore';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { PatchesBranchClient } from '../../src/client/PatchesBranchClient';
import type { PatchesDocOptions } from '../../src/client/PatchesDoc';
import { compressedSizeUint8 } from '../../src/compression';
import { createChange } from '../../src/data/change';
import type { BranchAPI } from '../../src/net/protocol/types';
import type { Branch } from '../../src/types';

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    id: 'branch-1',
    docId: 'doc1',
    branchedAtRev: 5,
    createdAt: 1000,
    modifiedAt: 1000,
    contentStartRev: 2,
    ...overrides,
  };
}

describe('PatchesBranchClient', () => {
  let api: BranchAPI & { [K in keyof BranchAPI]: ReturnType<typeof vi.fn> };
  let offlineApi: BranchClientStore & { [K in keyof BranchClientStore]: ReturnType<typeof vi.fn> };
  let patches: any;
  let mockAlgorithm: any;

  beforeEach(() => {
    api = {
      listBranches: vi.fn().mockResolvedValue([]),
      createBranch: vi.fn().mockResolvedValue('server-branch-id'),
      updateBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      mergeBranch: vi.fn().mockResolvedValue(undefined),
    };
    offlineApi = {
      listBranches: vi.fn().mockResolvedValue([]),
      createBranch: vi.fn().mockResolvedValue('offline-branch-id'),
      updateBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      loadBranch: vi.fn().mockResolvedValue(undefined),
      saveBranches: vi.fn().mockResolvedValue(undefined),
      removeBranches: vi.fn().mockResolvedValue(undefined),
      listPendingBranches: vi.fn().mockResolvedValue([]),
      getLastModifiedAt: vi.fn().mockResolvedValue(undefined),
    };
    mockAlgorithm = {
      // A real algorithm returns the changes it persisted; the branch client derives
      // `contentStartRev` from their revs.
      handleDocChange: vi.fn().mockResolvedValue([{ rev: 1 }]),
    };
    patches = {
      defaultAlgorithm: 'ot',
      algorithms: { ot: mockAlgorithm },
      docOptions: {},
      trackDocs: vi.fn().mockResolvedValue(undefined),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      untrackDocs: vi.fn().mockResolvedValue(undefined),
      onChange: { emit: vi.fn() },
      getDocAlgorithm: vi.fn().mockReturnValue(mockAlgorithm),
      getOpenDoc: vi.fn().mockReturnValue(undefined),
    };
  });

  describe('loadCached', () => {
    it('should return empty array with online API', async () => {
      const client = new PatchesBranchClient('doc1', api, patches);
      expect(await client.loadCached()).toEqual([]);
    });

    it('should load from offline API and set branches state', async () => {
      const cached = [makeBranch()];
      offlineApi.listBranches.mockResolvedValue(cached);
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      const result = await client.loadCached();

      expect(result).toEqual(cached);
      expect(client.branches.state).toEqual(cached);
      expect(offlineApi.listBranches).toHaveBeenCalledWith('doc1');
    });
  });

  describe('listBranches', () => {
    it('should fetch from online API', async () => {
      const branches = [makeBranch()];
      api.listBranches.mockResolvedValue(branches);
      const client = new PatchesBranchClient('doc1', api, patches);

      const result = await client.listBranches();

      expect(result).toEqual(branches);
      expect(api.listBranches).toHaveBeenCalledWith('doc1', undefined);
    });

    it('should read from offline API (local store)', async () => {
      const branches = [makeBranch()];
      offlineApi.listBranches.mockResolvedValue(branches);
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      const result = await client.listBranches();

      expect(result).toEqual(branches);
      expect(offlineApi.listBranches).toHaveBeenCalledWith('doc1', undefined);
    });

    it('should pass options through to API', async () => {
      api.listBranches.mockResolvedValue([]);
      const client = new PatchesBranchClient('doc1', api, patches);

      await client.listBranches({ since: 9999 });

      expect(api.listBranches).toHaveBeenCalledWith('doc1', { since: 9999 });
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
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      await expect(client.createBranch(5, { name: 'No ID' }, { title: 'Test' })).rejects.toThrow(
        'metadata.id is required'
      );
    });

    /** Wire up a real algorithm + store so persisted revs (the floor's source of truth) are real. */
    function useRealAlgorithm(docOptions: PatchesDocOptions = {}, algorithmOptions: PatchesDocOptions = docOptions) {
      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store, algorithmOptions);
      patches.docOptions = docOptions;
      patches.algorithms = { ot: algorithm };
      return store;
    }

    it('should create branch offline with initial state', async () => {
      const store = useRealAlgorithm();
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      const id = await client.createBranch(5, { id: 'my-branch', name: 'Feature' }, { title: 'Hello' });

      expect(id).toBe('my-branch');

      // Should call createBranch on the offline API (store handles pendingOp)
      expect(offlineApi.createBranch).toHaveBeenCalledWith('doc1', 5, {
        id: 'my-branch',
        name: 'Feature',
        contentStartRev: 2, // one persisted init change at rev 1, so content starts at 2
      });

      // Should track the branch document
      expect(patches.trackDocs).toHaveBeenCalledWith(['my-branch'], 'ot');

      // Should persist the root-replace seed as a pending change through the algorithm
      const pending = await store.getPendingChanges('my-branch');
      expect(pending).toHaveLength(1);
      expect(pending[0].rev).toBe(1);
      expect(pending[0].ops).toEqual([{ op: 'replace', path: '', value: { title: 'Hello' } }]);

      // Should emit onChange for sync
      expect(patches.onChange.emit).toHaveBeenCalledWith('my-branch');
    });

    it('splits the seed for the wire and counts the floor from the persisted revs', async () => {
      // Mirrors dw3's real config with small limits: the storage limit is a COMPRESSED measure,
      // the wire payload limit is UNCOMPRESSED. A highly-compressible seed fits one storage piece
      // but the wire splits it into several — `contentStartRev` must count the changes actually
      // persisted, or it undercounts the seed and a merge replays the tail, doubling the document.
      const docOptions = { maxStorageBytes: 3000, maxPayloadBytes: 6000, sizeCalculator: compressedSizeUint8 };
      const store = useRealAlgorithm(docOptions);
      const bigBody = 'The grey cat sat by the window. '.repeat(1000); // ~32KB, compresses tiny
      const initialState = { docs: { d1: { id: 'd1', body: { content: { ops: [{ insert: bigBody }] } } } } };

      const client = new PatchesBranchClient('doc1', offlineApi, patches);
      await client.createBranch(5, { id: 'big-branch' }, initialState);

      // The seed really was split into several persisted changes...
      const persisted = await store.getPendingChanges('big-branch');
      expect(persisted.length).toBeGreaterThan(1);
      // ...and contentStartRev = last persisted rev + 1, so a merge cannot replay seeded content.
      const sentMeta = offlineApi.createBranch.mock.calls[0][2] as { contentStartRev: number };
      expect(sentMeta.contentStartRev).toBe(persisted[persisted.length - 1].rev + 1);
    });

    it('derives contentStartRev from the revs the algorithm persisted, not a predicted split', async () => {
      // `patches.docOptions` and the algorithm's own options are configured independently, and
      // the algorithm re-splits whatever it persists by ITS `maxStorageBytes`. Predicting the
      // floor from `docOptions` undercounts the seed whenever the two configs disagree — the
      // persisted revs are the truth.
      const docOptions = { maxStorageBytes: 3000, maxPayloadBytes: 6000, sizeCalculator: compressedSizeUint8 };
      const store = useRealAlgorithm(docOptions, { maxStorageBytes: 2000 }); // stricter, uncompressed
      const bigBody = 'The grey cat sat by the window. '.repeat(1000);
      const initialState = { docs: { d1: { id: 'd1', body: { content: { ops: [{ insert: bigBody }] } } } } };

      const client = new PatchesBranchClient('doc1', offlineApi, patches);
      await client.createBranch(5, { id: 'big-branch' }, initialState);

      // The algorithm split further than a docOptions-based prediction would say...
      const rootReplace = createChange(0, 1, [{ op: 'replace' as const, path: '', value: initialState }], {
        committedAt: 0,
      });
      const predicted = breakChangesIntoBatches([rootReplace], docOptions).flat();
      const persisted = await store.getPendingChanges('big-branch');
      expect(persisted.length).toBeGreaterThan(predicted.length);
      // ...and the floor still counts every persisted rev.
      const sentMeta = offlineApi.createBranch.mock.calls[0][2] as { contentStartRev: number };
      expect(sentMeta.contentStartRev).toBe(persisted[persisted.length - 1].rev + 1);
    });

    it('should refresh branches after offline create', async () => {
      offlineApi.listBranches.mockResolvedValue([makeBranch({ id: 'b1', pendingOp: 'create' })]);
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      await client.createBranch(5, { id: 'b1' }, { data: 'test' });

      expect(offlineApi.listBranches).toHaveBeenCalled();
      expect(client.branches.state).toHaveLength(1);
    });

    it('should use specified algorithm', async () => {
      const lwwAlgorithm = { handleDocChange: vi.fn().mockResolvedValue([{ rev: 1 }]) };
      patches.algorithms.lww = lwwAlgorithm;
      const client = new PatchesBranchClient('doc1', offlineApi, patches, { algorithm: 'lww' });

      await client.createBranch(3, { id: 'lww-branch' }, { foo: 'bar' });

      expect(patches.trackDocs).toHaveBeenCalledWith(['lww-branch'], 'lww');
      expect(lwwAlgorithm.handleDocChange).toHaveBeenCalled();
      expect(mockAlgorithm.handleDocChange).not.toHaveBeenCalled();
    });

    it('should throw when algorithm not found', async () => {
      const client = new PatchesBranchClient('doc1', offlineApi, patches, { algorithm: 'lww' });

      await expect(client.createBranch(3, { id: 'bad' }, { x: 1 })).rejects.toThrow("Algorithm 'lww' not found");
    });

    it('should reject branching from a branch', async () => {
      offlineApi.loadBranch.mockResolvedValue(makeBranch({ id: 'doc1', docId: 'original-doc' }));
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      await expect(client.createBranch(5, { id: 'nested-branch' }, { data: 'test' })).rejects.toThrow(
        'Cannot create a branch from another branch.'
      );

      expect(offlineApi.createBranch).not.toHaveBeenCalled();
      expect(patches.trackDocs).not.toHaveBeenCalled();
    });

    it('should allow branching when document is not a branch', async () => {
      offlineApi.loadBranch.mockResolvedValue(undefined);
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      const id = await client.createBranch(5, { id: 'ok-branch' }, { data: 'test' });

      expect(id).toBe('ok-branch');
      expect(offlineApi.loadBranch).toHaveBeenCalledWith('doc1');
    });

    it('should rollback on algorithm failure', async () => {
      mockAlgorithm.handleDocChange.mockRejectedValue(new Error('Algorithm failed'));
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      await expect(client.createBranch(5, { id: 'fail-branch' }, { data: 'test' })).rejects.toThrow('Algorithm failed');

      // Should rollback by removing the branch and untracking the doc — and the branch meta
      // was never created, since seeding failed before the floor could be derived.
      expect(offlineApi.createBranch).not.toHaveBeenCalled();
      expect(offlineApi.removeBranches).toHaveBeenCalledWith(['fail-branch']);
      expect(patches.untrackDocs).toHaveBeenCalledWith(['fail-branch']);
    });

    it('should rollback when branch creation fails after seeding', async () => {
      offlineApi.createBranch.mockRejectedValue(new Error('store write failed'));
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      await expect(client.createBranch(5, { id: 'fail-branch' }, { data: 'test' })).rejects.toThrow(
        'store write failed'
      );

      expect(offlineApi.removeBranches).toHaveBeenCalledWith(['fail-branch']);
      expect(patches.untrackDocs).toHaveBeenCalledWith(['fail-branch']);
    });
  });

  describe('updateBranch', () => {
    it('should call API and update local branches state (online)', async () => {
      const client = new PatchesBranchClient('doc1', api, patches);
      client.branches.state = [makeBranch({ id: 'b1', name: 'old' }), makeBranch({ id: 'b2' })];

      await client.updateBranch('b1', { name: 'new name' });

      expect(api.updateBranch).toHaveBeenCalledWith('b1', { name: 'new name' });
      expect(client.branches.state.find(b => b.id === 'b1')!.name).toBe('new name');
      // Other branches unchanged
      expect(client.branches.state.find(b => b.id === 'b2')).toEqual(makeBranch({ id: 'b2' }));
    });

    it('should call offline API and update local branches state', async () => {
      const client = new PatchesBranchClient('doc1', offlineApi, patches);
      client.branches.state = [makeBranch({ id: 'b1', name: 'old' })];

      await client.updateBranch('b1', { name: 'renamed' });

      expect(offlineApi.updateBranch).toHaveBeenCalledWith('b1', { name: 'renamed' });
      expect(client.branches.state.find(b => b.id === 'b1')!.name).toBe('renamed');
    });
  });

  describe('deleteBranch', () => {
    it('should call API and update branches state (online)', async () => {
      const client = new PatchesBranchClient('doc1', api, patches);
      client.branches.state = [makeBranch({ id: 'b1' }), makeBranch({ id: 'b2' })];

      await client.deleteBranch('b1');

      expect(api.deleteBranch).toHaveBeenCalledWith('b1');
      expect(client.branches.state).toEqual([makeBranch({ id: 'b2' })]);
    });

    it('should call offline API and update branches state', async () => {
      const client = new PatchesBranchClient('doc1', offlineApi, patches);
      client.branches.state = [makeBranch({ id: 'b1' }), makeBranch({ id: 'b2' })];

      await client.deleteBranch('b1');

      // Store handles tombstone logic internally
      expect(offlineApi.deleteBranch).toHaveBeenCalledWith('b1');
      expect(client.branches.state).toEqual([makeBranch({ id: 'b2' })]);
    });
  });

  describe('deleteBranchWithDoc', () => {
    it('should delete both the branch record and the branch document', async () => {
      const client = new PatchesBranchClient('doc1', api, patches);
      client.branches.state = [makeBranch({ id: 'b1' })];

      await client.deleteBranchWithDoc('b1');

      expect(api.deleteBranch).toHaveBeenCalledWith('b1');
      expect(patches.deleteDoc).toHaveBeenCalledWith('b1');
      expect(client.branches.state).toEqual([]);
    });
  });

  describe('mergeBranch', () => {
    it('should call API and refresh branches (online)', async () => {
      api.listBranches.mockResolvedValue([]);
      const client = new PatchesBranchClient('doc1', api, patches);

      await client.mergeBranch('branch-1');

      expect(api.mergeBranch).toHaveBeenCalledWith('branch-1');
      expect(api.listBranches).toHaveBeenCalled();
    });

    it('should return the committed changes from the API so callers can fold them in', async () => {
      const committed = [{ id: 'c1', rev: 6, baseRev: 5, ops: [], created: 0 }];
      api.mergeBranch.mockResolvedValue(committed);
      api.listBranches.mockResolvedValue([]);
      const client = new PatchesBranchClient('doc1', api, patches);

      await expect(client.mergeBranch('branch-1')).resolves.toEqual(committed);
    });

    it('should normalize a void API result to an empty array', async () => {
      api.mergeBranch.mockResolvedValue(undefined);
      api.listBranches.mockResolvedValue([]);
      const client = new PatchesBranchClient('doc1', api, patches);

      await expect(client.mergeBranch('branch-1')).resolves.toEqual([]);
    });

    it('should throw when using offline API', async () => {
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      await expect(client.mergeBranch('branch-1')).rejects.toThrow('server connection');
    });

    it('should propagate server errors from online API', async () => {
      api.mergeBranch.mockRejectedValue(new Error('Branch nonexistent not found'));
      const client = new PatchesBranchClient('doc1', api, patches);

      await expect(client.mergeBranch('nonexistent')).rejects.toThrow('Branch nonexistent not found');
    });

    it('should throw when algorithm lacks listChanges', async () => {
      delete mockAlgorithm.listChanges;
      const client = new PatchesBranchClient('doc1', offlineApi, patches);

      await expect(client.mergeBranch('branch-1')).rejects.toThrow('server connection');
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
