import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommittedChanges } from '../../../src/algorithms/client/applyCommittedChanges.js';
import type { Change, PatchesSnapshot } from '../../../src/types.js';
// Import the actual modules to get their types for vi.mocked
import * as ActualApplyChangesModule from '../../../src/algorithms/shared/applyChanges.js';
import * as ActualRebaseChangesModule from '../../../src/algorithms/shared/rebaseChanges.js';

// Mock shared algorithms
vi.mock('../../../src/algorithms/shared/applyChanges.js', () => ({ applyChanges: vi.fn() }));
vi.mock('../../../src/algorithms/shared/rebaseChanges.js', () => ({ rebaseChanges: vi.fn() }));

// Import the mocked versions
import { applyChanges } from '../../../src/algorithms/shared/applyChanges.js';
import { rebaseChanges } from '../../../src/algorithms/shared/rebaseChanges.js';

const mockApplyChanges = applyChanges as vi.MockedFunction<typeof ActualApplyChangesModule.applyChanges>;
const mockRebaseChanges = rebaseChanges as vi.MockedFunction<typeof ActualRebaseChangesModule.rebaseChanges>;

describe('applyCommittedChanges Algorithm', () => {
  beforeEach(() => {
    mockApplyChanges.mockReset();
    mockRebaseChanges.mockReset();
  });

  const createDummyChange = (id: string, rev: number, baseRev: number, ops: any[] = []): Change => ({
    id,
    ops,
    rev,
    baseRev,
    created: Date.now(),
  });

  it('should apply server changes and rebase pending changes', () => {
    const initialSnapshot: PatchesSnapshot<any> = {
      state: { data: 'initial' },
      rev: 10,
      changes: [createDummyChange('pending1', 11, 10, [{ op: 'add', path: '/pending', value: 'p_val' }])],
    };
    // Server changes that are NEWER than snapshot.rev
    const serverChangesFromServer: Change[] = [
      createDummyChange('server11', 11, 10, [{ op: 'add', path: '/server', value: 's_val11' }]),
      createDummyChange('server12', 12, 11, [{ op: 'add', path: '/server', value: 's_val12' }]),
    ];
    const expectedNewServerChangesToProcess = serverChangesFromServer; // Both are new based on initialSnapshot.rev = 10

    const rebasedPendingChange = { ...initialSnapshot.changes[0], rev: 13, baseRev: 12, id: 'rebased-pending1' };
    const finalCommittedState = { data: 'server-updated' };

    mockApplyChanges.mockReturnValue(finalCommittedState);
    mockRebaseChanges.mockReturnValue([rebasedPendingChange]);

    const result = applyCommittedChanges(initialSnapshot, serverChangesFromServer);

    expect(mockApplyChanges).toHaveBeenCalledWith(initialSnapshot.state, expectedNewServerChangesToProcess);
    expect(mockRebaseChanges).toHaveBeenCalledWith(expectedNewServerChangesToProcess, initialSnapshot.changes);
    expect(result.state).toEqual(finalCommittedState);
    expect(result.rev).toBe(12); // Last server change rev
    expect(result.changes).toEqual([rebasedPendingChange]);
  });

  it('should return original snapshot if all serverChanges are old or already applied', () => {
    const initialSnapshot: PatchesSnapshot<any> = {
      state: { data: 'no-change' },
      rev: 10,
      changes: [createDummyChange('pending1', 11, 10)],
    };
    // All server changes have rev <= initialSnapshot.rev
    const serverChangesFromServer: Change[] = [
      createDummyChange('server9', 9, 8),
      createDummyChange('server10', 10, 9),
    ];

    const result = applyCommittedChanges(initialSnapshot, serverChangesFromServer);

    expect(result.state).toEqual(initialSnapshot.state);
    expect(result.rev).toEqual(initialSnapshot.rev);
    expect(result.changes).toEqual(initialSnapshot.changes);
    expect(mockApplyChanges).not.toHaveBeenCalled();
    expect(mockRebaseChanges).not.toHaveBeenCalled();
  });

  it('should throw an error if new server changes are not sequential to current revision', () => {
    const initialSnapshot: PatchesSnapshot<any> = { state: { data: 'initial' }, rev: 10, changes: [] };
    const serverChangesFromServer: Change[] = [createDummyChange('server12', 12, 11)];

    expect(() => applyCommittedChanges(initialSnapshot, serverChangesFromServer)).toThrow(
      'Missing changes from the server. Expected rev 11, got 12. Request changes since 10.'
    );
  });

  it('should handle no pending changes correctly', () => {
    const initialSnapshot: PatchesSnapshot<any> = { state: { data: 'clean' }, rev: 20, changes: [] }; // No pending changes
    const serverChangesFromServer: Change[] = [createDummyChange('server21', 21, 20)];
    const finalCommittedState = { data: 'server-updated-clean' };

    mockApplyChanges.mockReturnValue(finalCommittedState);
    // rebaseChanges should not be called if there are no pending changes

    const result = applyCommittedChanges(initialSnapshot, serverChangesFromServer);
    const expectedNewServerChangesToProcess = serverChangesFromServer; // These are all new

    expect(mockApplyChanges).toHaveBeenCalledWith(initialSnapshot.state, expectedNewServerChangesToProcess);
    expect(mockRebaseChanges).not.toHaveBeenCalled(); // Corrected expectation
    expect(result.state).toEqual(finalCommittedState);
    expect(result.rev).toBe(21);
    expect(result.changes).toEqual([]); // Still empty as no pending to rebase
  });

  it('should correctly filter and apply only genuinely new server changes', () => {
    const initialSnapshot: PatchesSnapshot<any> = {
      state: { data: 'initial' },
      rev: 11,
      changes: [createDummyChange('pending1', 12, 11)],
    };
    const serverChangesFromServer: Change[] = [
      createDummyChange('server10', 10, 9),
      createDummyChange('server11', 11, 10),
      createDummyChange('server12', 12, 11),
      createDummyChange('server13', 13, 12),
    ];
    const expectedNewServerChangesToProcess = [serverChangesFromServer[2], serverChangesFromServer[3]];
    const rebasedPending = [{ ...initialSnapshot.changes[0], rev: 14, baseRev: 13, id: 'rebased-pending' }];
    const finalState = { data: 'final-state-after-12-13' };

    mockApplyChanges.mockReturnValue(finalState);
    mockRebaseChanges.mockReturnValue(rebasedPending);

    const result = applyCommittedChanges(initialSnapshot, serverChangesFromServer);

    expect(mockApplyChanges).toHaveBeenCalledWith(initialSnapshot.state, expectedNewServerChangesToProcess);
    expect(mockRebaseChanges).toHaveBeenCalledWith(expectedNewServerChangesToProcess, initialSnapshot.changes);
    expect(result.state).toEqual(finalState);
    expect(result.rev).toBe(13);
    expect(result.changes).toEqual(rebasedPending);
  });
});
