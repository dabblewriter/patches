import { describe, expect, it } from 'vitest';
import { consolidateFieldOp, consolidateOps, convertDeltaOps } from '../../../src/algorithms/lww/consolidateOps';
import type { JSONPatchOp } from '../../../src/json-patch/types';

describe('consolidateFieldOp', () => {
  describe('@inc operations', () => {
    it('should sum values when both ops are @inc', () => {
      const existing: JSONPatchOp = { op: '@inc', path: '/counter', value: 5, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@inc', path: '/counter', value: 3, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result!.op).toBe('@inc');
      expect(result!.value).toBe(8);
      expect(result!.ts).toBe(2000);
    });

    it('should handle negative increments', () => {
      const existing: JSONPatchOp = { op: '@inc', path: '/counter', value: 10, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@inc', path: '/counter', value: -3, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result!.value).toBe(7);
    });
  });

  describe('@bit operations', () => {
    it('should combine bitmasks when both ops are @bit', () => {
      // Turn on bit 0
      const existing: JSONPatchOp = { op: '@bit', path: '/flags', value: 0b0001, ts: 1000 };
      // Turn on bit 1
      const incoming: JSONPatchOp = { op: '@bit', path: '/flags', value: 0b0010, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result!.op).toBe('@bit');
      // Both bits should be on
      expect(result!.value & 0b0011).toBe(0b0011);
      expect(result!.ts).toBe(2000);
    });
  });

  describe('@max operations', () => {
    it('should return null when incoming max is less than existing (no change)', () => {
      const existing: JSONPatchOp = { op: '@max', path: '/highScore', value: 100, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@max', path: '/highScore', value: 50, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).toBeNull();
    });

    it('should update when incoming is higher', () => {
      const existing: JSONPatchOp = { op: '@max', path: '/highScore', value: 50, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@max', path: '/highScore', value: 100, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.value).toBe(100);
    });
  });

  describe('@min operations', () => {
    it('should return null when incoming min is greater than existing (no change)', () => {
      const existing: JSONPatchOp = { op: '@min', path: '/lowestPrice', value: 50, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@min', path: '/lowestPrice', value: 100, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).toBeNull();
    });

    it('should update when incoming is lower', () => {
      const existing: JSONPatchOp = { op: '@min', path: '/lowestPrice', value: 100, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@min', path: '/lowestPrice', value: 50, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.value).toBe(50);
    });
  });

  describe('replace operations', () => {
    it('should return incoming when both are replace', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/name', value: 'Alice', ts: 1000 };
      const incoming: JSONPatchOp = { op: 'replace', path: '/name', value: 'Bob', ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result!.op).toBe('replace');
      expect(result!.value).toBe('Bob');
      expect(result!.ts).toBe(2000);
    });
  });

  describe('remove operations', () => {
    it('should return incoming when both are remove', () => {
      const existing: JSONPatchOp = { op: 'remove', path: '/field', ts: 1000 };
      const incoming: JSONPatchOp = { op: 'remove', path: '/field', ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result!.op).toBe('remove');
      expect(result!.ts).toBe(2000);
    });

    it('should return incoming remove when existing is replace', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/field', value: 'test', ts: 1000 };
      const incoming: JSONPatchOp = { op: 'remove', path: '/field', ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result!.op).toBe('remove');
    });
  });

  describe('mixed operation types', () => {
    it('should return incoming when operation types differ', () => {
      const existing: JSONPatchOp = { op: '@inc', path: '/value', value: 5, ts: 1000 };
      const incoming: JSONPatchOp = { op: 'replace', path: '/value', value: 100, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result!.op).toBe('replace');
      expect(result!.value).toBe(100);
    });

    it('should apply @inc to @max value and preserve @max op', () => {
      const existing: JSONPatchOp = { op: '@max', path: '/value', value: 50, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@inc', path: '/value', value: 10, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.op).toBe('@max');
      expect(result!.value).toBe(60);
    });
  });

  describe('apply behavior (delta op on replace)', () => {
    it('should apply @inc to replace value', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/count', value: 10, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@inc', path: '/count', value: 5, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.op).toBe('replace');
      expect(result!.value).toBe(15);
    });

    it('should apply @max to replace value when incoming is larger', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/highScore', value: 10, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@max', path: '/highScore', value: 20, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.op).toBe('replace');
      expect(result!.value).toBe(20);
    });

    it('should return null when @max incoming is less than replace value', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/highScore', value: 20, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@max', path: '/highScore', value: 10, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).toBeNull();
    });

    it('should apply @min to replace value when incoming is smaller', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/lowestPrice', value: 10, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@min', path: '/lowestPrice', value: 5, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.op).toBe('replace');
      expect(result!.value).toBe(5);
    });

    it('should return null when @min incoming is greater than replace value', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/lowestPrice', value: 5, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@min', path: '/lowestPrice', value: 10, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).toBeNull();
    });

    it('should apply @bit to replace value', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/flags', value: 0b0001, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@bit', path: '/flags', value: 0b0010, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.op).toBe('replace');
      expect(result!.value).toBe(0b0011);
    });
  });

  describe('apply behavior (delta op on different delta op)', () => {
    it('should apply @inc to @min value and preserve @min op', () => {
      const existing: JSONPatchOp = { op: '@min', path: '/value', value: 50, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@inc', path: '/value', value: 10, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.op).toBe('@min');
      expect(result!.value).toBe(60);
    });

    it('should apply @max to @inc value and preserve @inc op', () => {
      const existing: JSONPatchOp = { op: '@inc', path: '/value', value: 50, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@max', path: '/value', value: 100, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.op).toBe('@inc');
      expect(result!.value).toBe(100);
    });

    it('should apply @min to @inc value and preserve @inc op', () => {
      const existing: JSONPatchOp = { op: '@inc', path: '/value', value: 50, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@min', path: '/value', value: 30, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.op).toBe('@inc');
      expect(result!.value).toBe(30);
    });
  });

  describe('combinable ops always combine', () => {
    it('should combine @inc regardless of timestamp order', () => {
      const existing: JSONPatchOp = { op: '@inc', path: '/counter', value: 5, ts: 3000 };
      const incoming: JSONPatchOp = { op: '@inc', path: '/counter', value: 3, ts: 1000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.value).toBe(8);
    });

    it('should combine @inc even when existing has no timestamp', () => {
      const existing: JSONPatchOp = { op: '@inc', path: '/counter', value: 5 };
      const incoming: JSONPatchOp = { op: '@inc', path: '/counter', value: 3, ts: 1000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.value).toBe(8);
    });

    it('should return null when combined value equals existing (no change)', () => {
      const existing: JSONPatchOp = { op: '@inc', path: '/counter', value: 5, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@inc', path: '/counter', value: 0, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).toBeNull();
    });

    it('should return null when @max incoming is less than existing', () => {
      const existing: JSONPatchOp = { op: '@max', path: '/highScore', value: 100, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@max', path: '/highScore', value: 50, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).toBeNull();
    });

    it('should return null when @min incoming is greater than existing', () => {
      const existing: JSONPatchOp = { op: '@min', path: '/lowestPrice', value: 50, ts: 1000 };
      const incoming: JSONPatchOp = { op: '@min', path: '/lowestPrice', value: 100, ts: 2000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).toBeNull();
    });
  });

  describe('non-combinable ops use timestamp', () => {
    it('should return null when existing replace has newer timestamp', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/name', value: 'Alice', ts: 3000 };
      const incoming: JSONPatchOp = { op: 'replace', path: '/name', value: 'Bob', ts: 1000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).toBeNull();
    });

    it('should return null when existing has no timestamp (deemed newer)', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/name', value: 'Alice' };
      const incoming: JSONPatchOp = { op: 'replace', path: '/name', value: 'Bob', ts: 1000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).toBeNull();
    });

    it('should use incoming when timestamps are equal', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/name', value: 'Alice', ts: 1000 };
      const incoming: JSONPatchOp = { op: 'replace', path: '/name', value: 'Bob', ts: 1000 };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.value).toBe('Bob');
    });

    it('should use incoming when both timestamps are undefined', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/name', value: 'Alice' };
      const incoming: JSONPatchOp = { op: 'replace', path: '/name', value: 'Bob' };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.value).toBe('Bob');
    });

    it('should use incoming when incoming has no timestamp (deemed newer)', () => {
      const existing: JSONPatchOp = { op: 'replace', path: '/name', value: 'Alice', ts: 1000 };
      const incoming: JSONPatchOp = { op: 'replace', path: '/name', value: 'Bob' };

      const result = consolidateFieldOp(existing, incoming);

      expect(result).not.toBeNull();
      expect(result!.value).toBe('Bob');
    });
  });
});

