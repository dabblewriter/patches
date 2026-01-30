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
    const { handleOfflineSessionsAndBatches } =
      await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
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

  it('should fill in baseRev when missing (apply to latest)', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('existing', 5, 0)], // Server is at rev 5
    });

    // Change without baseRev
    const changes = [
      { id: '1', ops: [{ op: 'add', path: '/foo', value: 'bar' }], createdAt: Date.now() },
    ] as Change[];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Returned transformed changes should have baseRev filled in
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].baseRev).toBe(5);
  });

  it('should fill in baseRev for multiple changes when all omit it', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('existing', 3, 0)], // Server is at rev 3
    });

    // Multiple changes without baseRev
    const changes = [
      { id: '1', ops: [{ op: 'add', path: '/foo', value: 'bar' }], createdAt: Date.now() },
      { id: '2', ops: [{ op: 'add', path: '/baz', value: 'qux' }], createdAt: Date.now() },
    ] as Change[];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Returned transformed changes should have baseRev filled in
    expect(result[1]).toHaveLength(2);
    expect(result[1][0].baseRev).toBe(3);
    expect(result[1][1].baseRev).toBe(3);
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
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('existing', 1, 0)],
    });

    const changes = [createChange('1', 1, 5)]; // baseRev ahead of server

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis)).rejects.toThrow(
      'Client baseRev (5) is ahead of server revision (1) for doc doc1. Client needs to reload the document.'
    );
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

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis)).rejects.toThrow(
      /Document doc1 already exists.*Cannot apply root-level replace.*would overwrite the existing document/
    );
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

  it('should rebase baseRev:0 granular changes to head on existing docs', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    const { getStateAtRevision } = await import('../../../src/algorithms/server/getStateAtRevision');

    // Document exists with 5 revisions
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [
        createChange('c1', 1, 0),
        createChange('c2', 2, 1),
        createChange('c3', 3, 2),
        createChange('c4', 4, 3),
        createChange('c5', 5, 4),
      ],
    });

    // Granular change with explicit baseRev: 0 (never-synced client)
    const changes = [createChange('new', 1, 0)];
    changes[0].ops = [{ op: 'replace', path: '/darkMode', value: true }];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Should rebase to head (rev 5) - getStateAtRevision called with currentRev, not 0
    expect(getStateAtRevision).toHaveBeenCalledWith(mockStore, 'doc1', 5);

    // Returned change should have baseRev rebased to 5
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].baseRev).toBe(5);
  });

  it('should still throw error for root replace with baseRev:0 on existing docs', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('existing', 5, 0)],
    });

    // Root replace with explicit baseRev: 0
    const changes = [createChange('1', 1, 0)];
    changes[0].ops = [{ op: 'replace', path: '', value: { newDoc: true } }];

    await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis)).rejects.toThrow(
      /Document doc1 already exists.*Cannot apply root-level replace/
    );
  });

  it('should assign correct rev numbers to rebased changes', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [createChange('existing', 10, 0)], // Server at rev 10
    });

    // Multiple granular changes with baseRev: 0
    const changes = [
      { id: '1', baseRev: 0, ops: [{ op: 'replace', path: '/a', value: 1 }], createdAt: Date.now() },
      { id: '2', baseRev: 0, ops: [{ op: 'replace', path: '/b', value: 2 }], createdAt: Date.now() },
    ] as Change[];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Revs should be based on rebased baseRev (10), so 11 and 12
    expect(result[1][0].rev).toBe(11);
    expect(result[1][1].rev).toBe(12);
    expect(result[1][0].baseRev).toBe(10);
    expect(result[1][1].baseRev).toBe(10);
  });

  it('should filter soft empty container adds when rebasing baseRev:0 on existing docs', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    const { applyChanges } = await import('../../../src/algorithms/shared/applyChanges');

    // Mock state that has data at /settings
    vi.mocked(applyChanges).mockReturnValue({ settings: { theme: 'dark' } });

    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: {},
      rev: 0,
      changes: [createChange('existing', 5, 0)],
    });

    // Change with empty object add to existing path (implicit soft write)
    const changes = [
      {
        id: '1',
        baseRev: 0,
        ops: [
          { op: 'add', path: '/settings', value: {} }, // Should be filtered - path exists
          { op: 'add', path: '/settings/newProp', value: 'test' }, // Should remain
        ],
        createdAt: Date.now(),
      },
    ] as Change[];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Only the non-soft op should remain
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].ops).toHaveLength(1);
    expect(result[1][0].ops[0].path).toBe('/settings/newProp');
  });

  it('should filter explicit soft ops when rebasing baseRev:0 on existing docs', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    const { applyChanges } = await import('../../../src/algorithms/shared/applyChanges');

    // Mock state that has data at /config
    vi.mocked(applyChanges).mockReturnValue({ config: 'existing' });

    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: {},
      rev: 0,
      changes: [createChange('existing', 3, 0)],
    });

    // Change with explicit soft flag
    const changes = [
      {
        id: '1',
        baseRev: 0,
        ops: [
          { op: 'replace', path: '/config', value: 'new', soft: true }, // Should be filtered
          { op: 'add', path: '/other', value: 'data' }, // Should remain
        ],
        createdAt: Date.now(),
      },
    ] as Change[];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(result[1]).toHaveLength(1);
    expect(result[1][0].ops).toHaveLength(1);
    expect(result[1][0].ops[0].path).toBe('/other');
  });

  it('should keep soft writes to non-existent paths when rebasing baseRev:0', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    const { applyChanges } = await import('../../../src/algorithms/shared/applyChanges');

    // Mock state without the target paths
    vi.mocked(applyChanges).mockReturnValue({ existingData: true });

    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: {},
      rev: 0,
      changes: [createChange('existing', 2, 0)],
    });

    // Soft writes to paths that don't exist
    const changes = [
      {
        id: '1',
        baseRev: 0,
        ops: [
          { op: 'add', path: '/newContainer', value: {} }, // Should remain - path doesn't exist
          { op: 'add', path: '/anotherNew', value: [], soft: true }, // Should remain - path doesn't exist
        ],
        createdAt: Date.now(),
      },
    ] as Change[];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(result[1]).toHaveLength(1);
    expect(result[1][0].ops).toHaveLength(2);
  });

  it('should remove changes with no ops after soft write filtering', async () => {
    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    const { applyChanges } = await import('../../../src/algorithms/shared/applyChanges');

    // Mock state that has data at the target path
    vi.mocked(applyChanges).mockReturnValue({ settings: {} });

    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: {},
      rev: 0,
      changes: [createChange('existing', 1, 0)],
    });

    // Change with only soft ops that will all be filtered
    const changes = [
      {
        id: '1',
        baseRev: 0,
        ops: [{ op: 'add', path: '/settings', value: {} }], // Will be filtered
        createdAt: Date.now(),
      },
      {
        id: '2',
        baseRev: 0,
        ops: [{ op: 'add', path: '/newPath', value: 'data' }], // Will remain
        createdAt: Date.now(),
      },
    ] as Change[];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Only the second change should remain
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].id).toBe('2');
  });

  it('should normalize createdAt timestamps to be in the past', async () => {
    const futureTime = createTimestamp(10000); // 10 seconds in the future
    const changes = [createChange('1', 1, 0, futureTime)];

    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // Returned transformed changes should have normalized timestamps (clamped to server time)
    expect(result[1][0].createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('should create version when last change is older than session timeout', async () => {
    const oldTime = createTimestamp(-sessionTimeoutMillis - 1000);
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
    expect(createVersion).toHaveBeenCalledWith(mockStore, 'doc1', expect.objectContaining({ appliedChanges: 1 }), [
      lastChange,
    ]);
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

  it('should handle offline changes when batchId is present (fast-forward)', async () => {
    const changes = [createChange('1', 1, 0)];
    changes[0].batchId = 'offline-batch';

    // No committed changes = fast-forward with origin 'main'
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { handleOfflineSessionsAndBatches } =
      await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      0,
      'offline-batch',
      'main', // Fast-forward: origin is 'main'
      true, // isOffline
      undefined // maxPayloadBytes
    );
  });

  it('should handle offline changes when batchId is present (divergent)', async () => {
    const changes = [createChange('1', 1, 0)];
    changes[0].batchId = 'offline-batch';
    const committedChange = createChange('committed', 1, 0);

    // Has committed changes = divergent with origin 'offline-branch'
    vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { handleOfflineSessionsAndBatches } =
      await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      0,
      'offline-batch',
      'offline-branch', // Divergent: origin is 'offline-branch'
      true, // isOffline
      undefined // maxPayloadBytes
    );
  });

  it('should handle offline changes when timestamp is older than session timeout (fast-forward)', async () => {
    const oldTime = createTimestamp(-sessionTimeoutMillis - 1000);
    const changes = [createChange('1', 1, 0, oldTime)];

    // No committed changes = fast-forward with origin 'main'
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { handleOfflineSessionsAndBatches } =
      await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      0,
      undefined,
      'main', // Fast-forward: origin is 'main'
      true, // isOffline
      undefined // maxPayloadBytes
    );
  });

  it('should handle offline changes when timestamp is older than session timeout (divergent)', async () => {
    const oldTime = createTimestamp(-sessionTimeoutMillis - 1000);
    const changes = [createChange('1', 1, 0, oldTime)];
    const committedChange = createChange('committed', 1, 0);

    // Has committed changes = divergent with origin 'offline-branch'
    vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    const { handleOfflineSessionsAndBatches } =
      await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      changes,
      0,
      undefined,
      'offline-branch', // Divergent: origin is 'offline-branch'
      true, // isOffline
      undefined // maxPayloadBytes
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
      2,
      undefined
    );
  });

  it('should pass forceCommit option to transformIncomingChanges', async () => {
    const changes = [createChange('1', 1, 0)];
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis, { forceCommit: true });

    const { transformIncomingChanges } = await import('../../../src/algorithms/server/transformIncomingChanges');
    expect(transformIncomingChanges).toHaveBeenCalledWith(changes, expect.any(Object), [], 0, true);
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
    const oldTime = createTimestamp(-sessionTimeoutMillis - 1000);
    const recentTime = createTimestamp(-1000);

    const committedChange = createChange('committed', 2, 0, oldTime);
    const incomingChanges = [createChange('incoming1', 1, 0, oldTime), createChange('incoming2', 2, 0, recentTime)];

    const processedChanges = [createChange('processed', 1, 0, oldTime)];
    const transformedChanges = [{ ...processedChanges[0], rev: 3 }];

    const { getSnapshotAtRevision } = await import('../../../src/algorithms/server/getSnapshotAtRevision');
    vi.mocked(getSnapshotAtRevision).mockResolvedValue({
      state: { baseState: true },
      rev: 0,
      changes: [committedChange],
    });

    vi.mocked(mockStore.listChanges).mockResolvedValue([committedChange]);

    const { handleOfflineSessionsAndBatches } =
      await import('../../../src/algorithms/server/handleOfflineSessionsAndBatches');
    vi.mocked(handleOfflineSessionsAndBatches).mockResolvedValue(processedChanges);

    const { transformIncomingChanges } = await import('../../../src/algorithms/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockReturnValue(transformedChanges);

    const result = await commitChanges(mockStore, 'doc1', incomingChanges, sessionTimeoutMillis);

    expect(handleOfflineSessionsAndBatches).toHaveBeenCalled();
    expect(transformIncomingChanges).toHaveBeenCalledWith(
      processedChanges,
      expect.any(Object),
      [committedChange],
      2,
      undefined
    );
    expect(mockStore.saveChanges).toHaveBeenCalledWith('doc1', transformedChanges);
    expect(result[0]).toEqual([committedChange]);
    expect(result[1]).toEqual(transformedChanges);
  });
});
