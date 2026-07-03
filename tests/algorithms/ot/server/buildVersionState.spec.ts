import { describe, it, expect, vi } from 'vitest';
import {
  buildVersionState,
  getBaseStateBeforeVersion,
  getStateBeforeVersionAsStream,
} from '../../../../src/algorithms/ot/server/buildVersionState';
import { ApplyChangesError, type SkippedChange } from '../../../../src/algorithms/ot/shared/applyChanges';
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

function makeStore(changes: Change[]): OTStoreBackend {
  return {
    listChanges: vi.fn(async (_docId: string, options: any = {}) => {
      const startAfter = options.startAfter ?? 0;
      const endBefore = options.endBefore ?? Infinity;
      return changes.filter(c => c.rev > startAfter && c.rev < endBefore);
    }),
    loadVersion: vi.fn(async () => undefined),
    loadVersionState: vi.fn(async () => undefined),
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
