import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PatchesStore } from '../../src/client/PatchesStore';
import type { ClientAlgorithm } from '../../src/client/ClientAlgorithm';
import type { Change, PatchesSnapshot } from '../../src/types';

// Mock dependencies completely before importing
vi.mock('../../src/client/OTDoc', () => {
  return {
    OTDoc: vi.fn().mockImplementation(function () {
      return {
        setId: vi.fn(),
        import: vi.fn(),
        onChange: vi.fn().mockReturnValue(vi.fn()),
        close: vi.fn(),
        state: {},
        committedRev: 0,
        hasPending: false,
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
const { OTDoc } = await import('../../src/client/OTDoc');

describe('Patches', () => {
  let patches: InstanceType<typeof Patches>;
  let mockStore: PatchesStore;
  let mockAlgorithm: ClientAlgorithm;
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

    // Mock OTDoc (id is now passed in constructor, no setId)
    mockDoc = {
      id: 'test-doc',
      import: vi.fn(),
      applyChanges: vi.fn(),
      updateSyncing: vi.fn(),
      onChange: vi.fn().mockReturnValue(vi.fn()),
      close: vi.fn(),
      state: {},
      committedRev: 0,
      hasPending: false,
    };
    vi.mocked(OTDoc).mockImplementation(function () {
      return mockDoc;
    });

    // Mock algorithm that wraps the store
    mockAlgorithm = {
      name: 'ot',
      store: mockStore,
      createDoc: vi.fn().mockReturnValue(mockDoc),
      loadDoc: vi.fn().mockImplementation((docId: string) => mockStore.getDoc(docId)),
      handleDocChange: vi.fn().mockResolvedValue([]),
      getPendingToSend: vi.fn().mockResolvedValue(null),
      applyServerChanges: vi.fn().mockResolvedValue([]),
      confirmSent: vi.fn().mockResolvedValue(undefined),
      trackDocs: vi.fn().mockImplementation((ids: string[]) => mockStore.trackDocs(ids)),
      untrackDocs: vi.fn().mockImplementation((ids: string[]) => mockStore.untrackDocs(ids)),
      listDocs: vi.fn().mockImplementation((includeDeleted?: boolean) => mockStore.listDocs(includeDeleted)),
      getCommittedRev: vi.fn().mockImplementation((docId: string) => mockStore.getCommittedRev(docId)),
      deleteDoc: vi.fn().mockImplementation((docId: string) => mockStore.deleteDoc(docId)),
      confirmDeleteDoc: vi.fn().mockImplementation((docId: string) => mockStore.confirmDeleteDoc(docId)),
      close: vi.fn().mockImplementation(() => mockStore.close()),
    };

    patches = new Patches({ algorithms: { ot: mockAlgorithm }, defaultAlgorithm: 'ot' });

    // Wait for initial listDocs call
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  afterEach(async () => {
    await patches.close();
  });

  describe('constructor', () => {
    it('should initialize with algorithms and options', () => {
      expect(patches.algorithms.ot).toBe(mockAlgorithm);
      expect(patches.defaultAlgorithm).toBe('ot');
      expect(patches.trackedDocs).toBeInstanceOf(Set);
      expect(mockAlgorithm.listDocs).toHaveBeenCalled();
    });

    it('should track docs returned from algorithm.listDocs', async () => {
      const docs = [
        { docId: 'doc1', committedRev: 0 },
        { docId: 'doc2', committedRev: 0 },
      ];
      vi.mocked(mockAlgorithm.listDocs).mockResolvedValue(docs);

      const patchesInstance = new Patches({ algorithms: { ot: mockAlgorithm } });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(patchesInstance.trackedDocs.has('doc1')).toBe(true);
      expect(patchesInstance.trackedDocs.has('doc2')).toBe(true);
    });

    it('should accept custom docOptions', () => {
      const customOptions = { maxStorageBytes: 100 };
      const patchesInstance = new Patches({
        algorithms: { ot: mockAlgorithm },
        docOptions: customOptions,
      });

      expect(patchesInstance.docOptions).toEqual(customOptions);
    });

    it('should throw if no algorithms provided', () => {
      expect(() => new Patches({ algorithms: {} })).toThrow('At least one algorithm must be provided');
    });

    it('should throw if default algorithm not found', () => {
      expect(() => new Patches({ algorithms: { ot: mockAlgorithm }, defaultAlgorithm: 'lww' })).toThrow(
        "Default algorithm 'lww' not found"
      );
    });
  });

  describe('trackDocs', () => {
    it('should track new documents', async () => {
      const onTrackSpy = vi.fn();
      patches.onTrackDocs(onTrackSpy);

      await patches.trackDocs(['doc1', 'doc2']);

      expect(patches.trackedDocs.has('doc1')).toBe(true);
      expect(patches.trackedDocs.has('doc2')).toBe(true);
      expect(mockAlgorithm.trackDocs).toHaveBeenCalledWith(['doc1', 'doc2']);
      expect(onTrackSpy).toHaveBeenCalledWith(['doc1', 'doc2']);
    });

    it('should filter out already tracked documents', async () => {
      await patches.trackDocs(['doc1']);
      vi.clearAllMocks();

      await patches.trackDocs(['doc1', 'doc2']);

      expect(mockAlgorithm.trackDocs).toHaveBeenCalledWith(['doc2']);
    });

    it('should do nothing if no new documents to track', async () => {
      await patches.trackDocs(['doc1']);
      vi.clearAllMocks();

      await patches.trackDocs(['doc1']);

      expect(mockAlgorithm.trackDocs).not.toHaveBeenCalled();
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
      expect(mockAlgorithm.untrackDocs).toHaveBeenCalled();
      expect(onUntrackSpy).toHaveBeenCalledWith(['doc1', 'doc2']);
    });

    it('should filter out non-tracked documents', async () => {
      await patches.trackDocs(['doc1']);

      await patches.untrackDocs(['doc1', 'doc2']);

      // Should only untrack doc1 since doc2 was never tracked
      expect(mockAlgorithm.untrackDocs).toHaveBeenCalled();
    });

    it('should do nothing if no tracked documents to untrack', async () => {
      await patches.untrackDocs(['doc1']);

      expect(mockAlgorithm.untrackDocs).not.toHaveBeenCalled();
    });
  });

  describe('openDoc', () => {
    it('should open a new document via algorithm', async () => {
      const snapshot: PatchesSnapshot = { state: { text: 'hello' }, rev: 5, changes: [] };
      vi.mocked(mockAlgorithm.loadDoc).mockResolvedValue(snapshot);

      const doc = await patches.openDoc('doc1');

      expect(patches.trackedDocs.has('doc1')).toBe(true);
      expect(mockAlgorithm.loadDoc).toHaveBeenCalledWith('doc1');
      // New API: createDoc receives docId and snapshot
      expect(mockAlgorithm.createDoc).toHaveBeenCalledWith('doc1', snapshot);
      expect(mockDoc.onChange).toHaveBeenCalled();
      expect(doc).toBe(mockDoc);
    });

    it('should return existing document if already open', async () => {
      const doc1 = await patches.openDoc('doc1');
      const doc2 = await patches.openDoc('doc1');

      expect(doc1).toBe(doc2);
      expect(mockAlgorithm.createDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle document without snapshot', async () => {
      vi.mocked(mockAlgorithm.loadDoc).mockResolvedValue(undefined);

      const doc = await patches.openDoc('doc1');

      // When no snapshot exists, createDoc is called with docId and undefined snapshot
      expect(mockAlgorithm.createDoc).toHaveBeenCalledWith('doc1', undefined);
      expect(doc).toBe(mockDoc);
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
      expect(mockAlgorithm.untrackDocs).toHaveBeenCalled();
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
      expect(mockAlgorithm.deleteDoc).toHaveBeenCalledWith('doc1');
      expect(onDeleteSpy).toHaveBeenCalledWith('doc1');
    });

    it('should delete a tracked but not open document', async () => {
      await patches.trackDocs(['doc1']);
      await patches.deleteDoc('doc1');

      expect(patches.trackedDocs.has('doc1')).toBe(false);
      expect(mockAlgorithm.deleteDoc).toHaveBeenCalledWith('doc1');
    });

    it('should delete an untracked document', async () => {
      await patches.deleteDoc('doc1');

      expect(mockAlgorithm.deleteDoc).toHaveBeenCalledWith('doc1');
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

  describe('getDocAlgorithm', () => {
    it('should return algorithm for open document', async () => {
      await patches.openDoc('doc1');
      const algorithm = patches.getDocAlgorithm('doc1');

      expect(algorithm).toBe(mockAlgorithm);
    });

    it('should return undefined for non-open document', () => {
      const algorithm = patches.getDocAlgorithm('doc1');

      expect(algorithm).toBeUndefined();
    });
  });

  describe('close', () => {
    it('should close all documents and algorithms', async () => {
      const unsubscribe1 = vi.fn();
      const unsubscribe2 = vi.fn();
      mockDoc.onChange.mockReturnValueOnce(unsubscribe1).mockReturnValueOnce(unsubscribe2);

      await patches.openDoc('doc1');
      await patches.openDoc('doc2');

      await patches.close();

      expect(unsubscribe1).toHaveBeenCalled();
      expect(unsubscribe2).toHaveBeenCalled();
      expect(mockAlgorithm.close).toHaveBeenCalled();
      expect(patches.getOpenDoc('doc1')).toBeUndefined();
      expect(patches.getOpenDoc('doc2')).toBeUndefined();
    });
  });

  describe('_handleDocChange', () => {
    it('should delegate to algorithm and emit onChange', async () => {
      const onChangeSpy = vi.fn();
      patches.onChange(onChangeSpy);

      const ops = [{ op: 'add' as const, path: '/test', value: 'value' }];
      await (patches as any)._handleDocChange('doc1', ops, mockDoc, mockAlgorithm, {});

      expect(mockAlgorithm.handleDocChange).toHaveBeenCalledWith('doc1', ops, mockDoc, {});
      expect(onChangeSpy).toHaveBeenCalledWith('doc1');
    });

    it('should handle errors and emit onError', async () => {
      const onErrorSpy = vi.fn();
      patches.onError(onErrorSpy);

      const error = new Error('Algorithm failed');
      vi.mocked(mockAlgorithm.handleDocChange).mockRejectedValue(error);

      const ops = [{ op: 'add' as const, path: '/test', value: 'value' }];
      await (patches as any)._handleDocChange('doc1', ops, mockDoc, mockAlgorithm, {});

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
      let capturedChangeHandler: any;
      mockDoc.onChange.mockImplementation((callback: any) => {
        capturedChangeHandler = callback;
        return vi.fn();
      });

      await patches.openDoc('doc1');

      // Simulate ops from the document's onChange
      const ops = [{ op: 'add' as const, path: '/test', value: 'value' }];
      await capturedChangeHandler(ops);

      expect(mockAlgorithm.handleDocChange).toHaveBeenCalledWith('doc1', ops, mockDoc, {});
    });
  });
});
