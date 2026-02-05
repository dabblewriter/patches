import { describe, expect, it } from 'vitest';
import { mergeServerWithLocal } from '../../../src/algorithms/lww/mergeServerWithLocal';
import { createChange } from '../../../src/data/change';
import type { JSONPatchOp } from '../../../src/json-patch/types';
import type { Change } from '../../../src/types';

describe('mergeServerWithLocal', () => {
  describe('delta ops on same path as server', () => {
    it('should merge server replace with local @inc', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/count', value: 123 }])];
      const localOps: JSONPatchOp[] = [{ op: '@inc', path: '/count', value: 2, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result).toHaveLength(1);
      expect(result[0].ops).toHaveLength(1);
      expect(result[0].ops[0].value).toBe(125); // 123 + 2
    });

    it('should merge server replace with local @max (server value higher)', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/score', value: 100 }])];
      const localOps: JSONPatchOp[] = [{ op: '@max', path: '/score', value: 50, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result[0].ops[0].value).toBe(100); // max(100, 50) = 100
    });

    it('should merge server replace with local @max (local value higher)', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/score', value: 50 }])];
      const localOps: JSONPatchOp[] = [{ op: '@max', path: '/score', value: 100, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result[0].ops[0].value).toBe(100); // max(50, 100) = 100
    });

    it('should merge server replace with local @min (server value lower)', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/price', value: 10 }])];
      const localOps: JSONPatchOp[] = [{ op: '@min', path: '/price', value: 50, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result[0].ops[0].value).toBe(10); // min(10, 50) = 10
    });

    it('should merge server replace with local @min (local value lower)', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/price', value: 50 }])];
      const localOps: JSONPatchOp[] = [{ op: '@min', path: '/price', value: 10, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result[0].ops[0].value).toBe(10); // min(50, 10) = 10
    });

    it('should merge server replace with local @bit', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/flags', value: 0b0001 }])];
      // Turn on bit 1 (value encodes which bit to toggle)
      const localOps: JSONPatchOp[] = [{ op: '@bit', path: '/flags', value: 0b0010, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      // Both bits should be on after applying bitmask
      expect(result[0].ops[0].value & 0b0011).toBe(0b0011);
    });
  });

  describe('non-delta local ops', () => {
    it('should keep server value when local has replace on same path', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/name', value: 'Server' }])];
      const localOps: JSONPatchOp[] = [{ op: 'replace', path: '/name', value: 'Local', ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      // Server value wins for non-delta ops (already committed)
      expect(result[0].ops[0].value).toBe('Server');
    });

    it('should keep server value when local has remove on same path', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/field', value: 'value' }])];
      const localOps: JSONPatchOp[] = [{ op: 'remove', path: '/field', ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result[0].ops[0].value).toBe('value');
    });
  });

  describe('no local ops', () => {
    it('should return server changes unchanged when no local ops', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/count', value: 100 }])];

      const result = mergeServerWithLocal(serverChanges, []);

      expect(result).toBe(serverChanges); // Same reference
    });
  });

  describe('local ops on untouched paths', () => {
    it('should add local ops for paths server did not touch', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/serverPath', value: 'server' }])];
      const localOps: JSONPatchOp[] = [{ op: '@inc', path: '/localPath', value: 5, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result).toHaveLength(1);
      expect(result[0].ops).toHaveLength(2);
      expect(result[0].ops[0].path).toBe('/serverPath');
      expect(result[0].ops[1].path).toBe('/localPath');
      expect(result[0].ops[1].value).toBe(5);
    });

    it('should preserve non-delta local ops on untouched paths', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/a', value: 1 }])];
      const localOps: JSONPatchOp[] = [{ op: 'replace', path: '/b', value: 'local', ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result[0].ops).toHaveLength(2);
      expect(result[0].ops[1].path).toBe('/b');
      expect(result[0].ops[1].value).toBe('local');
    });
  });

  describe('multiple ops and changes', () => {
    it('should handle multiple server ops with mixed local deltas', () => {
      const serverChanges: Change[] = [
        createChange(5, 6, [
          { op: 'replace', path: '/a', value: 10 },
          { op: 'replace', path: '/b', value: 20 },
          { op: 'replace', path: '/c', value: 30 },
        ]),
      ];
      const localOps: JSONPatchOp[] = [
        { op: '@inc', path: '/a', value: 5, ts: 1000 }, // Delta - merge
        { op: 'replace', path: '/b', value: 'local', ts: 1000 }, // Non-delta - server wins
        // /c has no local op
      ];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result[0].ops[0].value).toBe(15); // 10 + 5
      expect(result[0].ops[1].value).toBe(20); // Server wins
      expect(result[0].ops[2].value).toBe(30); // No local op
    });

    it('should handle sendingChange ops + pendingOps combined', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/count', value: 100 }])];
      // Simulating sendingChange.ops + pendingOps combined
      const localOps: JSONPatchOp[] = [
        { op: '@inc', path: '/count', value: 10, ts: 1000 }, // From sendingChange
        { op: '@inc', path: '/other', value: 5, ts: 2000 }, // From pendingOps (different path)
      ];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result[0].ops[0].path).toBe('/count');
      expect(result[0].ops[0].value).toBe(110); // 100 + 10
      expect(result[0].ops[1].path).toBe('/other');
      expect(result[0].ops[1].value).toBe(5); // Untouched local op preserved
    });

    it('should handle multiple server changes', () => {
      const serverChanges: Change[] = [
        createChange(5, 6, [{ op: 'replace', path: '/a', value: 10 }]),
        createChange(6, 7, [{ op: 'replace', path: '/b', value: 20 }]),
      ];
      const localOps: JSONPatchOp[] = [
        { op: '@inc', path: '/a', value: 5, ts: 1000 },
        { op: '@inc', path: '/c', value: 3, ts: 1000 }, // Untouched path
      ];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result).toHaveLength(2);
      expect(result[0].ops[0].value).toBe(15); // 10 + 5
      expect(result[1].ops[0].value).toBe(20); // /b unchanged
      // Untouched local op added to last change
      expect(result[1].ops).toHaveLength(2);
      expect(result[1].ops[1].path).toBe('/c');
      expect(result[1].ops[1].value).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('should handle undefined server values', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/count', value: undefined }])];
      const localOps: JSONPatchOp[] = [{ op: '@inc', path: '/count', value: 5, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      // 0 (default for undefined) + 5 = 5
      expect(result[0].ops[0].value).toBe(5);
    });

    it('should handle undefined local values', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'replace', path: '/count', value: 100 }])];
      const localOps: JSONPatchOp[] = [{ op: '@inc', path: '/count', value: undefined, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      // 100 + 0 (default for undefined) = 100
      expect(result[0].ops[0].value).toBe(100);
    });

    it('should preserve other Change properties', () => {
      const serverChanges: Change[] = [
        {
          ...createChange(5, 6, [{ op: 'replace', path: '/count', value: 100 }]),
          committedAt: 123456789,
        },
      ];
      const localOps: JSONPatchOp[] = [{ op: '@inc', path: '/count', value: 5, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      expect(result[0].committedAt).toBe(123456789);
      expect(result[0].baseRev).toBe(5);
      expect(result[0].rev).toBe(6);
    });

    it('should convert server remove + local @inc to replace with delta value', () => {
      // Server removed the field, but client has a pending increment
      // Since @inc can work on undefined (starting from 0), the result should be a replace
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'remove', path: '/count' }])];
      const localOps: JSONPatchOp[] = [{ op: '@inc', path: '/count', value: 5, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      // Should become replace with value 5 (0 + 5), not a remove
      expect(result[0].ops[0].op).toBe('replace');
      expect(result[0].ops[0].path).toBe('/count');
      expect(result[0].ops[0].value).toBe(5);
    });

    it('should convert server remove + local @max to replace', () => {
      const serverChanges: Change[] = [createChange(5, 6, [{ op: 'remove', path: '/score' }])];
      const localOps: JSONPatchOp[] = [{ op: '@max', path: '/score', value: 100, ts: 1000 }];

      const result = mergeServerWithLocal(serverChanges, localOps);

      // max(0, 100) = 100, should be a replace
      expect(result[0].ops[0].op).toBe('replace');
      expect(result[0].ops[0].value).toBe(100);
    });
  });
});
