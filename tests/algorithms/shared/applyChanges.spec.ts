import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyChanges } from '../../../src/algorithms/shared/applyChanges';
import type { Change } from '../../../src/types';
import * as applyPatchModule from '../../../src/json-patch/applyPatch';

// Mock the dependencies
vi.mock('../../../src/json-patch/applyPatch');

describe('applyChanges', () => {
  const mockApplyPatch = vi.mocked(applyPatchModule.applyPatch);

  const createChange = (rev: number, ops: any[]): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev: rev - 1,
    ops,
    createdAt: new Date().toISOString(),
    committedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return original state when no changes', () => {
    const state = { text: 'hello', count: 0 };
    const changes: Change[] = [];

    const result = applyChanges(state, changes);

    expect(result).toBe(state);
    expect(mockApplyPatch).not.toHaveBeenCalled();
  });

  it('should apply single change to state', () => {
    const initialState = { text: 'hello', count: 0 };
    const finalState = { text: 'world', count: 0 };
    const changes = [createChange(1, [{ op: 'replace', path: '/text', value: 'world' }])];

    mockApplyPatch.mockReturnValue(finalState);

    const result = applyChanges(initialState, changes);

    expect(mockApplyPatch).toHaveBeenCalledWith(initialState, changes[0].ops, { strict: true });
    expect(result).toBe(finalState);
  });

  it('should apply multiple changes sequentially', () => {
    const state1 = { text: 'hello', count: 0 };
    const state2 = { text: 'world', count: 0 };
    const state3 = { text: 'world', count: 5 };

    const changes = [
      createChange(1, [{ op: 'replace', path: '/text', value: 'world' }]),
      createChange(2, [{ op: 'replace', path: '/count', value: 5 }]),
    ];

    mockApplyPatch.mockReturnValueOnce(state2).mockReturnValueOnce(state3);

    const result = applyChanges(state1, changes);

    expect(mockApplyPatch).toHaveBeenCalledTimes(2);
    expect(mockApplyPatch).toHaveBeenNthCalledWith(1, state1, changes[0].ops, { strict: true });
    expect(mockApplyPatch).toHaveBeenNthCalledWith(2, state2, changes[1].ops, { strict: true });
    expect(result).toBe(state3);
  });

  it('should handle null state', () => {
    const finalState = { text: 'hello' };
    const changes = [createChange(1, [{ op: 'add', path: '/text', value: 'hello' }])];

    mockApplyPatch.mockReturnValue(finalState);

    const result = applyChanges(null, changes);

    expect(mockApplyPatch).toHaveBeenCalledWith(null, changes[0].ops, { strict: true });
    expect(result).toBe(finalState);
  });

  it('should handle array state', () => {
    const initialState = [1, 2, 3];
    const finalState = [1, 2, 3, 4];
    const changes = [createChange(1, [{ op: 'add', path: '/3', value: 4 }])];

    mockApplyPatch.mockReturnValue(finalState);

    const result = applyChanges(initialState, changes);

    expect(mockApplyPatch).toHaveBeenCalledWith(initialState, changes[0].ops, { strict: true });
    expect(result).toBe(finalState);
  });

  it('should handle string state', () => {
    const initialState = 'hello';
    const finalState = 'world';
    const changes = [createChange(1, [{ op: 'replace', path: '', value: 'world' }])];

    mockApplyPatch.mockReturnValue(finalState);

    const result = applyChanges(initialState, changes);

    expect(mockApplyPatch).toHaveBeenCalledWith(initialState, changes[0].ops, { strict: true });
    expect(result).toBe(finalState);
  });

  it('should handle changes with multiple operations', () => {
    const initialState = { a: 1, b: 2 };
    const finalState = { a: 10, b: 20, c: 30 };
    const changes = [
      createChange(1, [
        { op: 'replace', path: '/a', value: 10 },
        { op: 'replace', path: '/b', value: 20 },
        { op: 'add', path: '/c', value: 30 },
      ]),
    ];

    mockApplyPatch.mockReturnValue(finalState);

    const result = applyChanges(initialState, changes);

    expect(mockApplyPatch).toHaveBeenCalledWith(initialState, changes[0].ops, { strict: true });
    expect(result).toBe(finalState);
  });

  it('should handle complex transformation sequence', () => {
    const state0 = { users: [], posts: [], settings: { theme: 'light' } };
    const state1 = { users: [{ id: 1, name: 'John' }], posts: [], settings: { theme: 'light' } };
    const state2 = {
      users: [{ id: 1, name: 'John' }],
      posts: [{ id: 1, title: 'Hello' }],
      settings: { theme: 'light' },
    };
    const state3 = {
      users: [{ id: 1, name: 'John' }],
      posts: [{ id: 1, title: 'Hello' }],
      settings: { theme: 'dark' },
    };

    const changes = [
      createChange(1, [{ op: 'add', path: '/users/0', value: { id: 1, name: 'John' } }]),
      createChange(2, [{ op: 'add', path: '/posts/0', value: { id: 1, title: 'Hello' } }]),
      createChange(3, [{ op: 'replace', path: '/settings/theme', value: 'dark' }]),
    ];

    mockApplyPatch.mockReturnValueOnce(state1).mockReturnValueOnce(state2).mockReturnValueOnce(state3);

    const result = applyChanges(state0, changes);

    expect(mockApplyPatch).toHaveBeenCalledTimes(3);
    expect(result).toBe(state3);
  });

  it('should pass through errors from applyPatch', () => {
    const initialState = { text: 'hello' };
    const changes = [createChange(1, [{ op: 'replace', path: '/invalid', value: 'world' }])];

    const error = new Error('Invalid path');
    mockApplyPatch.mockImplementation(() => {
      throw error;
    });

    expect(() => applyChanges(initialState, changes)).toThrow(error);
  });

  it('should use strict mode for all patches', () => {
    const initialState = { text: 'hello' };
    const changes = [
      createChange(1, [{ op: 'replace', path: '/text', value: 'world' }]),
      createChange(2, [{ op: 'add', path: '/count', value: 1 }]),
    ];

    mockApplyPatch.mockReturnValue(initialState);

    applyChanges(initialState, changes);

    expect(mockApplyPatch).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), { strict: true });
    expect(mockApplyPatch).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), { strict: true });
  });
});
