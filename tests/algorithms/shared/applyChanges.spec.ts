import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChanges } from '../../../src/algorithms/shared/applyChanges.js';
import * as applyPatchModule from '../../../src/json-patch/applyPatch.js';
import type { JSONPatchOp } from '../../../src/json-patch/types.js';
import type { Change } from '../../../src/types.js';

// Mock the applyPatch utility
vi.mock('../../../src/json-patch/applyPatch.js', () => ({
  applyPatch: vi.fn(),
}));

const mockApplyPatch = vi.mocked(applyPatchModule.applyPatch);

describe('applyChanges Algorithm', () => {
  beforeEach(() => {
    mockApplyPatch.mockReset();
  });

  it('should apply a sequence of changes to a state object', () => {
    const initialState = { count: 0, items: [] as string[] };
    const changes: Change[] = [
      {
        id: 'c1',
        ops: [{ op: 'add', path: '/count', value: 1 } as JSONPatchOp],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
      },
      {
        id: 'c2',
        ops: [{ op: 'add', path: '/items/-', value: 'apple' } as JSONPatchOp],
        rev: 2,
        baseRev: 1,
        created: Date.now(),
      },
    ];

    // Mock applyPatch to return a new state after each call
    let callCount = 0;
    mockApplyPatch.mockImplementation((state: any, ops: JSONPatchOp[]) => {
      callCount++;
      if (callCount === 1) {
        expect(ops).toEqual(changes[0].ops);
        return { ...state, count: 1 };
      }
      if (callCount === 2) {
        expect(ops).toEqual(changes[1].ops);
        return { ...state, items: ['apple'] };
      }
      return state; // Should not happen
    });

    const finalState = applyChanges(initialState, changes);

    expect(mockApplyPatch).toHaveBeenCalledTimes(2);
    expect(mockApplyPatch).toHaveBeenNthCalledWith(1, initialState, changes[0].ops, { strict: true });
    expect(mockApplyPatch).toHaveBeenNthCalledWith(2, { count: 1, items: [] }, changes[1].ops, { strict: true });
    expect(finalState).toEqual({ count: 1, items: ['apple'] });
  });

  it('should return the original state if no changes are provided', () => {
    const initialState = { message: 'hello' };
    const changes: Change[] = [];

    const finalState = applyChanges(initialState, changes);

    expect(finalState).toBe(initialState); // Should be the same object reference
    expect(mockApplyPatch).not.toHaveBeenCalled();
  });

  it('should pass strict: true to applyPatch', () => {
    const initialState = {};
    const change: Change = { id: 'c1', ops: [], rev: 1, baseRev: 0, created: Date.now() };
    mockApplyPatch.mockReturnValue({});

    applyChanges(initialState, [change]);
    expect(mockApplyPatch).toHaveBeenCalledWith(initialState, [], { strict: true });
  });
});
