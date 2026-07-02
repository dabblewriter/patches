import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../../../src/algorithms/ot/shared/applyChanges';
import { transformIncomingChanges } from '../../../../src/algorithms/ot/server/transformIncomingChanges';
import { createChange } from '../../../../src/data/change';
import type { Change } from '../../../../src/types';

// These tests run against the real transform machinery (no mocks): the off-by-N frame bug
// this file guards against was invisible to mocked transforms.

describe('transformIncomingChanges', () => {
  const txt = (value: any[]) => ({ op: '@txt', path: '/text', value });

  const textOf = (state: any): string =>
    new Delta(state.text).ops.map((op: any) => (typeof op.insert === 'string' ? op.insert : '')).join('');

  it('should transform changes and assign sequential revision numbers', () => {
    const incomingChanges = [
      createChange(2, 0, [{ op: 'replace', path: '/text', value: 'hello world' }]),
      createChange(2, 0, [{ op: 'replace', path: '/count', value: 5 }]),
    ];

    const committedChanges = [createChange(1, 3, [{ op: 'add', path: '/author', value: 'user1' }])];

    const result = transformIncomingChanges(incomingChanges, committedChanges, 3);

    expect(result).toHaveLength(2);
    expect(result[0].rev).toBe(4);
    expect(result[1].rev).toBe(5);
    expect(result[0].ops).toEqual(incomingChanges[0].ops);
    expect(result[1].ops).toEqual(incomingChanges[1].ops);
    expect(result[0].id).toBe(incomingChanges[0].id);
    expect(result[1].id).toBe(incomingChanges[1].id);
  });

  it('should filter out obsolete changes (empty ops after transformation)', () => {
    const incomingChanges = [
      createChange(1, 0, [{ op: 'replace', path: '/item/name', value: 'x' }]), // Obsolete: parent removed
      createChange(1, 0, [{ op: 'replace', path: '/count', value: 5 }]),
    ];

    const committedChanges = [createChange(0, 2, [{ op: 'remove', path: '/item' }])];

    const result = transformIncomingChanges(incomingChanges, committedChanges, 2);

    expect(result).toHaveLength(1);
    expect(result[0].rev).toBe(3);
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/count', value: 5 }]);
  });

  it('should handle empty incoming changes', () => {
    expect(transformIncomingChanges([], [], 1)).toEqual([]);
  });

  it('should handle empty committed changes', () => {
    const incomingChanges = [createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }])];

    const result = transformIncomingChanges(incomingChanges, [], 1);

    expect(result).toHaveLength(1);
    expect(result[0].rev).toBe(2);
    expect(result[0].ops).toEqual(incomingChanges[0].ops);
  });

  it('should preserve change metadata during transformation', () => {
    const metadata = { author: 'user1', timestamp: 12345 };
    const incomingChanges = [
      { ...createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]), ...metadata },
    ];

    const result = transformIncomingChanges(incomingChanges, [], 1);

    expect(result).toHaveLength(1);
    expect((result[0] as any).author).toBe('user1');
    expect((result[0] as any).timestamp).toBe(12345);
  });

  it('should transform against the ops of every committed change', () => {
    const incomingChanges = [createChange(1, 0, [{ op: 'replace', path: '/list/2', value: 'edited' }])];

    // Two committed changes each insert before the incoming change's index, shifting it by two
    const committedChanges = [
      createChange(0, 2, [{ op: 'add', path: '/list/0', value: 'x' }]),
      createChange(1, 3, [{ op: 'add', path: '/list/0', value: 'y' }]),
    ];

    const result = transformIncomingChanges(incomingChanges, committedChanges, 3);

    expect(result).toHaveLength(1);
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/list/4', value: 'edited' }]);
  });

  it('transforms each incoming change in its own frame (off-by-N regression)', () => {
    // base "abc\n"; incoming queue: L1 inserts "12345" at 1, then L2 deletes the "2"
    // (offset 2 in L1's frame). Committed foreign change deletes "b" (offset 1 in base).
    // L2 must be transformed against the committed delete *advanced through L1* (offset 6),
    // not the raw committed delete — the old code shifted L2 to offset 1 and permanently
    // committed a delete of the "1" instead of the "2".
    const base = { text: [{ insert: 'abc\n' }] };
    const mkChange = (id: string, rev: number, ops: any[]): Change => ({
      id,
      rev,
      baseRev: 0,
      ops,
      createdAt: 0,
      committedAt: 0,
    });
    const L1 = mkChange('L1', 1, [txt([{ retain: 1 }, { insert: '12345' }])]);
    const L2 = mkChange('L2', 2, [txt([{ retain: 2 }, { delete: 1 }])]);
    const S = { ...mkChange('S', 1, [txt([{ retain: 1 }, { delete: 1 }])]), committedAt: 99 };

    const transformed = transformIncomingChanges([L1, L2], [S], 1);
    const final = applyChanges(applyChanges(base, [S]), transformed);

    expect(textOf(final)).toBe('a1345c\n');
    expect(transformed[0].rev).toBe(2);
    expect(transformed[1].rev).toBe(3);
  });

  it('transforms each change in the coordinate space of the changes before it in the batch', () => {
    // Confirmed TP1 regression: doc rev 5 is {list:[e0..e11]}. A concurrent user committed add /list/10 "X" (rev 6).
    // The incoming batch removes e0 then replaces the element at index 9 (e10 in its own space). Without advancing
    // the committed ops over the first change, the second change lands on index 9 and destroys "X".
    const committedChanges = [createChange(5, 6, [{ op: 'add', path: '/list/10', value: 'X' }])];
    const incomingChanges = [
      createChange(5, 0, [{ op: 'remove', path: '/list/0' }]),
      createChange(5, 0, [{ op: 'replace', path: '/list/9', value: 'NEW' }]),
    ];

    const result = transformIncomingChanges(incomingChanges, committedChanges, 6);

    expect(result).toHaveLength(2);
    expect(result[0].rev).toBe(7);
    expect(result[0].ops).toEqual([{ op: 'remove', path: '/list/0' }]);
    expect(result[1].rev).toBe(8);
    expect(result[1].ops).toEqual([{ op: 'replace', path: '/list/10', value: 'NEW' }]);
  });

  describe('forceCommit option', () => {
    it('should preserve changes with empty ops when forceCommit is true', () => {
      const incomingChanges = [
        createChange(1, 0, [{ op: 'replace', path: '/item/name', value: 'x' }]), // Transforms to empty
        createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
      ];

      const committedChanges = [createChange(0, 2, [{ op: 'remove', path: '/item' }])];

      const result = transformIncomingChanges(incomingChanges, committedChanges, 2, true);

      expect(result).toHaveLength(2);
      expect(result[0].rev).toBe(3);
      expect(result[0].ops).toEqual([]);
      expect(result[1].rev).toBe(4);
      expect(result[1].ops).toEqual([{ op: 'replace', path: '/text', value: 'world' }]);
    });

    it('should preserve changes that arrive with empty ops when forceCommit is true', () => {
      const incomingChanges = [
        createChange(1, 0, []), // Empty ops
        createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
      ];

      const result = transformIncomingChanges(incomingChanges, [], 1, true);

      expect(result).toHaveLength(2);
      expect(result[0].rev).toBe(2);
      expect(result[0].ops).toEqual([]);
      expect(result[1].rev).toBe(3);
      expect(result[1].ops).toEqual([{ op: 'replace', path: '/text', value: 'world' }]);
    });

    it('should still filter out changes with empty ops when forceCommit is false', () => {
      const incomingChanges = [
        createChange(1, 0, []), // Empty ops
        createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
      ];

      const result = transformIncomingChanges(incomingChanges, [], 1, false);

      // Only the second change should be included
      expect(result).toHaveLength(1);
      expect(result[0].rev).toBe(2);
    });
  });
});
