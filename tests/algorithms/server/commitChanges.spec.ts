import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitChanges } from '../../../src/algorithms/server/commitChanges';
import type { PatchesStoreBackend } from '../../../src/server/types';
import type { Change } from '../../../src/types';

// Mock the dependencies
vi.mock('../../../src/algorithms/shared/applyChanges');
vi.mock('../../../src/algorithms/server/createVersion');
vi.mock('../../../src/algorithms/server/getSnapshotAtRevision');
vi.mock('../../../src/algorithms/server/getStateAtRevision');
vi.mock('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
vi.mock('../../../src/algorithms/server/transformIncomingChanges');

describe('commitChanges', () => {
  let mockStore: PatchesStoreBackend;
  const sessionTimeoutMillis = 300000; // 5 minutes

  const createChange = (id: string, rev: number, baseRev: number, created: number = Date.now()): Change => ({
    id,
    rev,
    baseRev,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    created,
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock applyChanges
    const { applyChanges } = await import('../../../src/algorithms/shared/applyChanges');
    vi.mocked(applyChanges).mockImplementation((state: any, changes: any) => ({
      ...(state || {}),
      appliedChanges: changes.length,
    }));

    // Mock createVersion
    const { createVersion } = await import('../../../src/algorithms/server/createVersion');
    vi.mocked(createVersion).mockResolvedValue(undefined);

    // Mock getSnapshotAtRevision
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [],
    });

    // Mock getStateAtRevision
    const { getStateAtRevision } = await import('../../../src/algorithms/server/getStateAtRevision');
    vi.mocked(getStateAtRevision).mockResolvedValue({
      state: { stateAtBaseRev: true },
      rev: 0,
    });

    // Mock handleOfflineSessionsAndBatches
    const { handleOfflineSessionsAndBatches } = await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
    vi.mocked(handleOfflineSessionsAndBatches).mockImplementation(async (store, timeout, docId, changes) => changes);

    // Mock transformIncomingChanges
    const { transformIncomingChanges } = await import('../../../src/algorithms/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockImplementation((changes, state, committed, currentRev) => {
      return changes.map((change, index) => ({
        ...change,
        rev: currentRev + index + 1,
      }));
    });

    mockStore = {
      listChanges: vi.fn(),
      saveChanges: vi.fn(),
    } as any;
  });

  it('should return empty arrays for empty changes array', async () => {
    const result = await commitChanges(mockStore, 'doc1', [], sessionTimeoutMillis);

    expect(result).toEqual([[], []]);
    expect(mockStore.listChanges).not.toHaveBeenCalled();
    expect(mockStore.saveChanges).not.toHaveBeenCalled();
  });

  it('should throw error when changes lack baseRev', async () => {
    const changes = [{ id: '1', rev: 1, ops: [], created: Date.now() }] as Change[];

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis))
      .rejects
      .toThrow('Client changes must include baseRev for doc doc1.');
  });

  it('should throw error when changes have inconsistent baseRev', async () => {
    const changes = [
      createChange('1', 1, 0),
      createChange('2', 2, 1), // Different baseRev
    ];

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis))
      .rejects
      .toThrow('Client changes must have consistent baseRev in all changes for doc doc1.');
  });

  it('should throw error when baseRev is ahead of server', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('existing', 1, 0)],
    });

    const changes = [createChange('1', 1, 5)]; // baseRev ahead of server

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis))
      .rejects
      .toThrow('Client baseRev (5) is ahead of server revision (1) for doc doc1. Client needs to reload the document.');
  });

  it('should throw error when trying to create document that already exists', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('existing', 1, 0)],
    });

    const changes = [createChange('1', 1, 0)];
    changes[0].ops = [{ op: 'add', path: '', value: {} }]; // Root creation

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis))
      .rejects
      .toThrow('Client baseRev is 0 but server has already been created for doc doc1. Client needs to load the existing document.');
  });

  it('should allow root creation when part of initial batch', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('existing', 1, 0)],
    });

    const changes = [createChange('1', 2, 0)]; // rev > 1 indicates part of initial batch
    changes[0].batchId = 'initial-batch';
    changes[0].ops = [{ op: 'add', path: '', value: {} }];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(result[1]).toHaveLength(1); // Should have transformed changes
  });

  it('should normalize created timestamps to be in the past', async () => {
    const futureTime = Date.now() + 10000;
    const changes = [createChange('1', 1, 0, futureTime)];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(changes[0].created).toBeLessThanOrEqual(Date.now());
  });

  it('should create version when last change is older than session timeout', async () => {
    const oldTime = Date.now() - sessionTimeoutMillis - 1000;
    const lastChange = createChange('old', 1, 0, oldTime);

    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [lastChange],
    });

    const changes = [createChange('1', 2, 1)];
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { createVersion } = await import('../../../src/algorithms/server/createVersion');
    expect(createVersion).toHaveBeenCalledWith(
      mockStore,
      'doc1',
      expect.objectContaining({ appliedChanges: 1 }),
      [lastChange]
    );
  });

  it('should filter out already committed changes', async () => {
    const existingChange = createChange('existing', 2, 1);
    const newChange = createChange('new', 3, 1);
    
    const changes = [existingChange, newChange];

    // Mock server state to have existing changes up to rev 2
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('server1', 1, 0), existingChange],
    });

    vi.mocked(mockStore.listChanges).mockResolvedValue([existingChange]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(result[0]).toEqual([existingChange]); // Committed changes
    expect(result[1]).toHaveLength(1); // Only new change should be transformed
    expect(result[1][0].id).toBe('new');
  });

  it('should return committed changes when all incoming changes already exist', async () => {
    const existingChange = createChange('existing', 2, 1);
    const changes = [existingChange];

    // Mock server state to have existing changes up to rev 2
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('server1', 1, 0), existingChange],
    });

    vi.mocked(mockStore.listChanges).mockResolvedValue([existingChange]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(result[0]).toEqual([existingChange]);
    expect(result[1]).toEqual([]);
    expect(mockStore.saveChanges).not.toHaveBeenCalled();
  });

  it('should handle offline changes when batchId is present', async () => {
    const changes = [createChange('1', 1, 0)];
    changes[0].batchId = 'offline-batch';

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { handleOfflineSessionsAndBatches } = await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      0,
      'offline-batch'
    );
  });

  it('should handle offline changes when timestamp is older than session timeout', async () => {
    const oldTime = Date.now() - sessionTimeoutMillis - 1000;
    const changes = [createChange('1', 1, 0, oldTime)];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { handleOfflineSessionsAndBatches } = await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      0,
      undefined
    );
  });

  it('should transform changes against committed changes', async () => {
    const committedChange = createChange('committed', 2, 0);
    const incomingChanges = [createChange('incoming', 1, 0)];

    vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);

    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [committedChange],
    });

    await commitChanges(mockStore, 'doc1', incomingChanges, sessionTimeoutMillis);

    const { transformIncomingChanges } = await import('../../../src/algorithms/server/transformIncomingChanges');
    expect(transformIncomingChanges).toHaveBeenCalledWith(
      incomingChanges,
      expect.objectContaining({ stateAtBaseRev: true }),
      [committedChange],
      2
    );
  });

  it('should save transformed changes to store', async () => {
    const changes = [createChange('1', 1, 0)];
    const transformedChanges = [{ ...changes[0], rev: 1 }];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const { transformIncomingChanges } = await import('../../../src/algorithms/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockReturnValue(transformedChanges);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(mockStore.saveChanges).toHaveBeenCalledWith('doc1', transformedChanges);
  });

  it('should not save when no transformed changes', async () => {
    const changes = [createChange('1', 1, 0)];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const { transformIncomingChanges } = await import('../../../src/algorithms/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockReturnValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(mockStore.saveChanges).not.toHaveBeenCalled();
  });

  it('should return both committed and transformed changes', async () => {
    const committedChange = createChange('committed', 2, 0);
    const incomingChange = createChange('incoming', 1, 0);
    const transformedChange = { ...incomingChange, rev: 3 };

    vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);

    const { transformIncomingChanges } = await import('../../../src/algorithms/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockReturnValue([transformedChange]);

    const result = await commitChanges(mockStore, 'doc1', [incomingChange], sessionTimeoutMillis);

    expect(result[0]).toEqual([committedChange]);
    expect(result[1]).toEqual([transformedChange]);
  });

  it('should exclude changes with matching batchId from committed changes', async () => {
    const changes = [createChange('1', 1, 0)];
    changes[0].batchId = 'test-batch';

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', {
      startAfter: 0,
      withoutBatchId: 'test-batch',
    });
  });

  it('should handle complex scenario with multiple changes and offline processing', async () => {
    const oldTime = Date.now() - sessionTimeoutMillis - 1000;
    const recentTime = Date.now() - 1000;
    
    const committedChange = createChange('committed', 2, 0, oldTime);
    const incomingChanges = [
      createChange('incoming1', 1, 0, oldTime),
      createChange('incoming2', 2, 0, recentTime),
    ];
    
    const processedChanges = [createChange('processed', 1, 0, oldTime)];
    const transformedChanges = [{ ...processedChanges[0], rev: 3 }];

    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [committedChange],
    });

    vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);

    const { handleOfflineSessionsAndBatches } = await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
    vi.mocked(handleOfflineSessionsAndBatches).mockResolvedValue(processedChanges);

    const { transformIncomingChanges } = await import('../../../src/algorithms/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockReturnValue(transformedChanges);

    const result = await commitChanges(mockStore, 'doc1', incomingChanges, sessionTimeoutMillis);

    expect(handleOfflineSessionsAndBatches).toHaveBeenCalled();
    expect(transformIncomingChanges).toHaveBeenCalledWith(
      processedChanges,
      expect.any(Object),
      [committedChange],
      2
    );
    expect(mockStore.saveChanges).toHaveBeenCalledWith('doc1', transformedChanges);
    expect(result[0]).toEqual([committedChange]);
    expect(result[1]).toEqual(transformedChanges);
  });
});