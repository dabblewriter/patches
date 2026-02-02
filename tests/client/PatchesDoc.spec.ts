import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Change, PatchesSnapshot } from '../../src/types';

// Mock dependencies completely before importing
vi.mock('../../src/algorithms/client/createStateFromSnapshot', () => ({
  createStateFromSnapshot: vi.fn().mockImplementation(snapshot => snapshot.state ?? {}),
}));

vi.mock('../../src/algorithms/client/makeChange', () => ({
  makeChange: vi.fn().mockImplementation((snapshot, mutator, metadata, maxBytes) => {
    // By default, return changes (can be overridden in specific tests)
    return [
      {
        id: 'mock-change-id',
        rev: snapshot.rev + 1,
        baseRev: snapshot.rev,
        ops: [{ op: 'add', path: '/test', value: 'mock' }],
        createdAt: Date.now(),
        committedAt: Date.now(),
        ...metadata,
      },
    ];
  }),
}));

vi.mock('../../src/algorithms/shared/applyChanges', () => ({
  applyChanges: vi.fn().mockImplementation((state, changes) => ({
    ...state,
    appliedChanges: changes?.length || 0,
  })),
}));

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
const { PatchesDoc } = await import('../../src/client/PatchesDoc');
const { createStateFromSnapshot } = await import('../../src/algorithms/client/createStateFromSnapshot');
const { makeChange } = await import('../../src/algorithms/client/makeChange');
const { applyChanges } = await import('../../src/algorithms/shared/applyChanges');

