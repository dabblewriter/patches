import { describe, it, expect, vi } from 'vitest';
import {
  buildVersionState,
  getBaseStateBeforeVersion,
  getStateBeforeVersionAsStream,
  MAX_ANCESTOR_HOPS,
  resolveBuildParent,
} from '../../../../src/algorithms/ot/server/buildVersionState';
import {
  applyChangesForReconstruction,
  ApplyChangesError,
  type SkippedChange,
} from '../../../../src/algorithms/ot/shared/applyChanges';
import { StatusError } from '../../../../src/net/error';
import { readStreamAsString } from '../../../../src/server/jsonReadable';
import type { OTStoreBackend } from '../../../../src/server/types';
import type { Change, VersionMetadata } from '../../../../src/types';

// End-to-end version building over a committed log containing a historically
// invalid op (an out-of-range array index committed under lenient pre-strict
// semantics). Uses the real applyPatch — no mocks — to mirror production.

const createChange = (rev: number, ops: any[]): Change => ({
  id: `change-${rev}`,
  rev,
  baseRev: rev - 1,
  ops,
  createdAt: 1000 + rev,
  committedAt: 1000 + rev,
});

/** rev 3 carries an invalid array-index op (children has 1 element, op targets /18). */
const changeLog: Change[] = [
  createChange(1, [{ op: 'replace', path: '', value: { docs: { '5wPI': { children: [] } } } }]),
  createChange(2, [{ op: 'add', path: '/docs/5wPI/children/0', value: 'scene-1' }]),
  createChange(3, [{ op: 'add', path: '/docs/5wPI/children/18', value: 'scene-lost' }]),
  createChange(4, [{ op: 'add', path: '/docs/5wPI/children/1', value: 'scene-2' }]),
];

const versionMeta = (overrides: Partial<VersionMetadata> = {}): VersionMetadata => ({
  id: 'v1',
  origin: 'main',
  startedAt: 1001,
  endedAt: 1004,
  startRev: 1,
  endRev: 4,
  ...overrides,
});

/** State at `rev` — replayed leniently, the way a real store builds version state. */
const stateAt = (changes: Change[], rev: number) =>
  applyChangesForReconstruction(
    null,
    changes.filter(c => c.rev <= rev),
    { onSkippedChange: () => {} }
  );

function makeStore(changes: Change[], versions: VersionMetadata[] = [], statelessIds: string[] = []): OTStoreBackend {
  const states = new Map(
    versions.filter(v => !statelessIds.includes(v.id)).map(v => [v.id, JSON.stringify(stateAt(changes, v.endRev))])
  );
  return {
    getCurrentRev: vi.fn(async () => changes.at(-1)?.rev ?? 0),
    listChanges: vi.fn(async (_docId: string, options: any = {}) => {
      const startAfter = options.startAfter ?? 0;
      const endBefore = options.endBefore ?? Infinity;
      return changes.filter(c => c.rev > startAfter && c.rev < endBefore);
    }),
    // Mirrors the reversed-cursor semantics of ListVersionsOptions: under `reverse` on
    // `endRev`, `startAfter: N` selects versions with `endRev < N`.
    listVersions: vi.fn(async (_docId: string, options: any = {}) => {
      let result = versions.filter(v => !options.origin || v.origin === options.origin);
      result.sort((a, b) => b.endRev - a.endRev);
      if (options.startAfter !== undefined) result = result.filter(v => v.endRev < options.startAfter);
      return options.limit !== undefined ? result.slice(0, options.limit) : result;
    }),
    loadVersion: vi.fn(async (_docId: string, id: string) => versions.find(v => v.id === id)),
    loadVersionState: vi.fn(async (_docId: string, id: string) => states.get(id)),
  } as unknown as OTStoreBackend;
}

