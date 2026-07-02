import { describe, expect, it } from 'vitest';
import { rebaseChanges } from '../../../../src/algorithms/ot/shared/rebaseChanges';
import type { Change } from '../../../../src/types';

describe('rebaseChanges', () => {
  const createChange = (id: string, rev: number, ops: any[], baseRev = rev - 1): Change => ({
    id,
    rev,
    baseRev,
    ops,
    createdAt: 0,
    committedAt: 0,
  });

  it('should return local changes unchanged when no server changes', () => {
    const localChanges = [
      createChange('local1', 3, [{ op: 'add', path: '/test', value: 'hello' }]),
      createChange('local2', 4, [{ op: 'add', path: '/count', value: 1 }]),
    ];

    const result = rebaseChanges([], localChanges);

    expect(result).toBe(localChanges);
  });

  it('should return local changes unchanged when no local changes', () => {
    const serverChanges = [createChange('server1', 3, [{ op: 'add', path: '/server', value: 'data' }])];

    const result = rebaseChanges(serverChanges, []);

    expect(result).toEqual([]);
  });

  it('should filter out local changes that exist in server changes', () => {
    const sharedChange = createChange('shared', 3, [{ op: 'add', path: '/shared', value: 'data' }]);
    const localOnlyChange = createChange('local', 4, [{ op: 'add', path: '/local', value: 'data' }]);

    const result = rebaseChanges([sharedChange], [sharedChange, localOnlyChange]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local');
    expect(result[0].baseRev).toBe(3); // Updated to last server change rev
    expect(result[0].rev).toBe(4); // Incremented from last server change
  });

  it('should transform local changes against server changes', () => {
    const serverChange = createChange('server', 3, [{ op: 'add', path: '/list/0', value: 'S' }]);
    const localChange = createChange('local', 4, [{ op: 'replace', path: '/list/1', value: 'edited' }]);

    const result = rebaseChanges([serverChange], [localChange]);

    expect(result).toHaveLength(1);
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/list/2', value: 'edited' }]);
    expect(result[0].baseRev).toBe(3);
    expect(result[0].rev).toBe(4);
  });

  it('should update revision numbers correctly for multiple local changes', () => {
    const serverChange = createChange('server', 5, [{ op: 'add', path: '/server', value: 'data' }]);
    const localChange1 = createChange('local1', 3, [{ op: 'add', path: '/local1', value: 'data' }]);
    const localChange2 = createChange('local2', 4, [{ op: 'add', path: '/local2', value: 'data' }]);

    const result = rebaseChanges([serverChange], [localChange1, localChange2]);

    expect(result).toHaveLength(2);
    expect(result[0].baseRev).toBe(5);
    expect(result[0].rev).toBe(6);
    expect(result[1].baseRev).toBe(5);
    expect(result[1].rev).toBe(7);
  });

  it('should filter out changes with empty ops after transformation', () => {
    // Removing /obj makes the first local change (inside /obj) a no-op
    const serverChange = createChange('server', 3, [{ op: 'remove', path: '/obj' }]);
    const localChange1 = createChange('local1', 4, [{ op: 'replace', path: '/obj/x', value: 'data' }]);
    const localChange2 = createChange('local2', 5, [{ op: 'add', path: '/local2', value: 'data' }]);

    const result = rebaseChanges([serverChange], [localChange1, localChange2]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local2');
    expect(result[0].rev).toBe(4); // First assigned rev (dropped change does not consume a rev)
  });

  it('should handle multiple server changes', () => {
    const serverChange1 = createChange('server1', 3, [{ op: 'add', path: '/list/0', value: 's1' }]);
    const serverChange2 = createChange('server2', 4, [{ op: 'add', path: '/list/0', value: 's2' }]);
    const localChange = createChange('local', 5, [{ op: 'replace', path: '/list/1', value: 'edited' }]);

    const result = rebaseChanges([serverChange1, serverChange2], [localChange]);

    expect(result).toHaveLength(1);
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/list/3', value: 'edited' }]);
    expect(result[0].baseRev).toBe(4); // Last server change rev
    expect(result[0].rev).toBe(5);
  });

  it('should exclude server changes that are also in local changes from transformation', () => {
    // If the local change were (wrongly) transformed against its own echoed server change, the shared add at
    // /list/0 would shift the local replace from /list/1 to /list/2
    const sharedChange = createChange('shared', 3, [{ op: 'add', path: '/list/0', value: 'mine' }]);
    const localOnlyChange = createChange('local', 5, [{ op: 'replace', path: '/list/1', value: 'edited' }]);

    const result = rebaseChanges([sharedChange], [sharedChange, localOnlyChange]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local');
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/list/1', value: 'edited' }]);
  });

  it('should preserve other change properties during rebase', () => {
    const serverChange = createChange('server', 3, [{ op: 'add', path: '/server', value: 'data' }]);
    const localChange = createChange('local', 4, [{ op: 'add', path: '/local', value: 'data' }]);
    localChange.createdAt = 1718450000000;
    localChange.committedAt = 1718450001000;
    (localChange as any).customField = 'test';

    const result = rebaseChanges([serverChange], [localChange]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local');
    expect(result[0].createdAt).toBe(1718450000000);
    expect(result[0].committedAt).toBe(1718450001000);
    expect((result[0] as any).customField).toBe('test');
  });

  it('should handle complex scenario with mixed changes', () => {
    const serverChange1 = createChange('s1', 3, [{ op: 'add', path: '/s1', value: 'data' }]);
    const sharedChange = createChange('shared', 4, [{ op: 'add', path: '/shared', value: 'data' }]);
    const serverChange2 = createChange('s2', 5, [{ op: 'add', path: '/s2', value: 'data' }]);

    const localChange1 = createChange('l1', 6, [{ op: 'add', path: '/l1', value: 'data' }]);
    const localChange2 = createChange('l2', 7, [{ op: 'add', path: '/l2', value: 'data' }]);

    const result = rebaseChanges(
      [serverChange1, sharedChange, serverChange2],
      [localChange1, sharedChange, localChange2]
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('l1');
    expect(result[1].id).toBe('l2');
    expect(result[0].baseRev).toBe(5); // Last server change rev
    expect(result[1].baseRev).toBe(5);
    expect(result[0].rev).toBe(6);
    expect(result[1].rev).toBe(7);
  });

  it('rebases each pending change in the coordinate space of the changes before it', () => {
    // Confirmed TP1 regression (client side of transformIncomingChanges): a foreign add at /list/10 must not be
    // destroyed by the second pending change, whose index was written after the first pending change's remove
    const serverChange = createChange('server', 6, [{ op: 'add', path: '/list/10', value: 'X' }]);
    const local1 = createChange('l1', 6, [{ op: 'remove', path: '/list/0' }], 5);
    const local2 = createChange('l2', 7, [{ op: 'replace', path: '/list/9', value: 'NEW' }], 5);

    const result = rebaseChanges([serverChange], [local1, local2]);

    expect(result).toHaveLength(2);
    expect(result[0].ops).toEqual([{ op: 'remove', path: '/list/0' }]);
    expect(result[1].ops).toEqual([{ op: 'replace', path: '/list/10', value: 'NEW' }]);
    expect(result[0].rev).toBe(7);
    expect(result[1].rev).toBe(8);
  });

  it('transforms pending changes against foreign changes in the space after its own acknowledged change', () => {
    // The client committed own1 (remove /list/0) after a foreign change it had not yet seen. The foreign change's
    // ops are in the pre-own1 space, so they must be advanced over own1 before transforming the later pending
    // change, which was written post-own1.
    const foreign = createChange('f1', 4, [{ op: 'remove', path: '/list/2' }]);
    const own = createChange('own1', 5, [{ op: 'remove', path: '/list/0' }]);
    const pendingOwn = createChange('own1', 4, [{ op: 'remove', path: '/list/0' }], 3);
    const local2 = createChange('l2', 5, [{ op: 'replace', path: '/list/1', value: 'C2' }], 3);

    const result = rebaseChanges([foreign, own], [pendingOwn, local2]);

    // In the post-own1 space the foreign remove is at /list/1 — the same element local2 replaces — so the replace
    // becomes an add into the removed slot instead of surviving at a stale index
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('l2');
    expect(result[0].ops).toEqual([{ op: 'add', path: '/list/1', value: 'C2' }]);
    expect(result[0].baseRev).toBe(5);
    expect(result[0].rev).toBe(6);
  });
});
