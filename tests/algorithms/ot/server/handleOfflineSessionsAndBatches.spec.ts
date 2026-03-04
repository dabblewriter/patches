import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOfflineSessionsAndBatches } from '../../../../src/algorithms/ot/server/handleOfflineSessionsAndBatches';
import type { OTStoreBackend } from '../../../../src/server/types';
import type { Change } from '../../../../src/types';

describe('handleOfflineSessionsAndBatches', () => {
  let mockStore: OTStoreBackend;
  const sessionTimeoutMillis = 300000; // 5 minutes

  const createChange = (id: string, rev: number, createdAtMs: number): Change => ({
    id,
    rev,
    baseRev: rev - 1,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    createdAt: createdAtMs,
    committedAt: Date.now(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      createVersion: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
    } as any;
  });

  it('should call store.createVersion for a single session of changes', async () => {
    const changes = [createChange('1', 6, 1000), createChange('2', 7, 1100)];

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 'offline-branch');

    expect(mockStore.createVersion).toHaveBeenCalledTimes(1);
    expect(mockStore.createVersion).toHaveBeenCalledWith(
      'doc1',
      expect.objectContaining({
        origin: 'offline-branch',
        startRev: 6,
        endRev: 7,
        startedAt: 1000,
        endedAt: 1100,
      }),
      changes
    );
  });

  it('should call store.createVersion per session when there are gaps', async () => {
    const changes = [
      createChange('1', 6, 1000),
      createChange('2', 7, 1100),
      createChange('3', 8, 400000), // Large gap - new session
      createChange('4', 9, 400100),
    ];

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 'offline-branch');

    expect(mockStore.createVersion).toHaveBeenCalledTimes(2);
    expect(mockStore.createVersion).toHaveBeenNthCalledWith(
      1,
      'doc1',
      expect.objectContaining({
        origin: 'offline-branch',
        startRev: 6,
        endRev: 7,
        startedAt: 1000,
        endedAt: 1100,
      }),
      [changes[0], changes[1]]
    );
    expect(mockStore.createVersion).toHaveBeenNthCalledWith(
      2,
      'doc1',
      expect.objectContaining({
        origin: 'offline-branch',
        startRev: 8,
        endRev: 9,
        startedAt: 400000,
        endedAt: 400100,
      }),
      [changes[2], changes[3]]
    );
  });

  it('should handle single change', async () => {
    const changes = [createChange('1', 6, 1000)];

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 'offline-branch');

    expect(mockStore.createVersion).toHaveBeenCalledTimes(1);
    expect(mockStore.createVersion).toHaveBeenCalledWith(
      'doc1',
      expect.objectContaining({
        origin: 'offline-branch',
        startRev: 6,
        endRev: 6,
        startedAt: 1000,
        endedAt: 1000,
      }),
      [changes[0]]
    );
  });

  it('should detect three sessions with two gaps', async () => {
    const changes = [
      createChange('1', 6, 1000),
      createChange('2', 7, 400000), // Gap 1
      createChange('3', 8, 800000), // Gap 2
    ];

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 'offline-branch');

    expect(mockStore.createVersion).toHaveBeenCalledTimes(3);
    expect(mockStore.createVersion).toHaveBeenNthCalledWith(
      1,
      'doc1',
      expect.objectContaining({ startRev: 6, endRev: 6, startedAt: 1000, endedAt: 1000 }),
      [changes[0]]
    );
    expect(mockStore.createVersion).toHaveBeenNthCalledWith(
      2,
      'doc1',
      expect.objectContaining({ startRev: 7, endRev: 7, startedAt: 400000, endedAt: 400000 }),
      [changes[1]]
    );
    expect(mockStore.createVersion).toHaveBeenNthCalledWith(
      3,
      'doc1',
      expect.objectContaining({ startRev: 8, endRev: 8, startedAt: 800000, endedAt: 800000 }),
      [changes[2]]
    );
  });

  it('should set parentId from last main version on first session', async () => {
    const changes = [createChange('1', 6, 1000), createChange('2', 7, 1100)];
    const mainVersion = { id: 'main-v1', endRev: 5, origin: 'main' };

    vi.mocked(mockStore.listVersions).mockResolvedValue([mainVersion] as any);

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 'offline-branch');

    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 6, // firstRev
      origin: 'main',
      orderBy: 'endRev',
    });

    expect(mockStore.createVersion).toHaveBeenCalledWith(
      'doc1',
      expect.objectContaining({ parentId: 'main-v1' }),
      changes
    );
  });

  it('should set undefined parentId when no main version exists', async () => {
    const changes = [createChange('1', 6, 1000)];

    // No main versions found
    vi.mocked(mockStore.listVersions).mockResolvedValue([]);

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 'offline-branch');

    // parentId should not be set (undefined is not included in objectContaining)
    expect(mockStore.createVersion).toHaveBeenCalledWith(
      'doc1',
      expect.not.objectContaining({ parentId: expect.anything() }),
      changes
    );
  });

  it('should not query for main version when origin is main', async () => {
    const changes = [createChange('1', 6, 1000)];

    await handleOfflineSessionsAndBatches(mockStore, sessionTimeoutMillis, 'doc1', changes, 'main');

    expect(mockStore.listVersions).not.toHaveBeenCalled();
    expect(mockStore.createVersion).toHaveBeenCalledWith('doc1', expect.objectContaining({ origin: 'main' }), changes);
  });
});
