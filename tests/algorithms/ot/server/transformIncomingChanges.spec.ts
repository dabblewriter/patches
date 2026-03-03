import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transformIncomingChanges } from '../../../../src/algorithms/ot/server/transformIncomingChanges';
import { createChange } from '../../../../src/data/change';
import * as transformPatchModule from '../../../../src/json-patch/transformPatch';

// Mock the dependencies
vi.mock('../../../../src/json-patch/transformPatch');

describe('transformIncomingChanges', () => {
  const mockTransformPatch = vi.mocked(transformPatchModule.transformPatch);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should transform changes and assign sequential revision numbers', () => {
    const incomingChanges = [
      createChange(2, 0, [{ op: 'replace', path: '/text', value: 'hello world' }]),
      createChange(2, 0, [{ op: 'replace', path: '/count', value: 5 }]),
    ];

    const committedChanges = [createChange(1, 3, [{ op: 'add', path: '/author', value: 'user1' }])];

    const transformedOps1 = [{ op: 'replace', path: '/text', value: 'hello world' }];
    const transformedOps2 = [{ op: 'replace', path: '/count', value: 5 }];

    mockTransformPatch.mockReturnValueOnce(transformedOps1).mockReturnValueOnce(transformedOps2);

    const result = transformIncomingChanges(incomingChanges, committedChanges, 3);

    expect(result).toHaveLength(2);
    expect(result[0].rev).toBe(4);
    expect(result[1].rev).toBe(5);
    expect(result[0].ops).toEqual(transformedOps1);
    expect(result[1].ops).toEqual(transformedOps2);
    expect(result[0].id).toBe(incomingChanges[0].id);
    expect(result[1].id).toBe(incomingChanges[1].id);
  });

  it('should filter out obsolete changes (empty ops after transformation)', () => {
    const incomingChanges = [
      createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
      createChange(1, 0, [{ op: 'replace', path: '/count', value: 5 }]),
    ];

    const committedChanges = [createChange(0, 2, [{ op: 'replace', path: '/text', value: 'world' }])];

    // First change becomes obsolete (empty ops), second change is valid
    mockTransformPatch
      .mockReturnValueOnce([]) // Obsolete change
      .mockReturnValueOnce([{ op: 'replace', path: '/count', value: 5 }]);

    const result = transformIncomingChanges(incomingChanges, committedChanges, 2);

    expect(result).toHaveLength(1);
    expect(result[0].rev).toBe(3);
    expect(result[0].ops).toEqual([{ op: 'replace', path: '/count', value: 5 }]);
  });

  it('should handle empty incoming changes', () => {
    const result = transformIncomingChanges([], [], 1);
    expect(result).toEqual([]);
    expect(mockTransformPatch).not.toHaveBeenCalled();
  });

  it('should handle empty committed changes', () => {
    const incomingChanges = [createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }])];

    mockTransformPatch.mockReturnValue([{ op: 'replace', path: '/text', value: 'world' }]);

    const result = transformIncomingChanges(incomingChanges, [], 1);

    expect(result).toHaveLength(1);
    expect(result[0].rev).toBe(2);
    // Stateless: passes null as state to transformPatch
    expect(mockTransformPatch).toHaveBeenCalledWith(null, [], incomingChanges[0].ops);
  });

  it('should preserve change metadata during transformation', () => {
    const metadata = { author: 'user1', timestamp: 12345 };
    const incomingChanges = [
      { ...createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]), ...metadata },
    ];

    mockTransformPatch.mockReturnValue([{ op: 'replace', path: '/text', value: 'world' }]);

    const result = transformIncomingChanges(incomingChanges, [], 1);

    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('user1');
    expect(result[0].timestamp).toBe(12345);
  });

  it('should flatten committed changes ops correctly', () => {
    const incomingChanges = [createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }])];

    const committedChanges = [
      createChange(0, 2, [{ op: 'add', path: '/author', value: 'user1' }]),
      createChange(1, 3, [
        { op: 'replace', path: '/count', value: 5 },
        { op: 'add', path: '/tags', value: [] },
      ]),
    ];

    const expectedCommittedOps = [
      { op: 'add', path: '/author', value: 'user1' },
      { op: 'replace', path: '/count', value: 5 },
      { op: 'add', path: '/tags', value: [] },
    ];

    mockTransformPatch.mockReturnValue([{ op: 'replace', path: '/text', value: 'world' }]);

    transformIncomingChanges(incomingChanges, committedChanges, 3);

    // Stateless: passes null as state to transformPatch
    expect(mockTransformPatch).toHaveBeenCalledWith(null, expectedCommittedOps, incomingChanges[0].ops);
  });

  describe('forceCommit option', () => {
    it('should preserve changes with empty ops when forceCommit is true', () => {
      const incomingChanges = [
        createChange(1, 0, []), // Empty ops
        createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
      ];

      // First change has empty ops, second change is valid
      mockTransformPatch
        .mockReturnValueOnce([]) // Empty ops
        .mockReturnValueOnce([{ op: 'replace', path: '/text', value: 'world' }]);

      const result = transformIncomingChanges(incomingChanges, [], 1, true);

      // Both changes should be preserved with forceCommit
      expect(result).toHaveLength(2);
      expect(result[0].rev).toBe(2);
      expect(result[0].ops).toEqual([]);
      expect(result[1].rev).toBe(3);
      expect(result[1].ops).toEqual([{ op: 'replace', path: '/text', value: 'world' }]);
    });

    it('should still filter out changes with empty ops when forceCommit is false', () => {
      const incomingChanges = [
        createChange(1, 0, []), // Empty ops
        createChange(1, 0, [{ op: 'replace', path: '/text', value: 'world' }]),
      ];

      mockTransformPatch
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ op: 'replace', path: '/text', value: 'world' }]);

      const result = transformIncomingChanges(incomingChanges, [], 1, false);

      // Only the second change should be included
      expect(result).toHaveLength(1);
      expect(result[0].rev).toBe(2);
    });
  });
});
