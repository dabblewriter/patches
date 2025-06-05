import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSnapshotAtRevision } from '../../../src/algorithms/server/getSnapshotAtRevision';
import type { PatchesStoreBackend } from '../../../src/server';

describe('getSnapshotAtRevision', () => {
  let mockStore: PatchesStoreBackend;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStore = {
      listVersions: vi.fn(),
      loadVersionState: vi.fn(),
      listChanges: vi.fn(),
    } as any;
  });

  it('should get latest snapshot when no revision specified', async () => {
    const mockVersions = [{ 
      id: 'v1', 
      rev: 10,
      origin: 'main' as const,
      startDate: 1000,
      endDate: 2000,
      baseRev: 0
    }];
    const mockState = { text: 'hello', count: 5 };
    const mockChanges = [
      { id: 'c1', rev: 11, baseRev: 10, created: 1100, ops: [{ op: 'replace', path: '/text', value: 'world' }] },
      { id: 'c2', rev: 12, baseRev: 11, created: 1200, ops: [{ op: 'replace', path: '/count', value: 10 }] },
    ];

    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(mockState);
    vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

    const result = await getSnapshotAtRevision(mockStore, 'doc1');

    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: undefined,
      origin: 'main',
      orderBy: 'rev',
    });
    expect(mockStore.loadVersionState).toHaveBeenCalledWith('doc1', 'v1');
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', {
      startAfter: 10,
      endBefore: undefined,
    });

    expect(result).toEqual({
      state: mockState,
      rev: 10,
      changes: mockChanges,
    });
  });

  it('should get snapshot at specific revision', async () => {
    const mockVersions = [{ 
      id: 'v1', 
      rev: 5,
      origin: 'main' as const,
      startDate: 1000,
      endDate: 2000,
      baseRev: 0
    }];
    const mockState = { text: 'hello' };
    const mockChanges = [
      { id: 'c1', rev: 6, baseRev: 5, created: 1100, ops: [{ op: 'replace', path: '/text', value: 'world' }] },
      { id: 'c2', rev: 7, baseRev: 6, created: 1200, ops: [{ op: 'add', path: '/count', value: 1 }] },
    ];

    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(mockState);
    vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

    const result = await getSnapshotAtRevision(mockStore, 'doc1', 7);

    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 8, // rev + 1
      origin: 'main',
      orderBy: 'rev',
    });
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', {
      startAfter: 5,
      endBefore: 8, // rev + 1
    });

    expect(result).toEqual({
      state: mockState,
      rev: 5,
      changes: mockChanges,
    });
  });

  it('should handle case with no versions found', async () => {
    const mockChanges = [{ id: 'c1', rev: 1, baseRev: 0, created: 1100, ops: [{ op: 'add', path: '/text', value: 'hello' }] }];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);
    vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

    const result = await getSnapshotAtRevision(mockStore, 'doc1');

    expect(mockStore.loadVersionState).not.toHaveBeenCalled();
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', {
      startAfter: 0,
      endBefore: undefined,
    });

    expect(result).toEqual({
      state: null,
      rev: 0,
      changes: mockChanges,
    });
  });

  it('should handle case with no version state', async () => {
    const mockVersions = [{ 
      id: 'v1', 
      rev: 10,
      origin: 'main' as const,
      startDate: 1000,
      endDate: 2000,
      baseRev: 0
    }];
    const mockChanges = [{ id: 'c1', rev: 11, baseRev: 10, created: 1100, ops: [{ op: 'add', path: '/text', value: 'hello' }] }];

    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(null);
    vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

    const result = await getSnapshotAtRevision(mockStore, 'doc1');

    expect(result).toEqual({
      state: null,
      rev: 10,
      changes: mockChanges,
    });
  });

  it('should handle empty changes list', async () => {
    const mockVersions = [{ 
      id: 'v1', 
      rev: 10,
      origin: 'main' as const,
      startDate: 1000,
      endDate: 2000,
      baseRev: 0
    }];
    const mockState = { text: 'hello' };

    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(mockState);
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await getSnapshotAtRevision(mockStore, 'doc1');

    expect(result).toEqual({
      state: mockState,
      rev: 10,
      changes: [],
    });
  });

  it('should work with revision 0', async () => {
    const mockChanges = [{ id: 'c1', rev: 1, baseRev: 0, created: 1100, ops: [{ op: 'add', path: '/text', value: 'hello' }] }];

    vi.mocked(mockStore.listVersions).mockResolvedValue([]);
    vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

    const result = await getSnapshotAtRevision(mockStore, 'doc1', 0);

    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: undefined, // When rev is 0, startAfter should be undefined
      origin: 'main',
      orderBy: 'rev',
    });
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', {
      startAfter: 0,
      endBefore: undefined, // When rev is 0, endBefore becomes undefined
    });

    expect(result).toEqual({
      state: null,
      rev: 0,
      changes: mockChanges,
    });
  });

  it('should handle complex scenario with multiple versions', async () => {
    const mockVersions = [{ 
      id: 'v2', 
      rev: 15,
      origin: 'main' as const,
      startDate: 1000,
      endDate: 2000,
      baseRev: 0
    }]; // Latest version before rev 20
    const mockState = { users: [{ name: 'John' }], settings: { theme: 'dark' } };
    const mockChanges = [
      { id: 'c1', rev: 16, baseRev: 15, created: 1100, ops: [{ op: 'add', path: '/users/1', value: { name: 'Jane' } }] },
      { id: 'c2', rev: 17, baseRev: 16, created: 1200, ops: [{ op: 'replace', path: '/settings/theme', value: 'light' }] },
      { id: 'c3', rev: 18, baseRev: 17, created: 1300, ops: [{ op: 'add', path: '/posts', value: [] }] },
    ];

    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(mockState);
    vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

    const result = await getSnapshotAtRevision(mockStore, 'doc1', 18);

    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 19,
      origin: 'main',
      orderBy: 'rev',
    });
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', {
      startAfter: 15,
      endBefore: 19,
    });

    expect(result).toEqual({
      state: mockState,
      rev: 15,
      changes: mockChanges,
    });
  });
});
