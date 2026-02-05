import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Change, PatchesSnapshot } from '../../src/types';

// Mock the event-signal module
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

// Now import after mocking
const { OTDoc } = await import('../../src/client/OTDoc');

describe('OTDoc', () => {
  let doc: InstanceType<typeof OTDoc<any>>;

  const createChange = (id: string, rev: number, baseRev?: number): Change => ({
    id,
    rev,
    baseRev: baseRev ?? rev - 1,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    createdAt: Date.now(),
    committedAt: Date.now(),
  });

  const createSnapshot = (state: any, rev: number, changes: Change[] = []): PatchesSnapshot<any> => ({
    state,
    rev,
    changes,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    doc = new OTDoc('test-doc', { state: { text: 'hello' }, rev: 0, changes: [] });
  });

  afterEach(() => {
    doc.onChange.clear();
    doc.onUpdate.clear();
    doc.onSyncing.clear();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      const emptyDoc = new OTDoc('empty-doc');

      expect(emptyDoc.state).toEqual({});
      expect(emptyDoc.id).toBe('empty-doc');
      expect(emptyDoc.committedRev).toBe(0);
      expect(emptyDoc.hasPending).toBe(false);
      expect(emptyDoc.syncing).toBeNull();
    });

    it('should initialize with provided snapshot', () => {
      const snapshot = createSnapshot({ title: 'Test Doc', content: 'Hello world' }, 5, [createChange('c1', 6)]);

      const testDoc = new OTDoc('test-doc', snapshot);

      expect(testDoc.state.title).toBe('Test Doc');
      expect(testDoc.committedRev).toBe(5);
      expect(testDoc.hasPending).toBe(true);
    });
  });

  describe('getters', () => {
    it('should return correct id', () => {
      expect(doc.id).toBe('test-doc');
    });

    it('should return current state', () => {
      expect(doc.state).toEqual({ text: 'hello' });
    });

    it('should return syncing state', () => {
      expect(doc.syncing).toBeNull();

      doc.updateSyncing('updating');
      expect(doc.syncing).toBe('updating');
    });

    it('should return committed revision', () => {
      expect(doc.committedRev).toBe(0);
    });

    it('should return pending status based on changes array', () => {
      expect(doc.hasPending).toBe(false);

      // Import a snapshot with pending changes to test hasPending
      const snapshot = createSnapshot({ text: 'hello' }, 0, [createChange('c1', 1)]);
      doc.import(snapshot);
      expect(doc.hasPending).toBe(true);
    });
  });

  // Note: setId was removed as ID is now required in constructor

  // Note: setChangeMetadata was removed as part of thin doc refactor.
  // Metadata is now passed to strategy when opening doc, not stored in doc.

  describe('subscribe', () => {
    it('should call callback immediately with current state', () => {
      const subscribeDoc = new OTDoc('sub-doc', { state: { text: 'hello' }, rev: 0, changes: [] });
      const callback = vi.fn();

      subscribeDoc.subscribe(callback);

      expect(callback).toHaveBeenCalledWith({ text: 'hello' });
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();

      const unsubscribe = doc.subscribe(callback);

      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('toJSON', () => {
    it('should export current snapshot via toJSON', () => {
      const jsonDoc = new OTDoc('json-doc', { state: { text: 'hello' }, rev: 0, changes: [] });
      const json = jsonDoc.toJSON();

      expect(json).toEqual({
        state: { text: 'hello' },
        rev: 0,
        changes: [],
      });
    });

    it('should include pending changes', () => {
      const snapshot = createSnapshot({ text: 'hello' }, 0, [createChange('c1', 1)]);
      doc.import(snapshot);

      const json = doc.toJSON();

      expect(json.changes).toHaveLength(1);
    });
  });

  describe('import', () => {
    it('should import snapshot and update state', () => {
      const snapshot = createSnapshot({ title: 'Imported Doc' }, 5, [createChange('c1', 6)]);

      doc.import(snapshot);

      expect(doc.committedRev).toBe(5);
      expect(doc.hasPending).toBe(true);
    });

    it('should emit onUpdate when importing', () => {
      const snapshot = createSnapshot({ imported: true }, 3);
      doc.import(snapshot);

      expect(doc.onUpdate.emit).toHaveBeenCalled();
    });
  });

  describe('change (thin doc interface)', () => {
    it('should emit ops via onChange signal', () => {
      doc.change((patch, path) => {
        patch.replace(path.text, 'world');
      });

      expect(doc.onChange.emit).toHaveBeenCalled();
      const emittedOps = (doc.onChange.emit as any).mock.calls[0][0];
      expect(emittedOps).toEqual([{ op: 'replace', path: '/text', value: 'world' }]);
    });

    it('should NOT apply changes locally (thin doc)', () => {
      doc.change((patch, path) => {
        patch.replace(path.text, 'world');
      });

      // State should not change - strategy handles state updates via applyChanges
      expect(doc.state).toEqual({ text: 'hello' });
    });

    it('should not emit for no-op changes', () => {
      doc.change((_patch, _path) => {
        // No actual change
      });

      expect(doc.onChange.emit).not.toHaveBeenCalled();
    });

    it('should handle multiple property changes in one mutation', () => {
      const testDoc = new OTDoc('multi-doc', { state: { text: 'hello', count: 0 }, rev: 0, changes: [] });
      testDoc.change((patch, path) => {
        patch.replace(path.text, 'world');
        patch.replace(path.count, 5);
      });

      expect(testDoc.onChange.emit).toHaveBeenCalled();
      const emittedOps = (testDoc.onChange.emit as any).mock.calls[0][0];
      expect(emittedOps).toHaveLength(2);
    });
  });

  describe('applyChanges (unified)', () => {
    it('should apply local changes (uncommitted) and add to pending', () => {
      // Local changes have committedAt === 0
      const localChange: Change = { ...createChange('c1', 1), committedAt: 0 };

      doc.applyChanges([localChange]);

      expect(doc.hasPending).toBe(true);
      expect(doc.getPendingChanges()).toHaveLength(1);
    });

    it('should emit onUpdate when applying local changes', () => {
      const localChange: Change = { ...createChange('c1', 1), committedAt: 0 };

      doc.applyChanges([localChange]);

      expect(doc.onUpdate.emit).toHaveBeenCalled();
    });

    it('should not emit for empty changes array', () => {
      doc.applyChanges([]);

      expect(doc.onUpdate.emit).not.toHaveBeenCalled();
    });

    it('should apply server changes (committed) and update revision', () => {
      // Server changes have committedAt > 0
      const serverChanges = [createChange('s1', 1)]; // createChange sets committedAt to Date.now()

      doc.applyChanges(serverChanges);

      expect(doc.committedRev).toBe(1);
    });

    it('should throw error if server revision mismatch', () => {
      const serverChanges = [createChange('s1', 5)]; // Wrong base revision

      expect(() => {
        doc.applyChanges(serverChanges);
      }).toThrow('Cannot apply committed changes to a doc that is not at the correct revision');
    });

    it('should handle server changes with rebased pending', () => {
      // First add a local pending change
      const localChange: Change = { ...createChange('p1', 1), committedAt: 0 };
      doc.applyChanges([localChange]);
      expect(doc.getPendingChanges()).toHaveLength(1);

      // Then apply server changes followed by rebased pending
      const serverChanges = [createChange('s1', 1)];
      const rebasedPending: Change = { ...createChange('p1-rebased', 2, 1), committedAt: 0 };

      doc.applyChanges([...serverChanges, rebasedPending]);

      expect(doc.committedRev).toBe(1);
      expect(doc.getPendingChanges()).toHaveLength(1);
      expect(doc.getPendingChanges()[0].id).toBe('p1-rebased');
    });

    it('should emit onUpdate after applying server changes', () => {
      const serverChanges = [createChange('s1', 1)];
      doc.applyChanges(serverChanges);

      expect(doc.onUpdate.emit).toHaveBeenCalled();
    });
  });

  describe('getPendingChanges', () => {
    it('should return empty array initially', () => {
      expect(doc.getPendingChanges()).toEqual([]);
    });

    it('should return pending changes after applyChanges with local changes', () => {
      const localChange: Change = { ...createChange('c1', 1), committedAt: 0 };
      doc.applyChanges([localChange]);

      expect(doc.getPendingChanges()).toHaveLength(1);
    });
  });

  describe('updateSyncing', () => {
    it('should update syncing state and emit event', () => {
      doc.updateSyncing('updating');

      expect(doc.syncing).toBe('updating');
      expect(doc.onSyncing.emit).toHaveBeenCalledWith('updating');
    });

    it('should handle null syncing state', () => {
      doc.updateSyncing('updating');
      doc.updateSyncing(null);

      expect(doc.syncing).toBeNull();
    });
  });

  describe('toJSON (serialization)', () => {
    it('should return snapshot for serialization', () => {
      const json = doc.toJSON();

      expect(json).toEqual({
        state: { text: 'hello' },
        rev: 0,
        changes: [],
      });
    });
  });

  describe('event handling', () => {
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

  describe('complex scenarios', () => {
    it('should handle multiple local changes and state updates', () => {
      const localChange1: Change = { ...createChange('c1', 1), committedAt: 0 };
      doc.applyChanges([localChange1]);
      expect(doc.hasPending).toBe(true);

      const localChange2: Change = { ...createChange('c2', 2, 1), committedAt: 0 };
      doc.applyChanges([localChange2]);
      expect(doc.getPendingChanges()).toHaveLength(2);

      // Apply server changes with rebased pending
      const serverChanges = [createChange('s1', 1)];
      const rebasedPending: Change = { ...createChange('p1', 2, 1), committedAt: 0 };
      doc.applyChanges([...serverChanges, rebasedPending]);

      expect(doc.committedRev).toBe(1);
      expect(doc.getPendingChanges()).toHaveLength(1);
    });

    it('should handle import after changes have been made', () => {
      const localChange: Change = { ...createChange('c1', 1), committedAt: 0 };
      doc.applyChanges([localChange]);
      expect(doc.hasPending).toBe(true);

      const snapshot = createSnapshot({ newState: true }, 10, []);
      doc.import(snapshot);

      expect(doc.committedRev).toBe(10);
      expect(doc.hasPending).toBe(false);
    });
  });
});
