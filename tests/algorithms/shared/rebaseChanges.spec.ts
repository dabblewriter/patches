import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rebaseChanges } from '../../../src/algorithms/shared/rebaseChanges.js';
import type { JSONPatchOp } from '../../../src/json-patch/types.js';
import type { Change } from '../../../src/types.js';

const mockTransformOps = vi.fn();
vi.mock('../../../src/json-patch/JSONPatch.js', () => ({
  JSONPatch: vi.fn().mockImplementation((ops: JSONPatchOp[]) => ({
    ops: ops,
    transform: mockTransformOps,
  })),
}));

// Import the mocked constructor after defining the mock
import { JSONPatch as MockedJSONPatch } from '../../../src/json-patch/JSONPatch.js';
const MockedJSONPatchConstructor = vi.mocked(MockedJSONPatch);

describe('rebaseChanges Algorithm', () => {
  beforeEach(() => {
    mockTransformOps.mockReset();
    MockedJSONPatchConstructor.mockClear();
  });

  const createDummyChange = (id: string, rev: number, baseRev: number, ops: JSONPatchOp[]): Change => ({
    id,
    rev,
    baseRev,
    ops,
    created: Date.now(),
  });

  it('should return localChanges if serverChanges is empty', () => {
    const local = [createDummyChange('local1', 2, 1, [{ op: 'add', path: '/foo', value: 'bar' }])];
    const result = rebaseChanges([], local);
    expect(result).toEqual(local);
    expect(MockedJSONPatchConstructor).not.toHaveBeenCalled();
  });

  it('should return localChanges (empty) if localChanges is empty', () => {
    const server = [createDummyChange('server1', 2, 1, [{ op: 'add', path: '/foo', value: 'bar' }])];
    const result = rebaseChanges(server, []);
    expect(result).toEqual([]);
    expect(MockedJSONPatchConstructor).not.toHaveBeenCalled();
  });

  it('should filter out local changes already present in server changes by id', () => {
    const commonOp = [{ op: 'add', path: '/common', value: 1 }];
    const server = [createDummyChange('s1', 2, 1, commonOp)];
    const local = [
      createDummyChange('s1', 2, 1, commonOp),
      createDummyChange('l1', 3, 1, [{ op: 'add', path: '/localOnly', value: 2 }]),
    ];
    mockTransformOps.mockReturnValue({ ops: [{ op: 'add', path: '/localOnly', value: 'transformed' }] });

    const result = rebaseChanges(server, local);

    expect(MockedJSONPatchConstructor).toHaveBeenCalledOnce();
    expect(mockTransformOps).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('l1');
    expect(result[0].ops).toEqual([{ op: 'add', path: '/localOnly', value: 'transformed' }]);
  });

  it('should transform remaining local changes and update their rev/baseRev', () => {
    const server = [createDummyChange('s1', 11, 10, [{ op: 'replace', path: '/a', value: 0 }])];
    const local = [
      createDummyChange('l1', 11, 10, [{ op: 'add', path: '/b', value: 1 }]),
      createDummyChange('l2', 12, 10, [{ op: 'add', path: '/c', value: 2 }]),
    ];

    const transformedOps1 = [{ op: 'add', path: '/b_transformed', value: 1 }];
    const transformedOps2 = [{ op: 'add', path: '/c_transformed', value: 2 }];

    mockTransformOps.mockReturnValueOnce({ ops: transformedOps1 }).mockReturnValueOnce({ ops: transformedOps2 });

    const result = rebaseChanges(server, local);

    expect(MockedJSONPatchConstructor).toHaveBeenCalledOnce();
    expect(MockedJSONPatchConstructor.mock.calls[0][0]).toEqual(server[0].ops);
    expect(mockTransformOps).toHaveBeenCalledTimes(2);
    expect(mockTransformOps).toHaveBeenNthCalledWith(1, local[0].ops);
    expect(mockTransformOps).toHaveBeenNthCalledWith(2, local[1].ops);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('l1');
    expect(result[0].ops).toEqual(transformedOps1);
    expect(result[0].baseRev).toBe(server[0].rev);
    expect(result[0].rev).toBe(server[0].rev + 1);

    expect(result[1].id).toBe('l2');
    expect(result[1].ops).toEqual(transformedOps2);
    expect(result[1].baseRev).toBe(server[0].rev);
    expect(result[1].rev).toBe(server[0].rev + 2);
  });

  it('should return empty if all local changes are filtered or their ops become empty after transform', () => {
    const server = [createDummyChange('s1', 2, 1, [{ op: 'add', path: '/a', value: 1 }])];
    const local = [createDummyChange('l1', 3, 1, [{ op: 'add', path: '/b', value: 2 }])];

    mockTransformOps.mockReturnValue({ ops: [] });

    const result = rebaseChanges(server, local);
    expect(result).toEqual([]);
  });

  it('should use ops from server changes that are not acked by local changes for transformation patch', () => {
    const serverChanges = [
      createDummyChange('s1', 11, 10, [{ op: 'add', path: '/server1', value: 'sv1' }]),
      createDummyChange('s2', 12, 11, [{ op: 'add', path: '/server2', value: 'sv2' }]),
    ];
    const localChanges = [
      createDummyChange('s1', 11, 10, [{ op: 'add', path: '/server1', value: 'sv1' }]),
      createDummyChange('l1', 12, 10, [{ op: 'add', path: '/local1', value: 'lc1' }]),
    ];

    mockTransformOps.mockImplementation(ops => ({ ops }));

    rebaseChanges(serverChanges, localChanges);

    expect(MockedJSONPatchConstructor).toHaveBeenCalledOnce();
    expect(MockedJSONPatchConstructor.mock.calls[0][0]).toEqual(serverChanges[1].ops);
    expect(mockTransformOps).toHaveBeenCalledWith(localChanges[1].ops);
  });
});
