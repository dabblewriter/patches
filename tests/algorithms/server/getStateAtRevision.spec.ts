import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStateAtRevision } from '../../../src/algorithms/server/getStateAtRevision';
import type { PatchesStoreBackend } from '../../../src/server';
import * as getSnapshotAtRevisionModule from '../../../src/algorithms/server/getSnapshotAtRevision';
import * as applyChangesModule from '../../../src/algorithms/shared/applyChanges';

// Mock the dependencies
vi.mock('../../../src/algorithms/server/getSnapshotAtRevision');
vi.mock('../../../src/algorithms/shared/applyChanges');

describe('getStateAtRevision', () => {
  const mockGetSnapshotAtRevision = vi.mocked(getSnapshotAtRevisionModule.getSnapshotAtRevision);
  const mockApplyChanges = vi.mocked(applyChangesModule.applyChanges);
  let mockStore: PatchesStoreBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {} as any;
  });

  it('should return state at specific revision', async () => {
    const versionState = { text: 'hello', count: 0 };
    const finalState = { text: 'world', count: 5 };
    const changes = [
      { id: 'c1', rev: 6, baseRev: 5, createdAt: '2024-01-01T00:00:01.000Z', committedAt: '2024-01-01T00:00:01.000Z', ops: [{ op: 'replace', path: '/text', value: 'world' }] },
      { id: 'c2', rev: 7, baseRev: 6, createdAt: '2024-01-01T00:00:02.000Z', committedAt: '2024-01-01T00:00:02.000Z', ops: [{ op: 'replace', path: '/count', value: 5 }] },
    ];

    mockGetSnapshotAtRevision.mockResolvedValue({
      state: { state: versionState },
      rev: 5,
      changes,
    });
    mockApplyChanges.mockReturnValue(finalState);

    const result = await getStateAtRevision(mockStore, 'doc1', 7);

    expect(mockGetSnapshotAtRevision).toHaveBeenCalledWith(mockStore, 'doc1', 7);
    expect(mockApplyChanges).toHaveBeenCalledWith(versionState, changes);
    expect(result).toEqual({
      state: finalState,
      rev: 7,
    });
  });

  it('should handle null version state', async () => {
    const finalState = { text: 'hello' };
    const changes = [{ id: 'c1', rev: 1, baseRev: 0, createdAt: '2024-01-01T00:00:01.000Z', committedAt: '2024-01-01T00:00:01.000Z', ops: [{ op: 'add', path: '/text', value: 'hello' }] }];

    mockGetSnapshotAtRevision.mockResolvedValue({
      state: null,
      rev: 0,
      changes,
    });
    mockApplyChanges.mockReturnValue(finalState);

    const result = await getStateAtRevision(mockStore, 'doc1', 1);

    expect(mockApplyChanges).toHaveBeenCalledWith(null, changes);
    expect(result).toEqual({
      state: finalState,
      rev: 1,
    });
  });

  it('should handle no changes after version', async () => {
    const versionState = { text: 'hello', count: 0 };

    mockGetSnapshotAtRevision.mockResolvedValue({
      state: { state: versionState },
      rev: 5,
      changes: [],
    });
    mockApplyChanges.mockReturnValue(versionState);

    const result = await getStateAtRevision(mockStore, 'doc1', 5);

    expect(mockApplyChanges).toHaveBeenCalledWith(versionState, []);
    expect(result).toEqual({
      state: versionState,
      rev: 5,
    });
  });

  it('should get latest state when no revision specified', async () => {
    const versionState = { users: [], posts: [] };
    const finalState = { users: [{ name: 'John' }], posts: [{ title: 'Hello' }] };
    const changes = [
      { id: 'c1', rev: 11, baseRev: 10, createdAt: '2024-01-01T00:00:01.000Z', committedAt: '2024-01-01T00:00:01.000Z', ops: [{ op: 'add', path: '/users/0', value: { name: 'John' } }] },
      { id: 'c2', rev: 12, baseRev: 11, createdAt: '2024-01-01T00:00:02.000Z', committedAt: '2024-01-01T00:00:02.000Z', ops: [{ op: 'add', path: '/posts/0', value: { title: 'Hello' } }] },
    ];

    mockGetSnapshotAtRevision.mockResolvedValue({
      state: { state: versionState },
      rev: 10,
      changes,
    });
    mockApplyChanges.mockReturnValue(finalState);

    const result = await getStateAtRevision(mockStore, 'doc1');

    expect(mockGetSnapshotAtRevision).toHaveBeenCalledWith(mockStore, 'doc1', undefined);
    expect(result).toEqual({
      state: finalState,
      rev: 12, // Last change revision
    });
  });

  it('should handle version state without nested state property', async () => {
    const versionState = { text: 'hello' };
    const finalState = { text: 'world' };
    const changes = [{ id: 'c1', rev: 2, baseRev: 1, createdAt: '2024-01-01T00:00:01.000Z', committedAt: '2024-01-01T00:00:01.000Z', ops: [{ op: 'replace', path: '/text', value: 'world' }] }];

    mockGetSnapshotAtRevision.mockResolvedValue({
      state: versionState, // Direct state, not wrapped in { state: ... }
      rev: 1,
      changes,
    });
    mockApplyChanges.mockReturnValue(finalState);

    const result = await getStateAtRevision(mockStore, 'doc1', 2);

    expect(mockApplyChanges).toHaveBeenCalledWith(null, changes); // versionState.state is undefined, so null is used
    expect(result).toEqual({
      state: finalState,
      rev: 2,
    });
  });

  it('should return snapshot revision when no changes exist', async () => {
    const versionState = { text: 'hello' };

    mockGetSnapshotAtRevision.mockResolvedValue({
      state: { state: versionState },
      rev: 10,
      changes: [],
    });
    mockApplyChanges.mockReturnValue(versionState);

    const result = await getStateAtRevision(mockStore, 'doc1', 10);

    expect(result).toEqual({
      state: versionState,
      rev: 10, // Snapshot revision since no changes
    });
  });

  it('should handle complex state transformation', async () => {
    const versionState = {
      users: [{ id: 1, name: 'John', status: 'active' }],
      settings: { theme: 'light', lang: 'en' },
      counters: { posts: 0, views: 100 },
    };

    const finalState = {
      users: [
        { id: 1, name: 'John Doe', status: 'active' },
        { id: 2, name: 'Jane', status: 'pending' },
      ],
      settings: { theme: 'dark', lang: 'en' },
      counters: { posts: 2, views: 150 },
    };

    const changes = [
      { id: 'c1', rev: 21, baseRev: 20, createdAt: '2024-01-01T00:00:01.000Z', committedAt: '2024-01-01T00:00:01.000Z', ops: [{ op: 'replace', path: '/users/0/name', value: 'John Doe' }] },
      { id: 'c2', rev: 22, baseRev: 21, createdAt: '2024-01-01T00:00:02.000Z', committedAt: '2024-01-01T00:00:02.000Z', ops: [{ op: 'add', path: '/users/1', value: { id: 2, name: 'Jane', status: 'pending' } }] },
      { id: 'c3', rev: 23, baseRev: 22, createdAt: '2024-01-01T00:00:03.000Z', committedAt: '2024-01-01T00:00:03.000Z', ops: [{ op: 'replace', path: '/settings/theme', value: 'dark' }] },
      { id: 'c4', rev: 24, baseRev: 23, createdAt: '2024-01-01T00:00:04.000Z', committedAt: '2024-01-01T00:00:04.000Z', ops: [{ op: 'replace', path: '/counters/posts', value: 2 }] },
      { id: 'c5', rev: 25, baseRev: 24, createdAt: '2024-01-01T00:00:05.000Z', committedAt: '2024-01-01T00:00:05.000Z', ops: [{ op: 'replace', path: '/counters/views', value: 150 }] },
    ];

    mockGetSnapshotAtRevision.mockResolvedValue({
      state: { state: versionState },
      rev: 20,
      changes,
    });
    mockApplyChanges.mockReturnValue(finalState);

    const result = await getStateAtRevision(mockStore, 'doc1', 25);

    expect(mockApplyChanges).toHaveBeenCalledWith(versionState, changes);
    expect(result).toEqual({
      state: finalState,
      rev: 25,
    });
  });
});