describe('buildVersionState over a log with an invalid committed op', () => {
  it('PIN: throws ApplyChangesError by default (strict replay)', async () => {
    const store = makeStore(changeLog);
    await expect(buildVersionState(store, 'projects/p1/content', versionMeta(), changeLog)).rejects.toThrow(
      ApplyChangesError
    );
  });

  it('succeeds in reconstruction mode, skipping exactly the invalid change', async () => {
    const store = makeStore(changeLog);
    const skipped: SkippedChange[] = [];

    const state = await buildVersionState(store, 'projects/p1/content', versionMeta(), changeLog, {
      reconstruction: { onSkippedChange: s => skipped.push(s) },
    });

    // All valid changes applied; the invalid one skipped
    expect(state).toEqual({ docs: { '5wPI': { children: ['scene-1', 'scene-2'] } } });

    // Telemetry fired exactly once, with full context for the repair sweep
    expect(skipped).toHaveLength(1);
    expect(skipped[0].change.id).toBe('change-3');
    expect(skipped[0].change.rev).toBe(3);
    expect(skipped[0].index).toBe(2);
    expect(String(skipped[0].error)).toContain('invalid array index');
    expect(skipped[0].change.ops[0].path).toBe('/docs/5wPI/children/18');
  });

  it('applies reconstruction mode to gap changes bridged before the version', async () => {
    // Version v2 starts at rev 5 with parent-less history: revs 1-4 (including
    // the invalid rev 3) are replayed as gap changes. The full replay warns; that
    // warn is under test elsewhere ('version parent chaining').
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gapVersion = versionMeta({ id: 'v2', startRev: 5, endRev: 5 });
    const versionChanges = [createChange(5, [{ op: 'add', path: '/docs/5wPI/children/2', value: 'scene-3' }])];
    const store = makeStore([...changeLog, ...versionChanges]);
    const skipped: SkippedChange[] = [];

    const state = await buildVersionState(store, 'projects/p1/content', gapVersion, versionChanges, {
      reconstruction: { onSkippedChange: s => skipped.push(s) },
    });

    expect(state).toEqual({ docs: { '5wPI': { children: ['scene-1', 'scene-2', 'scene-3'] } } });
    expect(skipped).toHaveLength(1);
    expect(skipped[0].change.id).toBe('change-3');
    warn.mockRestore();
  });

  it('getBaseStateBeforeVersion stays strict without explicit reconstruction options', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // parent-less full replay warns
    const gapVersion = versionMeta({ id: 'v2', startRev: 5, endRev: 5 });
    const store = makeStore(changeLog);
    await expect(getBaseStateBeforeVersion(store, 'projects/p1/content', gapVersion)).rejects.toThrow(
      ApplyChangesError
    );
    warn.mockRestore();
  });

  it('getStateBeforeVersionAsStream reconstructs through the invalid op when opted in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // parent-less full replay warns
    const gapVersion = versionMeta({ id: 'v2', startRev: 5, endRev: 5 });
    const store = makeStore(changeLog);

    const stream = await getStateBeforeVersionAsStream(store, 'projects/p1/content', gapVersion, {
      reconstruction: { onSkippedChange: () => {} },
    });
    const json = await readStreamAsString(stream);

    expect(JSON.parse(json)).toEqual({ docs: { '5wPI': { children: ['scene-1', 'scene-2'] } } });
    warn.mockRestore();
  });
});

