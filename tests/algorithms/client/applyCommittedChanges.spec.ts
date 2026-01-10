import { describe, it, expect } from 'vitest';
import { applyCommittedChanges } from '../../../src/algorithms/client/applyCommittedChanges';
import type { Change, PatchesSnapshot } from '../../../src/types';

describe('applyCommittedChanges', () => {
  const createChange = (rev: number, ops: any[] = []): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev: rev - 1,
    ops,
    createdAt: '2024-01-01T00:00:00.000Z',
    committedAt: '2024-01-01T00:00:00.000Z',
  });

  const createSnapshot = (state: any, rev: number, changes: Change[] = []): PatchesSnapshot => ({
    state,
    rev,
    changes,
  });

  it('should return snapshot unchanged when no new server changes', () => {
    const snapshot = createSnapshot({ text: 'hello' }, 5, []);
    const serverChanges = [createChange(3), createChange(4), createChange(5)];

    const result = applyCommittedChanges(snapshot, serverChanges);

    expect(result).toEqual(snapshot);
  });

  it('should apply new server changes to state and update revision', () => {
    const snapshot = createSnapshot({ text: 'hello' }, 2, []);
    const serverChanges = [
      createChange(3, [{ op: 'replace', path: '/text', value: 'world' }]),
      createChange(4, [{ op: 'add', path: '/count', value: 1 }]),
    ];

    const result = applyCommittedChanges(snapshot, serverChanges);

    expect(result.state).toEqual({ text: 'world', count: 1 });
    expect(result.rev).toBe(4);
    expect(result.changes).toEqual([]);
  });

  it('should rebase pending changes against new server changes', () => {
    const pendingChange = createChange(3, [{ op: 'add', path: '/local', value: true }]);
    pendingChange.id = 'local-change-1'; // Give it a unique ID different from server changes
    const snapshot = createSnapshot({ text: 'hello' }, 2, [pendingChange]);
    const serverChanges = [createChange(3, [{ op: 'replace', path: '/text', value: 'world' }])];
    serverChanges[0].id = 'server-change-1'; // Give server change a different ID

    const result = applyCommittedChanges(snapshot, serverChanges);

    expect(result.state).toEqual({ text: 'world' });
    expect(result.rev).toBe(3);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].baseRev).toBe(3);
    expect(result.changes[0].rev).toBe(4);
  });

  it('should throw error when server changes are not sequential', () => {
    const snapshot = createSnapshot({ text: 'hello' }, 2, []);
    const serverChanges = [
      createChange(4, [{ op: 'replace', path: '/text', value: 'world' }]), // Missing rev 3
    ];

    expect(() => applyCommittedChanges(snapshot, serverChanges)).toThrow(
      'Missing changes from the server. Expected rev 3, got 4. Request changes since 2.'
    );
  });

  it('should handle multiple server changes correctly', () => {
    const snapshot = createSnapshot({ count: 0 }, 1, []);
    const serverChanges = [
      createChange(2, [{ op: 'replace', path: '/count', value: 1 }]),
      createChange(3, [{ op: 'replace', path: '/count', value: 2 }]),
      createChange(4, [{ op: 'add', path: '/text', value: 'hello' }]),
    ];

    const result = applyCommittedChanges(snapshot, serverChanges);

    expect(result.state).toEqual({ count: 2, text: 'hello' });
    expect(result.rev).toBe(4);
  });

  it('should filter out server changes already applied', () => {
    const snapshot = createSnapshot({ text: 'hello' }, 5, []);
    const serverChanges = [
      createChange(3), // Already applied (rev <= 5)
      createChange(4), // Already applied
      createChange(5), // Already applied
      createChange(6, [{ op: 'add', path: '/new', value: true }]), // New
    ];

    const result = applyCommittedChanges(snapshot, serverChanges);

    expect(result.state).toEqual({ text: 'hello', new: true });
    expect(result.rev).toBe(6);
  });

  it('should handle empty pending changes', () => {
    const snapshot = createSnapshot({ text: 'hello' }, 2, []);
    const serverChanges = [createChange(3, [{ op: 'replace', path: '/text', value: 'world' }])];

    const result = applyCommittedChanges(snapshot, serverChanges);

    expect(result.changes).toEqual([]);
  });

  it('should throw error when apply changes fails', () => {
    const snapshot = createSnapshot({ arr: [1, 2, 3] }, 2, []);
    const serverChanges = [
      createChange(3, [{ op: 'add', path: '/arr/5', value: 'invalid' }]), // Invalid array index
    ];

    expect(() => applyCommittedChanges(snapshot, serverChanges)).toThrow('Critical sync error applying server changes');
  });

  it('should handle complex rebase scenario', () => {
    const pendingChange1 = createChange(3, [{ op: 'add', path: '/local1', value: 'a' }]);
    const pendingChange2 = createChange(4, [{ op: 'add', path: '/local2', value: 'b' }]);
    pendingChange1.id = 'local-change-1';
    pendingChange2.id = 'local-change-2';
    const snapshot = createSnapshot({ text: 'hello' }, 2, [pendingChange1, pendingChange2]);

    const serverChanges = [
      createChange(3, [{ op: 'add', path: '/server1', value: 'x' }]),
      createChange(4, [{ op: 'add', path: '/server2', value: 'y' }]),
    ];
    serverChanges[0].id = 'server-change-1';
    serverChanges[1].id = 'server-change-2';

    const result = applyCommittedChanges(snapshot, serverChanges);

    expect(result.state).toEqual({ text: 'hello', server1: 'x', server2: 'y' });
    expect(result.rev).toBe(4);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0].baseRev).toBe(4);
    expect(result.changes[0].rev).toBe(5);
    expect(result.changes[1].baseRev).toBe(4);
    expect(result.changes[1].rev).toBe(6);
  });
});
