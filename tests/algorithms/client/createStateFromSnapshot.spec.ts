import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStateFromSnapshot } from '../../../src/algorithms/client/createStateFromSnapshot.js';
import type { Change, PatchesSnapshot } from '../../../src/types.js';

// Mock the applyChanges algorithm
vi.mock('../../../src/algorithms/shared/applyChanges.js', () => ({
  applyChanges: vi.fn(),
}));

// Get a reference to the mocked function after it has been mocked
import { applyChanges } from '../../../src/algorithms/shared/applyChanges.js';
const mockApplyChanges = vi.mocked(applyChanges);

describe('createStateFromSnapshot', () => {
  beforeEach(() => {
    mockApplyChanges.mockClear();
  });

  it('should call applyChanges with snapshot state and changes', () => {
    const mockInitialState = { title: 'Initial' };
    const mockPendingChanges: Change[] = [
      { id: 'c1', ops: [{ op: 'add', path: '/text', value: 'Hello' }], rev: 1, baseRev: 0, created: Date.now() },
    ];
    const snapshot: PatchesSnapshot<any> = {
      state: mockInitialState,
      rev: 0,
      changes: mockPendingChanges,
    };

    const expectedFinalState = { title: 'Initial', text: 'Hello' };
    mockApplyChanges.mockReturnValue(expectedFinalState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledTimes(1);
    expect(mockApplyChanges).toHaveBeenCalledWith(mockInitialState, mockPendingChanges);
    expect(result).toBe(expectedFinalState);
  });

  it('should handle snapshot with no pending changes', () => {
    const mockInitialState = { count: 10 };
    const snapshot: PatchesSnapshot<any> = {
      state: mockInitialState,
      rev: 5,
      changes: [], // No pending changes
    };

    // If no changes, applyChanges should return the initial state itself
    mockApplyChanges.mockImplementation((state: any, _changes: Change[]) => state);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledTimes(1);
    expect(mockApplyChanges).toHaveBeenCalledWith(mockInitialState, []);
    expect(result).toBe(mockInitialState);
  });

  it('should handle snapshot with null initial state and pending changes', () => {
    const mockPendingChanges: Change[] = [
      { id: 'c1', ops: [{ op: 'add', path: '/message', value: 'Exists' }], rev: 1, baseRev: 0, created: Date.now() },
    ];
    const snapshot: PatchesSnapshot<any> = {
      state: null as any, // Initial state could be null for a new doc
      rev: 0,
      changes: mockPendingChanges,
    };

    const expectedFinalState = { message: 'Exists' };
    mockApplyChanges.mockReturnValue(expectedFinalState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledTimes(1);
    expect(mockApplyChanges).toHaveBeenCalledWith(null, mockPendingChanges);
    expect(result).toBe(expectedFinalState);
  });
});
