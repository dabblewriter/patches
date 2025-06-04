import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Patches } from '../../src/client/Patches.js';
import { PatchesDoc } from '../../src/client/PatchesDoc.js';
import type { PatchesStore } from '../../src/client/PatchesStore.js';
import { signal, type Signal } from '../../src/event-signal.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { ConnectionState } from '../../src/net/protocol/types.js';
import { PatchesWebSocket } from '../../src/net/websocket/PatchesWebSocket.js';
import type { Change, PatchesSnapshot } from '../../src/types.js';

// 1. Mock modules with factories returning new vi.fn()
vi.mock('../../src/algorithms/client/applyCommittedChanges.js', () => ({ applyCommittedChanges: vi.fn() }));
vi.mock('../../src/algorithms/client/batching.js', () => ({ breakIntoBatches: vi.fn() }));

// --- Mock Core Dependencies ---
vi.mock('../../src/client/Patches.js');
vi.mock('../../src/client/PatchesDoc.js');
vi.mock('../../src/net/websocket/PatchesWebSocket.js');
vi.mock('../../src/net/websocket/onlineState.js', () => ({
  onlineState: {
    isOnline: true,
    onOnlineChange: vi.fn(() => () => {}),
  },
}));

// 2. Import the functions AFTER they have been mocked.
import { applyCommittedChanges } from '../../src/algorithms/client/applyCommittedChanges.js';
import { breakIntoBatches } from '../../src/algorithms/client/batching.js';

// 3. Cast the imported mocks for type safety in tests.
const mockedApplyCommittedChanges = applyCommittedChanges as vi.MockedFunction<typeof applyCommittedChanges>;
const mockedBreakIntoBatches = breakIntoBatches as vi.MockedFunction<typeof breakIntoBatches>;

