import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchesDoc, type PatchesDocOptions } from '../../src/client/PatchesDoc.js';
import type { JSONPatchOp } from '../../src/json-patch/types.js';
import type { Change, PatchesSnapshot, SyncingState } from '../../src/types.js';

// 1. Mock the modules. The factory returns an object with vi.fn() for each function.
vi.mock('../../src/algorithms/client/makeChange.js', () => ({ makeChange: vi.fn() }));
vi.mock('../../src/algorithms/shared/applyChanges.js', () => ({ applyChanges: vi.fn() }));
vi.mock('../../src/algorithms/client/createStateFromSnapshot.js', () => ({ createStateFromSnapshot: vi.fn() }));

// 2. Import the functions AFTER they have been mocked. These are now the vi.fn() instances.
import { createStateFromSnapshot } from '../../src/algorithms/client/createStateFromSnapshot.js';
import { makeChange } from '../../src/algorithms/client/makeChange.js';
import { applyChanges } from '../../src/algorithms/shared/applyChanges.js';

// 3. Cast the imported mocks to vi.MockedFunction for type safety in tests.
const makeChangeAlgorithmMock = vi.mocked(makeChange);
const applyChangesAlgorithmMock = vi.mocked(applyChanges);
const createStateFromSnapshotAlgorithmMock = vi.mocked(createStateFromSnapshot);

