import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyChanges,
  applyChangesForReconstruction,
  ApplyChangesError,
  type SkippedChange,
} from '../../../../src/algorithms/ot/shared/applyChanges';
import type { Change } from '../../../../src/types';
import * as applyPatchModule from '../../../../src/json-patch/applyPatch';

// Mock the dependencies
vi.mock('../../../../src/json-patch/applyPatch');

describe('applyChanges', () => {
  const mockApplyPatch = vi.mocked(applyPatchModule.applyPatch);

  const createChange = (rev: number, ops: any[]): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev: rev - 1,
    ops,
    createdAt: Date.now(),
    committedAt: Date.now(),
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

  it('should throw ApplyChangesError for a bad change instead of silently skipping it', () => {
    // A skipped change would silently diverge this client from every other client
    // that applied it — the error must propagate so callers can recover or surface it.
    const initialState = { text: 'hello' };
    const changes = [createChange(1, [{ op: 'replace', path: '/invalid', value: 'world' }])];

    const error = new Error('Invalid path');
    mockApplyPatch.mockImplementation(() => {
      throw error;
    });

    expect(() => applyChanges(initialState, changes)).toThrow(ApplyChangesError);
  });

  it('should identify the failing change (id, rev, index) and wrap the cause', () => {
    const state1 = { text: 'hello' };
    const state2 = { text: 'world' };
    const changes = [
      createChange(1, [{ op: 'replace', path: '/text', value: 'world' }]),
      createChange(2, [{ op: 'replace', path: '/missing', value: true }]),
    ];

    const patchError = new Error('Invalid path');
    mockApplyPatch.mockReturnValueOnce(state2).mockImplementationOnce(() => {
      throw patchError;
    });

    try {
      applyChanges(state1, changes);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplyChangesError);
      const applyErr = err as ApplyChangesError;
      expect(applyErr.changeId).toBe('change-2');
      expect(applyErr.rev).toBe(2);
      expect(applyErr.index).toBe(1);
      expect(applyErr.cause).toBe(patchError);
      expect(applyErr.message).toContain('change-2');
      expect(applyErr.message).toContain('rev 2');
      expect(applyErr.message).toContain('Invalid path');
    }
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

describe('applyChangesForReconstruction', () => {
  const mockApplyPatch = vi.mocked(applyPatchModule.applyPatch);

  const createChange = (rev: number, ops: any[]): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev: rev - 1,
    ops,
    createdAt: Date.now(),
    committedAt: Date.now(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return original state when no changes', () => {
    const state = { text: 'hello' };

    expect(applyChangesForReconstruction(state, [])).toBe(state);
    expect(mockApplyPatch).not.toHaveBeenCalled();
  });

  it('should apply changes strictly when none fail (identical result to applyChanges)', () => {
    const state1 = { text: 'hello' };
    const state2 = { text: 'world' };
    const changes = [createChange(1, [{ op: 'replace', path: '/text', value: 'world' }])];

    mockApplyPatch.mockReturnValue(state2);
    const onSkippedChange = vi.fn();

    const result = applyChangesForReconstruction(state1, changes, { onSkippedChange });

    expect(mockApplyPatch).toHaveBeenCalledWith(state1, changes[0].ops, { strict: true });
    expect(result).toBe(state2);
    expect(onSkippedChange).not.toHaveBeenCalled();
  });

  it('should skip exactly the failing change and continue with the rest', () => {
    const state1 = { v: 1 };
    const state2 = { v: 2 };
    const state3 = { v: 3 };
    const changes = [
      createChange(1, [{ op: 'replace', path: '/v', value: 2 }]),
      createChange(2, [{ op: 'add', path: '/docs/5wPI/children/18', value: 'x' }]), // invalid array index
      createChange(3, [{ op: 'replace', path: '/v', value: 3 }]),
    ];

    const patchError = new TypeError('[op:add] invalid array index: /docs/5wPI/children/18');
    mockApplyPatch
      .mockReturnValueOnce(state2)
      .mockImplementationOnce(() => {
        throw patchError;
      })
      .mockReturnValueOnce(state3);

    const onSkippedChange = vi.fn();
    const result = applyChangesForReconstruction(state1, changes, { onSkippedChange });

    // The change AFTER the bad one is applied to the state from BEFORE the bad one
    expect(mockApplyPatch).toHaveBeenNthCalledWith(3, state2, changes[2].ops, { strict: true });
    expect(result).toBe(state3);
  });

  it('should call onSkippedChange exactly once per skipped change with full context', () => {
    const state = { v: 1 };
    const changes = [
      createChange(1, [{ op: 'replace', path: '/v', value: 2 }]),
      createChange(2, [{ op: 'add', path: '/docs/trash/children/78', value: 'x' }]),
      createChange(3, [{ op: 'replace', path: '/v', value: 3 }]),
    ];

    const patchError = new TypeError('[op:add] invalid array index: /docs/trash/children/78');
    mockApplyPatch
      .mockReturnValueOnce(state)
      .mockImplementationOnce(() => {
        throw patchError;
      })
      .mockReturnValueOnce(state);

    const skipped: SkippedChange[] = [];
    applyChangesForReconstruction(state, changes, { onSkippedChange: s => skipped.push(s) });

    expect(skipped).toHaveLength(1);
    expect(skipped[0].change).toBe(changes[1]);
    expect(skipped[0].change.id).toBe('change-2');
    expect(skipped[0].index).toBe(1);
    expect(skipped[0].error).toBe(patchError);
  });

  it('should log to console.error by default when no onSkippedChange is provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { v: 1 };
    const changes = [createChange(1, [{ op: 'add', path: '/list/9', value: 'x' }])];

    const patchError = new TypeError('[op:add] invalid array index: /list/9');
    mockApplyPatch.mockImplementation(() => {
      throw patchError;
    });

    const result = applyChangesForReconstruction(state, changes);

    expect(result).toBe(state);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('change-1'), patchError);
    consoleSpy.mockRestore();
  });

  it('never throws ApplyChangesError even when every change fails', () => {
    const state = { v: 1 };
    const changes = [
      createChange(1, [{ op: 'add', path: '/list/9', value: 'x' }]),
      createChange(2, [{ op: 'add', path: '/list/10', value: 'y' }]),
    ];

    mockApplyPatch.mockImplementation(() => {
      throw new TypeError('invalid');
    });

    const onSkippedChange = vi.fn();
    const result = applyChangesForReconstruction(state, changes, { onSkippedChange });

    expect(result).toBe(state);
    expect(onSkippedChange).toHaveBeenCalledTimes(2);
  });

  it('PIN: strict applyChanges still throws for the same batch (live paths must not be lenient)', () => {
    const state = { v: 1 };
    const changes = [createChange(1, [{ op: 'add', path: '/list/9', value: 'x' }])];

    mockApplyPatch.mockImplementation(() => {
      throw new TypeError('[op:add] invalid array index: /list/9');
    });

    expect(() => applyChanges(state, changes)).toThrow(ApplyChangesError);
  });
});