describe('PatchesSync', () => {
  let mockPatches: vi.Mocked<Patches>;
  let mockStore: vi.Mocked<PatchesStore>;
  let mockPatchesWebSocketInstance: vi.Mocked<PatchesWebSocket>;
  let patchesSync: PatchesSync | undefined; // Allow it to be undefined initially

  const DOC_ID_1 = 'doc1';
  const MOCK_URL = 'ws://localhost:1234';

  beforeEach(() => {
    mockedApplyCommittedChanges.mockReset();
    mockedBreakIntoBatches.mockReset();
    vi.mocked(Patches).mockClear();
    vi.mocked(PatchesWebSocket).mockClear();

    mockStore = {
      getDoc: vi.fn().mockResolvedValue(undefined),
      listDocs: vi.fn().mockResolvedValue([]),
      getPendingChanges: vi.fn().mockResolvedValue([]),
      getLastRevs: vi.fn().mockResolvedValue([0, 0]),
      saveDoc: vi.fn().mockResolvedValue(undefined),
      savePendingChanges: vi.fn().mockResolvedValue(undefined),
      saveCommittedChanges: vi.fn().mockResolvedValue(undefined),
      replacePendingChanges: vi.fn().mockResolvedValue(undefined),
      trackDocs: vi.fn().mockResolvedValue(undefined),
      untrackDocs: vi.fn().mockResolvedValue(undefined),
      deleteDoc: vi.fn().mockResolvedValue(undefined),
      confirmDeleteDoc: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as vi.Mocked<PatchesStore>;

    const MockedPatchesConstructor = vi.mocked(Patches);
    mockPatches = new MockedPatchesConstructor({ store: mockStore });
    (mockPatches as any).store = mockStore;
    (mockPatches as any).docOptions = { maxPayloadBytes: 1000 };
    (mockPatches as any).trackedDocs = new Set<string>();
    (mockPatches as any).getOpenDoc = vi.fn();
    (mockPatches as any).getDocChanges = vi.fn().mockReturnValue([]);
    (mockPatches as any).onError = signal();
    (mockPatches as any).onTrackDocs = signal();
    (mockPatches as any).onUntrackDocs = signal();
    (mockPatches as any).onDeleteDoc = signal();
    (mockPatches as any).onChange = signal();

    const MockedPatchesWebSocketConstructor = vi.mocked(PatchesWebSocket);
    mockPatchesWebSocketInstance = new MockedPatchesWebSocketConstructor(MOCK_URL);

    mockPatchesWebSocketInstance.connect = vi.fn().mockResolvedValue(undefined);
    mockPatchesWebSocketInstance.disconnect = vi.fn();
    mockPatchesWebSocketInstance.subscribe = vi.fn().mockResolvedValue(undefined);
    mockPatchesWebSocketInstance.unsubscribe = vi.fn().mockResolvedValue(undefined);
    mockPatchesWebSocketInstance.getDoc = vi.fn();
    mockPatchesWebSocketInstance.getChangesSince = vi.fn().mockResolvedValue([]);
    mockPatchesWebSocketInstance.commitChanges = vi.fn().mockResolvedValue([]);
    mockPatchesWebSocketInstance.deleteDoc = vi.fn().mockResolvedValue(undefined);
    (mockPatchesWebSocketInstance as any).onStateChange = signal<(state: ConnectionState) => void>();
    (mockPatchesWebSocketInstance as any).onChangesCommitted = signal<(docId: string, changes: Change[]) => void>();

    MockedPatchesWebSocketConstructor.mockImplementation(() => mockPatchesWebSocketInstance);

    patchesSync = new PatchesSync(mockPatches, MOCK_URL); // wsOptionsFromTest is now passed

    mockedApplyCommittedChanges.mockImplementation(
      (snapshot: PatchesSnapshot<any>, _serverChanges: Change[]) => snapshot
    );
    mockedBreakIntoBatches.mockImplementation((changes: Change[]) => [changes]);
  });

  afterEach(() => {
    if (patchesSync) {
      patchesSync.disconnect(); // Guarded call
    }
    vi.clearAllTimers();
  });

  describe('Initialization and Connection', () => {
    it('should initialize with Patches instance, URL, and options', () => {
      expect((patchesSync as any).patches).toBe(mockPatches);
      expect((patchesSync as any).store).toBe(mockStore);
      expect((patchesSync as any).maxPayloadBytes).toBe(1000);
      expect(vi.mocked(PatchesWebSocket)).toHaveBeenCalledWith(MOCK_URL);
    });

    it('should connect to WebSocket and update state', async () => {
      const stateChangeSpy = vi.fn();
      patchesSync!.onStateChange(stateChangeSpy);
      await patchesSync!.connect();
      expect(mockPatchesWebSocketInstance.connect).toHaveBeenCalled();
      ((mockPatchesWebSocketInstance as any).onStateChange as Signal<(state: ConnectionState) => void>).emit(
        'connected'
      );
      expect(patchesSync!.state.connected).toBe(true);
      expect(stateChangeSpy).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    });

    it('should sync all known docs upon connection', async () => {
      const syncAllDocsSpy = vi.spyOn(patchesSync as any, 'syncAllKnownDocs').mockResolvedValue(undefined);
      await patchesSync!.connect();
      ((mockPatchesWebSocketInstance as any).onStateChange as Signal<(state: ConnectionState) => void>).emit(
        'connected'
      );
      expect(syncAllDocsSpy).toHaveBeenCalled();
      syncAllDocsSpy.mockRestore();
    });
  });

  describe('_applyServerChangesToDoc (via _receiveCommittedChanges)', () => {
    let mockOpenDoc: vi.Mocked<PatchesDoc<any>>;
    const MOCK_SNAPSHOT_REV_5: PatchesSnapshot = { state: { text: 'rev5' }, rev: 5, changes: [] };

    beforeEach(() => {
      const MockedPatchesDoc = vi.mocked(PatchesDoc);
      mockOpenDoc = new MockedPatchesDoc();
      (mockOpenDoc as any).import = vi.fn();
      (mockOpenDoc as any).applyCommittedChanges = vi.fn();
      vi.spyOn(mockOpenDoc, 'committedRev', 'get').mockReturnValue(5);
      (mockOpenDoc as any).getPendingChanges = vi.fn().mockReturnValue([]);

      mockStore.getDoc.mockResolvedValue(MOCK_SNAPSHOT_REV_5);
      mockPatches.getOpenDoc.mockReturnValue(mockOpenDoc);
      mockedApplyCommittedChanges.mockImplementation((snap: PatchesSnapshot<any>, serverChanges: Change[]) => ({
        ...snap,
        rev: serverChanges.length > 0 ? serverChanges[serverChanges.length - 1].rev : snap.rev,
        changes: [],
      }));
    });

    it('should call applyCommittedChanges algorithm and update store', async () => {
      const serverChanges: Change[] = [{ id: 's6', rev: 6, baseRev: 5, ops: [], created: Date.now() }];
      const algoResultSnapshot: PatchesSnapshot = { state: { text: 'server updated' }, rev: 6, changes: [] };
      mockedApplyCommittedChanges.mockReturnValue(algoResultSnapshot);

      await (patchesSync as any)._receiveCommittedChanges(DOC_ID_1, serverChanges);

      expect(mockStore.getDoc).toHaveBeenCalledWith(DOC_ID_1);
      expect(mockedApplyCommittedChanges).toHaveBeenCalledWith(MOCK_SNAPSHOT_REV_5, serverChanges);
      expect(mockStore.saveCommittedChanges).toHaveBeenCalledWith(DOC_ID_1, serverChanges, undefined);
      expect(mockStore.replacePendingChanges).toHaveBeenCalledWith(DOC_ID_1, algoResultSnapshot.changes);
    });

    it('should call doc.applyCommittedChanges if doc is open and revs align', async () => {
      const serverChanges: Change[] = [{ id: 's6', rev: 6, baseRev: 5, ops: [], created: Date.now() }];
      vi.spyOn(mockOpenDoc, 'committedRev', 'get').mockReturnValue(5);
      const algoResultSnapshot: PatchesSnapshot = {
        state: { text: 'server updated' },
        rev: 6,
        changes: [{ id: 'p7', rev: 7, baseRev: 6, ops: [], created: Date.now() }],
      };
      mockedApplyCommittedChanges.mockReturnValue(algoResultSnapshot);

      await (patchesSync as any)._receiveCommittedChanges(DOC_ID_1, serverChanges);

      expect(mockPatches.getOpenDoc).toHaveBeenCalledWith(DOC_ID_1);
      expect(mockOpenDoc.applyCommittedChanges).toHaveBeenCalledWith(serverChanges, algoResultSnapshot.changes);
      expect(mockOpenDoc.import).not.toHaveBeenCalled();
    });

    it('should call doc.import if doc is open and revs do NOT align', async () => {
      const serverChanges: Change[] = [{ id: 's7', rev: 7, baseRev: 6, ops: [], created: Date.now() }];
      vi.spyOn(mockOpenDoc, 'committedRev', 'get').mockReturnValue(5);
      const algoResultSnapshot: PatchesSnapshot = { state: { text: 'server updated to 7' }, rev: 7, changes: [] };
      mockedApplyCommittedChanges.mockReturnValue(algoResultSnapshot);

      await (patchesSync as any)._receiveCommittedChanges(DOC_ID_1, serverChanges);

      expect(mockPatches.getOpenDoc).toHaveBeenCalledWith(DOC_ID_1);
      expect(mockOpenDoc.import).toHaveBeenCalledWith(algoResultSnapshot);
      expect(mockOpenDoc.applyCommittedChanges).not.toHaveBeenCalled();
    });
  });

  describe('flushDoc', () => {
    beforeEach(() => {
      (patchesSync as any).trackedDocs.add(DOC_ID_1);
      (patchesSync as any).updateState({ connected: true });
    });
    it('should get pending changes, break into batches, commit, and apply', async () => {
      const pendingChanges: Change[] = [{ id: 'p1', rev: 1, baseRev: 0, ops: [], created: Date.now() }];
      const committedChangesFromServer: Change[] = [{ id: 's1', rev: 1, baseRev: 0, ops: [], created: Date.now() }];
      const snapshotAfterCommit: PatchesSnapshot = { state: { flushed: true }, rev: 1, changes: [] };
      const range: [number, number] = [1, 1];

      mockStore.getPendingChanges.mockResolvedValue(pendingChanges);
      mockedBreakIntoBatches.mockReturnValue([pendingChanges]);
      mockPatchesWebSocketInstance.commitChanges.mockResolvedValue(committedChangesFromServer);

      const initialSnapshotForFlush: PatchesSnapshot = { state: {}, rev: 0, changes: pendingChanges };
      mockStore.getDoc.mockResolvedValue(initialSnapshotForFlush);
      mockedApplyCommittedChanges.mockReturnValue(snapshotAfterCommit);

      await (patchesSync as any).flushDoc(DOC_ID_1);

      expect(mockStore.getPendingChanges).toHaveBeenCalledWith(DOC_ID_1);
      expect(mockedBreakIntoBatches).toHaveBeenCalledWith(pendingChanges, 1000);
      expect(mockPatchesWebSocketInstance.commitChanges).toHaveBeenCalledWith(DOC_ID_1, pendingChanges);
      expect(mockStore.saveCommittedChanges).toHaveBeenCalledWith(DOC_ID_1, committedChangesFromServer, range);
      expect(mockedApplyCommittedChanges).toHaveBeenCalledWith(initialSnapshotForFlush, committedChangesFromServer);
    });
  });
});
