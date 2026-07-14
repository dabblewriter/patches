import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSnapshotAtRevision, getSnapshotStream } from '../../../../src/algorithms/ot/server/getSnapshotAtRevision';
import { StatusError } from '../../../../src/net/error';
import type { OTStoreBackend } from '../../../../src/server';

async function readStream(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}

describe('getSnapshotAtRevision', () => {
  let mockStore: OTStoreBackend;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStore = {
      getCurrentRev: vi.fn().mockResolvedValue(0),
      listVersions: vi.fn(),
      loadVersionState: vi.fn(),
      listChanges: vi.fn(),
    } as any;
  });

  it('should get latest snapshot when no revision specified', async () => {
    const mockVersions = [
      {
        id: 'v1',
        endRev: 10,
        origin: 'main' as const,
        startedAt: 1000,
        endedAt: 2000,
        startRev: 0,
      },
    ];
    const mockState = { text: 'hello', count: 5 };
    const mockChanges = [
      {
        id: 'c1',
        rev: 11,
        baseRev: 10,
        createdAt: 1100,
        committedAt: 1100,
        ops: [{ op: 'replace', path: '/text', value: 'world' }],
      },
      {
        id: 'c2',
        rev: 12,
        baseRev: 11,
        createdAt: 1200,
        committedAt: 1200,
        ops: [{ op: 'replace', path: '/count', value: 10 }],
      },
    ];

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(12);
    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(JSON.stringify(mockState));
    vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

    const result = await getSnapshotAtRevision(mockStore, 'doc1');

    // No target rev → bounded by currentRev (12). Reversed, `startAfter: 13` is an
    // upper bound (endRev <= 12).
    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 13,
      origin: 'main',
      orderBy: 'endRev',
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
    const mockVersions = [
      {
        id: 'v1',
        endRev: 5,
        origin: 'main' as const,
        startedAt: 1000,
        endedAt: 2000,
        startRev: 0,
      },
    ];
    const mockState = { text: 'hello' };
    const mockChanges = [
      {
        id: 'c1',
        rev: 6,
        baseRev: 5,
        createdAt: 1100,
        committedAt: 1100,
        ops: [{ op: 'replace', path: '/text', value: 'world' }],
      },
      {
        id: 'c2',
        rev: 7,
        baseRev: 6,
        createdAt: 1200,
        committedAt: 1200,
        ops: [{ op: 'add', path: '/count', value: 1 }],
      },
    ];

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(7);
    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(JSON.stringify(mockState));
    vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

    const result = await getSnapshotAtRevision(mockStore, 'doc1', 7);

    // Target rev 7, currentRev 7 → bound = min(7, 7) = 7, so startAfter = 8 (endRev <= 7).
    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 8,
      origin: 'main',
      orderBy: 'endRev',
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
    const mockChanges = [
      {
        id: 'c1',
        rev: 1,
        baseRev: 0,
        createdAt: 1100,
        committedAt: 1100,
        ops: [{ op: 'add', path: '/text', value: 'hello' }],
      },
    ];

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

  it('throws a retryable 503 when a version exists but its state is missing', async () => {
    // A lost (or not-yet-built) state blob must never serve the no-versions shape:
    // null state + only the tail of changes = the document served as EMPTY at rev 10.
    const mockVersions = [
      {
        id: 'v1',
        endRev: 10,
        origin: 'main' as const,
        startedAt: 1000,
        endedAt: 2000,
        startRev: 0,
      },
    ];

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(11);
    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(undefined);

    const err: any = await getSnapshotAtRevision(mockStore, 'doc1').catch(e => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err.code).toBe(503);
    expect(err.data).toEqual({ docId: 'doc1', versionId: 'v1' });
    expect(mockStore.listChanges).not.toHaveBeenCalled();
  });

  it('treats an empty-string state (zero-byte blob) as missing too', async () => {
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(11);
    vi.mocked(mockStore.listVersions).mockResolvedValue([
      { id: 'v1', endRev: 10, origin: 'main' as const, startedAt: 1000, endedAt: 2000, startRev: 0 },
    ]);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue('');

    const err: any = await getSnapshotAtRevision(mockStore, 'doc1').catch(e => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err.code).toBe(503);
  });

  it('should handle empty changes list', async () => {
    const mockVersions = [
      {
        id: 'v1',
        endRev: 10,
        origin: 'main' as const,
        startedAt: 1000,
        endedAt: 2000,
        startRev: 0,
      },
    ];
    const mockState = { text: 'hello' };

    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(JSON.stringify(mockState));
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await getSnapshotAtRevision(mockStore, 'doc1');

    expect(result).toEqual({
      state: mockState,
      rev: 10,
      changes: [],
    });
  });

  it('should bound to the empty state for revision 0', async () => {
    vi.mocked(mockStore.listVersions).mockResolvedValue([]);
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await getSnapshotAtRevision(mockStore, 'doc1', 0);

    // rev 0 is a real bound (the pre-history empty state), not "latest":
    // with currentRev defaulting to 0, bound = min(0, 0) = 0 → startAfter = 1
    // (endRev <= 0), so versions and changes before rev 1 are both excluded.
    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 1,
      origin: 'main',
      orderBy: 'endRev',
    });
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', {
      startAfter: 0,
      endBefore: 1,
    });

    expect(result).toEqual({
      state: null,
      rev: 0,
      changes: [],
    });
  });

  it('should handle complex scenario with multiple versions', async () => {
    const mockVersions = [
      {
        id: 'v2',
        endRev: 15,
        origin: 'main' as const,
        startedAt: 1000,
        endedAt: 2000,
        startRev: 0,
      },
    ]; // Latest version before rev 20
    const mockState = { users: [{ name: 'John' }], settings: { theme: 'dark' } };
    const mockChanges = [
      {
        id: 'c1',
        rev: 16,
        baseRev: 15,
        createdAt: 1100,
        committedAt: 1100,
        ops: [{ op: 'add', path: '/users/1', value: { name: 'Jane' } }],
      },
      {
        id: 'c2',
        rev: 17,
        baseRev: 16,
        createdAt: 1200,
        committedAt: 1200,
        ops: [{ op: 'replace', path: '/settings/theme', value: 'light' }],
      },
      {
        id: 'c3',
        rev: 18,
        baseRev: 17,
        createdAt: 1300,
        committedAt: 1300,
        ops: [{ op: 'add', path: '/posts', value: [] }],
      },
    ];

    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(18);
    vi.mocked(mockStore.listVersions).mockResolvedValue(mockVersions);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(JSON.stringify(mockState));
    vi.mocked(mockStore.listChanges).mockResolvedValue(mockChanges);

    const result = await getSnapshotAtRevision(mockStore, 'doc1', 18);

    // Target rev 18, currentRev 18 → bound = 18, so startAfter = 19 (endRev <= 18).
    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 19,
      origin: 'main',
      orderBy: 'endRev',
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

  it('never selects a version whose endRev is ahead of the committed tip', async () => {
    // Regression: an orphan `offline-branch` version sits at endRev 295 (left by a
    // no-op offline commit) while the real change log tops out at 294. The snapshot
    // must ignore it — otherwise getDoc reports a phantom rev 295.
    const allVersions = [
      { id: 'main294', endRev: 294, startRev: 0, origin: 'main' as const, startedAt: 1, endedAt: 2 },
      { id: 'orphan295', endRev: 295, startRev: 295, origin: 'offline-branch' as const, startedAt: 3, endedAt: 4 },
    ];
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(294);
    // Emulate the production store's reverse-cursor semantics: under `reverse`,
    // `startAfter` is an upper bound (endRev < startAfter), as FirestoreOTStore does.
    vi.mocked(mockStore.listVersions).mockImplementation(async (_doc, opts: any) => {
      const filtered = allVersions
        .filter(v => opts.startAfter === undefined || v.endRev < opts.startAfter)
        .filter(v => opts.origin === undefined || v.origin === opts.origin)
        .sort((a, b) => b.endRev - a.endRev);
      return opts.limit ? filtered.slice(0, opts.limit) : filtered;
    });
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(JSON.stringify({ ok: true }));
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const result = await getSnapshotAtRevision(mockStore, 'doc1');

    // startAfter = 295 (reversed → endRev <= 294) excludes orphan@295; the latest
    // valid main version is 294.
    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 295,
      origin: 'main',
      orderBy: 'endRev',
    });
    expect(mockStore.loadVersionState).toHaveBeenCalledWith('doc1', 'main294');
    expect(result.rev).toBe(294);
  });
});

