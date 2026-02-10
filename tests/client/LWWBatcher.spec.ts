import { describe, it, expect, beforeEach } from 'vitest';
import { LWWBatcher } from '../../src/client/LWWBatcher.js';
import type { JSONPatchOp } from '../../src/json-patch/types.js';

interface TestDoc {
  counter: number;
  name: string;
  flags: number;
  nested: {
    value: string;
  };
}

describe('LWWBatcher', () => {
  let batcher: LWWBatcher<TestDoc>;

  beforeEach(() => {
    batcher = new LWWBatcher<TestDoc>();
  });

  describe('add()', () => {
    it('should add operations with timestamps', () => {
      const ops: JSONPatchOp[] = [{ op: 'replace', path: '/name', value: 'Alice' }];
      batcher.add(ops);
      expect(batcher.isEmpty()).toBe(false);
      expect(batcher.size).toBe(1);
    });

    it('should preserve existing timestamps', () => {
      const timestamp = 1000;
      const ops: JSONPatchOp[] = [{ op: 'replace', path: '/name', value: 'Alice', ts: timestamp }];
      batcher.add(ops);

      const result = batcher.flush();
      expect(result.ops[0].ts).toBe(timestamp);
    });

    it('should add timestamps if not present', () => {
      const ops: JSONPatchOp[] = [{ op: 'replace', path: '/name', value: 'Alice' }];
      batcher.add(ops);

      const result = batcher.flush();
      expect(result.ops[0].ts).toBeGreaterThan(0);
    });

    it('should consolidate multiple operations on the same path', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice', ts: 1000 }]);
      batcher.add([{ op: 'replace', path: '/name', value: 'Bob', ts: 2000 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].value).toBe('Bob'); // Later timestamp wins
    });

    it('should merge @inc operations', () => {
      batcher.add([{ op: '@inc', path: '/counter', value: 5 }]);
      batcher.add([{ op: '@inc', path: '/counter', value: 3 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe('@inc');
      expect(result.ops[0].value).toBe(8);
    });

    it('should merge multiple @inc operations', () => {
      batcher.add([{ op: '@inc', path: '/counter', value: 5 }]);
      batcher.add([{ op: '@inc', path: '/counter', value: 3 }]);
      batcher.add([{ op: '@inc', path: '/counter', value: 2 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe('@inc');
      expect(result.ops[0].value).toBe(10);
    });

    it('should handle @inc followed by replace (replace wins)', () => {
      batcher.add([{ op: '@inc', path: '/counter', value: 5 }]);
      batcher.add([{ op: 'replace', path: '/counter', value: 100 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe('replace');
      expect(result.ops[0].value).toBe(100); // Replace overwrites @inc (same timestamp)
    });

    it('should handle replace followed by @inc', () => {
      batcher.add([{ op: 'replace', path: '/counter', value: 100 }]);
      batcher.add([{ op: '@inc', path: '/counter', value: 5 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe('replace');
      expect(result.ops[0].value).toBe(105);
    });

    it('should merge @bit operations', () => {
      batcher.add([{ op: '@bit', path: '/flags', value: 0b0010 }]);
      batcher.add([{ op: '@bit', path: '/flags', value: 0b0100 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe('@bit');
      expect(result.ops[0].value).toBe(0b0110);
    });

    it('should merge @max operations', () => {
      batcher.add([{ op: '@max', path: '/counter', value: 10 }]);
      batcher.add([{ op: '@max', path: '/counter', value: 5 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe('@max');
      expect(result.ops[0].value).toBe(10);
    });

    it('should merge @min operations', () => {
      batcher.add([{ op: '@min', path: '/counter', value: 10 }]);
      batcher.add([{ op: '@min', path: '/counter', value: 5 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe('@min');
      expect(result.ops[0].value).toBe(5);
    });

    it('should handle operations on different paths', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      batcher.add([{ op: '@inc', path: '/counter', value: 5 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(2);
    });

    it('should respect timestamp ordering for non-combinable ops', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice', ts: 2000 }]);
      batcher.add([{ op: 'replace', path: '/name', value: 'Bob', ts: 1000 }]);

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].value).toBe('Alice'); // Earlier add has later timestamp
    });

    it('should handle parent-child path relationships', () => {
      batcher.add([{ op: 'replace', path: '/nested/value', value: 'child' }]);
      batcher.add([{ op: 'replace', path: '/nested', value: { value: 'parent' } }]);

      const result = batcher.flush();
      // Parent write should delete child path
      expect(result.ops.some((op) => op.path === '/nested/value')).toBe(false);
      expect(result.ops.some((op) => op.path === '/nested')).toBe(true);
    });
  });

  describe('change()', () => {
    it('should capture operations using mutator', () => {
      batcher.change((patch, doc) => {
        patch.replace(doc.name, 'Alice');
      });

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].path).toBe('/name');
      expect(result.ops[0].value).toBe('Alice');
    });

    it('should handle multiple operations in one change', () => {
      batcher.change((patch, doc) => {
        patch.replace(doc.name, 'Alice');
        patch.increment(doc.counter, 5);
      });

      const result = batcher.flush();
      expect(result.ops).toHaveLength(2);
    });

    it('should consolidate operations from multiple change calls', () => {
      batcher.change((patch, doc) => {
        patch.increment(doc.counter, 5);
      });
      batcher.change((patch, doc) => {
        patch.increment(doc.counter, 3);
      });

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe('@inc');
      expect(result.ops[0].value).toBe(8);
    });

    it('should handle nested paths', () => {
      batcher.change((patch, doc) => {
        patch.replace(doc.nested.value, 'test');
      });

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].path).toBe('/nested/value');
      expect(result.ops[0].value).toBe('test');
    });

    it('should handle bit operation', () => {
      batcher.change((patch, doc) => {
        patch.bit(doc.flags, 1, true);
      });

      const result = batcher.flush();
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe('@bit');
    });

    it('should do nothing for empty change', () => {
      batcher.change(() => {
        // No operations
      });

      expect(batcher.isEmpty()).toBe(true);
    });
  });

  describe('flush()', () => {
    it('should return ChangeInput with generated id', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      const result = batcher.flush();

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
    });

    it('should return ChangeInput with createdAt timestamp', () => {
      const before = Date.now();
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      const result = batcher.flush();
      const after = Date.now();

      expect(result.createdAt).toBeDefined();
      expect(result.createdAt).toBeGreaterThanOrEqual(before);
      expect(result.createdAt).toBeLessThanOrEqual(after);
    });

    it('should return ChangeInput with ops', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      const result = batcher.flush();

      expect(result.ops).toBeDefined();
      expect(Array.isArray(result.ops)).toBe(true);
      expect(result.ops).toHaveLength(1);
    });

    it('should NOT include rev or baseRev', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      const result = batcher.flush();

      expect(result).not.toHaveProperty('rev');
      expect(result).not.toHaveProperty('baseRev');
    });

    it('should include custom metadata', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      const result = batcher.flush({ customField: 'value', batchId: 'batch-123' });

      expect(result.customField).toBe('value');
      expect(result.batchId).toBe('batch-123');
    });

    it('should clear operations after flush', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      batcher.flush();

      expect(batcher.isEmpty()).toBe(true);
      expect(batcher.size).toBe(0);
    });

    it('should return empty ops array when flushing empty batch', () => {
      const result = batcher.flush();

      expect(result.ops).toHaveLength(0);
    });

    it('should generate unique ids for multiple flushes', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      const result1 = batcher.flush();

      batcher.add([{ op: 'replace', path: '/name', value: 'Bob' }]);
      const result2 = batcher.flush();

      expect(result1.id).not.toBe(result2.id);
    });
  });

  describe('clear()', () => {
    it('should remove all operations', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      batcher.clear();

      expect(batcher.isEmpty()).toBe(true);
      expect(batcher.size).toBe(0);
    });

    it('should not create a ChangeInput', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      batcher.clear();

      // If we flush now, we should get empty ops
      const result = batcher.flush();
      expect(result.ops).toHaveLength(0);
    });
  });

  describe('isEmpty()', () => {
    it('should return true for new batcher', () => {
      expect(batcher.isEmpty()).toBe(true);
    });

    it('should return false after adding operations', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      expect(batcher.isEmpty()).toBe(false);
    });

    it('should return true after flush', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      batcher.flush();
      expect(batcher.isEmpty()).toBe(true);
    });

    it('should return true after clear', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      batcher.clear();
      expect(batcher.isEmpty()).toBe(true);
    });
  });

  describe('size', () => {
    it('should return 0 for new batcher', () => {
      expect(batcher.size).toBe(0);
    });

    it('should return correct size after adding operations', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      expect(batcher.size).toBe(1);

      batcher.add([{ op: '@inc', path: '/counter', value: 5 }]);
      expect(batcher.size).toBe(2);
    });

    it('should return correct size after consolidation', () => {
      batcher.add([{ op: '@inc', path: '/counter', value: 5 }]);
      batcher.add([{ op: '@inc', path: '/counter', value: 3 }]);

      // Should consolidate to 1 operation
      expect(batcher.size).toBe(1);
    });

    it('should return 0 after flush', () => {
      batcher.add([{ op: 'replace', path: '/name', value: 'Alice' }]);
      batcher.flush();
      expect(batcher.size).toBe(0);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle migration script batching', () => {
      // Simulate a migration script that processes records
      const records = [
        { id: 1, increment: 5 },
        { id: 2, increment: 3 },
        { id: 1, increment: 2 }, // Same counter as first record
      ];

      for (const record of records) {
        batcher.change((patch, doc) => {
          patch.increment(doc.counter, record.increment);
        });
      }

      const result = batcher.flush();
      // Should consolidate id:1 increments (5 + 2 = 7) but keep id:2 separate
      // Actually, all go to same path, so total is 5+3+2=10
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].value).toBe(10);
    });

    it('should handle mixed operation types efficiently', () => {
      batcher.change((patch, doc) => {
        patch.replace(doc.name, 'Alice');
        patch.increment(doc.counter, 1);
      });

      batcher.change((patch, doc) => {
        patch.replace(doc.name, 'Bob');
        patch.increment(doc.counter, 2);
      });

      batcher.change((patch, doc) => {
        patch.increment(doc.counter, 3);
        patch.bit(doc.flags, 1, true);
      });

      const result = batcher.flush();
      // name: Bob (last write wins)
      // counter: @inc(6) (all increments merged)
      // flags: @bit(0b0010)
      expect(result.ops).toHaveLength(3);

      const nameOp = result.ops.find((op) => op.path === '/name');
      expect(nameOp?.value).toBe('Bob');

      const counterOp = result.ops.find((op) => op.path === '/counter');
      expect(counterOp?.op).toBe('@inc');
      expect(counterOp?.value).toBe(6);

      const flagsOp = result.ops.find((op) => op.path === '/flags');
      expect(flagsOp?.op).toBe('@bit');
    });
  });
});
