import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { Patches } from '../../src/client/Patches';
import { PatchesDoc } from '../../src/client/PatchesDoc.js';
import type { PatchesStore } from '../../src/client/PatchesStore.js';
import { signal } from '../../src/event-signal.js';
import type { Change } from '../../src/types.js';

// Mock PatchesDoc before any test setup
vi.mock('../../src/client/PatchesDoc.js');

// Define a type for the document state used in tests
interface TestDocState {
  count?: number;
  initial?: boolean;
}

describe('Patches', () => {
  let mockStore: Mocked<PatchesStore>;
  let mockDocInstance: Mocked<PatchesDoc<TestDocState>>;
  let patches: Patches;

  const DOC_ID = 'test-doc-1';

  beforeEach(() => {
    vi.resetAllMocks();

    // Setup mock store
    mockStore = {
      getDoc: vi.fn().mockResolvedValue({ state: { initial: true }, rev: 0, changes: [] }),
      getPendingChanges: vi.fn().mockResolvedValue([]),
      getLastRevs: vi.fn().mockResolvedValue([0, 0]),
      listDocs: vi.fn().mockResolvedValue([{ docId: DOC_ID, committedRev: 0 }]),
      savePendingChanges: vi.fn().mockResolvedValue(undefined),
      saveCommittedChanges: vi.fn().mockResolvedValue(undefined),
      trackDocs: vi.fn().mockResolvedValue(undefined),
      untrackDocs: vi.fn().mockResolvedValue(undefined),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      saveDoc: vi.fn().mockResolvedValue(undefined),
      replacePendingChanges: vi.fn().mockResolvedValue(undefined),
      confirmDeleteDoc: vi.fn().mockResolvedValue(undefined),
      onPendingChanges: signal(),
    } as Mocked<PatchesStore>;

    // Create a fresh mock instance for PatchesDoc for each test
    // to allow spying on its `onChange.emit` if needed per test.
    const MockedPatchesDoc = vi.mocked(PatchesDoc);
    mockDocInstance = new MockedPatchesDoc() as Mocked<PatchesDoc<TestDocState>>;

    // Setup the onChange signal on the instance *before* it's returned by the constructor mock
    // This ensures that when Patches._setupLocalDocListeners runs, it gets a valid signal to subscribe to.
    (mockDocInstance as any).onChange = signal<(changes: Change[]) => void>(); // Instance specific signal
    mockDocInstance.import = vi.fn();
    mockDocInstance.setId = vi.fn();
    // getOpenDoc in Patches will return this instance if ID matches

    MockedPatchesDoc.mockImplementation(() => mockDocInstance);

    // Create Patches instance
    patches = new Patches({
      store: mockStore,
    });

    // Spy on console methods
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    patches.close();
    vi.restoreAllMocks();
  });

  // --- Test Cases ---

  describe('Initialization', () => {
    it('should initialize with the provided store and track existing docs', async () => {
      await new Promise(process.nextTick);
      expect(patches['store']).toBe(mockStore);
      expect(mockStore.listDocs).toHaveBeenCalled();
      expect(mockStore.trackDocs).toHaveBeenCalledWith([DOC_ID]);
      expect(patches.trackedDocs.has(DOC_ID)).toBe(true);
    });
  });

  describe('Document Operations', () => {
    it('should open a document, set it up, and listen for its changes', async () => {
      const onPatchesChangeSpy = vi.fn();
      patches.onChange(onPatchesChangeSpy); // Correct way to subscribe to signal

      const doc = await patches.openDoc<TestDocState>(DOC_ID);
      expect(doc).toBe(mockDocInstance);
      expect(mockStore.getDoc).toHaveBeenCalledWith(DOC_ID);
      expect(mockDocInstance.setId).toHaveBeenCalledWith(DOC_ID);
      expect(mockDocInstance.import).toHaveBeenCalled();
      expect((patches as any).docs.get(DOC_ID).doc).toBe(mockDocInstance);

      const testChanges: Change[] = [{ id: 'c1', ops: [], rev: 1, baseRev: 0, created: Date.now() }];
      // Access the actual signal on the instance that was created and used by Patches
      const managedDoc = (patches as any).docs.get(DOC_ID);
      const docInstanceUsedByPatches = managedDoc.doc as Mocked<PatchesDoc<TestDocState>>;
      docInstanceUsedByPatches.onChange.emit(testChanges); // Emit on the correct signal instance

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockStore.savePendingChanges).toHaveBeenCalledWith(DOC_ID, testChanges);
      expect(onPatchesChangeSpy).toHaveBeenCalledWith(DOC_ID, testChanges);
    });

    it('should close a document and unsubscribe its listener', async () => {
      await patches.openDoc<TestDocState>(DOC_ID);
      const managedDoc = (patches as any).docs.get(DOC_ID);
      const unsubscribeSpy = vi.spyOn(managedDoc, 'unsubscribe');

      await patches.closeDoc(DOC_ID);
      expect(unsubscribeSpy).toHaveBeenCalled();
      expect((patches as any).docs.has(DOC_ID)).toBe(false);
    });

    it('should delete a document, closing and untracking it', async () => {
      await patches.openDoc<TestDocState>(DOC_ID);
      await patches.trackDocs([DOC_ID]);

      const closeDocSpy = vi.spyOn(patches, 'closeDoc');
      const untrackDocsSpy = vi.spyOn(patches, 'untrackDocs');
      const onDeleteDocSpy = vi.spyOn(patches.onDeleteDoc, 'emit');

      await patches.deleteDoc(DOC_ID);

      expect(closeDocSpy).toHaveBeenCalledWith(DOC_ID);
      expect(untrackDocsSpy).toHaveBeenCalledWith([DOC_ID]);
      expect(mockStore.deleteDoc).toHaveBeenCalledWith(DOC_ID);
      expect(onDeleteDocSpy).toHaveBeenCalledWith(DOC_ID);
    });
  });
});
