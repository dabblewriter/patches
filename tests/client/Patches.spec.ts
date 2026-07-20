import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApplyChangesError } from '../../src/algorithms/ot/shared/applyChanges';
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

vi.mock('easy-signal', async () => {
  const actual = await vi.importActual<typeof import('easy-signal')>('easy-signal');
  return {
    ...actual,
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
      mockSignal.emitError = vi.fn();
      mockSignal.clear = vi.fn().mockImplementation(function () {
        return subscribers.clear();
      });
      return mockSignal;
    }),
  };
});

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
      updateSyncStatus: vi.fn(),
      _setFlushAwaiter: vi.fn(),
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
      hasPending: vi.fn().mockResolvedValue(false),
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
      expect(onTrackSpy).toHaveBeenCalledWith(['doc1', 'doc2'], 'ot');
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

    it('should unwind trackDocs if loadDoc throws (DAB-507 Bug 2)', async () => {
      // openDoc tracks the doc before calling loadDoc. If loadDoc throws, the doc must
      // not be left in `trackedDocs` (a tracked-but-unopened zombie).
      vi.mocked(mockAlgorithm.loadDoc).mockRejectedValue(new Error('transient load failure'));

      await expect(patches.openDoc('doc1')).rejects.toThrow('transient load failure');

      expect(patches.trackedDocs.has('doc1')).toBe(false);
      expect(mockAlgorithm.untrackDocs).toHaveBeenCalledWith(['doc1']);
    });

    it('should not untrack a pre-tracked doc when openDoc fails (DAB-507 Bug 2)', async () => {
      // Doc was tracked before openDoc was called (e.g., from a prior session). A failed
      // open must not nuke the existing subscription.
      await patches.trackDocs(['doc1']);
      vi.mocked(mockAlgorithm.untrackDocs).mockClear();
      vi.mocked(mockAlgorithm.loadDoc).mockRejectedValue(new Error('transient load failure'));

      await expect(patches.openDoc('doc1')).rejects.toThrow('transient load failure');

      expect(patches.trackedDocs.has('doc1')).toBe(true);
      expect(mockAlgorithm.untrackDocs).not.toHaveBeenCalled();
    });

    it('emits onDocLoadFailed when the snapshot fails to materialize (ApplyChangesError)', async () => {
      // The closed-doc receive path persists committed changes without applying, so an
      // unappliable change surfaces here, on first open. The open still rejects; the signal
      // lets a sync layer reload the authoritative snapshot so a retry succeeds.
      await patches.trackDocs(['doc1']);
      const loadErr = new ApplyChangesError('c-bad', 6, 0, new Error('[op:add] invalid path'));
      vi.mocked(mockAlgorithm.loadDoc).mockRejectedValue(loadErr);
      const failed: Array<[string, Error]> = [];
      patches.onDocLoadFailed((docId, error) => failed.push([docId, error]));

      await expect(patches.openDoc('doc1')).rejects.toThrow(loadErr);

      expect(failed).toEqual([['doc1', loadErr]]);
    });

    it('does not emit onDocLoadFailed for a non-materialization open failure', async () => {
      vi.mocked(mockAlgorithm.loadDoc).mockRejectedValue(new Error('transient load failure'));
      const failed = vi.fn();
      patches.onDocLoadFailed(failed);

      await expect(patches.openDoc('doc1')).rejects.toThrow('transient load failure');

      expect(failed).not.toHaveBeenCalled();
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

  describe('openDoc/closeDoc refcounting', () => {
    it('keeps doc open when openDoc count exceeds closeDoc count', async () => {
      const unsubscribe = vi.fn();
      mockDoc.onChange.mockReturnValue(unsubscribe);

      await patches.openDoc('doc1');
      await patches.openDoc('doc1');
      await patches.closeDoc('doc1');

      expect(unsubscribe).not.toHaveBeenCalled();
      expect(patches.getOpenDoc('doc1')).toBe(mockDoc);
    });

    it('tears down once when every openDoc is matched by a closeDoc', async () => {
      const unsubscribe = vi.fn();
      mockDoc.onChange.mockReturnValue(unsubscribe);

      await patches.openDoc('doc1');
      await patches.openDoc('doc1');
      await patches.closeDoc('doc1');
      await patches.closeDoc('doc1');

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(patches.getOpenDoc('doc1')).toBeUndefined();
    });

    it('treats an extra closeDoc past zero as a no-op', async () => {
      const unsubscribe = vi.fn();
      mockDoc.onChange.mockReturnValue(unsubscribe);

      await patches.openDoc('doc1');
      await patches.closeDoc('doc1');
      await patches.closeDoc('doc1');

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(patches.getOpenDoc('doc1')).toBeUndefined();
    });

    it('deleteDoc evicts even with outstanding refs', async () => {
      const unsubscribe = vi.fn();
      mockDoc.onChange.mockReturnValue(unsubscribe);

      await patches.openDoc('doc1');
      await patches.openDoc('doc1');
      await patches.deleteDoc('doc1');

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(patches.getOpenDoc('doc1')).toBeUndefined();
      expect(mockAlgorithm.deleteDoc).toHaveBeenCalledWith('doc1');
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

    it('awaits an in-flight openDoc so the doc is force-closed, not left live over a tombstone (finding #33)', async () => {
      let resolveLoad!: (s?: PatchesSnapshot) => void;
      vi.mocked(mockAlgorithm.loadDoc).mockReturnValue(
        new Promise(r => {
          resolveLoad = r;
        })
      );
      const unsubscribe = vi.fn();
      mockDoc.onChange.mockReturnValue(unsubscribe);

      const openPromise = patches.openDoc('doc1');
      await new Promise(r => setTimeout(r, 0)); // open reaches the loadDoc await

      const deletePromise = patches.deleteDoc('doc1');
      let deleteResolved = false;
      deletePromise.then(() => {
        deleteResolved = true;
      });
      await new Promise(r => setTimeout(r, 0));
      expect(deleteResolved).toBe(false); // deleteDoc waits out the open

      resolveLoad({ state: {}, rev: 0, changes: [] });
      await openPromise;
      await deletePromise;

      expect(patches.getOpenDoc('doc1')).toBeUndefined();
      expect(unsubscribe).toHaveBeenCalled();
      expect(mockAlgorithm.deleteDoc).toHaveBeenCalledWith('doc1');
    });
  });

  describe('closeDoc drains the in-flight change queue (finding #30)', () => {
    let capturedChangeHandler: any;

    beforeEach(async () => {
      mockDoc.onChange.mockImplementation((cb: any) => {
        capturedChangeHandler = cb;
        return vi.fn();
      });
      await patches.openDoc('doc1');
    });

    it('does not resolve the final closeDoc until a pending change has been processed', async () => {
      let resolveMint!: (v: any) => void;
      vi.mocked(mockAlgorithm.handleDocChange).mockReturnValue(
        new Promise(r => {
          resolveMint = r;
        })
      );
      capturedChangeHandler([{ op: 'add', path: '/t', value: 1 }]);

      const closePromise = patches.closeDoc('doc1');
      let closed = false;
      closePromise.then(() => {
        closed = true;
      });
      await new Promise(r => setTimeout(r, 0));
      expect(closed).toBe(false);

      resolveMint([]);
      await closePromise;
      expect(patches.getOpenDoc('doc1')).toBeUndefined();
    });

    it('reopen waits for the previous instance queue before loading the snapshot', async () => {
      expect(mockAlgorithm.loadDoc).toHaveBeenCalledTimes(1);
      let resolveMint!: (v: any) => void;
      vi.mocked(mockAlgorithm.handleDocChange).mockReturnValue(
        new Promise(r => {
          resolveMint = r;
        })
      );
      capturedChangeHandler([{ op: 'add', path: '/t', value: 1 }]);

      void patches.closeDoc('doc1'); // not awaited — close and reopen back-to-back
      const reopenPromise = patches.openDoc('doc1');
      await new Promise(r => setTimeout(r, 0));
      // The snapshot must not be read while the mint's store write is in flight —
      // it would miss the pending change and remint at the same rev.
      expect(mockAlgorithm.loadDoc).toHaveBeenCalledTimes(1);

      resolveMint([]);
      await reopenPromise;
      expect(mockAlgorithm.loadDoc).toHaveBeenCalledTimes(2);
    });
  });

  describe('change queue failure isolation (finding #31)', () => {
    it('skips changes queued behind an authoritative rejection that rolled back the optimistic queue', async () => {
      mockDoc.rollbackOptimistic = vi.fn();
      let capturedChangeHandler: any;
      mockDoc.onChange.mockImplementation((cb: any) => {
        capturedChangeHandler = cb;
        return vi.fn();
      });
      await patches.openDoc('doc1');

      const onErrorSpy = vi.fn();
      patches.onError(onErrorSpy);

      let rejectFirst!: (e: Error) => void;
      vi.mocked(mockAlgorithm.handleDocChange).mockImplementationOnce(
        () =>
          new Promise((_, rej) => {
            rejectFirst = rej;
          })
      );

      const first = capturedChangeHandler([{ op: 'add', path: '/a', value: [] }]);
      const second = capturedChangeHandler([{ op: 'add', path: '/a/0', value: 'x' }]); // depends on first
      await new Promise(r => setTimeout(r, 0));

      // Terminal StatusError shape — the server's definitive verdict on the change.
      rejectFirst(Object.assign(new Error('write denied'), { code: 403 }));
      await first;
      await second;

      // The dependent change must NOT be minted — its base was rolled back.
      expect(mockAlgorithm.handleDocChange).toHaveBeenCalledTimes(1);
      expect(mockDoc.rollbackOptimistic).toHaveBeenCalledTimes(1);
      expect(onErrorSpy).toHaveBeenCalledTimes(1);
      expect(onErrorSpy.mock.calls[0][1]).toEqual({ docId: 'doc1', willRetry: false });

      // A change made after the rollback processes normally.
      await capturedChangeHandler([{ op: 'add', path: '/c', value: 3 }]);
      expect(mockAlgorithm.handleDocChange).toHaveBeenCalledTimes(2);
    });
  });

  describe('submitDocChange', () => {
    it('takes an optimistic slot on the open doc before queueing (finding #32)', async () => {
      mockDoc._applyOptimistic = vi.fn();
      await patches.openDoc('doc1');
      const ops = [{ op: 'add' as const, path: '/x', value: 1 }];

      await patches.submitDocChange('doc1', ops);

      expect(mockDoc._applyOptimistic).toHaveBeenCalledWith(ops);
      expect(mockAlgorithm.handleDocChange).toHaveBeenCalledWith('doc1', ops, mockDoc, {}, expect.any(String), false);
    });

    it('passes undefined doc when the doc is not open', async () => {
      const ops = [{ op: 'add' as const, path: '/x', value: 1 }];
      await patches.submitDocChange('doc1', ops);

      expect(mockAlgorithm.handleDocChange).toHaveBeenCalledWith('doc1', ops, undefined, {}, expect.any(String), false);
    });

    it('is a no-op for empty ops', async () => {
      await patches.submitDocChange('doc1', []);
      expect(mockAlgorithm.handleDocChange).not.toHaveBeenCalled();
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

    it('should await in-flight openDoc before closing algorithms (DAB-507 Bug 3)', async () => {
      // Without the fix, close() clears `docs`/algorithms while an open is between its
      // last `await` and `this.docs.set`. The open then registers a doc against a
      // half-closed instance. With the fix, close() awaits the in-flight body first.
      let resolveLoadDoc!: (snap: PatchesSnapshot | undefined) => void;
      vi.mocked(mockAlgorithm.loadDoc).mockImplementation(
        () =>
          new Promise(resolve => {
            resolveLoadDoc = resolve;
          })
      );

      const openPromise = patches.openDoc('doc1');
      // Yield so openDoc reaches the loadDoc await before we call close().
      await new Promise(r => setTimeout(r, 0));

      const closePromise = patches.close();
      // close() must not resolve yet — openDoc is still pending on loadDoc.
      let closeResolved = false;
      closePromise.then(() => {
        closeResolved = true;
      });
      await Promise.resolve();
      expect(closeResolved).toBe(false);
      // mockAlgorithm.close must not have been called yet.
      expect(mockAlgorithm.close).not.toHaveBeenCalled();

      // Release loadDoc; openDoc completes; close() proceeds.
      resolveLoadDoc({ state: {}, rev: 1, changes: [] });
      await openPromise;
      await closePromise;

      expect(mockAlgorithm.close).toHaveBeenCalled();
      // openDoc's doc is gone from the map after close() cleared it.
      expect(patches.getOpenDoc('doc1')).toBeUndefined();
    });
  });

  describe('_handleDocChange', () => {
    it('should delegate to algorithm and emit onChange', async () => {
      const onChangeSpy = vi.fn();
      patches.onChange(onChangeSpy);

      const ops = [{ op: 'add' as const, path: '/test', value: 'value' }];
      await (patches as any)._handleDocChange('doc1', ops, mockDoc, mockAlgorithm, {});

      expect(mockAlgorithm.handleDocChange).toHaveBeenCalledWith('doc1', ops, mockDoc, {}, expect.any(String), false);
      expect(onChangeSpy).toHaveBeenCalledWith('doc1');
    });

    it('should roll back and emit onError on an authoritative rejection', async () => {
      mockDoc.rollbackOptimistic = vi.fn();
      const onErrorSpy = vi.fn();
      patches.onError(onErrorSpy);

      const error = Object.assign(new Error('Algorithm rejected'), { code: 404 });
      vi.mocked(mockAlgorithm.handleDocChange).mockRejectedValue(error);

      const ops = [{ op: 'add' as const, path: '/test', value: 'value' }];
      await (patches as any)._handleDocChange('doc1', ops, mockDoc, mockAlgorithm, {});

      expect(mockDoc.rollbackOptimistic).toHaveBeenCalledTimes(1);
      expect(onErrorSpy).toHaveBeenCalledWith(error, { docId: 'doc1', willRetry: false });
    });

    it('should keep ops and retry (same stable id) on a transient failure', async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockDoc.rollbackOptimistic = vi.fn();
        mockDoc._hasOptimisticEntry = vi.fn().mockReturnValue(true);
        const onErrorSpy = vi.fn();
        patches.onError(onErrorSpy);

        const error = new Error('Call timed out'); // no status code — ambiguous transport death
        vi.mocked(mockAlgorithm.handleDocChange).mockRejectedValueOnce(error).mockResolvedValueOnce([]);

        const ops = [{ op: 'add' as const, path: '/test', value: 'value' }];
        const processed = (patches as any)._handleDocChange('doc1', ops, mockDoc, mockAlgorithm, {});
        await vi.advanceTimersByTimeAsync(0);

        // Failed once, nothing rolled back, error surfaced as retryable.
        expect(mockDoc.rollbackOptimistic).not.toHaveBeenCalled();
        expect(onErrorSpy).toHaveBeenCalledWith(error, { docId: 'doc1', willRetry: true, attempt: 0 });

        await vi.advanceTimersByTimeAsync(1000); // first backoff
        await processed;

        expect(mockAlgorithm.handleDocChange).toHaveBeenCalledTimes(2);
        const [first, second] = vi.mocked(mockAlgorithm.handleDocChange).mock.calls;
        expect(first).toEqual(['doc1', ops, mockDoc, {}, expect.any(String), false]);
        // Same stable id, isRetry flagged so the algorithm pre-scans for a landed batch.
        expect(second).toEqual(['doc1', ops, mockDoc, {}, first[4], true]);
        expect(mockDoc.rollbackOptimistic).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
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

      expect(mockAlgorithm.handleDocChange).toHaveBeenCalledWith('doc1', ops, mockDoc, {}, expect.any(String), false);
    });
  });

  describe('applySnapshot', () => {
    const newer = (rev: number): PatchesSnapshot => ({ state: { text: `r${rev}` }, rev, changes: [] });

    it('imports immediately when doc is open and snapshot rev is newer', async () => {
      mockDoc.committedRev = 3;
      await patches.openDoc('doc1');
      const snapshot = newer(7);

      patches.applySnapshot('doc1', snapshot);

      expect(mockDoc.import).toHaveBeenCalledWith(snapshot);
    });

    it('drops snapshot when rev is not strictly newer than committedRev', async () => {
      // Strict `>` (not `>=`): doc.import resets internal pending-state from
      // snapshot.changes, so firing on equal-rev duplicate broadcasts would wipe
      // legitimate in-flight ops mid-typing.
      mockDoc.committedRev = 10;
      await patches.openDoc('doc1');

      patches.applySnapshot('doc1', newer(10));
      patches.applySnapshot('doc1', newer(5));

      expect(mockDoc.import).not.toHaveBeenCalled();
    });

    it('drops snapshot when doc is neither open nor opening', () => {
      expect(() => patches.applySnapshot('doc1', newer(5))).not.toThrow();
      expect(mockDoc.import).not.toHaveBeenCalled();
    });

    it('stashes snapshot during in-flight openDoc and drains after open resolves', async () => {
      let resolveLoad!: (s: PatchesSnapshot | undefined) => void;
      vi.mocked(mockAlgorithm.loadDoc).mockReturnValue(
        new Promise(r => {
          resolveLoad = r;
        })
      );

      const openPromise = patches.openDoc('doc1');
      // Yield so openDoc reaches the awaited loadDoc
      await new Promise(r => setTimeout(r, 0));

      const stash = newer(5);
      patches.applySnapshot('doc1', stash);
      // mockDoc isn't returned by createDoc until loadDoc resolves, so import not yet called
      expect(mockDoc.import).not.toHaveBeenCalled();

      // loadDoc resolves with an older snapshot — stashed one should win
      mockDoc.committedRev = 0;
      resolveLoad({ state: {}, rev: 0, changes: [] });
      await openPromise;

      expect(mockDoc.import).toHaveBeenCalledWith(stash);
    });

    it('highest-rev snapshot wins regardless of arrival order', async () => {
      let resolveLoad!: (s: PatchesSnapshot | undefined) => void;
      vi.mocked(mockAlgorithm.loadDoc).mockReturnValue(
        new Promise(r => {
          resolveLoad = r;
        })
      );

      const openPromise = patches.openDoc('doc1');
      await new Promise(r => setTimeout(r, 0));

      // Out-of-order: higher rev arrives FIRST, lower rev arrives second.
      // The lower one must NOT overwrite the higher in the stash.
      patches.applySnapshot('doc1', newer(7));
      patches.applySnapshot('doc1', newer(5));

      mockDoc.committedRev = 0;
      resolveLoad(undefined);
      await openPromise;

      expect(mockDoc.import).toHaveBeenCalledTimes(1);
      expect(mockDoc.import).toHaveBeenCalledWith(newer(7));
    });

    it('clears stash on open failure (no leak, no stale-drain on retry)', async () => {
      let rejectLoad!: (err: Error) => void;
      vi.mocked(mockAlgorithm.loadDoc).mockReturnValueOnce(
        new Promise((_, r) => {
          rejectLoad = r;
        })
      );

      const openPromise = patches.openDoc('doc1');
      await new Promise(r => setTimeout(r, 0));

      patches.applySnapshot('doc1', newer(5));

      rejectLoad(new Error('boom'));
      await expect(openPromise).rejects.toThrow('boom');

      // After failure, the doc isn't tracked anywhere — stash is gone.
      // A subsequent retry starts fresh; the broadcaster's next emission repopulates it.
      vi.mocked(mockAlgorithm.loadDoc).mockResolvedValue({ state: {}, rev: 0, changes: [] });
      mockDoc.committedRev = 0;

      await patches.openDoc('doc1');

      expect(mockDoc.import).not.toHaveBeenCalled();
    });
  });

  describe('multi-algorithm: closed-doc resolution (DAB-507 Bug 4)', () => {
    // For a closed doc opened on a non-default algorithm, deleteDoc / untrackDocs
    // must resolve the algorithm by scanning each store rather than defaulting —
    // otherwise the tombstone or untrack lands in the wrong store.

    let multiPatches: InstanceType<typeof Patches>;
    let otAlgorithm: ClientAlgorithm;
    let lwwAlgorithm: ClientAlgorithm;

    beforeEach(async () => {
      const makeAlgorithm = (name: string): ClientAlgorithm =>
        ({
          name,
          store: {} as PatchesStore,
          createDoc: vi.fn().mockReturnValue(mockDoc),
          loadDoc: vi.fn().mockResolvedValue(undefined),
          handleDocChange: vi.fn().mockResolvedValue([]),
          getPendingToSend: vi.fn().mockResolvedValue(null),
          applyServerChanges: vi.fn().mockResolvedValue([]),
          confirmSent: vi.fn().mockResolvedValue(undefined),
          trackDocs: vi.fn().mockResolvedValue(undefined),
          untrackDocs: vi.fn().mockResolvedValue(undefined),
          listDocs: vi.fn().mockResolvedValue([]),
          getCommittedRev: vi.fn().mockResolvedValue(0),
          deleteDoc: vi.fn().mockResolvedValue(undefined),
          confirmDeleteDoc: vi.fn().mockResolvedValue(undefined),
          hasPending: vi.fn().mockResolvedValue(false),
          close: vi.fn().mockResolvedValue(undefined),
        }) as ClientAlgorithm;

      otAlgorithm = makeAlgorithm('ot');
      lwwAlgorithm = makeAlgorithm('lww');

      multiPatches = new Patches({
        algorithms: { ot: otAlgorithm, lww: lwwAlgorithm },
        defaultAlgorithm: 'ot',
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    afterEach(async () => {
      await multiPatches.close();
    });

    it('deleteDoc routes to the algorithm whose store claims the closed doc', async () => {
      // Doc lives in LWW store (e.g., opened with `algorithm: 'lww'` then closed).
      // Defaulting to 'ot' would tombstone the wrong store.
      vi.mocked(lwwAlgorithm.listDocs).mockResolvedValue([{ docId: 'settings', committedRev: 1, algorithm: 'lww' }]);
      multiPatches.trackedDocs.add('settings');

      await multiPatches.deleteDoc('settings');

      expect(lwwAlgorithm.deleteDoc).toHaveBeenCalledWith('settings');
      expect(otAlgorithm.deleteDoc).not.toHaveBeenCalled();
    });

    it('untrackDocs routes to the algorithm whose store claims the closed doc', async () => {
      vi.mocked(lwwAlgorithm.listDocs).mockResolvedValue([{ docId: 'settings', committedRev: 1, algorithm: 'lww' }]);
      multiPatches.trackedDocs.add('settings');

      await multiPatches.untrackDocs(['settings']);

      expect(lwwAlgorithm.untrackDocs).toHaveBeenCalledWith(['settings']);
      expect(otAlgorithm.untrackDocs).not.toHaveBeenCalled();
    });

    it('listQuarantinedChanges dedups entries both algorithm stores report from a shared database', async () => {
      // In shared-database setups (createMultiAlgorithmIndexedDBPatches) every algorithm
      // store reads the same `quarantinedChanges` object store, so both return the same
      // entries; the aggregate must not double them.
      const entry = { docId: 'doc1', changeId: 'c1', change: createChange('c1', 2), reason: 'r', quarantinedAt: 1 };
      const other = { docId: 'doc2', changeId: 'c2', change: createChange('c2', 3), reason: 'r', quarantinedAt: 2 };
      (otAlgorithm as any).listQuarantinedChanges = vi.fn().mockResolvedValue([entry, other]);
      (lwwAlgorithm as any).listQuarantinedChanges = vi.fn().mockResolvedValue([entry, other]);

      const listed = await multiPatches.listQuarantinedChanges();

      expect(listed.map(e => `${e.docId}/${e.changeId}`).sort()).toEqual(['doc1/c1', 'doc2/c2']);
    });
  });
});
