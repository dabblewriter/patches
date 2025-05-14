import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { Patches } from '../../src/client/Patches';
import { PatchesDoc } from '../../src/client/PatchesDoc';
import type { PatchesStore } from '../../src/client/types';
import { signal } from '../../src/event-signal';
import type { Change } from '../../src/types';

// Mock PatchesDoc before any test setup
vi.mock('../../src/client/PatchesDoc');

// Define a type for the document state used in tests
interface TestDocState {
  count?: number;
  initial?: boolean;
}

describe('Patches', () => {
  let mockStore: Mocked<PatchesStore>;
  let mockDocInstanceFactory: () => Mocked<PatchesDoc<any>>;
  let patches: Patches;

  const DOC_ID = 'test-doc-1';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock store
    mockStore = {
      getDoc: vi.fn().mockResolvedValue({ state: { initial: true }, rev: 0, changes: [] }),
      getPendingChanges: vi.fn().mockResolvedValue([]),
      getLastRevs: vi.fn().mockResolvedValue([0, 0]),
      listDocs: vi.fn().mockResolvedValue([]),
      savePendingChanges: vi.fn().mockResolvedValue(undefined),
      saveCommittedChanges: vi.fn().mockResolvedValue(undefined),
      trackDocs: vi.fn().mockResolvedValue(undefined),
      untrackDocs: vi.fn().mockResolvedValue(undefined),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      onPendingChanges: signal(),
    } as unknown as Mocked<PatchesStore>;

    // Setup mock PatchesDoc factory
    mockDocInstanceFactory = () => {
      const _mockPendingChanges: Change[] = [];
      let _mockSendingChanges: Change[] = [];
      let _id: string | null = null;
      let _mockUpdatesForServer: Change[] = [];

      const instance = {
        state: { initial: true },
        committedRev: 0,
        get isSending() {
          return _mockSendingChanges.length > 0;
        },
        get hasPending() {
          return _mockPendingChanges.length > 0;
        },
        get id() {
          return _id;
        },
        setId: vi.fn((docId: string) => {
          if (_id !== null && _id !== docId) {
            throw new Error('Document ID cannot be changed once set');
          }
          _id = docId;
        }),
        import: vi.fn(),
        change: vi.fn((_mutator: (draft: any) => void) => {
          const newChange: Change = { id: `mock-${Math.random()}`, ops: [], rev: 0, baseRev: 0, created: Date.now() };
          _mockPendingChanges.push(newChange);
          instance.onChange.emit(newChange);
          return newChange;
        }),
        getUpdatesForServer: vi.fn(() => _mockUpdatesForServer),
        applyServerConfirmation: vi.fn((serverCommit: Change[]) => {
          if (serverCommit.length === 0) {
            _mockSendingChanges = [];
          } else {
            _mockSendingChanges = [];
          }
        }),
        applyExternalServerUpdate: vi.fn(),
        handleSendFailure: vi.fn(() => {
          _mockPendingChanges.unshift(..._mockSendingChanges);
          _mockSendingChanges = [];
        }),
        onChange: signal<(change: Change) => void>(),
        onBeforeChange: signal(),
        onUpdate: signal(),
        _setMockUpdatesForServer: (updates: Change[]) => {
          _mockUpdatesForServer = updates;
        },
      } as unknown as Mocked<PatchesDoc<any>>;

      vi.spyOn(instance, 'getUpdatesForServer');
      vi.spyOn(instance, 'handleSendFailure');
      vi.spyOn(instance, 'import');
      vi.spyOn(instance, 'applyServerConfirmation');
      vi.spyOn(instance, 'applyExternalServerUpdate');
      vi.spyOn(instance, 'setId');
      return instance;
    };

    // Mock PatchesDoc constructor
    const mockPatchesDoc = vi.mocked(PatchesDoc);
    mockPatchesDoc.mockImplementation(() => {
      const instance = mockDocInstanceFactory();
      return instance;
    });

    // Create Patches instance
    patches = new Patches({
      store: mockStore,
    });

    // Spy on console methods
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Test Cases ---

  describe('Initialization', () => {
    it('should initialize with the provided store', () => {
      expect(patches['store']).toBe(mockStore);
    });
  });

  describe('Document Operations', () => {
    it('should open a document and set up listeners', async () => {
      const doc = await patches.openDoc<TestDocState>(DOC_ID);

      expect(mockStore.getDoc).toHaveBeenCalledWith(DOC_ID);
      expect(doc.setId).toHaveBeenCalledWith(DOC_ID);
      expect(doc.import).toHaveBeenCalled();
      expect((patches as any).docs.has(DOC_ID)).toBe(true);

      const testChange: Change = { id: 'test-change', ops: [], rev: 1, baseRev: 0, created: Date.now() };
      (doc as any)._setMockUpdatesForServer([testChange]);

      doc.onChange.emit(testChange);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(doc.getUpdatesForServer).toHaveBeenCalled();
      expect(mockStore.savePendingChanges).toHaveBeenCalledWith(DOC_ID, [testChange]);
    });

    it('should return existing doc if already open', async () => {
      const mockDoc = mockDocInstanceFactory();
      (patches as any).docs.set(DOC_ID, {
        doc: mockDoc,
        onChangeUnsubscriber: vi.fn(),
      });

      const doc = await patches.openDoc<TestDocState>(DOC_ID);

      expect(doc).toBe(mockDoc);
      expect(mockStore.getDoc).not.toHaveBeenCalled();
    });

    it('should close a document and clean up listeners', async () => {
      const mockDoc = mockDocInstanceFactory();
      const unsubscriber = vi.fn();
      (patches as any).docs.set(DOC_ID, {
        doc: mockDoc,
        onChangeUnsubscriber: unsubscriber,
      });

      await patches.closeDoc(DOC_ID);

      expect(unsubscriber).toHaveBeenCalled();
      expect((patches as any).docs.has(DOC_ID)).toBe(false);
    });

    it('should delete a document', async () => {
      const mockDoc = mockDocInstanceFactory();
      const unsubscriber = vi.fn();
      (patches as any).docs.set(DOC_ID, {
        doc: mockDoc,
        onChangeUnsubscriber: unsubscriber,
      });

      await patches.deleteDoc(DOC_ID);

      expect(unsubscriber).toHaveBeenCalled();
      expect((patches as any).docs.has(DOC_ID)).toBe(false);
      expect(mockStore.deleteDoc).toHaveBeenCalledWith(DOC_ID);
    });
  });

  describe('Error Handling', () => {
    it('should emit errors when saving pending changes fails', async () => {
      const mockDoc = mockDocInstanceFactory();

      mockDoc.getUpdatesForServer.mockReturnValue([
        { id: 'change-1', ops: [], rev: 1, baseRev: 0, created: Date.now() },
      ]);

      const saveError = new Error('Failed to save pending changes');
      mockStore.savePendingChanges.mockRejectedValue(saveError);

      // Setup doc
      (patches as any).docs.set(DOC_ID, {
        doc: mockDoc,
        onChangeUnsubscriber: (patches as any)._setupLocalDocListener(DOC_ID, mockDoc),
      });

      // Spy on error signal
      const errorSpy = vi.spyOn(patches.onError, 'emit');

      // Trigger change
      const testChange: Change = { id: 'change-1', ops: [], rev: 1, baseRev: 0, created: Date.now() };
      mockDoc.onChange.emit(testChange);

      // Wait for the async operation to complete
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith(saveError, { docId: DOC_ID });
    });
  });
});
