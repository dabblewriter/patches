import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatchesAPI } from '../../src/net/protocol/types';
import type { Change, EditableVersionMetadata, VersionMetadata } from '../../src/types';

// Mock dependencies completely before importing
vi.mock('../../src/algorithms/shared/applyChanges', () => ({
  applyChanges: vi.fn().mockImplementation((state, changes) => ({
    ...state,
    appliedChanges: changes?.length || 0,
  })),
}));

vi.mock('../../src/event-signal', () => ({
  signal: vi.fn().mockImplementation(() => {
    const subscribers = new Set();
    const mockSignal = vi.fn().mockImplementation((callback: any) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    }) as any;
    mockSignal.emit = vi.fn().mockImplementation(async (...args: any[]) => {
      for (const callback of subscribers) {
        await (callback as any)(...args);
      }
    });
    mockSignal.error = vi.fn().mockReturnValue(vi.fn());
    mockSignal.clear = vi.fn().mockImplementation(() => subscribers.clear());
    return mockSignal;
  }),
}));

// Now import after mocking
const { PatchesHistoryClient } = await import('../../src/client/PatchesHistoryClient');
const { applyChanges } = await import('../../src/algorithms/shared/applyChanges');

describe('PatchesHistoryClient', () => {
  let client: InstanceType<typeof PatchesHistoryClient>;
  let mockAPI: PatchesAPI;

  const createVersion = (id: string, rev: number, parentId?: string): VersionMetadata => ({
    id,
    endRev: rev,
    startRev: rev,
    origin: 'main' as const,
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    parentId,
    groupId: 'group1',
    name: `Version ${id}`,
    description: `Description for version ${id}`,
  });

  const createChange = (id: string, rev: number): Change => ({
    id,
    rev,
    baseRev: rev - 1,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    createdAt: Date.now(),
    committedAt: Date.now(),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockAPI = {
      listVersions: vi.fn().mockResolvedValue([]),
      createVersion: vi.fn().mockResolvedValue('new-version-id'),
      updateVersion: vi.fn().mockResolvedValue(undefined),
      getVersionState: vi.fn().mockResolvedValue({ state: { default: 'state' } }),
      getVersionChanges: vi.fn().mockResolvedValue([]),
    } as any;

    client = new PatchesHistoryClient('doc1', mockAPI);
  });

  afterEach(() => {
    client.clear();
  });

  describe('constructor', () => {
    it('should initialize with document ID and API', () => {
      expect(client.id).toBe('doc1');
      expect(client.versions).toEqual([]);
      expect(client.state).toBeNull();
    });
  });

  describe('getters', () => {
    it('should return versions list', () => {
      expect(client.versions).toEqual([]);
    });

    it('should return current state', () => {
      expect(client.state).toBeNull();
    });
  });

  describe('listVersions', () => {
    it('should fetch and store versions', async () => {
      const versions = [createVersion('v1', 1), createVersion('v2', 2)];
      vi.mocked(mockAPI.listVersions).mockResolvedValue(versions);

      const result = await client.listVersions();

      expect(mockAPI.listVersions).toHaveBeenCalledWith('doc1', undefined);
      expect(client.versions).toEqual(versions);
      expect(result).toEqual(versions);
    });

    it('should pass options to API call', async () => {
      const options = { limit: 10, reverse: true };

      await client.listVersions(options);

      expect(mockAPI.listVersions).toHaveBeenCalledWith('doc1', options);
    });

    it('should emit onVersionsChange event', async () => {
      const versions = [createVersion('v1', 1)];
      const versionsSpy = vi.fn();
      client.onVersionsChange(versionsSpy);
      vi.mocked(mockAPI.listVersions).mockResolvedValue(versions);

      await client.listVersions();

      expect(versionsSpy).toHaveBeenCalledWith(versions);
    });
  });

  describe('createVersion', () => {
    it('should create version and refresh list', async () => {
      const metadata: EditableVersionMetadata = {
        name: 'New Version',
        description: 'A new version',
      };
      const versions = [createVersion('new-v', 1)];

      vi.mocked(mockAPI.createVersion).mockResolvedValue('new-version-id');
      vi.mocked(mockAPI.listVersions).mockResolvedValue(versions);

      const result = await client.createVersion(metadata);

      expect(mockAPI.createVersion).toHaveBeenCalledWith('doc1', metadata);
      expect(mockAPI.listVersions).toHaveBeenCalledWith('doc1', undefined);
      expect(result).toBe('new-version-id');
      expect(client.versions).toEqual(versions);
    });
  });

  describe('updateVersion', () => {
    it('should update version and refresh list', async () => {
      const metadata: EditableVersionMetadata = {
        name: 'Updated Version',
        description: 'Updated description',
      };
      const versions = [createVersion('v1', 1)];

      vi.mocked(mockAPI.listVersions).mockResolvedValue(versions);

      await client.updateVersion('v1', metadata);

      expect(mockAPI.updateVersion).toHaveBeenCalledWith('doc1', 'v1', metadata);
      expect(mockAPI.listVersions).toHaveBeenCalledWith('doc1', undefined);
      expect(client.versions).toEqual(versions);
    });
  });

  describe('getVersionState', () => {
    it('should fetch and cache version state', async () => {
      const state = { title: 'Test Doc', content: 'Hello world' };
      vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state, rev: 1 });

      const result = await client.getVersionState('v1');

      expect(mockAPI.getVersionState).toHaveBeenCalledWith('doc1', 'v1');
      expect(result).toEqual(state);
      expect(client.state).toEqual(state);
    });

    it('should return cached state on second call', async () => {
      const state = { cached: 'data' };
      vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state, rev: 1 });

      // First call
      await client.getVersionState('v1');

      // Second call
      const result = await client.getVersionState('v1');

      expect(mockAPI.getVersionState).toHaveBeenCalledTimes(1);
      expect(result).toEqual(state);
    });

    it('should emit onStateChange event', async () => {
      const state = { test: 'state' };
      const stateSpy = vi.fn();
      client.onStateChange(stateSpy);
      vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state, rev: 1 });

      await client.getVersionState('v1');

      expect(stateSpy).toHaveBeenCalledWith(state);
    });

    it('should merge with existing cache data', async () => {
      const state = { version: 'state' };
      const changes = [createChange('c1', 1)];

      // First get changes (to populate cache)
      vi.mocked(mockAPI.getVersionChanges).mockResolvedValue(changes);
      await client.getVersionChanges('v1');

      // Then get state (should merge with existing cache)
      vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state, rev: 1 });
      await client.getVersionState('v1');

      expect(mockAPI.getVersionState).toHaveBeenCalledTimes(1);
      expect(mockAPI.getVersionChanges).toHaveBeenCalledTimes(1);
    });
  });

  describe('getVersionChanges', () => {
    it('should fetch and cache version changes', async () => {
      const changes = [createChange('c1', 1), createChange('c2', 2)];
      vi.mocked(mockAPI.getVersionChanges).mockResolvedValue(changes);

      const result = await client.getVersionChanges('v1');

      expect(mockAPI.getVersionChanges).toHaveBeenCalledWith('doc1', 'v1');
      expect(result).toEqual(changes);
    });

    it('should return cached changes on second call', async () => {
      const changes = [createChange('c1', 1)];
      vi.mocked(mockAPI.getVersionChanges).mockResolvedValue(changes);

      // First call
      await client.getVersionChanges('v1');

      // Second call
      const result = await client.getVersionChanges('v1');

      expect(mockAPI.getVersionChanges).toHaveBeenCalledTimes(1);
      expect(result).toEqual(changes);
    });

    it('should merge with existing cache data', async () => {
      const state = { version: 'state' };
      const changes = [createChange('c1', 1)];

      // First get state (to populate cache)
      vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state, rev: 1 });
      await client.getVersionState('v1');

      // Then get changes (should merge with existing cache)
      vi.mocked(mockAPI.getVersionChanges).mockResolvedValue(changes);
      await client.getVersionChanges('v1');

      expect(mockAPI.getVersionState).toHaveBeenCalledTimes(1);
      expect(mockAPI.getVersionChanges).toHaveBeenCalledTimes(1);
    });
  });

  describe('scrubTo', () => {
    beforeEach(async () => {
      // Set up versions in client
      const versions = [createVersion('v1', 1), createVersion('v2', 2, 'v1')];
      vi.mocked(mockAPI.listVersions).mockResolvedValue(versions);
      await client.listVersions();
    });

    it('should scrub to specific change index', async () => {
      const parentState = { title: 'Parent' };
      const changes = [createChange('c1', 1), createChange('c2', 2), createChange('c3', 3)];
      const expectedState = { title: 'Parent', appliedChanges: 2 };

      vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state: parentState, rev: 1 });
      vi.mocked(mockAPI.getVersionChanges).mockResolvedValue(changes);
      vi.mocked(applyChanges).mockReturnValue(expectedState);

      const stateSpy = vi.fn();
      client.onStateChange(stateSpy);

      await client.scrubTo('v2', 2);

      expect(mockAPI.getVersionState).toHaveBeenCalledWith('doc1', 'v1');
      expect(mockAPI.getVersionChanges).toHaveBeenCalledWith('doc1', 'v2');
      expect(applyChanges).toHaveBeenCalledWith(parentState, changes.slice(0, 2));
      expect(client.state).toEqual(expectedState);
      expect(stateSpy).toHaveBeenCalledWith(expectedState);
    });

    it('should handle scrubbing to index 0 (parent version)', async () => {
      const parentState = { title: 'Parent' };
      const changes = [createChange('c1', 1)];

      vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state: parentState, rev: 1 });
      vi.mocked(mockAPI.getVersionChanges).mockResolvedValue(changes);

      await client.scrubTo('v2', 0);

      expect(mockAPI.getVersionState).toHaveBeenCalledWith('doc1', 'v1');
      expect(applyChanges).not.toHaveBeenCalled();
      expect(client.state).toEqual(parentState);
    });

    it('should handle version without parent', async () => {
      const changes = [createChange('c1', 1)];

      vi.mocked(mockAPI.getVersionChanges).mockResolvedValue(changes);

      await client.scrubTo('v1', 1);

      expect(mockAPI.getVersionState).not.toHaveBeenCalled();
      expect(mockAPI.getVersionChanges).toHaveBeenCalledWith('doc1', 'v1');
      expect(applyChanges).toHaveBeenCalledWith(undefined, changes.slice(0, 1));
    });

    it('should emit state change event', async () => {
      const changes = [createChange('c1', 1)];
      const stateSpy = vi.fn();
      client.onStateChange(stateSpy);

      vi.mocked(mockAPI.getVersionChanges).mockResolvedValue(changes);

      await client.scrubTo('v1', 1);

      expect(stateSpy).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should reset all state and clear caches', async () => {
      // Set up some state
      const versions = [createVersion('v1', 1)];
      const state = { test: 'data' };

      vi.mocked(mockAPI.listVersions).mockResolvedValue(versions);
      vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state, rev: 1 });

      await client.listVersions();
      await client.getVersionState('v1');

      expect(client.versions).toHaveLength(1);
      expect(client.state).toEqual(state);

      // Clear everything
      client.clear();

      expect(client.versions).toEqual([]);
      expect(client.state).toBeNull();
    });

    it('should emit events for cleared state', () => {
      const versionsSpy = vi.fn();
      const stateSpy = vi.fn();

      client.onVersionsChange(versionsSpy);
      client.onStateChange(stateSpy);

      client.clear();

      expect(versionsSpy).toHaveBeenCalledWith([]);
      expect(stateSpy).toHaveBeenCalledWith(null);
    });
  });

  describe('LRU cache behavior', () => {
    it('should cache version data', async () => {
      const state = { cached: 'data' };
      const changes = [createChange('c1', 1)];

      vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state, rev: 1 });
      vi.mocked(mockAPI.getVersionChanges).mockResolvedValue(changes);

      // Load both state and changes
      await client.getVersionState('v1');
      await client.getVersionChanges('v1');

      // Second calls should use cache
      await client.getVersionState('v1');
      await client.getVersionChanges('v1');

      expect(mockAPI.getVersionState).toHaveBeenCalledTimes(1);
      expect(mockAPI.getVersionChanges).toHaveBeenCalledTimes(1);
    });

    it('should evict least recently used items when cache is full', async () => {
      // Create many versions to exceed cache size (6)
      const versions = Array.from({ length: 8 }, (_, i) => `v${i + 1}`);

      // Load state for all versions
      for (const versionId of versions) {
        vi.mocked(mockAPI.getVersionState).mockResolvedValue({ state: { id: versionId }, rev: 1 });
        await client.getVersionState(versionId);
      }

      // First few versions should be evicted from cache
      vi.mocked(mockAPI.getVersionState).mockClear();

      // Accessing early version should require new API call
      await client.getVersionState('v1');
      expect(mockAPI.getVersionState).toHaveBeenCalledTimes(1);

      // Accessing recent version should use cache
      await client.getVersionState('v8');
      expect(mockAPI.getVersionState).toHaveBeenCalledTimes(1); // Still 1, no new call
    });
  });

  describe('error handling', () => {
    it('should propagate API errors', async () => {
      const error = new Error('API Error');
      vi.mocked(mockAPI.listVersions).mockRejectedValue(error);

      await expect(client.listVersions()).rejects.toThrow('API Error');
    });

    it('should handle missing version in scrubTo', async () => {
      // Try to scrub to non-existent version
      await client.scrubTo('non-existent', 1);

      // Should still try to get changes but not parent state
      expect(mockAPI.getVersionChanges).toHaveBeenCalledWith('doc1', 'non-existent');
      expect(mockAPI.getVersionState).not.toHaveBeenCalled();
    });
  });

  describe('event signals', () => {
    it('should provide onVersionsChange signal', () => {
      const callback = vi.fn();
      const unsubscribe = client.onVersionsChange(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should provide onStateChange signal', () => {
      const callback = vi.fn();
      const unsubscribe = client.onStateChange(callback);

      expect(typeof unsubscribe).toBe('function');
    });
  });
});
