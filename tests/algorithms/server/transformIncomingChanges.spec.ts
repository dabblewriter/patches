import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transformIncomingChanges } from '../../../src/algorithms/server/transformIncomingChanges';
import { createChange } from '../../../src/data/change';
import * as transformPatchModule from '../../../src/json-patch/transformPatch';
import * as applyPatchModule from '../../../src/json-patch/applyPatch';

// Mock the dependencies
vi.mock('../../../src/json-patch/transformPatch');
vi.mock('../../../src/json-patch/applyPatch');

describe('transformIncomingChanges', () => {
  const mockTransformPatch = vi.mocked(transformPatchModule.transformPatch);
  const mockApplyPatch = vi.mocked(applyPatchModule.applyPatch);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should transform changes and assign sequential revision numbers', () => {
    const initialState = { text: 'hello', count: 0 };
    const state1 = { text: 'hello world', count: 0 };
    const state2 = { text: 'hello world', count: 5 };

    const incomingChanges = [
      createChange(2, 0, [{ op: 'replace', path: '/text', value: 'hello world' }]),
      createChange(2, 0, [{ op: 'replace', path: '/count', value: 5 }]),
    ];

    const committedChanges = [
      createChange(1, 3, [{ op: 'add', path: '/author', value: 'user1' }]),
    ];

    const transformedOps1 = [{ op: 'replace', path: '/text', value: 'hello world' }];
    const transformedOps2 = [{ op: 'replace', path: '/count', value: 5 }];

    mockTransformPatch
      .mockReturnValueOnce(transformedOps1)
      .mockReturnValueOnce(transformedOps2);

    mockApplyPatch
      .mockReturnValueOnce(state1)
      .mockReturnValueOnce(state2);

    const result = transformIncomingChanges(incomingChanges, initialState, committedChanges, 3);

    expect(result).toHaveLength(2);
    expect(result[0].rev).toBe(4);
    expect(result[1].rev).toBe(5);
    expect(result[0].ops).toEqual(transformedOps1);
    expect(result[1].ops).toEqual(transformedOps2);
    expect(result[0].id).toBe(incomingChanges[0].id);
    expect(result[1].id).toBe(incomingChanges[1].id);
  });

  it('should filter out obsolete changes (empty ops after transformation)', () => {
    const initialState = { text: 'hello' };
    const incomingChanges = [
      createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
      createChange(1, 0, [{ op: 'replace', path: '/count', value: 5 }]),
    ];

    const committedChanges = [
      createChange(0, 2, [{ op: 'replace', path: '/text', value: 'world' }]),
    ];

    // First change becomes obsolete (empty ops), second change is valid
    mockTransformPatch
      .mockReturnValueOnce([]) // Obsolete change
      .mockReturnValueOnce([{ op: 'replace', path: '/count', value: 5 }]);

    mockApplyPatch.mockReturnValue({ text: 'hello', count: 5 });

    const result = transformIncomingChanges(incomingChanges, initialState, committedChanges, 2);

    expect(result).toHaveLength(1);
    expect(result[0].rev).toBe(3);
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/count', value: 5 }]);
  });

  it('should filter out no-op changes (state unchanged after apply)', () => {
    const initialState = { text: 'hello', count: 0 };
    const incomingChanges = [
      createChange(1, 0, [{ op: 'replace', path: '/text', value: 'hello' }]), // No-op
      createChange(1, 0, [{ op: 'replace', path: '/count', value: 5 }]),
    ];

    const transformedOps = [{ op: 'replace', path: '/text', value: 'hello' }];
    mockTransformPatch
      .mockReturnValueOnce(transformedOps)
      .mockReturnValueOnce([{ op: 'replace', path: '/count', value: 5 }]);

    // First apply returns same state (no-op), second apply changes state
    mockApplyPatch
      .mockReturnValueOnce(initialState) // Same state = no-op
      .mockReturnValueOnce({ text: 'hello', count: 5 });

    const result = transformIncomingChanges(incomingChanges, initialState, [], 1);

    expect(result).toHaveLength(1);
    expect(result[0].rev).toBe(2);
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/count', value: 5 }]);
  });

  it('should handle apply errors gracefully', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const initialState = { text: 'hello' };
    const incomingChanges = [
      createChange(1, 0, [{ op: 'replace', path: '/invalid', value: 'test' }]),
      createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
    ];

    mockTransformPatch
      .mockReturnValueOnce([{ op: 'replace', path: '/invalid', value: 'test' }])
      .mockReturnValueOnce([{ op: 'replace', path: '/text', value: 'world' }]);

    const applyError = new Error('Invalid path');
    mockApplyPatch
      .mockImplementationOnce(() => { throw applyError; })
      .mockReturnValueOnce({ text: 'world' });

    const result = transformIncomingChanges(incomingChanges, initialState, [], 1);

    expect(result).toHaveLength(1);
    expect(result[0].rev).toBe(2);
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/text', value: 'world' }]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      `Error applying change ${incomingChanges[0].id} to state:`,
      applyError
    );

    consoleErrorSpy.mockRestore();
  });

  it('should handle empty incoming changes', () => {
    const result = transformIncomingChanges([], { text: 'hello' }, [], 1);
    expect(result).toEqual([]);
    expect(mockTransformPatch).not.toHaveBeenCalled();
    expect(mockApplyPatch).not.toHaveBeenCalled();
  });

  it('should handle empty committed changes', () => {
    const initialState = { text: 'hello' };
    const incomingChanges = [
      createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
    ];

    mockTransformPatch.mockReturnValue([{ op: 'replace', path: '/text', value: 'world' }]);
    mockApplyPatch.mockReturnValue({ text: 'world' });

    const result = transformIncomingChanges(incomingChanges, initialState, [], 1);

    expect(result).toHaveLength(1);
    expect(result[0].rev).toBe(2);
    expect(mockTransformPatch).toHaveBeenCalledWith(initialState, [], incomingChanges[0].ops);
  });

  it('should preserve change metadata during transformation', () => {
    const initialState = { text: 'hello' };
    const metadata = { author: 'user1', timestamp: 12345 };
    const incomingChanges = [
      { ...createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]), ...metadata },
    ];

    mockTransformPatch.mockReturnValue([{ op: 'replace', path: '/text', value: 'world' }]);
    mockApplyPatch.mockReturnValue({ text: 'world' });

    const result = transformIncomingChanges(incomingChanges, initialState, [], 1);

    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('user1');
    expect(result[0].timestamp).toBe(12345);
  });

  it('should not mutate original state parameter', () => {
    const originalState = { text: 'hello', count: 0 };
    const stateAtBaseRev = { ...originalState };
    const incomingChanges = [
      createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
    ];

    mockTransformPatch.mockReturnValue([{ op: 'replace', path: '/text', value: 'world' }]);
    mockApplyPatch.mockReturnValue({ text: 'world', count: 0 });

    transformIncomingChanges(incomingChanges, stateAtBaseRev, [], 1);

    // Original state should remain unchanged
    expect(stateAtBaseRev).toEqual(originalState);
  });

  it('should flatten committed changes ops correctly', () => {
    const initialState = { text: 'hello' };
    const incomingChanges = [
      createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
    ];

    const committedChanges = [
      createChange(0, 2, [{ op: 'add', path: '/author', value: 'user1' }]),
      createChange(1, 3, [{ op: 'replace', path: '/count', value: 5 }, { op: 'add', path: '/tags', value: [] }]),
    ];

    const expectedCommittedOps = [
      { op: 'add', path: '/author', value: 'user1' },
      { op: 'replace', path: '/count', value: 5 },
      { op: 'add', path: '/tags', value: [] },
    ];

    mockTransformPatch.mockReturnValue([{ op: 'replace', path: '/text', value: 'world' }]);
    mockApplyPatch.mockReturnValue({ text: 'world' });

    transformIncomingChanges(incomingChanges, initialState, committedChanges, 3);

    expect(mockTransformPatch).toHaveBeenCalledWith(
      initialState,
      expectedCommittedOps,
      incomingChanges[0].ops
    );
  });
});