describe('getSnapshotStream', () => {
  let mockStore: OTStoreBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      getCurrentRev: vi.fn().mockResolvedValue(0),
      listVersions: vi.fn(),
      loadVersionState: vi.fn(),
      listChanges: vi.fn(),
    } as any;
  });

  it('streams the latest snapshot envelope when no revision specified', async () => {
    const changes = [{ id: 'c1', rev: 11, baseRev: 10, createdAt: 1, committedAt: 1, ops: [] }];
    vi.mocked(mockStore.listVersions).mockResolvedValue([{ id: 'v1', endRev: 10 } as any]);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(JSON.stringify({ text: 'hi' }));
    vi.mocked(mockStore.listChanges).mockResolvedValue(changes);

    const json = await readStream(await getSnapshotStream(mockStore, 'doc1'));

    expect(JSON.parse(json)).toEqual({ state: { text: 'hi' }, rev: 10, changes });
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', { startAfter: 10, endBefore: undefined });
  });

  it('bounds the snapshot to the requested revision', async () => {
    const changes = [{ id: 'c6', rev: 6, baseRev: 5, createdAt: 1, committedAt: 1, ops: [] }];
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(10); // doc has changes beyond the requested rev
    vi.mocked(mockStore.listVersions).mockResolvedValue([{ id: 'v1', endRev: 5 } as any]);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(JSON.stringify({ text: 'base' }));
    vi.mocked(mockStore.listChanges).mockResolvedValue(changes);

    const json = await readStream(await getSnapshotStream(mockStore, 'doc1', 6));

    expect(JSON.parse(json)).toEqual({ state: { text: 'base' }, rev: 5, changes });
    // Requested rev 6, currentRev 10 → bound = min(6, 10) = 6, so startAfter = 7 (endRev <= 6).
    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 7,
      origin: 'main',
      orderBy: 'endRev',
    });
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', { startAfter: 5, endBefore: 7 });
  });

  it('streams a null state when no version exists', async () => {
    vi.mocked(mockStore.listVersions).mockResolvedValue([]);
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const json = await readStream(await getSnapshotStream(mockStore, 'doc1'));

    expect(JSON.parse(json)).toEqual({ state: null, rev: 0, changes: [] });
  });

  it('throws a retryable 503 instead of streaming null state when a version state is missing', async () => {
    vi.mocked(mockStore.getCurrentRev).mockResolvedValue(10);
    vi.mocked(mockStore.listVersions).mockResolvedValue([{ id: 'v1', endRev: 10 } as any]);
    vi.mocked(mockStore.loadVersionState).mockResolvedValue(undefined);

    const err: any = await getSnapshotStream(mockStore, 'doc1').catch(e => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err.code).toBe(503);
  });

  it('treats rev 0 as a bound (empty pre-history state), not "latest"', async () => {
    vi.mocked(mockStore.listVersions).mockResolvedValue([]);
    vi.mocked(mockStore.listChanges).mockResolvedValue([]);

    const json = await readStream(await getSnapshotStream(mockStore, 'doc1', 0));

    expect(JSON.parse(json)).toEqual({ state: null, rev: 0, changes: [] });
    // rev 0 → bound = min(0, 0) = 0, so startAfter = 1 (endRev <= 0, nothing before rev 1).
    expect(mockStore.listVersions).toHaveBeenCalledWith('doc1', {
      limit: 1,
      reverse: true,
      startAfter: 1,
      origin: 'main',
      orderBy: 'endRev',
    });
    expect(mockStore.listChanges).toHaveBeenCalledWith('doc1', { startAfter: 0, endBefore: 1 });
  });
});
