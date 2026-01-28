import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeChange } from '../../../src/algorithms/client/makeChange';
import { JSONPatch } from '../../../src/json-patch/JSONPatch';
import type { Change, PatchesSnapshot } from '../../../src/types';

// Mock the dependencies
vi.mock('../../../src/algorithms/client/createStateFromSnapshot');
vi.mock('../../../src/json-patch/createJSONPatch');
vi.mock('../../../src/data/change');
vi.mock('../../../src/algorithms/shared/changeBatching');

describe('makeChange', () => {
  const createSnapshot = <T>(state: T, rev: number, changes: Change[] = []): PatchesSnapshot<T> => ({
    state,
    rev,
    changes,
  });

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

  it('should create a change when mutator produces operations', async () => {
    const { createStateFromSnapshot } = await import('../../../src/algorithms/client/createStateFromSnapshot');
    const { createJSONPatch } = await import('../../../src/json-patch/createJSONPatch');
    const { createChange: createChangeFunc } = await import('../../../src/data/change');

    const mockCreateStateFromSnapshot = vi.mocked(createStateFromSnapshot);
    const mockCreateJSONPatch = vi.mocked(createJSONPatch);
    const mockCreateChange = vi.mocked(createChangeFunc);

    const snapshot = createSnapshot({ text: 'hello' }, 5, []);
    const mockPatch = new JSONPatch([{ op: 'replace', path: '/text', value: 'world' }]);
    vi.spyOn(mockPatch, 'apply').mockImplementation(vi.fn());

    mockCreateStateFromSnapshot.mockReturnValue({ text: 'hello' });
    mockCreateJSONPatch.mockReturnValue(mockPatch);
    mockCreateChange.mockReturnValue(createChange(6, mockPatch.ops));

    const mutator = vi.fn((patch, path) => {
      patch.replace(path.text, 'world');
    });

    const result = makeChange(snapshot, mutator);

    expect(mockCreateStateFromSnapshot).toHaveBeenCalledWith(snapshot);
    expect(mockCreateJSONPatch).toHaveBeenCalledWith(mutator);
    expect(mockPatch.apply).toHaveBeenCalledWith({ text: 'hello' });
    expect(result).toHaveLength(1);
    expect(result[0].ops).toEqual(mockPatch.ops);
  });

  it('should return empty array when no operations produced', async () => {
    const { createStateFromSnapshot } = await import('../../../src/algorithms/client/createStateFromSnapshot');
    const { createJSONPatch } = await import('../../../src/json-patch/createJSONPatch');

    const mockCreateStateFromSnapshot = vi.mocked(createStateFromSnapshot);
    const mockCreateJSONPatch = vi.mocked(createJSONPatch);

    const snapshot = createSnapshot({ text: 'hello' }, 5, []);
    const mockPatch = new JSONPatch([]);
    vi.spyOn(mockPatch, 'apply').mockImplementation(vi.fn());

    mockCreateStateFromSnapshot.mockReturnValue({ text: 'hello' });
    mockCreateJSONPatch.mockReturnValue(mockPatch);

    const mutator = vi.fn();
    const result = makeChange(snapshot, mutator);

    expect(result).toEqual([]);
  });

  it('should break change when maxStorageBytes is specified', async () => {
    const { createStateFromSnapshot } = await import('../../../src/algorithms/client/createStateFromSnapshot');
    const { createJSONPatch } = await import('../../../src/json-patch/createJSONPatch');
    const { createChange: createChangeFunc } = await import('../../../src/data/change');
    const { breakChanges } = await import('../../../src/algorithms/shared/changeBatching');

    const mockCreateStateFromSnapshot = vi.mocked(createStateFromSnapshot);
    const mockCreateJSONPatch = vi.mocked(createJSONPatch);
    const mockCreateChange = vi.mocked(createChangeFunc);
    const mockBreakChanges = vi.mocked(breakChanges);

    const snapshot = createSnapshot({ text: 'hello' }, 5, []);
    const mockPatch = new JSONPatch([{ op: 'replace', path: '/text', value: 'world' }]);
    vi.spyOn(mockPatch, 'apply').mockImplementation(vi.fn());

    const originalChange = createChange(6, mockPatch.ops);
    const brokenChanges = [
      createChange(6, [{ op: 'replace', path: '/text', value: 'wor' }]),
      createChange(7, [{ op: 'replace', path: '/text', value: 'ld' }]),
    ];

    mockCreateStateFromSnapshot.mockReturnValue({ text: 'hello' });
    mockCreateJSONPatch.mockReturnValue(mockPatch);
    mockCreateChange.mockReturnValue(originalChange);
    mockBreakChanges.mockReturnValue(brokenChanges);

    const mutator = vi.fn();
    const result = makeChange(
      snapshot,
      mutator,
      {},
      100,
      vi.fn(() => 50)
    );

    expect(mockBreakChanges).toHaveBeenCalledWith([originalChange], 100, expect.any(Function));
    expect(result).toBe(brokenChanges);
  });

  it('should handle pending changes in revision calculation', async () => {
    const { createStateFromSnapshot } = await import('../../../src/algorithms/client/createStateFromSnapshot');
    const { createJSONPatch } = await import('../../../src/json-patch/createJSONPatch');
    const { createChange: createChangeFunc } = await import('../../../src/data/change');

    const mockCreateStateFromSnapshot = vi.mocked(createStateFromSnapshot);
    const mockCreateJSONPatch = vi.mocked(createJSONPatch);
    const mockCreateChange = vi.mocked(createChangeFunc);

    const pendingChanges = [createChange(6, []), createChange(7, [])];
    const snapshot = createSnapshot({ text: 'hello' }, 5, pendingChanges);
    const mockPatch = new JSONPatch([{ op: 'add', path: '/count', value: 1 }]);
    vi.spyOn(mockPatch, 'apply').mockImplementation(vi.fn());

    mockCreateStateFromSnapshot.mockReturnValue({ text: 'hello', count: 0 });
    mockCreateJSONPatch.mockReturnValue(mockPatch);
    mockCreateChange.mockReturnValue(createChange(8, mockPatch.ops));

    const mutator = vi.fn();
    const result = makeChange(snapshot, mutator);

    // Should use revision after pending changes (7 + 1 = 8)
    expect(mockCreateChange).toHaveBeenCalledWith(5, 8, mockPatch.ops, undefined);
    expect(result).toHaveLength(1);
  });

  it('should pass change metadata to createChange', async () => {
    const { createStateFromSnapshot } = await import('../../../src/algorithms/client/createStateFromSnapshot');
    const { createJSONPatch } = await import('../../../src/json-patch/createJSONPatch');
    const { createChange: createChangeFunc } = await import('../../../src/data/change');

    const mockCreateStateFromSnapshot = vi.mocked(createStateFromSnapshot);
    const mockCreateJSONPatch = vi.mocked(createJSONPatch);
    const mockCreateChange = vi.mocked(createChangeFunc);

    const snapshot = createSnapshot({ text: 'hello' }, 5, []);
    const mockPatch = new JSONPatch([{ op: 'replace', path: '/text', value: 'world' }]);
    vi.spyOn(mockPatch, 'apply').mockImplementation(vi.fn());

    const metadata = { author: 'user123', source: 'ui' };

    mockCreateStateFromSnapshot.mockReturnValue({ text: 'hello' });
    mockCreateJSONPatch.mockReturnValue(mockPatch);
    mockCreateChange.mockReturnValue(createChange(6, mockPatch.ops));

    const mutator = vi.fn();
    const result = makeChange(snapshot, mutator, metadata);

    expect(mockCreateChange).toHaveBeenCalledWith(5, 6, mockPatch.ops, metadata);
    expect(result).toHaveLength(1);
  });

  it('should throw error when patch application fails', async () => {
    const { createStateFromSnapshot } = await import('../../../src/algorithms/client/createStateFromSnapshot');
    const { createJSONPatch } = await import('../../../src/json-patch/createJSONPatch');

    const mockCreateStateFromSnapshot = vi.mocked(createStateFromSnapshot);
    const mockCreateJSONPatch = vi.mocked(createJSONPatch);

    const snapshot = createSnapshot({ text: 'hello' }, 5, []);
    const mockPatch = new JSONPatch([{ op: 'replace', path: '/invalid', value: 'world' }]);
    vi.spyOn(mockPatch, 'apply').mockImplementation(() => {
      throw new Error('Invalid path');
    });

    mockCreateStateFromSnapshot.mockReturnValue({ text: 'hello' });
    mockCreateJSONPatch.mockReturnValue(mockPatch);

    const mutator = vi.fn();

    expect(() => makeChange(snapshot, mutator)).toThrow(
      'Failed to apply change to state during makeChange: Error: Invalid path'
    );
  });
});
