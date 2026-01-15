import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOfflineSessionsAndBatches } from '../../../src/algorithms/server/handleOfflineSessionsAndBatches';
import type { PatchesStoreBackend } from '../../../src/server/types';
import type { Change } from '../../../src/types';
import { getISO } from '../../../src/utils/dates';

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
    committedAt: getISO(),
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
      origin: 'offline-branch' as const,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
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
      appendVersionChanges: vi.fn(),
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
      origin: 'offline-branch' as const,
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
    expect(mockStore.appendVersionChanges).toHaveBeenCalledWith(
      'doc1',
      'existing-version',
      changes,
      expect.any(String), // newEndedAt
      6, // newRev from the change
      expect.any(Object) // mergedState
    );
    expect(mockStore.updateVersion).not.toHaveBeenCalled();
    expect(mockStore.saveChanges).not.toHaveBeenCalled();
  });

  it('should create new session when timeout exceeded', async () => {
    const existingVersion = {
      id: 'existing-version',
      parentId: 'parent-version',
      endedAt: toISO(1000),
      origin: 'offline-branch' as const,
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
    // toISO strips milliseconds
    const toUTC = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}/, '');
    expect(createVersion).toHaveBeenCalledWith({
      parentId: undefined,
      groupId: 'generated-group-id',
      origin: 'offline-branch',
      isOffline: true,
      startedAt: toUTC(1000),
      endedAt: toUTC(2000),
      endRev: 7,
      startRev: 5,
    });
  });

  it('should break collapsed changes when maxPayloadBytes is set and exceeded', async () => {
    // Create changes with large ops that when collapsed will exceed the limit
    const createLargeChange = (id: string, rev: number, createdAtMs: number): Change => ({
      id,
      rev,
      baseRev: rev - 1,
      ops: [{ op: 'add', path: `/change-${id}`, value: 'x'.repeat(200) }],
      createdAt: toISO(createdAtMs),
      committedAt: getISO(),
    });

    const changes = [createLargeChange('1', 6, 1000), createLargeChange('2', 7, 1100), createLargeChange('3', 8, 1200)];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    // Set a maxPayloadBytes that will be exceeded by the collapsed change
    const maxPayloadBytes = 400; // Small enough to trigger breaking
    const result = await handleOfflineSessionsAndBatches(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      5,
      undefined,
      'offline-branch',
      true,
      maxPayloadBytes
    );

    // Should return multiple changes since the collapsed one was too large
    expect(result.length).toBeGreaterThan(1);
    // Each resulting change should be smaller than maxPayloadBytes
    for (const change of result) {
      expect(JSON.stringify(change).length).toBeLessThanOrEqual(maxPayloadBytes);
    }
  });

  it('should not break collapsed changes when maxPayloadBytes is not set', async () => {
    const createLargeChange = (id: string, rev: number, createdAtMs: number): Change => ({
      id,
      rev,
      baseRev: rev - 1,
      ops: [{ op: 'add', path: `/change-${id}`, value: 'x'.repeat(200) }],
      createdAt: toISO(createdAtMs),
      committedAt: getISO(),
    });

    const changes = [createLargeChange('1', 6, 1000), createLargeChange('2', 7, 1100), createLargeChange('3', 8, 1200)];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    // No maxPayloadBytes set
    const result = await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 5);

    // Should return single collapsed change
    expect(result).toHaveLength(1);
    expect(result[0].ops).toHaveLength(3);
  });

  it('should return unchanged changes when origin is main (fast-forward)', async () => {
    const changes = [createChange('1', 6, 1000), createChange('2', 7, 1100)];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    const result = await handleOfflineSessionsAndBatches(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      5,
      undefined,
      'main', // Fast-forward case
      true
    );

    // Should return unchanged changes (not collapsed)
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(changes[0]);
    expect(result[1]).toBe(changes[1]);
  });
});
