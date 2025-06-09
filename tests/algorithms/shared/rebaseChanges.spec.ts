import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rebaseChanges } from '../../../src/algorithms/shared/rebaseChanges';
import type { Change } from '../../../src/types';
import * as jsonPatchModule from '../../../src/json-patch/JSONPatch';

// Mock the dependencies
vi.mock('../../../src/json-patch/JSONPatch');

describe('rebaseChanges', () => {
  const mockJSONPatch = vi.mocked(jsonPatchModule.JSONPatch);

  const createChange = (id: string, rev: number, ops: any[], baseRev = rev - 1): Change => ({
    id,
    rev,
    baseRev,
    ops,
    created: Date.now(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return local changes unchanged when no server changes', () => {
    const localChanges = [
      createChange('local1', 3, [{ op: 'add', path: '/test', value: 'hello' }]),
      createChange('local2', 4, [{ op: 'add', path: '/count', value: 1 }]),
    ];

    const result = rebaseChanges([], localChanges);

    expect(result).toBe(localChanges);
  });

  it('should return local changes unchanged when no local changes', () => {
    const serverChanges = [createChange('server1', 3, [{ op: 'add', path: '/server', value: 'data' }])];

    const result = rebaseChanges(serverChanges, []);

    expect(result).toEqual([]);
  });

  it('should filter out local changes that exist in server changes', () => {
    const sharedChange = createChange('shared', 3, [{ op: 'add', path: '/shared', value: 'data' }]);
    const localOnlyChange = createChange('local', 4, [{ op: 'add', path: '/local', value: 'data' }]);

    const serverChanges = [sharedChange];
    const localChanges = [sharedChange, localOnlyChange];

    const mockTransform = vi.fn().mockReturnValue({ ops: localOnlyChange.ops });
    const mockPatch = { transform: mockTransform };
    mockJSONPatch.mockImplementation(() => mockPatch as any);

    const result = rebaseChanges(serverChanges, localChanges);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local');
    expect(result[0].baseRev).toBe(3); // Updated to last server change rev
    expect(result[0].rev).toBe(4); // Incremented from last server change
  });

  it('should transform local changes against server changes', () => {
    const serverChange = createChange('server', 3, [{ op: 'add', path: '/server', value: 'data' }]);
    const localChange = createChange('local', 4, [{ op: 'add', path: '/local', value: 'data' }]);

    const transformedOps = [{ op: 'add', path: '/local_transformed', value: 'data' }];
    const mockTransform = vi.fn().mockReturnValue({ ops: transformedOps });
    const mockPatch = { transform: mockTransform };
    mockJSONPatch.mockImplementation(() => mockPatch as any);

    const result = rebaseChanges([serverChange], [localChange]);

    expect(mockJSONPatch).toHaveBeenCalledWith([serverChange.ops].flat());
    expect(mockTransform).toHaveBeenCalledWith(localChange.ops);
    expect(result).toHaveLength(1);
    expect(result[0].ops).toBe(transformedOps);
    expect(result[0].baseRev).toBe(3);
    expect(result[0].rev).toBe(4);
  });

  it('should update revision numbers correctly for multiple local changes', () => {
    const serverChange = createChange('server', 5, [{ op: 'add', path: '/server', value: 'data' }]);
    const localChange1 = createChange('local1', 3, [{ op: 'add', path: '/local1', value: 'data' }]);
    const localChange2 = createChange('local2', 4, [{ op: 'add', path: '/local2', value: 'data' }]);

    const mockTransform = vi
      .fn()
      .mockReturnValueOnce({ ops: [{ op: 'add', path: '/local1_t', value: 'data' }] })
      .mockReturnValueOnce({ ops: [{ op: 'add', path: '/local2_t', value: 'data' }] });
    const mockPatch = { transform: mockTransform };
    mockJSONPatch.mockImplementation(() => mockPatch as any);

    const result = rebaseChanges([serverChange], [localChange1, localChange2]);

    expect(result).toHaveLength(2);
    expect(result[0].baseRev).toBe(5);
    expect(result[0].rev).toBe(6);
    expect(result[1].baseRev).toBe(5);
    expect(result[1].rev).toBe(7);
  });

  it('should filter out changes with empty ops after transformation', () => {
    const serverChange = createChange('server', 3, [{ op: 'add', path: '/server', value: 'data' }]);
    const localChange1 = createChange('local1', 4, [{ op: 'add', path: '/local1', value: 'data' }]);
    const localChange2 = createChange('local2', 5, [{ op: 'add', path: '/local2', value: 'data' }]);

    const mockTransform = vi
      .fn()
      .mockReturnValueOnce({ ops: [] }) // Empty ops - should be filtered out
      .mockReturnValueOnce({ ops: [{ op: 'add', path: '/local2_t', value: 'data' }] });
    const mockPatch = { transform: mockTransform };
    mockJSONPatch.mockImplementation(() => mockPatch as any);

    const result = rebaseChanges([serverChange], [localChange1, localChange2]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local2');
    expect(result[0].rev).toBe(5); // Second rev after server change (first was filtered out)
  });

  it('should handle multiple server changes', () => {
    const serverChange1 = createChange('server1', 3, [{ op: 'add', path: '/s1', value: 'data' }]);
    const serverChange2 = createChange('server2', 4, [{ op: 'add', path: '/s2', value: 'data' }]);
    const localChange = createChange('local', 5, [{ op: 'add', path: '/local', value: 'data' }]);

    const mockTransform = vi.fn().mockReturnValue({ ops: [{ op: 'add', path: '/local_t', value: 'data' }] });
    const mockPatch = { transform: mockTransform };
    mockJSONPatch.mockImplementation(() => mockPatch as any);

    const result = rebaseChanges([serverChange1, serverChange2], [localChange]);

    expect(mockJSONPatch).toHaveBeenCalledWith([...serverChange1.ops, ...serverChange2.ops]);
    expect(result).toHaveLength(1);
    expect(result[0].baseRev).toBe(4); // Last server change rev
    expect(result[0].rev).toBe(5);
  });

  it('should exclude server changes that are also in local changes from transformation', () => {
    const sharedChange = createChange('shared', 3, [{ op: 'add', path: '/shared', value: 'data' }]);
    const serverOnlyChange = createChange('server', 4, [{ op: 'add', path: '/server', value: 'data' }]);
    const localOnlyChange = createChange('local', 5, [{ op: 'add', path: '/local', value: 'data' }]);

    const serverChanges = [sharedChange, serverOnlyChange];
    const localChanges = [sharedChange, localOnlyChange];

    const mockTransform = vi.fn().mockReturnValue({ ops: [{ op: 'add', path: '/local_t', value: 'data' }] });
    const mockPatch = { transform: mockTransform };
    mockJSONPatch.mockImplementation(() => mockPatch as any);

    const result = rebaseChanges(serverChanges, localChanges);

    // Should only transform against serverOnlyChange, not sharedChange
    expect(mockJSONPatch).toHaveBeenCalledWith([serverOnlyChange.ops].flat());
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local');
  });

  it('should preserve other change properties during rebase', () => {
    const serverChange = createChange('server', 3, [{ op: 'add', path: '/server', value: 'data' }]);
    const localChange = createChange('local', 4, [{ op: 'add', path: '/local', value: 'data' }]);
    localChange.created = 1234567890;
    (localChange as any).customField = 'test';

    const mockTransform = vi.fn().mockReturnValue({ ops: [{ op: 'add', path: '/local_t', value: 'data' }] });
    const mockPatch = { transform: mockTransform };
    mockJSONPatch.mockImplementation(() => mockPatch as any);

    const result = rebaseChanges([serverChange], [localChange]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local');
    expect(result[0].created).toBe(1234567890);
    expect((result[0] as any).customField).toBe('test');
  });

  it('should handle complex scenario with mixed changes', () => {
    const serverChange1 = createChange('s1', 3, [{ op: 'add', path: '/s1', value: 'data' }]);
    const sharedChange = createChange('shared', 4, [{ op: 'add', path: '/shared', value: 'data' }]);
    const serverChange2 = createChange('s2', 5, [{ op: 'add', path: '/s2', value: 'data' }]);

    const localChange1 = createChange('l1', 6, [{ op: 'add', path: '/l1', value: 'data' }]);
    const localChange2 = createChange('l2', 7, [{ op: 'add', path: '/l2', value: 'data' }]);

    const serverChanges = [serverChange1, sharedChange, serverChange2];
    const localChanges = [localChange1, sharedChange, localChange2];

    const mockTransform = vi
      .fn()
      .mockReturnValueOnce({ ops: [{ op: 'add', path: '/l1_t', value: 'data' }] })
      .mockReturnValueOnce({ ops: [{ op: 'add', path: '/l2_t', value: 'data' }] });
    const mockPatch = { transform: mockTransform };
    mockJSONPatch.mockImplementation(() => mockPatch as any);

    const result = rebaseChanges(serverChanges, localChanges);

    // Should transform against s1 and s2, but not shared
    expect(mockJSONPatch).toHaveBeenCalledWith([...serverChange1.ops, ...serverChange2.ops]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('l1');
    expect(result[1].id).toBe('l2');
    expect(result[0].baseRev).toBe(5); // Last server change rev
    expect(result[1].baseRev).toBe(5);
    expect(result[0].rev).toBe(6);
    expect(result[1].rev).toBe(7);
  });
});
