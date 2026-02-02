import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PatchesStore } from '../../src/client/PatchesStore';
import type { Change } from '../../src/types';

// Mock dependencies completely before importing
vi.mock('../../src/client/PatchesDoc', () => {
  return {
    PatchesDoc: vi.fn().mockImplementation(function () {
      return {
        setId: vi.fn(),
        import: vi.fn(),
        onChange: vi.fn().mockReturnValue(vi.fn()),
        close: vi.fn(),
      };
    }),
  };
});

vi.mock('../../src/utils/concurrency', () => ({
  singleInvocation: vi.fn().mockImplementation(function (matchOnFirstArg?: boolean) {
    if (typeof matchOnFirstArg === 'function') {
      return matchOnFirstArg;
    }
    return function (target: any) {
      return target;
    };
  }),
}));

vi.mock('../../src/event-signal', () => ({
  signal: vi.fn().mockImplementation(function () {
    const subscribers = new Set();
    const mockSignal = vi.fn().mockImplementation(function (callback: any) {
      subscribers.add(callback);
      return function () {
        return subscribers.delete(callback);
      };
    }) as any;
    mockSignal.emit = vi.fn().mockImplementation(async function (...args: any[]) {
      for (const callback of subscribers) {
        await (callback as any)(...args);
      }
    });
    mockSignal.error = vi.fn().mockReturnValue(vi.fn());
    mockSignal.clear = vi.fn().mockImplementation(function () {
      return subscribers.clear();
    });
    return mockSignal;
  }),
}));

// Now import after mocking
const { Patches } = await import('../../src/client/Patches');
const { PatchesDoc } = await import('../../src/client/PatchesDoc');