describe('PatchesDoc', () => {
  type TestDocShape = { text?: string; count?: number; items?: string[]; other?: boolean };
  let doc: PatchesDoc<TestDocShape>;
  const initialDocState: TestDocShape = { text: 'hello' };
  const initialMetadata = { client: 'testClient' };
  const docOptions: PatchesDocOptions = { maxPayloadBytes: 1000 };

  const createInitialSnapshot = (
    state: TestDocShape = initialDocState,
    rev = 1,
    changes: Change[] = []
  ): PatchesSnapshot<TestDocShape> =>
    structuredClone({
      state,
      rev,
      changes,
    });

  beforeEach(() => {
    makeChangeAlgorithmMock.mockReset();
    applyChangesAlgorithmMock.mockReset();
    createStateFromSnapshotAlgorithmMock.mockReset();

    doc = new PatchesDoc<TestDocShape>(structuredClone(initialDocState), initialMetadata, docOptions);

    createStateFromSnapshotAlgorithmMock.mockImplementation((snapshot: PatchesSnapshot<TestDocShape>): TestDocShape => {
      let s = structuredClone(snapshot.state);
      if (snapshot.changes && snapshot.changes.length > 0) {
        s = applyChangesAlgorithmMock(s, snapshot.changes);
      }
      return s;
    });

    applyChangesAlgorithmMock.mockImplementation((state: TestDocShape, changesToApply: Change[]): TestDocShape => {
      let s = structuredClone(state);
      for (const change of changesToApply) {
        if (change.ops) {
          change.ops.forEach((op: JSONPatchOp) => {
            const pathParts = op.path.split('/').slice(1);
            let currentLevel: any = s;
            for (let i = 0; i < pathParts.length - 1; i++) {
              currentLevel = currentLevel[pathParts[i]] = currentLevel[pathParts[i]] || {};
            }
            if (op.op === 'add' || op.op === 'replace') {
              currentLevel[pathParts[pathParts.length - 1]] = op.value;
            } else if (op.op === 'remove') {
              delete currentLevel[pathParts[pathParts.length - 1]];
            }
          });
        }
      }
      return s;
    });
  });

  it('should initialize with given state, metadata, and options', () => {
    expect(doc.state).toEqual(initialDocState);
    expect(doc.committedRev).toBe(0);
    expect(doc.hasPending).toBe(false);
    expect((doc as any)._changeMetadata).toEqual(initialMetadata);
    expect((doc as any)._maxPayloadBytes).toBe(docOptions.maxPayloadBytes);
  });

  describe('import()', () => {
    it('should import a snapshot and update state via algorithm', () => {
      const newSnapshotState: TestDocShape = { text: 'world', count: 1 };
      const snapshotToImport: PatchesSnapshot<TestDocShape> = { state: newSnapshotState, rev: 5, changes: [] };

      createStateFromSnapshotAlgorithmMock.mockReturnValueOnce(newSnapshotState);
      const onUpdateSpy = vi.spyOn(doc.onUpdate, 'emit');

      doc.import(snapshotToImport);

      expect((doc as any)._snapshot).toEqual(snapshotToImport);
      expect(createStateFromSnapshotAlgorithmMock).toHaveBeenCalledWith(snapshotToImport);
      expect(doc.state).toEqual(newSnapshotState);
      expect(onUpdateSpy).toHaveBeenCalledWith(newSnapshotState);
    });
  });

  describe('change()', () => {
    let mutator: (draft: TestDocShape) => void;
    let madeChange: Change;
    let stateAfterOpsAppliedToCurrentView: TestDocShape;
    let snapshotInDocBeforeCallChange: PatchesSnapshot<TestDocShape>;

    beforeEach(() => {
      snapshotInDocBeforeCallChange = createInitialSnapshot(initialDocState, 1, []);
      createStateFromSnapshotAlgorithmMock.mockReset();
      createStateFromSnapshotAlgorithmMock.mockReturnValueOnce(structuredClone(snapshotInDocBeforeCallChange.state));
      doc.import(snapshotInDocBeforeCallChange);
      expect(doc.committedRev).toBe(1);
      expect(doc.state).toEqual(initialDocState);

      mutator = (d: TestDocShape) => {
        d.text = 'new text';
      };
      const op: JSONPatchOp = { op: 'replace', path: '/text', value: 'new text' };
      madeChange = { id: 'c1', rev: 2, baseRev: 1, ops: [op], created: Date.now() };
      stateAfterOpsAppliedToCurrentView = { ...initialDocState, text: 'new text' };

      makeChangeAlgorithmMock.mockReturnValue([madeChange]);
      applyChangesAlgorithmMock.mockImplementation(
        (currentState: TestDocShape, changesMade: Change[]): TestDocShape => {
          if (changesMade[0]?.id === 'c1') return stateAfterOpsAppliedToCurrentView;
          return currentState;
        }
      );
    });

    it('should call makeChange, update internal state and snapshot, and emit events', () => {
      const initialLiveStateBeforeChange = doc.state;
      const onChangeSpy = vi.spyOn(doc.onChange, 'emit');
      const onUpdateSpy = vi.spyOn(doc.onUpdate, 'emit');

      const resultChanges = doc.change(mutator);

      expect(makeChangeAlgorithmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          state: snapshotInDocBeforeCallChange.state,
          rev: snapshotInDocBeforeCallChange.rev,
        }),
        mutator,
        initialMetadata,
        docOptions.maxPayloadBytes
      );
      expect(resultChanges).toEqual([madeChange]);

      const currentDocSnapshot = doc.export();
      expect(currentDocSnapshot.changes).toEqual([madeChange]);
      expect(currentDocSnapshot.rev).toBe(snapshotInDocBeforeCallChange.rev);
      expect(currentDocSnapshot.state).toEqual(snapshotInDocBeforeCallChange.state);

      expect(applyChangesAlgorithmMock).toHaveBeenCalledWith(initialLiveStateBeforeChange, [madeChange]);
      expect(doc.state).toEqual(stateAfterOpsAppliedToCurrentView);

      expect(onChangeSpy).toHaveBeenCalledWith([madeChange]);
      expect(onUpdateSpy).toHaveBeenCalledWith(stateAfterOpsAppliedToCurrentView);
    });
  });

  describe('applyCommittedChanges(serverChanges, rebasedPendingChanges)', () => {
    let initialSnapshotInDoc: PatchesSnapshot<TestDocShape>;
    let initialLiveStateOfDoc: TestDocShape;

    beforeEach(() => {
      initialSnapshotInDoc = {
        state: { text: 'initial committed base' },
        rev: 1,
        changes: [{ id: 'pendingOld', rev: 2, baseRev: 1, ops: [{ op: 'add', path: '/count', value: 0 }] } as Change],
      };
      initialLiveStateOfDoc = { text: 'initial committed base', count: 0 };

      createStateFromSnapshotAlgorithmMock.mockReset();
      createStateFromSnapshotAlgorithmMock.mockReturnValueOnce(initialLiveStateOfDoc);
      doc.import(initialSnapshotInDoc);
      expect(doc.state).toEqual(initialLiveStateOfDoc);
    });

    it('should update snapshot state, rev, and pending changes, then update live state via algorithms', () => {
      const serverChanges: Change[] = [
        {
          id: 'server2',
          rev: 2,
          baseRev: 1,
          ops: [{ op: 'replace', path: '/text', value: 'server update' }],
          created: Date.now(),
        },
      ];
      const rebasedPendingClientChanges: Change[] = [
        {
          id: 'pendingOld-rebased',
          rev: 3,
          baseRev: 2,
          ops: [{ op: 'add', path: '/count', value: 0 }],
          created: Date.now(),
        },
      ];

      const stateAfterServerOpsAppliedToSnapshotBase: TestDocShape = { text: 'server update' };
      const finalLiveStateFromNewSnapshot: TestDocShape = { text: 'server update', count: 0 };

      applyChangesAlgorithmMock.mockReset();
      applyChangesAlgorithmMock.mockImplementationOnce((s_1: TestDocShape, c_1: Change[]): TestDocShape => {
        expect(s_1).toEqual(initialSnapshotInDoc.state);
        expect(c_1).toEqual(serverChanges);
        return stateAfterServerOpsAppliedToSnapshotBase;
      });

      createStateFromSnapshotAlgorithmMock.mockReset();
      createStateFromSnapshotAlgorithmMock.mockImplementationOnce(
        (s_2: PatchesSnapshot<TestDocShape>): TestDocShape => {
          expect(s_2.state).toEqual(stateAfterServerOpsAppliedToSnapshotBase);
          expect(s_2.changes).toEqual(rebasedPendingClientChanges);
          return finalLiveStateFromNewSnapshot;
        }
      );

      const onUpdateSpy = vi.spyOn(doc.onUpdate, 'emit');

      doc.applyCommittedChanges(serverChanges, rebasedPendingClientChanges);

      const newSnapshot = doc.export();
      expect(applyChangesAlgorithmMock).toHaveBeenCalledTimes(1);
      expect(newSnapshot.state).toEqual(stateAfterServerOpsAppliedToSnapshotBase);
      expect(newSnapshot.rev).toBe(2);
      expect(newSnapshot.changes).toEqual(rebasedPendingClientChanges);

      expect(createStateFromSnapshotAlgorithmMock).toHaveBeenCalledTimes(1);
      expect(doc.state).toEqual(finalLiveStateFromNewSnapshot);
      expect(onUpdateSpy).toHaveBeenCalledWith(finalLiveStateFromNewSnapshot);
    });
  });

  describe('updateSyncing()', () => {
    it('should update syncing state and emit onSyncing signal', () => {
      const onSyncingSpy = vi.spyOn(doc.onSyncing, 'emit');
      const newSyncState: SyncingState = 'updating';
      doc.updateSyncing(newSyncState);
      expect(doc.syncing).toBe(newSyncState);
      expect(onSyncingSpy).toHaveBeenCalledWith(newSyncState);

      const errorState = new Error('Sync Error');
      doc.updateSyncing(errorState);
      expect(doc.syncing).toBe(errorState);
      expect(onSyncingSpy).toHaveBeenCalledWith(errorState);
    });
  });
});
