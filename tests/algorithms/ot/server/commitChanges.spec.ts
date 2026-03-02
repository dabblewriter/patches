import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitChanges } from '../../../../src/algorithms/ot/server/commitChanges';
import type { OTStoreBackend } from '../../../../src/server/types';
import type { Change } from '../../../../src/types';

// Mock the dependencies
vi.mock('../../../../src/algorithms/ot/server/handleOfflineSessionsAndBatches');
vi.mock('../../../../src/algorithms/ot/server/transformIncomingChanges');

describe('commitChanges', () => {
  let mockStore: OTStoreBackend;
  const sessionTimeoutMillis = 300000; // 5 minutes

  /** Creates a timestamp offset by the given milliseconds from now */
  const createTimestamp = (offsetMs: number = 0): number => {
    return Date.now() + offsetMs;
  };

  const createChange = (id: string, rev: number, baseRev: number, createdAt: number = Date.now()): Change => ({
    id,
    rev,
    baseRev,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    createdAt,
    committedAt: Date.now(),
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock handleOfflineSessionsAndBatches
    const { handleOfflineSessionsAndBatches } =
      await import('../../../../src/algorithms/ot/server/handleOfflineSessionsAndBatches');
    vi.mocked(handleOfflineSessionsAndBatches).mockImplementation(async () => {});

    // Mock transformIncomingChanges
    const { transformIncomingChanges } = await import('../../../../src/algorithms/ot/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockImplementation((changes, committed, currentRev) => {
      return changes.map((change, index) => ({
        ...change,
        rev: currentRev + index + 1,
      }));
    });

    mockStore = {
      getCurrentRev: vi.fn().mockResolvedValue(0),
      listChanges: vi.fn().mockResolvedValue([]),
      saveChanges: vi.fn(),
      // Versioning methods (not used in commitChanges but required by interface)
      createVersion: vi.fn(),
      listVersions: vi.fn(),
      loadVersionState: vi.fn(),
      updateVersion: vi.fn(),
      deleteDoc: vi.fn(),
    } as any;
  });

  it('should return empty arrays for empty changes array', async () => {
    const result = await commitChanges(mockStore, 'doc1', [], sessionTimeoutMillis);

    expect(result).toEqual({ catchupChanges: [], newChanges: [] });
    expect(mockStore.listChanges).not.toHaveBeenCalled();
    expect(mockStore.saveChanges).not.toHaveBeenCalled();
  });

  it('should fill in baseRev when missing (apply to latest)', async () => {
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(5);

    // Change without baseRev
    const changes = [{ id: '1', ops: [{ op: 'add', path: '/foo', value: 'bar' }], createdAt: Date.now() }] as Change[];

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Returned transformed changes should have baseRev filled in
    expect(result.newChanges).toHaveLength(1);
    expect(result.newChanges[0].baseRev).toBe(5);
  });

  it('should fill in baseRev for multiple changes when all omit it', async () => {
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(3);

    // Multiple changes without baseRev
    const changes = [
      { id: '1', ops: [{ op: 'add', path: '/foo', value: 'bar' }], createdAt: Date.now() },
      { id: '2', ops: [{ op: 'add', path: '/baz', value: 'qux' }], createdAt: Date.now() },
    ] as Change[];

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Returned transformed changes should have baseRev filled in
    expect(result.newChanges).toHaveLength(2);
    expect(result.newChanges[0].baseRev).toBe(3);
    expect(result.newChanges[1].baseRev).toBe(3);
  });

  it('should throw error when changes have inconsistent baseRev', async () => {
    const changes = [
      createChange('1', 1, 0),
      createChange('2', 2, 1), // Different baseRev
    ];

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis)).rejects.toThrow(
      'Client changes must have consistent baseRev in all changes for doc doc1.'
    );
  });

  it('should throw error when baseRev is ahead of server', async () => {
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(1);

    const changes = [createChange('1', 1, 5)]; // baseRev ahead of server

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis)).rejects.toThrow(
      'Client baseRev (5) is ahead of server revision (1) for doc doc1. Client needs to reload the document.'
    );
  });

  it('should throw error when trying to create document that already exists', async () => {
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(1);

    const changes = [createChange('1', 1, 0)];
    changes[0].ops = [{ op: 'add', path: '', value: {} }]; // Root creation

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis)).rejects.toThrow(
      /Document doc1 already exists.*Cannot apply root-level replace.*would overwrite the existing document/
    );
  });

  it('should allow root creation when part of initial batch', async () => {
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(1);

    const changes = [createChange('1', 2, 0)]; // rev > 1 indicates part of initial batch
    changes[0].batchId = 'initial-batch';
    changes[0].ops = [{ op: 'add', path: '', value: {} }];

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(result.newChanges).toHaveLength(1); // Should have transformed changes
  });

  it('should rebase baseRev:0 granular changes to head on existing docs', async () => {
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(5);

    // Granular change with explicit baseRev: 0 (never-synced client)
    const changes = [createChange('new', 1, 0)];
    changes[0].ops = [{ op: 'replace', path: '/darkMode', value: true }];

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Should rebase to head (rev 5)
    expect(result.newChanges).toHaveLength(1);
    expect(result.newChanges[0].baseRev).toBe(5);
  });

  it('should still throw error for root replace with baseRev:0 on existing docs', async () => {
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(5);

    // Root replace with explicit baseRev: 0
    const changes = [createChange('1', 1, 0)];
    changes[0].ops = [{ op: 'replace', path: '', value: { newDoc: true } }];

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis)).rejects.toThrow(
      /Document doc1 already exists.*Cannot apply root-level replace/
    );
  });

  it('should normalize createdAt timestamps to be in the past', async () => {
    const futureTime = createTimestamp(10000); // 10 seconds in the future
    const changes = [createChange('1', 1, 0, futureTime)];

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Returned transformed changes should have normalized timestamps (clamped to server time)
    expect(result.newChanges[0].createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('should call store.createVersion when last change is older than session timeout', async () => {
    const oldTime = createTimestamp(-sessionTimeoutMillis - 1000);
    const lastChange = createChange('old', 1, 0, oldTime);

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(1);
    vi.mocked(mockStore.listChanges)
      .mockResolvedValueOnce([lastChange]) // First call: reverse/limit for session check
      .mockResolvedValueOnce([]); // Second call: committed changes for transformation

    const changes = [createChange('1', 2, 1)];

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(mockStore.createVersion).toHaveBeenCalledWith('doc1', expect.any(Object), [lastChange]);
  });

  it('should filter out already committed changes', async () => {
    const existingChange = createChange('existing', 2, 1);
    const newChange = createChange('new', 3, 1);

    const changes = [existingChange, newChange];

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(2);
    vi.mocked(mockStore.listChanges)
      .mockResolvedValueOnce([]) // First call: reverse/limit for session check
      .mockResolvedValueOnce([existingChange]); // Second call: committed changes

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(result.catchupChanges).toEqual([existingChange]); // Committed changes
    expect(result.newChanges).toHaveLength(1); // Only new change should be transformed
    expect(result.newChanges[0].id).toBe('new');
  });

  it('should return committed changes when all incoming changes already exist', async () => {
    const existingChange = createChange('existing', 2, 1);
    const changes = [existingChange];

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(2);
    vi.mocked(mockStore.listChanges)
      .mockResolvedValueOnce([]) // First call: reverse/limit for session check
      .mockResolvedValueOnce([existingChange]); // Second call: committed changes

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(result.catchupChanges).toEqual([existingChange]);
    expect(result.newChanges).toEqual([]);
    expect(mockStore.saveChanges).not.toHaveBeenCalled();
  });

  it('should handle offline changes when batchId is present (fast-forward)', async () => {
    const changes = [createChange('1', 1, 0)];
    changes[0].batchId = 'offline-batch';

    // No committed changes = fast-forward with origin 'main'
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { handleOfflineSessionsAndBatches } =
      await import('../../../../src/algorithms/ot/server/handleOfflineSessionsAndBatches');
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      'main' // Fast-forward: origin is 'main'
    );
  });

  it('should handle offline changes when batchId is present (divergent)', async () => {
    const changes = [createChange('1', 1, 0)];
    changes[0].batchId = 'offline-batch';
    const committedChange = createChange('committed', 1, 0);

    // Has committed changes = divergent with origin 'offline-branch'
    vi.mocked(mockStore.listChanges)
      .mockResolvedValueOnce([]) // First call: reverse/limit for session check
      .mockResolvedValueOnce([committedChange]); // Second call: committed changes

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { handleOfflineSessionsAndBatches } =
      await import('../../../../src/algorithms/ot/server/handleOfflineSessionsAndBatches');
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      'offline-branch' // Divergent: origin is 'offline-branch'
    );
  });

  it('should handle offline changes when timestamp is older than session timeout (fast-forward)', async () => {
    const oldTime = createTimestamp(-sessionTimeoutMillis - 1000);
    const changes = [createChange('1', 1, 0, oldTime)];

    // No committed changes = fast-forward with origin 'main'
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { handleOfflineSessionsAndBatches } =
      await import('../../../../src/algorithms/ot/server/handleOfflineSessionsAndBatches');
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      'main' // Fast-forward: origin is 'main'
    );
  });

  it('should transform changes against committed changes (stateless)', async () => {
    const committedChange = createChange('committed', 2, 0);
    const incomingChanges = [createChange('incoming', 1, 0)];

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(2);
    vi.mocked(mockStore.listChanges)
      .mockResolvedValueOnce([]) // First call: reverse/limit for session check
      .mockResolvedValueOnce([committedChange]); // Second call: committed changes

    await commitChanges(mockStore, 'doc1', incomingChanges, sessionTimeoutMillis);

    const { transformIncomingChanges } = await import('../../../../src/algorithms/ot/server/transformIncomingChanges');
    // Stateless: no state parameter, just changes, committed, currentRev, forceCommit
    expect(transformIncomingChanges).toHaveBeenCalledWith(incomingChanges, [committedChange], 2, undefined);
  });

  it('should pass forceCommit option to transformIncomingChanges', async () => {
    const changes = [createChange('1', 1, 0)];

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis, { forceCommit: true });

    const { transformIncomingChanges } = await import('../../../../src/algorithms/ot/server/transformIncomingChanges');
    expect(transformIncomingChanges).toHaveBeenCalledWith(changes, [], 0, true);
  });

  it('should save transformed changes to store', async () => {
    const changes = [createChange('1', 1, 0)];
    const transformedChanges = [{ ...changes[0], rev: 1 }];

    const { transformIncomingChanges } = await import('../../../../src/algorithms/ot/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockReturnValue(transformedChanges);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(mockStore.saveChanges).toHaveBeenCalledWith('doc1', transformedChanges);
  });

  it('should not save when no transformed changes', async () => {
    const changes = [createChange('1', 1, 0)];

    const { transformIncomingChanges } = await import('../../../../src/algorithms/ot/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockReturnValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(mockStore.saveChanges).not.toHaveBeenCalled();
  });

  it('should return both committed and transformed changes', async () => {
    const committedChange = createChange('committed', 2, 0);
    const incomingChange = createChange('incoming', 1, 0);
    const transformedChange = { ...incomingChange, rev: 3 };

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(2);
    vi.mocked(mockStore.listChanges)
      .mockResolvedValueOnce([]) // First call: reverse/limit for session check
      .mockResolvedValueOnce([committedChange]); // Second call: committed changes

    const { transformIncomingChanges } = await import('../../../../src/algorithms/ot/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockReturnValue([transformedChange]);

    const result = await commitChanges(mockStore, 'doc1', [incomingChange], sessionTimeoutMillis);

    expect(result.catchupChanges).toEqual([committedChange]);
    expect(result.newChanges).toEqual([transformedChange]);
  });

  it('should exclude changes with matching batchId from committed changes', async () => {
    const changes = [createChange('1', 1, 0)];
    changes[0].batchId = 'test-batch';

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // The second listChanges call should filter by batchId
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', {
      startAfter: 0,
      withoutBatchId: 'test-batch',
    });
  });
});
