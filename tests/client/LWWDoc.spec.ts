import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Change, PatchesSnapshot } from '../../src/types';

vi.mock('../../src/event-signal', () => ({
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
    mockSignal.error = vi.fn().mockReturnValue(vi.fn());
    mockSignal.clear = vi.fn().mockImplementation(() => subscribers.clear());
    return mockSignal;
  }),
}));

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
    doc.onChange.clear();
    doc.onUpdate.clear();
    doc.onSyncing.clear();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      const emptyDoc = new LWWDoc('empty-doc');

      expect(emptyDoc.state).toEqual({});
      expect(emptyDoc.id).toBe('empty-doc');
      expect(emptyDoc.committedRev).toBe(0);
      expect(emptyDoc.hasPending).toBe(false);
      expect(emptyDoc.syncing).toBeNull();
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

    it('should return syncing state', () => {
      expect(doc.syncing).toBeNull();

      doc.updateSyncing('updating');
      expect(doc.syncing).toBe('updating');
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

    it('should NOT apply changes locally (thin doc)', async () => {
      doc.change((patch, path) => {
        patch.replace(path.text, 'world');
      });

      // State should not change - strategy handles state updates
      expect(doc.state).toEqual({ text: 'hello', count: 0 });
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

    it('should emit onUpdate after import', () => {
      const newSnapshot = createSnapshot({ title: 'New Doc' }, 10);
      doc.import(newSnapshot);

      expect(doc.onUpdate.emit).toHaveBeenCalled();
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

    it('should emit onUpdate after applying changes', () => {
      const change = createChange('c1', 1, [{ op: 'replace', path: '/text', value: 'world' }]);
      doc.applyChanges([change]);

      expect(doc.onUpdate.emit).toHaveBeenCalledWith({ text: 'world', count: 0 });
    });

    it('should not emit for empty changes array', () => {
      doc.applyChanges([]);

      expect(doc.onUpdate.emit).not.toHaveBeenCalled();
    });
  });

  describe('updateSyncing', () => {
    it('should update syncing state and emit onSyncing', async () => {
      const syncListener = vi.fn();
      doc.onSyncing(syncListener);

      doc.updateSyncing('updating');

      expect(doc.syncing).toBe('updating');
      expect(doc.onSyncing.emit).toHaveBeenCalledWith('updating');
    });

    it('should handle error syncing state', async () => {
      const error = new Error('Sync failed');
      doc.updateSyncing(error);

      expect(doc.syncing).toBe(error);
    });

    it('should handle null syncing state', async () => {
      doc.updateSyncing('updating');
      doc.updateSyncing(null);

      expect(doc.syncing).toBeNull();
    });
  });

  describe('subscribe', () => {
    it('should call callback immediately with current state', () => {
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

    it('should provide onUpdate signal', () => {
      const callback = vi.fn();
      const unsubscribe = doc.onUpdate(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should provide onSyncing signal', () => {
      const callback = vi.fn();
      const unsubscribe = doc.onSyncing(callback);

      expect(typeof unsubscribe).toBe('function');
    });
  });
});
