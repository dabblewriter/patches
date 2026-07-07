import { describe, it, expect } from 'vitest';
import { applyCommittedChanges } from '../../../../src/algorithms/ot/client/applyCommittedChanges';
import { ApplyChangesError } from '../../../../src/algorithms/ot/shared/applyChanges';
import type { Change, PatchesSnapshot } from '../../../../src/types';

describe('applyCommittedChanges', () => {
  const createChange = (rev: number, ops: any[] = []): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev: rev - 1,
    ops,
    createdAt: 0,
    committedAt: 0,
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

  it('should throw ApplyChangesError for a bad server change instead of silently skipping it', () => {
    // A skipped change would silently diverge this client from every other client
    // that applied it — the error must propagate so PatchesSync can recover.
    const snapshot = createSnapshot({ arr: [1, 2, 3] }, 2, []);
    const serverChanges = [
      createChange(3, [{ op: 'add', path: '/arr/5', value: 'invalid' }]), // Invalid array index
    ];

    expect(() => applyCommittedChanges(snapshot, serverChanges)).toThrow(ApplyChangesError);
    try {
      applyCommittedChanges(snapshot, serverChanges);
      expect.unreachable('should have thrown');
    } catch (err) {
      const applyErr = err as ApplyChangesError;
      expect(applyErr.changeId).toBe('change-3');
      expect(applyErr.rev).toBe(3);
      expect(applyErr.index).toBe(0);
      expect(applyErr.cause).toBeInstanceOf(Error);
    }
  });

  it('drops pending changes when a root-replace catchup supersedes them', () => {
    // Intended semantics, not a bug: a root replace transforms every pending op away,
    // mirroring the transform the server applies to those same changes at commit time.
    // Keeping them alive locally would fork this replica from every other. Real offline
    // edits are protected a layer up: PatchesSync flushes pending at their true baseRev
    // before installing a server snapshot (_reloadDocFromServer's flushPendingFirst).
    const pendingChange = createChange(3, [{ op: 'add', path: '/local', value: true }]);
    pendingChange.id = 'local-change-1';
    const snapshot = createSnapshot({ text: 'hello' }, 2, [pendingChange]);
    const serverChanges = [createChange(10, [{ op: 'replace', path: '', value: { text: 'fresh' } }])];
    serverChanges[0].id = 'server-change-1';

    const result = applyCommittedChanges(snapshot, serverChanges);

    expect(result.state).toEqual({ text: 'fresh' });
    expect(result.rev).toBe(10);
    expect(result.changes).toEqual([]);
  });

  it('confirms a stranded pending copy on a redundant own-echo delivery (DAB-607)', () => {
    // The SSE broadcast already advanced rev to 28795, but a raced pending write left the
    // acked change stranded in the queue. The HTTP ack then redelivers the echo: before the
    // fix it was filtered out by rev without the id-drop, so the strand survived and the next
    // flush re-sent it with baseRev 28795 — past its own commit — and the server committed a
    // duplicate at 28796.
    const stranded = createChange(28795, [{ op: 'add', path: '/text', value: 'hi' }]);
    stranded.id = 'own-change-1';
    const snapshot = createSnapshot({ text: 'hi' }, 28795, [stranded]);
    const echo = createChange(28795, [{ op: 'add', path: '/text', value: 'hi' }]);
    echo.id = 'own-change-1';
    echo.committedAt = 1000;

    const result = applyCommittedChanges(snapshot, [echo]);

    expect(result.rev).toBe(28795);
    expect(result.changes).toEqual([]);
    expect(result.state).toEqual({ text: 'hi' });
  });

  it('keeps unrelated pending changes on a redundant delivery', () => {
    const pending = createChange(6, [{ op: 'add', path: '/local', value: true }]);
    pending.id = 'local-change-1';
    const snapshot = createSnapshot({ text: 'hello' }, 5, [pending]);
    const serverChanges = [createChange(4), createChange(5)];

    const result = applyCommittedChanges(snapshot, serverChanges);

    expect(result.rev).toBe(5);
    expect(result.changes).toEqual([pending]);
  });

  it('drops a redundant echo from the rebase queue so it cannot skew the tail transform', () => {
    // Delivery partially overlaps the snapshot: the own echo at rev 5 is already applied, a
    // foreign change at rev 6 is new. The stranded copy must not sit in the rebase queue —
    // the committed state already contains its effect, so advancing the foreign ops through
    // it would land the tail at shifted offsets — and it must not survive as pending.
    const stranded = createChange(5, [{ op: 'add', path: '/list/0', value: 'a' }]);
    stranded.id = 'own-change-1';
    const tail = createChange(6, [{ op: 'add', path: '/list/1', value: 'b' }]);
    tail.id = 'local-change-2';
    const snapshot = createSnapshot({ list: ['a'] }, 5, [stranded, tail]);

    const echo = createChange(5, [{ op: 'add', path: '/list/0', value: 'a' }]);
    echo.id = 'own-change-1';
    const foreign = createChange(6, [{ op: 'add', path: '/other', value: 1 }]);
    foreign.id = 'server-change-1';

    const result = applyCommittedChanges(snapshot, [echo, foreign]);

    expect(result.rev).toBe(6);
    expect(result.state).toEqual({ list: ['a'], other: 1 });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].id).toBe('local-change-2');
    expect(result.changes[0].baseRev).toBe(6);
    expect(result.changes[0].rev).toBe(7);
    expect(result.changes[0].ops).toEqual([{ op: 'add', path: '/list/1', value: 'b' }]);
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
