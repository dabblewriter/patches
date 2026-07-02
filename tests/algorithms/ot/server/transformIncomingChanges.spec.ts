import { describe, expect, it } from 'vitest';
import { transformIncomingChanges } from '../../../../src/algorithms/ot/server/transformIncomingChanges';
import { createChange } from '../../../../src/data/change';

describe('transformIncomingChanges', () => {
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
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/text', value: 'hello world' }]);
    expect(result[1].ops).toEqual([{ op: 'replace', path: '/count', value: 5 }]);
    expect(result[0].id).toBe(incomingChanges[0].id);
    expect(result[1].id).toBe(incomingChanges[1].id);
  });

  it('should filter out obsolete changes (empty ops after transformation)', () => {
    const incomingChanges = [
      createChange(1, 0, [{ op: 'replace', path: '/obj/text', value: 'world' }]),
      createChange(1, 0, [{ op: 'replace', path: '/count', value: 5 }]),
    ];

    // Removing /obj makes the first incoming change obsolete
    const committedChanges = [createChange(0, 2, [{ op: 'remove', path: '/obj' }])];

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
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/text', value: 'world' }]);
  });

  it('should preserve change metadata during transformation', () => {
    const metadata = { author: 'user1', timestamp: 12345 };
    const incomingChanges = [
      { ...createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]), ...metadata },
    ];

    const result = transformIncomingChanges(incomingChanges, [], 1);

    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('user1');
    expect(result[0].timestamp).toBe(12345);
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
        createChange(1, 0, []), // Empty ops
        createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
      ];

      const result = transformIncomingChanges(incomingChanges, [], 1, true);

      // Both changes should be preserved with forceCommit
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
