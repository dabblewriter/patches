import { describe, it, expect, vi } from 'vitest';
import {
  buildVersionState,
  getBaseStateBeforeVersion,
  getStateBeforeVersionAsStream,
} from '../../../../src/algorithms/ot/server/buildVersionState';
import {
  applyChangesForReconstruction,
  ApplyChangesError,
  type SkippedChange,
} from '../../../../src/algorithms/ot/shared/applyChanges';
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

function makeStore(changes: Change[], versions: VersionMetadata[] = []): OTStoreBackend {
  const states = new Map(versions.map(v => [v.id, JSON.stringify(stateAt(changes, v.endRev))]));
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
    // the invalid rev 3) are replayed as gap changes.
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
  });

  it('getBaseStateBeforeVersion stays strict without explicit reconstruction options', async () => {
    const gapVersion = versionMeta({ id: 'v2', startRev: 5, endRev: 5 });
    const store = makeStore(changeLog);
    await expect(getBaseStateBeforeVersion(store, 'projects/p1/content', gapVersion)).rejects.toThrow(
      ApplyChangesError
    );
  });

  it('getStateBeforeVersionAsStream reconstructs through the invalid op when opted in', async () => {
    const gapVersion = versionMeta({ id: 'v2', startRev: 5, endRev: 5 });
    const store = makeStore(changeLog);

    const stream = await getStateBeforeVersionAsStream(store, 'projects/p1/content', gapVersion, {
      reconstruction: { onSkippedChange: () => {} },
    });
    const json = await readStreamAsString(stream);

    expect(JSON.parse(json)).toEqual({ docs: { '5wPI': { children: ['scene-1', 'scene-2'] } } });
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
    warn.mockRestore();
  });

  it('resolves the missing parent on the streaming path too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore(cleanLog, [parent]);
    const version = versionMeta({ id: 'v2', startRev: 5, endRev: 5 }); // no parentId

    const json = await readStreamAsString(await getStateBeforeVersionAsStream(store, docId, version));

    expect(JSON.parse(json)).toEqual({ words: ['one', 'two', 'three'] });
    expect(readsFrom(store)).toEqual([3]);
    warn.mockRestore();
  });

  it('builds the first version of a document with no parent', async () => {
    const store = makeStore(cleanLog);
    const version = versionMeta({ id: 'v1', startRev: 1, endRev: 5 });

    const state = await buildVersionState(store, docId, version, cleanLog);

    expect(state).toEqual({ words: ['one', 'two', 'three', 'four'] });
    // Nothing precedes rev 1: no parent to look for, no history to bridge.
    expect(store.listVersions).not.toHaveBeenCalled();
    expect(readsFrom(store)).toEqual([]);
  });
});