// A version's base state is bridged forward from its parent's snapshot. With no parent the
// bridge starts at rev 0 and replays the document's entire history — an unbounded read that on
// a large document is expensive enough to fail outright.
describe('version parent chaining', () => {
  const cleanLog: Change[] = [
    createChange(1, [{ op: 'replace', path: '', value: { words: [] } }]),
    createChange(2, [{ op: 'add', path: '/words/0', value: 'one' }]),
    createChange(3, [{ op: 'add', path: '/words/1', value: 'two' }]),
    createChange(4, [{ op: 'add', path: '/words/2', value: 'three' }]),
    createChange(5, [{ op: 'add', path: '/words/3', value: 'four' }]),
  ];

  const parent = versionMeta({ id: 'v-parent', startRev: 1, endRev: 3 });
  const docId = 'projects/p1/content';

  /** The rev each `listChanges` call started reading after; `0` is a full-history replay. */
  const readsFrom = (store: OTStoreBackend) =>
    vi.mocked(store.listChanges).mock.calls.map(([, options]) => options?.startAfter ?? 0);

  it('bridges from the parent snapshot instead of replaying from rev 1', async () => {
    const store = makeStore(cleanLog, [parent]);
    const version = versionMeta({ id: 'v2', parentId: 'v-parent', startRev: 4, endRev: 5 });

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two'] });
    expect(rev).toBe(3);
    // The parent's snapshot already covers revs 1-3 and the version starts at 4, so there is no
    // gap to bridge and the change log is never read.
    expect(readsFrom(store)).toEqual([]);
  });

  it('bounds the gap read to the parent endRev', async () => {
    const store = makeStore(cleanLog, [parent]);
    const version = versionMeta({ id: 'v2', parentId: 'v-parent', startRev: 5, endRev: 5 });

    const { state } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two', 'three'] });
    expect(store.listChanges).toHaveBeenCalledTimes(1);
    expect(store.listChanges).toHaveBeenCalledWith(docId, { startAfter: 3, endBefore: 5 });
  });

  it('resolves a parent the writer failed to record rather than replaying the whole log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(cleanLog, [parent]);
    const version = versionMeta({ id: 'v2', startRev: 5, endRev: 5 }); // no parentId

    const { state } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two', 'three'] });
    expect(readsFrom(store)).toEqual([3]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no parentId'));
    // The resolution already returned the parent's metadata; no re-fetch.
    expect(store.loadVersion).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('resolves the missing parent on the streaming path too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(cleanLog, [parent]);
    const version = versionMeta({ id: 'v2', startRev: 5, endRev: 5 }); // no parentId

    const json = await readStreamAsString(await getStateBeforeVersionAsStream(store, docId, version));

    expect(JSON.parse(json)).toEqual({ words: ['one', 'two', 'three'] });
    expect(readsFrom(store)).toEqual([3]);
    expect(store.loadVersion).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns about the full replay — not about chaining — when the resolved parent state is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(cleanLog, [parent]);
    vi.mocked(store.loadVersionState).mockResolvedValue(undefined); // resolved parent's state is gone
    const version = versionMeta({ id: 'v2', startRev: 5, endRev: 5 }); // no parentId

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two', 'three'] });
    expect(rev).toBe(4);
    expect(readsFrom(store)).toEqual([0]); // full-history replay
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable parent'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('chaining'));
    warn.mockRestore();
  });

  it('warns about the full replay when the recorded parent cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(cleanLog); // no versions: the recorded parent is dead
    const version = versionMeta({ id: 'v2', parentId: 'v-gone', startRev: 5, endRev: 5 });

    const { state } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two', 'three'] });
    expect(readsFrom(store)).toEqual([0]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable parent'));
    warn.mockRestore();
  });

  it('ignores a recorded parent whose snapshot overlaps the version', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(cleanLog, [parent]); // parent snapshot covers revs 1-3
    const version = versionMeta({ id: 'v2', parentId: 'v-parent', startRev: 3, endRev: 5 });

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    // The parent's snapshot (endRev 3) already contains rev 3; the true base is the state at rev 2.
    expect(state).toEqual({ words: ['one'] });
    expect(rev).toBe(2);
    expect(readsFrom(store)).toEqual([0]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlaps'));
    warn.mockRestore();
  });

  it('keeps the streaming fast path from serving an overlapping parent state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(cleanLog, [parent]);
    const version = versionMeta({ id: 'v2', parentId: 'v-parent', startRev: 3, endRev: 5 });

    const json = await readStreamAsString(await getStateBeforeVersionAsStream(store, docId, version));

    // Unguarded, the no-gap fast path (endRev 3 >= startRev - 1) would stream the parent's
    // rev-3 bytes verbatim — one rev too new.
    expect(JSON.parse(json)).toEqual({ words: ['one'] });
    expect(readsFrom(store)).toEqual([0]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlaps'));
    warn.mockRestore();
  });

  it('walks past a stateless parent to the nearest ancestor with state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const grandparent = versionMeta({ id: 'v-gp', startRev: 1, endRev: 2 });
    const statelessParent = versionMeta({ id: 'v-mid', parentId: 'v-gp', startRev: 3, endRev: 3 });
    const store = makeStore(cleanLog, [grandparent, statelessParent], ['v-mid']);
    const version = versionMeta({ id: 'v2', parentId: 'v-mid', startRev: 4, endRev: 5 });

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two'] });
    expect(rev).toBe(3);
    // Only the gap between the grandparent (endRev 2) and startRev 4 is bridged — never the full log.
    expect(readsFrom(store)).toEqual([2]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chaining to ancestor v-gp'));
    warn.mockRestore();
  });

  it('walks past a stateless parent on the streaming path too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const grandparent = versionMeta({ id: 'v-gp', startRev: 1, endRev: 2 });
    const statelessParent = versionMeta({ id: 'v-mid', parentId: 'v-gp', startRev: 3, endRev: 3 });
    const store = makeStore(cleanLog, [grandparent, statelessParent], ['v-mid']);
    const version = versionMeta({ id: 'v2', parentId: 'v-mid', startRev: 4, endRev: 5 });

    const json = await readStreamAsString(await getStateBeforeVersionAsStream(store, docId, version));

    expect(JSON.parse(json)).toEqual({ words: ['one', 'two'] });
    expect(readsFrom(store)).toEqual([2]);
    warn.mockRestore();
  });

  it('walks past a stateless parent whose metadata overlaps the version', async () => {
    // The overlap only makes the parent's SNAPSHOT unusable; with no snapshot
    // there is nothing to reject, and dropping to full replay would abandon a
    // clean stateful ancestor one hop up.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const grandparent = versionMeta({ id: 'v-gp', startRev: 1, endRev: 2 });
    const statelessOverlapping = versionMeta({ id: 'v-mid', parentId: 'v-gp', startRev: 3, endRev: 4 });
    const store = makeStore(cleanLog, [grandparent, statelessOverlapping], ['v-mid']);
    const version = versionMeta({ id: 'v2', parentId: 'v-mid', startRev: 3, endRev: 5 });

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one'] });
    expect(rev).toBe(2);
    expect(readsFrom(store)).toEqual([]); // chained from v-gp, no replay
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chaining to ancestor v-gp'));
    warn.mockRestore();
  });

  it('bounds the ancestor walk on a chain with no state anywhere', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A stateless parentId chain deeper than the walk's hop limit.
    const depth = MAX_ANCESTOR_HOPS + 5;
    const chain = Array.from({ length: depth }, (_, i) =>
      versionMeta({ id: `v-c${i}`, parentId: i > 0 ? `v-c${i - 1}` : undefined, startRev: 1, endRev: 3 })
    );
    const store = makeStore(
      cleanLog,
      chain,
      chain.map(v => v.id)
    );
    const version = versionMeta({ id: 'v2', parentId: `v-c${depth - 1}`, startRev: 5, endRev: 5 });

    const { state } = await getBaseStateBeforeVersion(store, docId, version);

    // No state found within the bound → today's full-history replay, with its warning.
    expect(state).toEqual({ words: ['one', 'two', 'three'] });
    expect(readsFrom(store)).toEqual([0]);
    // 1 read for the recorded parent + the bounded hops, never the whole chain.
    expect(vi.mocked(store.loadVersionState).mock.calls).toHaveLength(MAX_ANCESTOR_HOPS + 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable parent'));
    warn.mockRestore();
  });

  it('treats an empty-string state as missing and walks past it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const grandparent = versionMeta({ id: 'v-gp', startRev: 1, endRev: 2 });
    const truncatedParent = versionMeta({ id: 'v-mid', parentId: 'v-gp', startRev: 3, endRev: 3 });
    const store = makeStore(cleanLog, [grandparent, truncatedParent]);
    // A zero-byte blob reads back as '', not undefined.
    const realLoad = vi.mocked(store.loadVersionState).getMockImplementation()!;
    vi.mocked(store.loadVersionState).mockImplementation(async (d: string, id: string) =>
      id === 'v-mid' ? '' : realLoad(d, id)
    );
    const version = versionMeta({ id: 'v2', parentId: 'v-mid', startRev: 4, endRev: 5 });

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two'] });
    expect(rev).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chaining to ancestor v-gp'));
    warn.mockRestore();
  });

  it('warns once when a resolved parent is stateless and walked past', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const grandparent = versionMeta({ id: 'v-gp', startRev: 1, endRev: 2 });
    const statelessParent = versionMeta({ id: 'v-mid', parentId: 'v-gp', startRev: 3, endRev: 3 });
    const store = makeStore(cleanLog, [grandparent, statelessParent], ['v-mid']);
    const version = versionMeta({ id: 'v2', startRev: 4, endRev: 5 }); // no parentId

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two'] });
    expect(rev).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chaining to ancestor v-gp'));
    warn.mockRestore();
  });

  it('degrades to the replay fallback when a walk hop fails transiently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const grandparent = versionMeta({ id: 'v-gp', startRev: 1, endRev: 2 });
    const statelessParent = versionMeta({ id: 'v-mid', parentId: 'v-gp', startRev: 3, endRev: 3 });
    const store = makeStore(cleanLog, [grandparent, statelessParent], ['v-mid']);
    // The walk hop reads a different subsystem (state blobs) than the replay fallback (change
    // log), so a transient blob-store failure must not fail the whole read.
    const realLoad = vi.mocked(store.loadVersionState).getMockImplementation()!;
    vi.mocked(store.loadVersionState).mockImplementation(async (d: string, id: string) => {
      if (id === 'v-gp') throw new Error('transient blob outage');
      return realLoad(d, id);
    });
    const version = versionMeta({ id: 'v2', parentId: 'v-mid', startRev: 4, endRev: 5 });

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two'] });
    expect(rev).toBe(3);
    expect(readsFrom(store)).toEqual([0]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ancestor walk failed'), expect.any(Error));
    warn.mockRestore();
  });

  it('propagates a StatusError thrown mid-walk instead of degrading to replay', async () => {
    // A deferred backend can throw a retryable 503 ("build in progress") from loadVersionState.
    // Unlike a transient blob outage, that is an authoritative retry signal — it must reach the
    // caller, not be swallowed into a silent full-history replay.
    const grandparent = versionMeta({ id: 'v-gp', startRev: 1, endRev: 2 });
    const statelessParent = versionMeta({ id: 'v-mid', parentId: 'v-gp', startRev: 3, endRev: 3 });
    const store = makeStore(cleanLog, [grandparent, statelessParent], ['v-mid']);
    const realLoad = vi.mocked(store.loadVersionState).getMockImplementation()!;
    vi.mocked(store.loadVersionState).mockImplementation(async (d: string, id: string) => {
      if (id === 'v-gp') throw new StatusError(503, 'Version build in progress; retry later.');
      return realLoad(d, id);
    });
    const version = versionMeta({ id: 'v2', parentId: 'v-mid', startRev: 4, endRev: 5 });

    const err: any = await getBaseStateBeforeVersion(store, docId, version).catch(e => e);

    expect(err).toBeInstanceOf(StatusError);
    expect(err.code).toBe(503);
  });

  it('resolves a stateless ancestor that recorded no parentId, mid-walk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const grandparent = versionMeta({ id: 'v-gp', startRev: 1, endRev: 2 });
    // Stateless AND — unlike the walk tests above — recording no parentId of its own. A bare
    // parentId walk would exit on entry here and drop to full-history replay.
    const statelessParent = versionMeta({ id: 'v-mid', startRev: 3, endRev: 3 });
    const store = makeStore(cleanLog, [grandparent, statelessParent], ['v-mid']);
    const version = versionMeta({ id: 'v2', parentId: 'v-mid', startRev: 4, endRev: 5 });

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    expect(state).toEqual({ words: ['one', 'two'] });
    expect(rev).toBe(3);
    // findLatestMainVersion resolves the link v-mid failed to record → a bounded bridge from
    // the grandparent's endRev 2, not the full-history replay (readsFrom [0]) a bare walk gives.
    expect(readsFrom(store)).toEqual([2]);
    expect(store.listVersions).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chaining to ancestor v-gp'));
    warn.mockRestore();
  });

  it('rejects a walked-to ancestor whose snapshot overlaps the version', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const grandparent = versionMeta({ id: 'v-gp', startRev: 1, endRev: 3 }); // contains rev 3
    // The direct parent is clean (endRev 2 stays below startRev 3) but stateless, so the walk
    // hops to v-gp — whose snapshot overlaps. resolveBuildParent can't catch this; the final
    // guard must.
    const statelessParent = versionMeta({ id: 'v-mid', parentId: 'v-gp', startRev: 1, endRev: 2 });
    const store = makeStore(cleanLog, [grandparent, statelessParent], ['v-mid']);
    const version = versionMeta({ id: 'v2', parentId: 'v-mid', startRev: 3, endRev: 5 }); // bogus recorded chain

    const { state, rev } = await getBaseStateBeforeVersion(store, docId, version);

    // The walked-to ancestor's snapshot (endRev 3) already contains rev 3 — unusable.
    expect(state).toEqual({ words: ['one'] });
    expect(rev).toBe(2);
    expect(readsFrom(store)).toEqual([0]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlaps'));
    warn.mockRestore();
  });

  it('builds the first version of a document with no parent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(cleanLog);
    const version = versionMeta({ id: 'v1', startRev: 1, endRev: 5 });

    const state = await buildVersionState(store, docId, version, cleanLog);

    expect(state).toEqual({ words: ['one', 'two', 'three', 'four'] });
    // Nothing precedes rev 1: no parent to look for, no history to bridge, nothing to warn about.
    expect(store.listVersions).not.toHaveBeenCalled();
    expect(readsFrom(store)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// Exported for deferred-build backends: a builder draining pending versions must order builds
// with the same parent resolution the build itself uses, or drain order and built states diverge.
describe('resolveBuildParent', () => {
  const docId = 'projects/p1/content';
  const log: Change[] = [
    createChange(1, [{ op: 'replace', path: '', value: { words: [] } }]),
    createChange(2, [{ op: 'add', path: '/words/0', value: 'one' }]),
    createChange(3, [{ op: 'add', path: '/words/1', value: 'two' }]),
    createChange(4, [{ op: 'add', path: '/words/2', value: 'three' }]),
  ];

  it('returns the recorded parent without reading any state', async () => {
    const parent = versionMeta({ id: 'v-parent', startRev: 1, endRev: 2 });
    const store = makeStore(log, [parent]);
    const version = versionMeta({ id: 'v2', parentId: 'v-parent', startRev: 3, endRev: 4 });

    await expect(resolveBuildParent(store, docId, version)).resolves.toBe(parent);
    expect(store.loadVersionState).not.toHaveBeenCalled();
  });

  it("returns an overlapping recorded parent — usability is the build's concern, not resolution's", async () => {
    // Rejecting here would also skip the ancestor walk: a stateless
    // overlapping link must still be walked past to a clean ancestor.
    const parent = versionMeta({ id: 'v-parent', startRev: 1, endRev: 3 }); // contains rev 3
    const store = makeStore(log, [parent]);
    const version = versionMeta({ id: 'v2', parentId: 'v-parent', startRev: 3, endRev: 4 });

    await expect(resolveBuildParent(store, docId, version)).resolves.toBe(parent);
  });

  it('resolves the latest main version below startRev when no parentId was recorded', async () => {
    const parent = versionMeta({ id: 'v-parent', startRev: 1, endRev: 3 });
    const store = makeStore(log, [parent]);
    const version = versionMeta({ id: 'v2', startRev: 4, endRev: 4 });

    await expect(resolveBuildParent(store, docId, version)).resolves.toBe(parent);
  });

  it('never resolves an orphan version stamped past the committed change log', async () => {
    // currentRev is 4; the orphan claims endRev 6 (e.g. left by a no-op offline commit). A raw
    // "latest main below startRev" query would pick it; the clamp bounds the search to the log.
    const legit = versionMeta({ id: 'v-legit', startRev: 1, endRev: 4 });
    const orphan = versionMeta({ id: 'v-orphan', startRev: 5, endRev: 6 });
    const store = makeStore(log, [legit, orphan]);
    const version = versionMeta({ id: 'v2', startRev: 8, endRev: 8 });

    await expect(resolveBuildParent(store, docId, version)).resolves.toBe(legit);
  });

  it('returns undefined at the rev-1 origin and for a dangling parentId', async () => {
    const store = makeStore(log, []);

    await expect(
      resolveBuildParent(store, docId, versionMeta({ id: 'v1', startRev: 1, endRev: 4 }))
    ).resolves.toBeUndefined();
    expect(store.listVersions).not.toHaveBeenCalled();

    const dangling = versionMeta({ id: 'v2', parentId: 'v-gone', startRev: 3, endRev: 4 });
    await expect(resolveBuildParent(store, docId, dangling)).resolves.toBeUndefined();
  });
});