describe('PatchesDoc', () => {
  let doc: InstanceType<typeof PatchesDoc<any>>;

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
    doc = new PatchesDoc({ text: 'hello' }, { userId: 'user1' });
  });

  afterEach(() => {
    doc.onChange.clear();
    doc.onUpdate.clear();
    doc.onBeforeChange.clear();
    doc.onSyncing.clear();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      const emptyDoc = new PatchesDoc();

      expect(emptyDoc.state).toEqual({});
      expect(emptyDoc.id).toBeNull();
      expect(emptyDoc.committedRev).toBe(0);
      expect(emptyDoc.hasPending).toBe(false);
      expect(emptyDoc.syncing).toBeNull();
    });

    it('should initialize with provided state and metadata', () => {
      const initialState = { title: 'Test Doc', content: 'Hello world' };
      const metadata = { userId: 'user1', sessionId: 'session1' };
      const options = { maxStorageBytes: 1000 };

      const testDoc = new PatchesDoc(initialState, metadata, options);

      expect(testDoc.state).toEqual(initialState);
      expect(testDoc.committedRev).toBe(0);
    });

    it('should clone initial state to avoid mutation', () => {
      const initialState = { items: [1, 2, 3] };
      const testDoc = new PatchesDoc(initialState);

      initialState.items.push(4);

      expect(testDoc.state.items).toEqual([1, 2, 3]);
    });
  });

  describe('getters', () => {
    it('should return correct id', () => {
      expect(doc.id).toBeNull();

      doc.setId('doc1');
      expect(doc.id).toBe('doc1');
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

    it('should return pending status', () => {
      expect(doc.hasPending).toBe(false);

      // Simulate adding pending changes
      doc.change(() => {});
      expect(doc.hasPending).toBe(true);
    });
  });

  describe('setId', () => {
    it('should set document ID', () => {
      doc.setId('doc1');
      expect(doc.id).toBe('doc1');
    });

    it('should allow setting same ID multiple times', () => {
      doc.setId('doc1');
      doc.setId('doc1');
      expect(doc.id).toBe('doc1');
    });

    it('should throw error when changing existing ID', () => {
      doc.setId('doc1');

      expect(() => doc.setId('doc2')).toThrow('Document ID cannot be changed once set. Current: doc1, Attempted: doc2');
    });
  });

  describe('setChangeMetadata', () => {
    it('should update change metadata', () => {
      const newMetadata = { sessionId: 'session2', timestamp: Date.now() };
      doc.setChangeMetadata(newMetadata);

      doc.change(() => {});

      expect(makeChange).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Function),
        newMetadata,
        undefined,
        undefined
      );
    });
  });

  describe('subscribe', () => {
    it('should call callback immediately with current state', () => {
      const callback = vi.fn();

      doc.subscribe(callback);

      expect(callback).toHaveBeenCalledWith({ text: 'hello' });
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();

      const unsubscribe = doc.subscribe(callback);

      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('export', () => {
    it('should export current snapshot', () => {
      const exported = doc.export();

      expect(exported).toEqual({
        state: { text: 'hello' },
        rev: 0,
        changes: [],
      });
    });

    it('should return clone to prevent mutation', () => {
      const exported1 = doc.export();
      const exported2 = doc.export();

      expect(exported1).not.toBe(exported2);
      expect(exported1).toEqual(exported2);
    });

    it('should include pending changes', () => {
      doc.change(() => {});

      const exported = doc.export();

      expect(exported.changes).toHaveLength(1);
    });
  });

  describe('import', () => {
    it('should import snapshot and update state', () => {
      const snapshot = createSnapshot({ title: 'Imported Doc' }, 5, [createChange('c1', 6)]);

      doc.import(snapshot);

      expect(createStateFromSnapshot).toHaveBeenCalledWith(snapshot);
      expect(doc.committedRev).toBe(5);
      expect(doc.hasPending).toBe(true);
    });

    it('should emit onUpdate when importing', () => {
      const updateSpy = vi.fn();
      doc.onUpdate(updateSpy);

      const snapshot = createSnapshot({ imported: true }, 3);
      doc.import(snapshot);

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should clone imported snapshot', () => {
      const snapshot = createSnapshot({ mutable: [1, 2, 3] }, 1);

      doc.import(snapshot);
      (snapshot.state as any).mutable.push(4);

      const exported = doc.export();
      expect((exported.state as any).mutable).toEqual([1, 2, 3]);
    });
  });

  describe('change', () => {
    it('should create and apply changes', () => {
      const mutator = vi.fn();

      const changes = doc.change(mutator);

      expect(makeChange).toHaveBeenCalledWith(
        expect.objectContaining({ rev: 0 }),
        mutator,
        { userId: 'user1' },
        undefined,
        undefined
      );
      expect(applyChanges).toHaveBeenCalled();
      expect(changes).toHaveLength(1);
    });

    it('should emit onChange and onUpdate when changes are made', () => {
      const changeSpy = vi.fn();
      const updateSpy = vi.fn();
      doc.onChange(changeSpy);
      doc.onUpdate(updateSpy);

      const changes = doc.change(() => {});

      expect(changeSpy).toHaveBeenCalledWith(changes);
      expect(updateSpy).toHaveBeenCalled();
    });

    it('should return empty array and not emit when no changes', () => {
      vi.mocked(makeChange).mockReturnValue([]);
      const changeSpy = vi.fn();
      doc.onChange(changeSpy);

      const changes = doc.change(() => {});

      expect(changes).toEqual([]);
      expect(changeSpy).not.toHaveBeenCalled();
    });

    it('should add changes to pending list', () => {
      // Ensure makeChange returns changes to trigger the logic
      vi.mocked(makeChange).mockReturnValue([
        {
          id: 'test-change',
          rev: 1,
          baseRev: 0,
          ops: [{ op: 'add', path: '/test', value: 'added' }],
          createdAt: Date.now(),
          committedAt: Date.now(),
        },
      ]);

      doc.change(() => {});

      expect(doc.hasPending).toBe(true);
      expect(doc.getPendingChanges()).toHaveLength(1);
    });

    it('should pass maxStorageBytes and sizeCalculator to makeChange', () => {
      const mockSizeCalculator = (data: unknown) => JSON.stringify(data).length;
      const docWithLimit = new PatchesDoc({}, {}, { maxStorageBytes: 500, sizeCalculator: mockSizeCalculator });

      docWithLimit.change(() => {});

      expect(makeChange).toHaveBeenCalledWith(expect.any(Object), expect.any(Function), {}, 500, mockSizeCalculator);
    });
  });

  describe('getPendingChanges', () => {
    it('should return pending changes', () => {
      expect(doc.getPendingChanges()).toEqual([]);

      // Make a change that actually returns changes
      doc.change(() => {});

      expect(doc.getPendingChanges()).toHaveLength(1);
    });
  });

  describe('applyCommittedChanges', () => {
    it('should apply server changes and update state', () => {
      const serverChanges = [createChange('s1', 1), createChange('s2', 2)];
      const rebasedPending = [createChange('p1', 3, 2)];

      doc.applyCommittedChanges(serverChanges, rebasedPending);

      expect(applyChanges).toHaveBeenCalledWith(expect.any(Object), serverChanges);
      expect(createStateFromSnapshot).toHaveBeenCalled();
      expect(doc.committedRev).toBe(2);
    });

    it('should throw error if revision mismatch', () => {
      const serverChanges = [createChange('s1', 5)]; // Wrong base revision

      expect(() => {
        doc.applyCommittedChanges(serverChanges, []);
      }).toThrow('Cannot apply committed changes to a doc that is not at the correct revision');
    });

    it('should replace pending changes with rebased ones', () => {
      // Add some pending changes first
      doc.change(() => {});
      expect(doc.getPendingChanges()).toHaveLength(1);

      const serverChanges = [createChange('s1', 1)];
      const rebasedPending = [createChange('p1', 2, 1), createChange('p2', 3, 1)];

      doc.applyCommittedChanges(serverChanges, rebasedPending);

      expect(doc.getPendingChanges()).toEqual(rebasedPending);
    });

    it('should emit onUpdate after applying changes', () => {
      const updateSpy = vi.fn();
      doc.onUpdate(updateSpy);

      const serverChanges = [createChange('s1', 1)];
      doc.applyCommittedChanges(serverChanges, []);

      expect(updateSpy).toHaveBeenCalled();
    });
  });

  describe('updateSyncing', () => {
    it('should update syncing state and emit event', () => {
      const syncingSpy = vi.fn();
      doc.onSyncing(syncingSpy);

      doc.updateSyncing('updating');

      expect(doc.syncing).toBe('updating');
      expect(syncingSpy).toHaveBeenCalledWith('updating');
    });

    it('should handle null syncing state', () => {
      doc.updateSyncing('updating');
      doc.updateSyncing(null);

      expect(doc.syncing).toBeNull();
    });
  });

  describe('toJSON', () => {
    it('should return exported snapshot', () => {
      const json = doc.toJSON();
      const exported = doc.export();

      expect(json).toEqual(exported);
    });
  });

  describe('event handling', () => {
    it('should provide onBeforeChange signal', () => {
      const callback = vi.fn();
      const unsubscribe = doc.onBeforeChange(callback);

      expect(typeof unsubscribe).toBe('function');
    });

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
    it('should handle multiple changes and state updates', () => {
      doc.change(() => {}); // Change 1
      expect(doc.hasPending).toBe(true);

      doc.change(() => {}); // Change 2
      expect(doc.getPendingChanges()).toHaveLength(2);

      // Apply some server changes
      const serverChanges = [createChange('s1', 1)];
      const rebasedPending = [createChange('p1', 2, 1)];
      doc.applyCommittedChanges(serverChanges, rebasedPending);

      expect(doc.committedRev).toBe(1);
      expect(doc.getPendingChanges()).toEqual(rebasedPending);
    });

    it('should maintain state consistency during rapid changes', () => {
      const updateSpy = vi.fn();
      doc.onUpdate(updateSpy);

      // Make multiple rapid changes
      doc.change(() => {});
      doc.change(() => {});
      doc.change(() => {});

      expect(updateSpy).toHaveBeenCalledTimes(3);
      expect(doc.getPendingChanges()).toHaveLength(3);
    });

    it('should handle import after changes have been made', () => {
      doc.change(() => {});
      expect(doc.hasPending).toBe(true);

      const snapshot = createSnapshot({ newState: true }, 10, []);
      doc.import(snapshot);

      expect(doc.committedRev).toBe(10);
      expect(doc.hasPending).toBe(false);
      expect(createStateFromSnapshot).toHaveBeenCalledWith(snapshot);
    });
  });
});
