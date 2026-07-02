import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitChanges } from '../../../../src/algorithms/ot/server/commitChanges';
import { RevConflictError } from '../../../../src/server/RevConflictError';
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
      listVersions: vi.fn().mockResolvedValue([]),
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
      .mockResolvedValueOnce([lastChange]) // Second call: createVersionAtRev loads all changes since last version
      .mockResolvedValueOnce([]); // Third call: committed changes for transformation

    const changes = [createChange('1', 2, 1)];

    await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    // createVersionAtRev passes all changes since last version (not just the last change)
    expect(mockStore.createVersion).toHaveBeenCalledWith('doc1', expect.any(Object), [lastChange]);
  });

  describe('count-based versioning (maxChangesPerVersion)', () => {
    it('creates a version when a commit crosses a maxChangesPerVersion boundary', async () => {
      // Tip 19 → 20 crosses the boundary at 20 (interval 10); last version at rev 0, so 19
      // un-versioned changes (>= 10) trigger a snapshot even though there is no session gap.
      const lastChange = createChange('19', 19, 18); // recent createdAt → no session-gap trigger
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(19);
      vi.mocked(mockStore.listChanges)
        .mockResolvedValueOnce([lastChange]) // session/count check (reverse, limit 1)
        .mockResolvedValueOnce([createChange('v', 10, 9)]) // createVersionAtRev range load
        .mockResolvedValueOnce([]); // committed changes for transformation

      await commitChanges(mockStore, 'doc1', [createChange('1', 20, 19)], sessionTimeoutMillis, {
        maxChangesPerVersion: 10,
      });

      expect(mockStore.createVersion).toHaveBeenCalledTimes(1);
    });

    it('does not version below the boundary', async () => {
      // Tip 5 → 6 stays within the same interval bucket; no version lookup, no version.
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(5);
      vi.mocked(mockStore.listChanges)
        .mockResolvedValueOnce([createChange('5', 5, 4)]) // session/count check
        .mockResolvedValueOnce([]); // committed changes

      await commitChanges(mockStore, 'doc1', [createChange('1', 6, 5)], sessionTimeoutMillis, {
        maxChangesPerVersion: 10,
      });

      expect(mockStore.listVersions).not.toHaveBeenCalled();
      expect(mockStore.createVersion).not.toHaveBeenCalled();
    });

    it('does not version when fewer than N changes have accrued since the last version', async () => {
      // Boundary is crossed, but the last version is recent (endRev 15) so only 4 changes
      // have accrued — below the threshold.
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(19);
      vi.mocked(mockStore.listVersions).mockResolvedValue([{ endRev: 15 } as any]);
      vi.mocked(mockStore.listChanges)
        .mockResolvedValueOnce([createChange('19', 19, 18)]) // session/count check
        .mockResolvedValueOnce([]); // committed changes

      await commitChanges(mockStore, 'doc1', [createChange('1', 20, 19)], sessionTimeoutMillis, {
        maxChangesPerVersion: 10,
      });

      expect(mockStore.listVersions).toHaveBeenCalled(); // boundary gate fired
      expect(mockStore.createVersion).not.toHaveBeenCalled(); // but 19 - 15 = 4 < 10
    });

    it('drains a backlogged document in N-sized steps until the tail is below N (bounded builds)', async () => {
      // Last version at rev 0, tip at 99, N=10; the 99→100 commit crosses the rev-100 boundary.
      // It must catch the WHOLE backlog up in steps of at most N — not advance by a single N
      // step (the bug: a per-commit +N step left a backlogged doc pinned at a constant lag
      // forever, and let any commit larger than N grow the log without bound). Versions end at
      // 10,20,...,90 (nine builds), each loading at most N changes, leaving a 9-change tail.
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(99);
      const lastChange = createChange('99', 99, 98);
      const rangeLoads: Array<{ startAfter: number; endBefore: number }> = [];
      vi.mocked(mockStore.listChanges).mockImplementation(async (_doc, opts: any) => {
        if (opts?.reverse) return [lastChange]; // session/count tip check
        if (opts?.endBefore !== undefined) {
          // version range load: synthesize the contiguous changes in (startAfter, endBefore)
          rangeLoads.push({ startAfter: opts.startAfter, endBefore: opts.endBefore });
          const out: Change[] = [];
          for (let r = opts.startAfter + 1; r <= Math.min(opts.endBefore - 1, 99); r++) {
            out.push(createChange(String(r), r, r - 1));
          }
          return out;
        }
        return []; // committed-changes load (startAfter only, no endBefore)
      });

      await commitChanges(mockStore, 'doc1', [createChange('c', 100, 99)], sessionTimeoutMillis, {
        maxChangesPerVersion: 10,
      });

      // Nine bounded versions: [1..10], [11..20], ... [81..90]. Tail 91..99 (< N) left for later.
      expect(mockStore.createVersion).toHaveBeenCalledTimes(9);
      // Every build loaded at most N changes (endBefore - 1 - startAfter <= N).
      for (const { startAfter, endBefore } of rangeLoads) {
        expect(endBefore - 1 - startAfter).toBeLessThanOrEqual(10);
      }
      // listVersions is read once for the whole catch-up, not once per step.
      expect(mockStore.listVersions).toHaveBeenCalledTimes(1);
    });

    it('bounds session-gap versioning too: a backlogged session drains in N-sized steps incl. the tail', async () => {
      // A session gap on a doc with a large un-versioned backlog must NOT load the whole backlog
      // in one build. With count versioning enabled it drains in N-sized steps and, because the
      // session is complete, also versions the final < N tail (unlike the count trigger).
      const oldTime = createTimestamp(-sessionTimeoutMillis - 1000);
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(25);
      const lastChange = createChange('25', 25, 24, oldTime); // old → session gap
      const rangeLoads: Array<{ startAfter: number; endBefore: number }> = [];
      vi.mocked(mockStore.listChanges).mockImplementation(async (_doc, opts: any) => {
        if (opts?.reverse) return [lastChange];
        if (opts?.endBefore !== undefined) {
          rangeLoads.push({ startAfter: opts.startAfter, endBefore: opts.endBefore });
          const out: Change[] = [];
          for (let r = opts.startAfter + 1; r <= Math.min(opts.endBefore - 1, 25); r++) {
            out.push(createChange(String(r), r, r - 1));
          }
          return out;
        }
        return [];
      });

      await commitChanges(mockStore, 'doc1', [createChange('c', 26, 25)], sessionTimeoutMillis, {
        maxChangesPerVersion: 10,
      });

      // 25 changes, N=10 → versions end at 10, 20, 25 (the tail IS versioned for a completed session).
      expect(mockStore.createVersion).toHaveBeenCalledTimes(3);
      for (const { startAfter, endBefore } of rangeLoads) {
        expect(endBefore - 1 - startAfter).toBeLessThanOrEqual(10);
      }
    });

    it('runs count-based versioning once even when the save retries on RevConflictError', async () => {
      // Versioning happens before the save/retry loop, so a RevConflictError on save must not
      // re-trigger it. Backlog 19, N=10 → exactly one version, regardless of the retry.
      vi.mocked(mockStore.getCurrentRev).mockResolvedValueOnce(19).mockResolvedValueOnce(19);
      const lastChange = createChange('19', 19, 18);
      vi.mocked(mockStore.listChanges).mockImplementation(async (_doc, opts: any) => {
        if (opts?.reverse) return [lastChange];
        if (opts?.endBefore !== undefined) {
          const out: Change[] = [];
          for (let r = opts.startAfter + 1; r <= Math.min(opts.endBefore - 1, 19); r++) {
            out.push(createChange(String(r), r, r - 1));
          }
          return out;
        }
        return []; // committed-changes load
      });
      vi.mocked(mockStore.saveChanges).mockRejectedValueOnce(new RevConflictError()).mockResolvedValueOnce(undefined);

      await commitChanges(mockStore, 'doc1', [createChange('c', 20, 19)], sessionTimeoutMillis, {
        maxChangesPerVersion: 10,
      });

      expect(mockStore.saveChanges).toHaveBeenCalledTimes(2); // retried
      expect(mockStore.createVersion).toHaveBeenCalledTimes(1); // versioned once, not per attempt
    });

    it('is disabled when maxChangesPerVersion is 0 (the default for direct callers)', async () => {
      vi.mocked(mockStore.getCurrentRev).mockResolvedValue(99);
      vi.mocked(mockStore.listChanges)
        .mockResolvedValueOnce([createChange('99', 99, 98)]) // session/count check
        .mockResolvedValueOnce([]); // committed changes

      await commitChanges(mockStore, 'doc1', [createChange('1', 100, 99)], sessionTimeoutMillis);

      expect(mockStore.listVersions).not.toHaveBeenCalled();
      expect(mockStore.createVersion).not.toHaveBeenCalled();
    });
  });

  it('does not version an offline change that rebases to a no-op (no orphan versions)', async () => {
    // Regression: an offline change whose content is already committed rebases to
    // nothing. It must not be saved AND must not mint an offline-session version —
    // otherwise we get an orphan version stamped at a rev that never persisted.
    const { handleOfflineSessionsAndBatches } =
      await import('../../../../src/algorithms/ot/server/handleOfflineSessionsAndBatches');
    const { transformIncomingChanges } = await import('../../../../src/algorithms/ot/server/transformIncomingChanges');
    vi.mocked(transformIncomingChanges).mockReturnValue([]); // rebases away to nothing

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(5);
    const committed = createChange('committed', 5, 4);
    vi.mocked(mockStore.listChanges)
      .mockResolvedValueOnce([]) // session check: no last change → no createVersionAtRev
      .mockResolvedValueOnce([committed]); // committed changes after baseRev → not a fast-forward

    const oldTime = createTimestamp(-sessionTimeoutMillis - 1000); // offline timestamp
    const offline = createChange('offline', 3, 2, oldTime);

    const result = await commitChanges(mockStore, 'doc1', [offline], sessionTimeoutMillis);

    expect(handleOfflineSessionsAndBatches).not.toHaveBeenCalled();
    expect(mockStore.saveChanges).not.toHaveBeenCalled();
    expect(result.newChanges).toEqual([]);
    expect(result.catchupChanges).toEqual([committed]);
  });

  it('versions an offline change from its persisted (post-transform) rev, not the claimed rev', async () => {
    // When an offline change DOES persist, the version must be built from the rebased
    // change (its real saved rev), never the pre-transform claimed rev.
    const { handleOfflineSessionsAndBatches } =
      await import('../../../../src/algorithms/ot/server/handleOfflineSessionsAndBatches');
    const { transformIncomingChanges } = await import('../../../../src/algorithms/ot/server/transformIncomingChanges');
    const rebased = { ...createChange('offline', 6, 5), rev: 6 }; // rebased onto the real tip
    vi.mocked(transformIncomingChanges).mockReturnValue([rebased]);

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(5);
    const committed = createChange('committed', 5, 4);
    vi.mocked(mockStore.listChanges)
      .mockResolvedValueOnce([]) // session check
      .mockResolvedValueOnce([committed]); // committed → not fast-forward

    const oldTime = createTimestamp(-sessionTimeoutMillis - 1000);
    const offline = createChange('offline', 3, 2, oldTime); // claims rev 3

    await commitChanges(mockStore, 'doc1', [offline], sessionTimeoutMillis);

    // Versioned from the rebased change (rev 6), not the claimed rev 3, and only the persisted change is saved.
    expect(handleOfflineSessionsAndBatches).toHaveBeenCalledWith(
      mockStore,
      sessionTimeoutMillis,
      'doc1',
      [rebased],
      'offline-branch'
    );
    expect(mockStore.saveChanges).toHaveBeenCalledWith('doc1', [rebased]);
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

  it('should commit a change id repeated within one batch only once', async () => {
    // A client retry/flush race can repeat the same change twice in a single incoming
    // array. Committing both copies double-applies the ops (the second copy is never
    // transformed against the first), corrupting every replica.
    const duplicated = createChange('dup', 3, 2);
    const other = createChange('other', 4, 2);

    const changes = [duplicated, { ...duplicated }, other];

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(2);
    vi.mocked(mockStore.listChanges)
      .mockResolvedValueOnce([]) // First call: reverse/limit for session check
      .mockResolvedValueOnce([]); // Second call: committed changes

    const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

    expect(result.newChanges.map(c => c.id)).toEqual(['dup', 'other']);
    expect(mockStore.saveChanges).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(mockStore.saveChanges).mock.calls[0][1] as Change[];
    expect(saved.map(c => c.id)).toEqual(['dup', 'other']);
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

  describe('RevConflictError retry', () => {
    it('should retry on RevConflictError and succeed on second attempt', async () => {
      const changes = [createChange('1', 1, 0)];

      // First saveChanges throws RevConflictError, second succeeds
      vi.mocked(mockStore.saveChanges).mockRejectedValueOnce(new RevConflictError()).mockResolvedValueOnce(undefined);

      // First getCurrentRev returns 0 (used for baseRev setup + first attempt)
      // Second getCurrentRev returns 1 (retry picks up the conflicting commit)
      vi.mocked(mockStore.getCurrentRev).mockResolvedValueOnce(0).mockResolvedValueOnce(1);

      // First listChanges: session check (reverse/limit)
      // Second listChanges: committed changes for first attempt (empty)
      // Third listChanges: committed changes for retry (includes the conflicting change)
      const conflictingChange = createChange('other', 1, 0);
      vi.mocked(mockStore.listChanges)
        .mockResolvedValueOnce([]) // session check
        .mockResolvedValueOnce([]) // first attempt: no committed changes
        .mockResolvedValueOnce([conflictingChange]); // retry: conflicting change now visible

      const result = await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

      expect(mockStore.saveChanges).toHaveBeenCalledTimes(2);
      expect(mockStore.getCurrentRev).toHaveBeenCalledTimes(2);
      expect(result.newChanges).toHaveLength(1);
      expect(result.catchupChanges).toEqual([conflictingChange]);
    });

    it('should throw after exhausting all retries', async () => {
      const changes = [createChange('1', 1, 0)];

      // All saveChanges attempts throw RevConflictError
      vi.mocked(mockStore.saveChanges).mockRejectedValue(new RevConflictError());

      await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis)).rejects.toThrow(RevConflictError);

      expect(mockStore.saveChanges).toHaveBeenCalledTimes(5);
    });

    it('should not retry on non-RevConflictError errors', async () => {
      const changes = [createChange('1', 1, 0)];

      vi.mocked(mockStore.saveChanges).mockRejectedValue(new Error('disk full'));

      await expect(commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis)).rejects.toThrow('disk full');

      expect(mockStore.saveChanges).toHaveBeenCalledTimes(1);
    });

    it('versions the offline session once, from the persisted post-transform changes, after a FF save conflict', async () => {
      // Regression for the FF + conflict-retry residual: the fast-forward branch
      // saves before it versions, so when that save loses a rev conflict NOTHING is
      // versioned. The retry's transform branch then versions from the changes that
      // actually persisted — never the stale pre-transform claim from the FF attempt.
      const oldTime = Date.now() - sessionTimeoutMillis - 1000;
      const changes = [createChange('1', 1, 0, oldTime)]; // claims rev 1

      // First save fails (fast-forward path), second succeeds (transform path)
      vi.mocked(mockStore.saveChanges).mockRejectedValueOnce(new RevConflictError()).mockResolvedValueOnce(undefined);

      vi.mocked(mockStore.getCurrentRev).mockResolvedValueOnce(0).mockResolvedValueOnce(1);

      const conflictingChange = createChange('other', 1, 0);
      vi.mocked(mockStore.listChanges)
        .mockResolvedValueOnce([]) // session check
        .mockResolvedValueOnce([]) // first attempt: no committed changes (fast-forward)
        .mockResolvedValueOnce([conflictingChange]); // retry: now has committed changes

      await commitChanges(mockStore, 'doc1', changes, sessionTimeoutMillis);

      const { handleOfflineSessionsAndBatches } =
        await import('../../../../src/algorithms/ot/server/handleOfflineSessionsAndBatches');
      // Versioned exactly once, and from the rebased rev (transform mock → currentRev+1 = 2),
      // not the pre-transform claimed rev 1 that the conflicting FF attempt would have minted.
      expect(handleOfflineSessionsAndBatches).toHaveBeenCalledTimes(1);
      const versionedChanges = vi.mocked(handleOfflineSessionsAndBatches).mock.calls[0][3];
      expect(versionedChanges).toHaveLength(1);
      expect(versionedChanges[0].rev).toBe(2);
    });
  });
});
