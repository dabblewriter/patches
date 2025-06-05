import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStateFromSnapshot } from '../../../src/algorithms/client/createStateFromSnapshot';
import type { PatchesSnapshot, Change } from '../../../src/types';
import * as applyChangesModule from '../../../src/algorithms/shared/applyChanges';

// Mock the dependencies
vi.mock('../../../src/algorithms/shared/applyChanges');

describe('createStateFromSnapshot', () => {
  const mockApplyChanges = vi.mocked(applyChangesModule.applyChanges);

  const createChange = (rev: number, ops: any[]): Change => ({
    id: `change-${rev}`,
    rev,
    baseRev: rev - 1,
    ops,
    created: Date.now(),
  });

  const createSnapshot = <T>(state: T, rev: number, changes: Change[] = []): PatchesSnapshot<T> => ({
    state,
    rev,
    changes,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return original state when no changes', () => {
    const baseState = { text: 'hello', count: 0 };
    const snapshot = createSnapshot(baseState, 5, []);

    mockApplyChanges.mockReturnValue(baseState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(baseState, []);
    expect(result).toBe(baseState);
  });

  it('should apply changes to state', () => {
    const baseState = { text: 'hello', count: 0 };
    const changes = [
      createChange(6, [{ op: 'replace', path: '/text', value: 'world' }]),
      createChange(7, [{ op: 'replace', path: '/count', value: 1 }]),
    ];
    const snapshot = createSnapshot(baseState, 5, changes);
    const expectedState = { text: 'world', count: 1 };

    mockApplyChanges.mockReturnValue(expectedState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(baseState, changes);
    expect(result).toBe(expectedState);
  });

  it('should handle null state', () => {
    const changes = [createChange(1, [{ op: 'add', path: '/text', value: 'hello' }])];
    const snapshot = createSnapshot(null, 0, changes);
    const expectedState = { text: 'hello' };

    mockApplyChanges.mockReturnValue(expectedState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(null, changes);
    expect(result).toBe(expectedState);
  });

  it('should handle empty state object', () => {
    const baseState = {};
    const changes = [
      createChange(1, [{ op: 'add', path: '/name', value: 'test' }]),
      createChange(2, [{ op: 'add', path: '/value', value: 42 }]),
    ];
    const snapshot = createSnapshot(baseState, 0, changes);
    const expectedState = { name: 'test', value: 42 };

    mockApplyChanges.mockReturnValue(expectedState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(baseState, changes);
    expect(result).toBe(expectedState);
  });

  it('should handle array state', () => {
    const baseState = [1, 2, 3];
    const changes = [
      createChange(1, [{ op: 'add', path: '/3', value: 4 }]),
      createChange(2, [{ op: 'replace', path: '/0', value: 0 }]),
    ];
    const snapshot = createSnapshot(baseState, 0, changes);
    const expectedState = [0, 2, 3, 4];

    mockApplyChanges.mockReturnValue(expectedState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(baseState, changes);
    expect(result).toBe(expectedState);
  });

  it('should handle string state', () => {
    const baseState = 'initial';
    const changes = [createChange(1, [{ op: 'replace', path: '', value: 'modified' }])];
    const snapshot = createSnapshot(baseState, 0, changes);
    const expectedState = 'modified';

    mockApplyChanges.mockReturnValue(expectedState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(baseState, changes);
    expect(result).toBe(expectedState);
  });

  it('should handle number state', () => {
    const baseState = 42;
    const changes = [createChange(1, [{ op: 'replace', path: '', value: 100 }])];
    const snapshot = createSnapshot(baseState, 0, changes);
    const expectedState = 100;

    mockApplyChanges.mockReturnValue(expectedState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(baseState, changes);
    expect(result).toBe(expectedState);
  });

  it('should handle complex nested state', () => {
    const baseState = {
      user: { name: 'John', age: 30 },
      items: [{ id: 1, name: 'Item 1' }],
      settings: { theme: 'light', notifications: true },
    };
    const changes = [
      createChange(1, [{ op: 'replace', path: '/user/age', value: 31 }]),
      createChange(2, [{ op: 'add', path: '/items/1', value: { id: 2, name: 'Item 2' } }]),
      createChange(3, [{ op: 'replace', path: '/settings/theme', value: 'dark' }]),
    ];
    const snapshot = createSnapshot(baseState, 0, changes);
    const expectedState = {
      user: { name: 'John', age: 31 },
      items: [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ],
      settings: { theme: 'dark', notifications: true },
    };

    mockApplyChanges.mockReturnValue(expectedState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(baseState, changes);
    expect(result).toBe(expectedState);
  });

  it('should handle single change', () => {
    const baseState = { counter: 0 };
    const changes = [createChange(1, [{ op: 'replace', path: '/counter', value: 5 }])];
    const snapshot = createSnapshot(baseState, 0, changes);
    const expectedState = { counter: 5 };

    mockApplyChanges.mockReturnValue(expectedState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(baseState, changes);
    expect(result).toBe(expectedState);
  });

  it('should handle changes with multiple operations', () => {
    const baseState = { a: 1, b: 2 };
    const changes = [
      createChange(1, [
        { op: 'replace', path: '/a', value: 10 },
        { op: 'replace', path: '/b', value: 20 },
        { op: 'add', path: '/c', value: 30 },
      ]),
    ];
    const snapshot = createSnapshot(baseState, 0, changes);
    const expectedState = { a: 10, b: 20, c: 30 };

    mockApplyChanges.mockReturnValue(expectedState);

    const result = createStateFromSnapshot(snapshot);

    expect(mockApplyChanges).toHaveBeenCalledWith(baseState, changes);
    expect(result).toBe(expectedState);
  });
});
