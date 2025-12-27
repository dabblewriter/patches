import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOfflineSessionsAndBatches } from '../../../src/algorithms/server/handleOfflineSessionsAndBatches';
import type { PatchesStoreBackend } from '../../../src/server/types';
import type { Change } from '../../../src/types';
import { createServerTimestamp } from '../../../src/utils/dates';

// Mock the dependencies
vi.mock('crypto-id');
vi.mock('../../../src/data/version');
vi.mock('../../../src/algorithms/shared/applyChanges');
vi.mock('../../../src/algorithms/server/getStateAtRevision');

describe('handleOfflineSessionsAndBatches', () => {
  let mockStore: PatchesStoreBackend;
  const sessionTimeoutMillis = 300000; // 5 minutes

  /** Creates an ISO timestamp from milliseconds since epoch */
  const toISO = (ms: number): string => new Date(ms).toISOString().replace('Z', '+00:00');

  const createChange = (id: string, rev: number, createdAtMs: number): Change => ({
    id,
    rev,
    baseRev: rev - 1,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    createdAt: toISO(createdAtMs),
    committedAt: createServerTimestamp(),
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock crypto-id
    const { createSortableId } = await import('crypto-id');
    vi.mocked(createSortableId).mockReturnValue('generated-group-id');

    // Mock createVersion
    const { createVersionMetadata: createVersion } = await import('../../../src/data/version');
    vi.mocked(createVersion).mockImplementation((data: any) => ({
      id: 'version-id',
      origin: 'offline' as const,
      startDate: Date.now(),
      endDate: Date.now(),
      rev: 1,
      baseRev: 0,
      ...(data || {}),
    }));

    // Mock applyChanges
    const { applyChanges } = await import('../../../src/algorithms/shared/applyChanges');
    vi.mocked(applyChanges).mockImplementation((state: any, changes: any) => ({
      ...(state || {}),
      appliedChanges: changes.length,
    }));

    // Mock getStateAtRevision
    const { getStateAtRevision } = await import('../../../src/algorithms/server/getStateAtRevision');
    vi.mocked(getStateAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 5,
    });

    mockStore = {
      listVersions: vi.fn(),
      createVersion: vi.fn(),
      updateVersion: vi.fn(),
      loadVersionState: vi.fn(),
      saveChanges: vi.fn(),
    } as any;
  });

  it('should create new version for first batch without existing groupId', async () => {
    const changes = [createChange('1', 6, 1000), createChange('2', 7, 1100)];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    const result = await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5);

    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      groupId: 'generated-group-id',
      reverse: true,
      limit: 1,
    });

    expect(mockStore.createVersion).toHaveBeenCalled();

    // Should return collapsed changes
    expect(result).toHaveLength(1);
    expect(result[0].ops).toHaveLength(2); // Combined ops
  });

  it('should create new version when batchId is provided', async () => {
    const changes = [createChange('1', 6, 1000), createChange('2', 7, 1100)];
    const batchId = 'custom-batch-id';

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5, batchId);

    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      groupId: batchId, // Should use provided batchId as groupId
      reverse: true,
      limit: 1,
    });
  });

  it('should extend existing version when within timeout', async () => {
    const existingVersion = {
      id: 'existing-version',
      parentId: 'parent-version',
      endedAt: toISO(1000),
      origin: 'offline' as const,
      startedAt: toISO(900),
      rev: 1,
      baseRev: 0,
    };
    const changes = [
      createChange('1', 6, 1200), // Within timeout
    ];

    vi.mocked(mockStore.listVersions).mockResolvedValue([existingVersion]);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue({ existingState: true });

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5);

    expect(mockStore.loadVersionState).toHaveBeenCalledWith('doc1', 'existing-version');
    expect(mockStore.updateVersion).toHaveBeenCalledWith('doc1', 'existing-version', {});
  });

  it('should create new session when timeout exceeded', async () => {
    const existingVersion = {
      id: 'existing-version',
      parentId: 'parent-version',
      endedAt: toISO(1000),
      origin: 'offline' as const,
      startedAt: toISO(900),
      rev: 1,
      baseRev: 0,
    };
    const changes = [
      createChange('1', 6, 400000), // Exceeds timeout (300000ms)
    ];

    vi.mocked(mockStore.listVersions).mockResolvedValue([existingVersion]);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue({ existingState: true });

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5);

    expect(mockStore.createVersion).toHaveBeenCalled();
  });

  it('should handle multiple sessions within same batch', async () => {
    const changes = [
      createChange('1', 6, 1000),
      createChange('2', 7, 1100),
      createChange('3', 8, 400000), // Large gap - new session
      createChange('4', 9, 400100),
    ];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5);

    // Should create two versions (two sessions)
    expect(mockStore.createVersion).toHaveBeenCalledTimes(2);
  });

  it('should collapse all changes into single change for transformation', async () => {
    const changes = [createChange('1', 6, 1000), createChange('2', 7, 1100), createChange('3', 8, 1200)];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    const result = await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5);

    expect(result).toHaveLength(1);
    expect(result[0].ops).toHaveLength(3); // All ops combined
    expect(result[0].id).toBe(changes[0].id); // Should keep first change's id
  });

  it('should handle single change', async () => {
    const changes = [createChange('1', 6, 1000)];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    const result = await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(changes[0]); // Should return the same change
  });

  it('should use getStateAtRevision for initial base state when no existing version', async () => {
    const changes = [createChange('1', 6, 1000)];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5);

    const { getStateAtRevision } = await import('../../../src/algorithms/server/getStateAtRevision');
    expect(getStateAtRevision).toHaveBeenCalledWith(mockStore, 'doc1', 5);
  });

  it('should set correct metadata for created versions', async () => {
    const changes = [createChange('1', 6, 1000), createChange('2', 7, 2000)];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5);

    const { createVersionMetadata: createVersion } = await import('../../../src/data/version');
    expect(createVersion).toHaveBeenCalledWith({
      parentId: undefined,
      groupId: 'generated-group-id',
      origin: 'offline',
      startedAt: new Date(1000).toISOString(),
      endedAt: new Date(2000).toISOString(),
      rev: 7,
      baseRev: 5,
    });
  });
});
