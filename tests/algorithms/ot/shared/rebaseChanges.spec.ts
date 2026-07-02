import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../../../src/algorithms/ot/shared/applyChanges';
import { rebaseChanges } from '../../../../src/algorithms/ot/shared/rebaseChanges';
import { transformIncomingChanges } from '../../../../src/algorithms/ot/server/transformIncomingChanges';
import type { Change } from '../../../../src/types';

// These tests run against the real transform machinery (no mocks): the off-by-N frame bug
// this file guards against was invisible to mocked transforms.

describe('rebaseChanges', () => {
  const createChange = (id: string, rev: number, baseRev: number, ops: any[]): Change => ({
    id,
    rev,
    baseRev,
    ops,
    createdAt: 0,
    committedAt: 0,
  });

  const txt = (value: any[]) => ({ op: '@txt', path: '/text', value });

  const textOf = (state: any): string =>
    new Delta(state.text).ops.map((op: any) => (typeof op.insert === 'string' ? op.insert : '')).join('');

  it('returns local changes unchanged when no server changes', () => {
    const localChanges = [
      createChange('local1', 3, 2, [{ op: 'add', path: '/test', value: 'hello' }]),
      createChange('local2', 4, 2, [{ op: 'add', path: '/count', value: 1 }]),
    ];

    expect(rebaseChanges([], localChanges)).toBe(localChanges);
  });

  it('returns empty array when no local changes', () => {
    const serverChanges = [createChange('server1', 3, 2, [{ op: 'add', path: '/server', value: 'data' }])];

    expect(rebaseChanges(serverChanges, [])).toEqual([]);
  });

  it('drops own committed changes from the queue untransformed', () => {
    // Own change come back committed: later local changes were created on top of it,
    // so they must pass through unchanged (no transform against our own ops).
    const own = createChange('own', 5, 4, [txt([{ insert: 'X' }])]);
    const later = createChange('later', 6, 4, [txt([{ retain: 2 }, { insert: 'Y' }])]);

    const result = rebaseChanges([own], [own, later]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('later');
    expect(result[0].ops).toEqual(later.ops);
    expect(result[0].baseRev).toBe(5);
    expect(result[0].rev).toBe(6);
  });

  it('transforms each queued change in its own frame (off-by-N regression)', () => {
    // base "abc\n"; local queue: L1 inserts "12345" at 1, then L2 deletes the "2"
    // (offset 2 in L1's frame). Foreign server change deletes "b" (offset 1 in base).
    // L2 must be transformed against the foreign delete *advanced through L1* (where it
    // sits at offset 6), not the raw foreign delete — the old code shifted L2 to offset 1
    // and deleted the "1" instead of the "2".
    const base = { text: [{ insert: 'abc\n' }] };
    const L1 = createChange('L1', 1, 0, [txt([{ retain: 1 }, { insert: '12345' }])]);
    const L2 = createChange('L2', 2, 0, [txt([{ retain: 2 }, { delete: 1 }])]);
    const S = createChange('S', 1, 0, [txt([{ retain: 1 }, { delete: 1 }])]);

    const rebased = rebaseChanges([S], [L1, L2]);
    const final = applyChanges(applyChanges(base, [S]), rebased);

    expect(textOf(final)).toBe('a1345c\n');
  });

  it('converges with the server transform for the same concurrent edits', () => {
    const base = { text: [{ insert: 'abc\n' }] };
    const L1 = createChange('L1', 1, 0, [txt([{ retain: 1 }, { insert: '12345' }])]);
    const L2 = createChange('L2', 2, 0, [txt([{ retain: 2 }, { delete: 1 }])]);
    const S = createChange('S', 1, 0, [txt([{ retain: 1 }, { delete: 1 }])]);

    const clientFinal = applyChanges(applyChanges(base, [S]), rebaseChanges([S], [L1, L2]));
    const serverFinal = applyChanges(applyChanges(base, [S]), transformIncomingChanges([L1, L2], [S], 1));

    expect(textOf(clientFinal)).toBe(textOf(serverFinal));
  });

  it('advances multiple server changes through the queue in order', () => {
    // base "abcdef\n"; two foreign deletes: "b" (offset 1), then "d" (offset 2 in the
    // frame after the first delete). Local L1 appends "!" after "abcdef", local L2
    // appends "?" after the "!". Both must shift left by 2.
    const base = { text: [{ insert: 'abcdef\n' }] };
    const S1 = createChange('S1', 1, 0, [txt([{ retain: 1 }, { delete: 1 }])]);
    const S2 = createChange('S2', 2, 0, [txt([{ retain: 2 }, { delete: 1 }])]);
    const L1 = createChange('L1', 1, 0, [txt([{ retain: 6 }, { insert: '!' }])]);
    const L2 = createChange('L2', 2, 0, [txt([{ retain: 7 }, { insert: '?' }])]);

    const rebased = rebaseChanges([S1, S2], [L1, L2]);
    const final = applyChanges(applyChanges(base, [S1, S2]), rebased);

    expect(textOf(final)).toBe('acef!?\n');
    expect(rebased[0].baseRev).toBe(2);
    expect(rebased[0].rev).toBe(3);
    expect(rebased[1].rev).toBe(4);
  });

  it('handles own committed change interleaved with foreign changes', () => {
    // Committed order: our L1 first, then a foreign change whose frame includes L1.
    // The queue keeps L2 (created on top of L1); it must be transformed against the
    // foreign change only.
    const base = { text: [{ insert: 'abc\n' }] };
    const L1 = createChange('L1', 1, 0, [txt([{ insert: 'X' }])]); // "Xabc\n"
    const L2 = createChange('L2', 2, 0, [txt([{ retain: 2 }, { insert: 'Y' }])]); // "XaYbc\n"
    const committedL1 = { ...L1, rev: 1, committedAt: 99 };
    // Foreign S in the committed frame after L1: deletes the "a" at offset 1.
    const S = createChange('S', 2, 1, [txt([{ retain: 1 }, { delete: 1 }])]);

    const rebased = rebaseChanges([committedL1, S], [L1, L2]);
    const final = applyChanges(applyChanges(base, [committedL1, S]), rebased);

    expect(rebased).toHaveLength(1);
    expect(rebased[0].id).toBe('L2');
    expect(textOf(final)).toBe('XYbc\n');
  });

  it('drops changes whose ops transform away without consuming a rev', () => {
    const S = createChange('S', 5, 4, [{ op: 'remove', path: '/item' }]);
    const emptied = createChange('emptied', 5, 4, [{ op: 'replace', path: '/item/name', value: 'x' }]);
    const kept = createChange('kept', 6, 4, [{ op: 'add', path: '/other', value: 1 }]);

    const result = rebaseChanges([S], [emptied, kept]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('kept');
    expect(result[0].baseRev).toBe(5);
    expect(result[0].rev).toBe(6);
  });
});