describe('consolidatePendingOps', () => {
  it('should return new ops when no existing ops', () => {
    const existingOps: JSONPatchOp[] = [];
    const newOps: JSONPatchOp[] = [
      { op: 'replace', path: '/name', value: 'Alice', ts: 1000 },
      { op: '@inc', path: '/count', value: 1, ts: 1000 },
    ];

    const result = consolidateOps(existingOps, newOps);

    expect(result.opsToSave).toHaveLength(2);
    expect(result.pathsToDelete).toHaveLength(0);
  });

  it('should consolidate ops on same path', () => {
    const existingOps: JSONPatchOp[] = [{ op: '@inc', path: '/counter', value: 5, ts: 1000 }];
    const newOps: JSONPatchOp[] = [{ op: '@inc', path: '/counter', value: 3, ts: 2000 }];

    const result = consolidateOps(existingOps, newOps);

    expect(result.opsToSave).toHaveLength(1);
    expect(result.opsToSave[0].value).toBe(8);
    expect(result.pathsToDelete).toHaveLength(0);
  });

  it('should mark child paths for deletion when parent is written', () => {
    const existingOps: JSONPatchOp[] = [
      { op: 'replace', path: '/user/name', value: 'Alice', ts: 1000 },
      { op: 'replace', path: '/user/age', value: 30, ts: 1000 },
      { op: 'replace', path: '/other', value: 'keep', ts: 1000 },
    ];
    const newOps: JSONPatchOp[] = [{ op: 'replace', path: '/user', value: { name: 'Bob' }, ts: 2000 }];

    const result = consolidateOps(existingOps, newOps);

    expect(result.opsToSave).toHaveLength(1);
    expect(result.opsToSave[0].path).toBe('/user');
    expect(result.pathsToDelete).toContain('/user/name');
    expect(result.pathsToDelete).toContain('/user/age');
    expect(result.pathsToDelete).not.toContain('/other');
  });

  it('should handle multiple new ops with mixed consolidation', () => {
    const existingOps: JSONPatchOp[] = [
      { op: '@inc', path: '/views', value: 10, ts: 1000 },
      { op: 'replace', path: '/title', value: 'Old', ts: 1000 },
    ];
    const newOps: JSONPatchOp[] = [
      { op: '@inc', path: '/views', value: 5, ts: 2000 },
      { op: 'replace', path: '/author', value: 'New Author', ts: 2000 },
    ];

    const result = consolidateOps(existingOps, newOps);

    expect(result.opsToSave).toHaveLength(2);

    const viewsOp = result.opsToSave.find(op => op.path === '/views');
    expect(viewsOp?.value).toBe(15);

    const authorOp = result.opsToSave.find(op => op.path === '/author');
    expect(authorOp?.value).toBe('New Author');
  });

  it('should not mark sibling paths for deletion', () => {
    const existingOps: JSONPatchOp[] = [
      { op: 'replace', path: '/users/1', value: 'Alice', ts: 1000 },
      { op: 'replace', path: '/users/2', value: 'Bob', ts: 1000 },
    ];
    const newOps: JSONPatchOp[] = [{ op: 'replace', path: '/users/1', value: 'Charlie', ts: 2000 }];

    const result = consolidateOps(existingOps, newOps);

    expect(result.opsToSave).toHaveLength(1);
    expect(result.pathsToDelete).toHaveLength(0);
  });

  it('should handle remove operations', () => {
    const existingOps: JSONPatchOp[] = [{ op: 'replace', path: '/field', value: 'test', ts: 1000 }];
    const newOps: JSONPatchOp[] = [{ op: 'remove', path: '/field', ts: 2000 }];

    const result = consolidateOps(existingOps, newOps);

    expect(result.opsToSave).toHaveLength(1);
    expect(result.opsToSave[0].op).toBe('remove');
  });
});

