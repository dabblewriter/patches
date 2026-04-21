import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Change, PatchesSnapshot } from '../../src/types';

vi.mock('easy-signal', async () => {
  const actual = await vi.importActual<typeof import('easy-signal')>('easy-signal');
  return {
    ...actual,
    signal: vi.fn().mockImplementation(() => {
      const subscribers = new Set();
      const mockSignal = vi.fn().mockImplementation((callback: any) => {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      }) as any;
      mockSignal.emit = vi.fn().mockImplementation(async (...args: any[]) => {
        for (const callback of subscribers) {
          await (callback as any)(...args);
        }
      });
      mockSignal.emitError = vi.fn();
      mockSignal.clear = vi.fn().mockImplementation(() => subscribers.clear());
      return mockSignal;
    }),
  };
});

// Import after mocking
const { LWWDoc } = await import('../../src/client/LWWDoc');

describe('LWWDoc', () => {
  let doc: InstanceType<typeof LWWDoc<any>>;

  const createChange = (id: string, rev: number, ops: any[] = [], committed = true): Change => ({
    id,
    rev,
    baseRev: rev - 1,
    ops,
    createdAt: Date.now(),
    committedAt: committed ? Date.now() : 0,
  });

  const createSnapshot = (state: any, rev: number, changes: Change[] = []): PatchesSnapshot<any> => ({
    state,
    rev,
    changes,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
    doc = new LWWDoc('test-doc', createSnapshot({ text: 'hello', count: 0 }, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      const emptyDoc = new LWWDoc('empty-doc');

      expect(emptyDoc.state).toEqual({});
      expect(emptyDoc.id).toBe('empty-doc');
      expect(emptyDoc.committedRev).toBe(0);
      expect(emptyDoc.hasPending).toBe(false);
      expect(emptyDoc.syncStatus.state).toBe('unsynced');
    });

    it('should initialize with provided snapshot', () => {
      const snapshot = createSnapshot({ title: 'Test Doc', content: 'Hello world' }, 5);
      const testDoc = new LWWDoc('test-doc', snapshot);

      expect(testDoc.state).toEqual(snapshot.state);
      expect(testDoc.committedRev).toBe(5);
      expect(testDoc.hasPending).toBe(false);
    });

    it('should initialize with pending changes in snapshot', () => {
      const pendingChange = createChange('p1', 6, [{ op: 'replace', path: '/extra', value: 'pending' }], false);
      const snapshot = createSnapshot({ title: 'Test' }, 5, [pendingChange]);
      const testDoc = new LWWDoc('test-doc', snapshot);

      expect(testDoc.committedRev).toBe(5);
      expect(testDoc.hasPending).toBe(true);
      // Pending ops should be applied to state
      expect(testDoc.state.extra).toBe('pending');
    });
  });

  describe('getters', () => {
    it('should return correct id', () => {
      expect(doc.id).toBe('test-doc');
    });

    it('should return current state', () => {
      expect(doc.state).toEqual({ text: 'hello', count: 0 });
    });

    it('should return committedRev', () => {
      expect(doc.committedRev).toBe(0);
    });

    it('should return hasPending', () => {
      expect(doc.hasPending).toBe(false);
    });

    it('should return sync status', () => {
      expect(doc.syncStatus.state).toBe('unsynced');

      doc.updateSyncStatus('syncing');
      expect(doc.syncStatus.state).toBe('syncing');
    });
  });

  describe('change', () => {
    it('should emit ops via onChange signal', async () => {
      const changeListener = vi.fn();
      doc.onChange(changeListener);

      doc.change((patch, path) => {
        patch.replace(path.text, 'world');
      });

      expect(doc.onChange.emit).toHaveBeenCalled();
      // The ops emitted should be JSON Patch operations
      const emittedOps = (doc.onChange.emit as any).mock.calls[0][0];
      expect(emittedOps).toEqual([{ op: 'replace', path: '/text', value: 'world' }]);
    });

    it('should apply changes optimistically to state', async () => {
      doc.change((patch, path) => {
        patch.replace(path.text, 'world');
      });

      expect(doc.state).toEqual({ text: 'world', count: 0 });
    });

    it('should not emit for no-op changes', async () => {
      doc.change((_patch, _path) => {
        // No actual change
      });

      expect(doc.onChange.emit).not.toHaveBeenCalled();
    });

    it('should handle multiple property changes in one mutation', async () => {
      doc.change((patch, path) => {
        patch.replace(path.text, 'world');
        patch.replace(path.count, 5);
      });

      expect(doc.onChange.emit).toHaveBeenCalled();
      const emittedOps = (doc.onChange.emit as any).mock.calls[0][0];
      expect(emittedOps).toHaveLength(2);
    });

    it('should handle adding new properties', async () => {
      doc.change((patch, path) => {
        patch.add((path as any).newField, 'new value');
      });

      expect(doc.onChange.emit).toHaveBeenCalled();
      const emittedOps = (doc.onChange.emit as any).mock.calls[0][0];
      expect(emittedOps).toEqual([{ op: 'add', path: '/newField', value: 'new value' }]);
    });

    it('should handle removing properties', async () => {
      doc.change((patch, path) => {
        patch.remove(path.text);
      });

      expect(doc.onChange.emit).toHaveBeenCalled();
      const emittedOps = (doc.onChange.emit as any).mock.calls[0][0];
      expect(emittedOps).toEqual([{ op: 'remove', path: '/text' }]);
    });
  });

  describe('import', () => {
    it('should reset state from snapshot', () => {
      const newSnapshot = createSnapshot({ title: 'New Doc' }, 10);
      doc.import(newSnapshot);

      expect(doc.state).toEqual({ title: 'New Doc' });
      expect(doc.committedRev).toBe(10);
      expect(doc.hasPending).toBe(false);
    });

    it('should apply pending changes from snapshot', () => {
      const pendingChange = createChange('p1', 11, [{ op: 'add', path: '/extra', value: 'data' }], false);
      const newSnapshot = createSnapshot({ title: 'New Doc' }, 10, [pendingChange]);
      doc.import(newSnapshot);

      expect(doc.state.title).toBe('New Doc');
      expect(doc.state.extra).toBe('data');
      expect(doc.hasPending).toBe(true);
    });

    it('should notify subscribers after import', () => {
      const callback = vi.fn();
      doc.subscribe(callback, false);

      const newSnapshot = createSnapshot({ title: 'New Doc' }, 10);
      doc.import(newSnapshot);

      expect(callback).toHaveBeenCalled();
    });
  });

  describe('applyChanges', () => {
    it('should apply ops from changes to state', () => {
      const change = createChange('c1', 1, [{ op: 'replace', path: '/text', value: 'world' }]);
      doc.applyChanges([change]);

      expect(doc.state).toEqual({ text: 'world', count: 0 });
    });

    it('should apply multiple changes', () => {
      const changes = [
        createChange('c1', 1, [{ op: 'replace', path: '/text', value: 'world' }]),
        createChange('c2', 2, [{ op: 'replace', path: '/count', value: 5 }]),
      ];
      doc.applyChanges(changes);

      expect(doc.state).toEqual({ text: 'world', count: 5 });
    });

    it('should update committedRev from committed changes', () => {
      const change = createChange('c1', 5, [{ op: 'replace', path: '/text', value: 'world' }]);
      doc.applyChanges([change]);

      expect(doc.committedRev).toBe(5);
    });

    it('should set hasPending for uncommitted changes', () => {
      const uncommittedChange = createChange('p1', 1, [{ op: 'replace', path: '/text', value: 'world' }], false);
      doc.applyChanges([uncommittedChange]);

      expect(doc.hasPending).toBe(true);
    });

    it('should clear hasPending when only committed changes', () => {
      // First add a pending change
      const uncommittedChange = createChange('p1', 1, [{ op: 'replace', path: '/text', value: 'world' }], false);
      doc.applyChanges([uncommittedChange]);
      expect(doc.hasPending).toBe(true);

      // Then apply committed changes only
      const committedChange = createChange('c1', 1, [{ op: 'replace', path: '/text', value: 'final' }]);
      doc.applyChanges([committedChange]);
      expect(doc.hasPending).toBe(false);
    });

    it('should use hasPending override when provided as true', () => {
      const committedChange = createChange('c1', 1, [{ op: 'replace', path: '/text', value: 'world' }]);
      doc.applyChanges([committedChange], true);

      // Even though the change is committed, hasPending override says true
      expect(doc.hasPending).toBe(true);
    });

    it('should use hasPending override when provided as false', () => {
      const uncommittedChange = createChange('p1', 1, [{ op: 'replace', path: '/text', value: 'world' }], false);
      doc.applyChanges([uncommittedChange], false);

      // Even though the change is uncommitted, hasPending override says false
      expect(doc.hasPending).toBe(false);
    });

    it('should infer hasPending from changes when override is not provided', () => {
      const uncommittedChange = createChange('p1', 1, [{ op: 'replace', path: '/text', value: 'world' }], false);
      doc.applyChanges([uncommittedChange]);

      expect(doc.hasPending).toBe(true);
    });

    it('should notify subscribers after applying changes', () => {
      const callback = vi.fn();
      doc.subscribe(callback, false);

      const change = createChange('c1', 1, [{ op: 'replace', path: '/text', value: 'world' }]);
      doc.applyChanges([change]);

      expect(callback).toHaveBeenCalledWith({ text: 'world', count: 0 });
    });

    it('should not notify for empty changes array', () => {
      const callback = vi.fn();
      doc.subscribe(callback, false);

      doc.applyChanges([]);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('applyChanges — server echo of own pending changes', () => {
    it('does NOT notify subscribers when a server-committed change is a pure echo of a local change', () => {
      // 1. User makes a local change → applies optimistically + emits.
      const callback = vi.fn();
      doc.subscribe(callback, false);

      doc.change((patch, path) => {
        patch.replace(path.text, 'world');
      });
      expect(callback).toHaveBeenCalledTimes(1);

      // 2. Local-confirmation path (committedAt === 0) — no extra emit.
      const localOps = (doc.onChange.emit as any).mock.calls[0][0];
      const localChange = createChange('echo-id', 1, localOps, false);
      doc.applyChanges([localChange], true);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(doc.hasPending).toBe(true);

      // 3. Server commits and broadcasts back the same change id (pure echo). Skip the spurious emit.
      const echoed = createChange('echo-id', 1, localOps, true);
      const stateBefore = doc.state;
      doc.applyChanges([echoed], false);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(doc.state).toBe(stateBefore);
      expect(doc.committedRev).toBe(1);
      expect(doc.hasPending).toBe(false);
      expect(doc.state).toEqual({ text: 'world', count: 0 });
    });

    it('DOES notify subscribers for foreign server changes (no matching pending id)', () => {
      const callback = vi.fn();
      doc.subscribe(callback, false);

      const foreign = createChange('foreign', 1, [{ op: 'replace', path: '/text', value: 'remote' }], true);
      doc.applyChanges([foreign]);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(doc.state.text).toBe('remote');
    });

    it('DOES notify when the server batch mixes echoes with foreign ops', () => {
      const callback = vi.fn();
      doc.subscribe(callback, false);

      // Local change applied + locally confirmed
      doc.change((patch, path) => patch.replace(path.text, 'mine'));
      const localOps = (doc.onChange.emit as any).mock.calls[0][0];
      doc.applyChanges([createChange('mine', 1, localOps, false)], true);
      expect(callback).toHaveBeenCalledTimes(1);

      // Server batch: our echo + a foreign change
      const echoed = createChange('mine', 1, localOps, true);
      const foreign = createChange('foreign', 2, [{ op: 'replace', path: '/count', value: 9 }], true);
      doc.applyChanges([echoed, foreign], false);

      expect(callback).toHaveBeenCalledTimes(2);
      expect(doc.state).toEqual({ text: 'mine', count: 9 });
    });

    it('does not skip when an echo arrives in a batch that also contains a fresh local change', () => {
      const callback = vi.fn();
      doc.subscribe(callback, false);

      // Track a local change first
      doc.change((patch, path) => patch.replace(path.text, 'a'));
      const opsA = (doc.onChange.emit as any).mock.calls[0][0];
      doc.applyChanges([createChange('a', 1, opsA, false)], true);
      expect(callback).toHaveBeenCalledTimes(1);

      // Mixed batch: echo of 'a' + a brand-new local change 'b' arriving via worker-tab sync
      const echoOfA = createChange('a', 1, opsA, true);
      const freshLocal = createChange('b', 2, [{ op: 'replace', path: '/count', value: 7 }], false);
      doc.applyChanges([echoOfA, freshLocal], true);

      // Mixed batch should still recompute since fresh local ops need to land on _baseState.
      expect(callback).toHaveBeenCalledTimes(2);
      expect(doc.state.count).toBe(7);
    });

    it('handles multi-change pure-echo batches without notifying subscribers', () => {
      const callback = vi.fn();
      doc.subscribe(callback, false);

      doc.change((patch, path) => patch.replace(path.text, 'a'));
      const opsA = (doc.onChange.emit as any).mock.calls[0][0];
      doc.applyChanges([createChange('a', 1, opsA, false)], true);

      doc.change((patch, path) => patch.replace(path.count, 1));
      const opsB = (doc.onChange.emit as any).mock.calls[1][0];
      doc.applyChanges([createChange('b', 2, opsB, false)], true);

      expect(callback).toHaveBeenCalledTimes(2);

      doc.applyChanges([createChange('a', 1, opsA, true), createChange('b', 2, opsB, true)], false);

      expect(callback).toHaveBeenCalledTimes(2);
      expect(doc.committedRev).toBe(2);
      expect(doc.hasPending).toBe(false);
    });
  });

  describe('updateSyncStatus', () => {
    it('should update sync status and notify subscribers', async () => {
      const syncListener = vi.fn();
      doc.syncStatus.subscribe(syncListener, false);

      doc.updateSyncStatus('syncing');

      expect(doc.syncStatus.state).toBe('syncing');
      expect(syncListener).toHaveBeenCalledWith('syncing');
    });

    it('should handle error sync status', async () => {
      const error = new Error('Sync failed');
      doc.updateSyncStatus('error', error);

      expect(doc.syncStatus.state).toBe('error');
      expect(doc.syncError.state).toBe(error);
    });

    it('should handle synced state', async () => {
      doc.updateSyncStatus('syncing');
      doc.updateSyncStatus('synced');

      expect(doc.syncStatus.state).toBe('synced');
    });

    it('should clear syncError when transitioning away from error', async () => {
      const error = new Error('Sync failed');
      doc.updateSyncStatus('error', error);
      expect(doc.syncError.state).toBe(error);

      doc.updateSyncStatus('syncing');
      expect(doc.syncStatus.state).toBe('syncing');
      expect(doc.syncError.state).toBeUndefined();
    });
  });

  describe('isLoaded', () => {
    it('should default to false', () => {
      expect(doc.isLoaded.state).toBe(false);
    });

    it('should become true when constructed with committedRev > 0', () => {
      const loadedDoc = new LWWDoc('loaded', createSnapshot({ text: 'hi' }, 5));
      expect(loadedDoc.isLoaded.state).toBe(true);
    });

    it('should become true when constructed with pending changes', () => {
      const change = createChange('c1', 1, [{ op: 'replace', path: '/text', value: 'hi' }], false);
      const loadedDoc = new LWWDoc('loaded', createSnapshot({ text: 'hello' }, 0, [change]));
      expect(loadedDoc.isLoaded.state).toBe(true);
    });

    it('should become true after updateSyncStatus synced', () => {
      doc.updateSyncStatus('synced');
      expect(doc.isLoaded.state).toBe(true);
    });

    it('should stay true after transitioning back to syncing', () => {
      doc.updateSyncStatus('synced');
      expect(doc.isLoaded.state).toBe(true);

      doc.updateSyncStatus('syncing');
      expect(doc.isLoaded.state).toBe(true);
    });

    it('should become true after applyChanges with committed changes', () => {
      const change = createChange('c1', 1, [{ op: 'replace', path: '/text', value: 'world' }]);
      doc.applyChanges([change]);
      expect(doc.isLoaded.state).toBe(true);
    });

    it('should become true after import with rev > 0', () => {
      doc.import(createSnapshot({ text: 'imported' }, 3));
      expect(doc.isLoaded.state).toBe(true);
    });
  });

  describe('subscribe', () => {
    it('should call callback immediately with current state via store subscribe', () => {
      const subscribeDoc = new LWWDoc('sub-doc', createSnapshot({ text: 'hello', count: 0 }, 0));
      const callback = vi.fn();
      subscribeDoc.subscribe(callback);

      expect(callback).toHaveBeenCalledWith({ text: 'hello', count: 0 });
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = doc.subscribe(callback);

      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('signals', () => {
    it('should provide onChange signal', () => {
      const callback = vi.fn();
      const unsubscribe = doc.onChange(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should provide state store with subscribe', () => {
      const callback = vi.fn();
      const unsubscribe = doc.subscribe(callback);

      expect(typeof unsubscribe).toBe('function');
      expect(callback).toHaveBeenCalledWith({ text: 'hello', count: 0 });
    });

    it('should provide syncStatus store with subscribe', () => {
      const callback = vi.fn();
      const unsubscribe = doc.syncStatus.subscribe(callback);

      expect(typeof unsubscribe).toBe('function');
      expect(callback).toHaveBeenCalledWith('unsynced');
    });
  });
});