describe('Patches', () => {
  let patches: InstanceType<typeof Patches>;
  let mockStore: PatchesStore;
  let mockDoc: any;

  const createChange = (id: string, rev: number): Change => ({
    id,
    rev,
    baseRev: rev - 1,
    ops: [{ op: 'add', path: `/change-${id}`, value: `data-${id}` }],
    createdAt: Date.now(),
    committedAt: Date.now(),
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock store
    mockStore = {
      listDocs: vi.fn().mockResolvedValue([]),
      trackDocs: vi.fn().mockResolvedValue(undefined),
      untrackDocs: vi.fn().mockResolvedValue(undefined),
      getDoc: vi.fn().mockResolvedValue(undefined),
      saveDoc: vi.fn().mockResolvedValue(undefined),
      savePendingChanges: vi.fn().mockResolvedValue(undefined),
      getPendingChanges: vi.fn().mockResolvedValue([]),
      applyServerChanges: vi.fn().mockResolvedValue(undefined),
      getCommittedRev: vi.fn().mockResolvedValue(0),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      confirmDeleteDoc: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    // Mock PatchesDoc
    mockDoc = {
      setId: vi.fn(),
      import: vi.fn(),
      onChange: vi.fn().mockReturnValue(vi.fn()),
      close: vi.fn(),
    };
    vi.mocked(PatchesDoc).mockImplementation(function () {
      return mockDoc;
    });

    patches = new Patches({ store: mockStore });

    // Wait for initial listDocs call
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  afterEach(() => {
    patches.close();
  });

  describe('constructor', () => {
    it('should initialize with store and options', () => {
      expect(patches.store).toBe(mockStore);
      expect(patches.trackedDocs).toBeInstanceOf(Set);
      expect(mockStore.listDocs).toHaveBeenCalled();
    });

    it('should track docs returned from store.listDocs', async () => {
      const docs = [
        { docId: 'doc1', committedRev: 0 },
        { docId: 'doc2', committedRev: 0 },
      ];
      vi.mocked(mockStore.listDocs).mockResolvedValue(docs);

      const patchesInstance = new Patches({ store: mockStore });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(patchesInstance.trackedDocs.has('doc1')).toBe(true);
      expect(patchesInstance.trackedDocs.has('doc2')).toBe(true);
    });

    it('should accept custom docOptions', () => {
      const customOptions = { maxStorageBytes: 100 };
      const patchesInstance = new Patches({
        store: mockStore,
        docOptions: customOptions,
      });

      expect(patchesInstance.docOptions).toEqual(customOptions);
    });
  });

  describe('trackDocs', () => {
    it('should track new documents', async () => {
      const onTrackSpy = vi.fn();
      patches.onTrackDocs(onTrackSpy);

      await patches.trackDocs(['doc1', 'doc2']);

      expect(patches.trackedDocs.has('doc1')).toBe(true);
      expect(patches.trackedDocs.has('doc2')).toBe(true);
      expect(mockStore.trackDocs).toHaveBeenCalledWith(['doc1', 'doc2']);
      expect(onTrackSpy).toHaveBeenCalledWith(['doc1', 'doc2']);
    });

    it('should filter out already tracked documents', async () => {
      await patches.trackDocs(['doc1']);
      vi.clearAllMocks();

      await patches.trackDocs(['doc1', 'doc2']);

      expect(mockStore.trackDocs).toHaveBeenCalledWith(['doc2']);
    });

    it('should do nothing if no new documents to track', async () => {
      await patches.trackDocs(['doc1']);
      vi.clearAllMocks();

      await patches.trackDocs(['doc1']);

      expect(mockStore.trackDocs).not.toHaveBeenCalled();
    });
  });

  describe('untrackDocs', () => {
    it('should untrack documents and close open docs', async () => {
      const onUntrackSpy = vi.fn();
      patches.onUntrackDocs(onUntrackSpy);

      await patches.trackDocs(['doc1', 'doc2']);
      await patches.openDoc('doc1');

      vi.clearAllMocks();

      await patches.untrackDocs(['doc1', 'doc2']);

      expect(patches.trackedDocs.has('doc1')).toBe(false);
      expect(patches.trackedDocs.has('doc2')).toBe(false);
      expect(mockStore.untrackDocs).toHaveBeenCalledWith(['doc1', 'doc2']);
      expect(onUntrackSpy).toHaveBeenCalledWith(['doc1', 'doc2']);
    });

    it('should filter out non-tracked documents', async () => {
      await patches.trackDocs(['doc1']);

      await patches.untrackDocs(['doc1', 'doc2']);

      expect(mockStore.untrackDocs).toHaveBeenCalledWith(['doc1']);
    });

    it('should do nothing if no tracked documents to untrack', async () => {
      await patches.untrackDocs(['doc1']);

      expect(mockStore.untrackDocs).not.toHaveBeenCalled();
    });
  });

  describe('openDoc', () => {
    it('should open a new document', async () => {
      const snapshot = { state: { text: 'hello' }, rev: 5, changes: [] };
      vi.mocked(mockStore.getDoc).mockResolvedValue(snapshot);

      const doc = await patches.openDoc('doc1');

      expect(patches.trackedDocs.has('doc1')).toBe(true);
      expect(mockStore.getDoc).toHaveBeenCalledWith('doc1');
      expect(PatchesDoc).toHaveBeenCalledWith({ text: 'hello' }, {}, {});
      expect(mockDoc.setId).toHaveBeenCalledWith('doc1');
      expect(mockDoc.import).toHaveBeenCalledWith(snapshot);
      expect(mockDoc.onChange).toHaveBeenCalled();
      expect(doc).toBe(mockDoc);
    });

    it('should return existing document if already open', async () => {
      const doc1 = await patches.openDoc('doc1');
      const doc2 = await patches.openDoc('doc1');

      expect(doc1).toBe(doc2);
      expect(PatchesDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle document without snapshot', async () => {
      vi.mocked(mockStore.getDoc).mockResolvedValue(undefined);

      const doc = await patches.openDoc('doc1');

      expect(PatchesDoc).toHaveBeenCalledWith({}, {}, {});
      expect(mockDoc.import).not.toHaveBeenCalled();
      expect(doc).toBe(mockDoc);
    });

    it('should merge metadata options', async () => {
      const globalMetadata = { userId: 'user1' };
      const docMetadata = { sessionId: 'session1' };

      const patchesWithMetadata = new Patches({
        store: mockStore,
        metadata: globalMetadata,
      });

      await patchesWithMetadata.openDoc('doc1', { metadata: docMetadata });

      expect(PatchesDoc).toHaveBeenCalledWith({}, { userId: 'user1', sessionId: 'session1' }, {});
    });
  });

  describe('closeDoc', () => {
    it('should close an open document', async () => {
      const unsubscribe = vi.fn();
      mockDoc.onChange.mockReturnValue(unsubscribe);

      await patches.openDoc('doc1');
      await patches.closeDoc('doc1');

      expect(unsubscribe).toHaveBeenCalled();
      expect(patches.getOpenDoc('doc1')).toBeUndefined();
    });

    it('should untrack document when untrack option is true', async () => {
      await patches.openDoc('doc1');
      await patches.closeDoc('doc1', { untrack: true });

      expect(patches.trackedDocs.has('doc1')).toBe(false);
      expect(mockStore.untrackDocs).toHaveBeenCalledWith(['doc1']);
    });

    it('should do nothing if document is not open', async () => {
      await patches.closeDoc('non-existent');
      // Test passes if no errors thrown
    });
  });

  describe('deleteDoc', () => {
    it('should delete an open document', async () => {
      const onDeleteSpy = vi.fn();
      patches.onDeleteDoc(onDeleteSpy);

      await patches.openDoc('doc1');
      await patches.deleteDoc('doc1');

      expect(patches.getOpenDoc('doc1')).toBeUndefined();
      expect(patches.trackedDocs.has('doc1')).toBe(false);
      expect(mockStore.deleteDoc).toHaveBeenCalledWith('doc1');
      expect(onDeleteSpy).toHaveBeenCalledWith('doc1');
    });

    it('should delete a tracked but not open document', async () => {
      await patches.trackDocs(['doc1']);
      await patches.deleteDoc('doc1');

      expect(patches.trackedDocs.has('doc1')).toBe(false);
      expect(mockStore.deleteDoc).toHaveBeenCalledWith('doc1');
    });

    it('should delete an untracked document', async () => {
      await patches.deleteDoc('doc1');

      expect(mockStore.deleteDoc).toHaveBeenCalledWith('doc1');
    });
  });

  describe('getOpenDoc', () => {
    it('should return open document', async () => {
      const doc = await patches.openDoc('doc1');
      const retrieved = patches.getOpenDoc('doc1');

      expect(retrieved).toBe(doc);
    });

    it('should return undefined for non-open document', () => {
      const retrieved = patches.getOpenDoc('doc1');

      expect(retrieved).toBeUndefined();
    });
  });

  describe('close', () => {
    it('should close all documents and clean up', async () => {
      const unsubscribe1 = vi.fn();
      const unsubscribe2 = vi.fn();
      mockDoc.onChange.mockReturnValueOnce(unsubscribe1).mockReturnValueOnce(unsubscribe2);

      await patches.openDoc('doc1');
      await patches.openDoc('doc2');

      patches.close();

      expect(unsubscribe1).toHaveBeenCalled();
      expect(unsubscribe2).toHaveBeenCalled();
      expect(mockStore.close).toHaveBeenCalled();
      expect(patches.getOpenDoc('doc1')).toBeUndefined();
      expect(patches.getOpenDoc('doc2')).toBeUndefined();
    });
  });

  describe('_savePendingChanges', () => {
    it('should save changes to store and emit onChange', async () => {
      const onChangeSpy = vi.fn();
      patches.onChange(onChangeSpy);

      const changes = [createChange('c1', 1)];
      await (patches as any)._savePendingChanges('doc1', changes);

      expect(mockStore.savePendingChanges).toHaveBeenCalledWith('doc1', changes);
      expect(onChangeSpy).toHaveBeenCalledWith('doc1', changes);
    });

    it('should handle errors and emit onError', async () => {
      const onErrorSpy = vi.fn();
      patches.onError(onErrorSpy);

      const error = new Error('Save failed');
      vi.mocked(mockStore.savePendingChanges).mockRejectedValue(error);

      const changes = [createChange('c1', 1)];
      await (patches as any)._savePendingChanges('doc1', changes);

      expect(onErrorSpy).toHaveBeenCalledWith(error, { docId: 'doc1' });
    });
  });

  describe('signals', () => {
    it('should provide onChange signal', () => {
      const callback = vi.fn();
      const unsubscribe = patches.onChange(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should provide onTrackDocs signal', () => {
      const callback = vi.fn();
      const unsubscribe = patches.onTrackDocs(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should provide onUntrackDocs signal', () => {
      const callback = vi.fn();
      const unsubscribe = patches.onUntrackDocs(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should provide onDeleteDoc signal', () => {
      const callback = vi.fn();
      const unsubscribe = patches.onDeleteDoc(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should provide onError signal', () => {
      const callback = vi.fn();
      const unsubscribe = patches.onError(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should provide onServerCommit signal', () => {
      const callback = vi.fn();
      const unsubscribe = patches.onServerCommit(callback);

      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('change listener integration', () => {
    it('should set up change listener when opening document', async () => {
      const changeHandler = vi.fn();
      mockDoc.onChange.mockImplementation((callback: any) => {
        changeHandler.mockImplementation(callback);
        return vi.fn();
      });

      await patches.openDoc('doc1');

      // Simulate a change in the document
      const changes = [createChange('c1', 1)];
      changeHandler(changes);

      expect(mockStore.savePendingChanges).toHaveBeenCalledWith('doc1', changes);
    });
  });
});