describe('convertDeltaOps', () => {
  it('should convert @inc to replace by applying to 0', () => {
    const ops: JSONPatchOp[] = [{ op: '@inc', path: '/count', value: 5, ts: 1000 }];

    const result = convertDeltaOps(ops);

    expect(result).toHaveLength(1);
    expect(result[0].op).toBe('replace');
    expect(result[0].value).toBe(5);
    expect(result[0].path).toBe('/count');
    expect(result[0].ts).toBe(1000);
  });

  it('should convert @max to replace by applying to 0', () => {
    const ops: JSONPatchOp[] = [{ op: '@max', path: '/highScore', value: 100, ts: 1000 }];

    const result = convertDeltaOps(ops);

    expect(result).toHaveLength(1);
    expect(result[0].op).toBe('replace');
    expect(result[0].value).toBe(100);
  });

  it('should convert @min to replace by applying to 0', () => {
    const ops: JSONPatchOp[] = [{ op: '@min', path: '/lowestPrice', value: -5, ts: 1000 }];

    const result = convertDeltaOps(ops);

    expect(result).toHaveLength(1);
    expect(result[0].op).toBe('replace');
    expect(result[0].value).toBe(-5);
  });

  it('should convert @bit to replace by applying to 0', () => {
    const ops: JSONPatchOp[] = [{ op: '@bit', path: '/flags', value: 0b0011, ts: 1000 }];

    const result = convertDeltaOps(ops);

    expect(result).toHaveLength(1);
    expect(result[0].op).toBe('replace');
    expect(result[0].value).toBe(0b0011);
  });

  it('should pass through replace ops unchanged', () => {
    const ops: JSONPatchOp[] = [{ op: 'replace', path: '/name', value: 'hello', ts: 1000 }];

    const result = convertDeltaOps(ops);

    expect(result).toHaveLength(1);
    expect(result[0].op).toBe('replace');
    expect(result[0].value).toBe('hello');
  });

  it('should convert remove ops to replace', () => {
    const ops: JSONPatchOp[] = [{ op: 'remove', path: '/field', ts: 1000 }];

    const result = convertDeltaOps(ops);

    expect(result).toHaveLength(1);
    expect(result[0].op).toBe('replace');
    expect(result[0].value).toBeUndefined();
  });

  it('should convert array of mixed ops', () => {
    const ops: JSONPatchOp[] = [
      { op: '@inc', path: '/count', value: 5, ts: 1000 },
      { op: 'replace', path: '/name', value: 'Alice', ts: 1000 },
      { op: '@max', path: '/highScore', value: 100, ts: 1000 },
    ];

    const result = convertDeltaOps(ops);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ op: 'replace', path: '/count', value: 5, ts: 1000 });
    expect(result[1]).toEqual({ op: 'replace', path: '/name', value: 'Alice', ts: 1000 });
    expect(result[2]).toEqual({ op: 'replace', path: '/highScore', value: 100, ts: 1000 });
  });

  it('should return empty array for empty input', () => {
    const result = convertDeltaOps([]);

    expect(result).toHaveLength(0);
  });

  it('should preserve all op properties like path and ts', () => {
    const ops: JSONPatchOp[] = [{ op: '@inc', path: '/nested/count', value: 10, ts: 5000 }];

    const result = convertDeltaOps(ops);

    expect(result[0].path).toBe('/nested/count');
    expect(result[0].ts).toBe(5000);
  });
});
