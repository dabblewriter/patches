import { Delta } from '@dabble/delta';
import { beforeEach, describe, expect, it } from 'vitest';
import { JSONPatch } from '../../src/json-patch/JSONPatch.js';
import { createPathProxy } from '../../src/json-patch/pathProxy.js';

interface TestType {
  foo: string;
  bar?: number;
  nested: {
    a: string;
    b?: boolean;
  };
  arr: Array<{ id: number; value: string } | string>;
  simpleArr: number[];
}

describe('Path Proxy Utilities', () => {
  describe('createPathProxy - Path Generation', () => {
    const pathProxy = createPathProxy<TestType>();

    it('should generate correct paths for top-level properties', () => {
      expect(pathProxy.foo.toString()).toBe('/foo');
      expect(pathProxy.bar!.toString()).toBe('/bar');
    });

    it('should generate correct paths for nested properties', () => {
      expect(pathProxy.nested.a.toString()).toBe('/nested/a');
      expect(pathProxy.nested.b!.toString()).toBe('/nested/b');
    });

    it('should generate correct paths for array indices', () => {
      expect(pathProxy.arr[0].toString()).toBe('/arr/0');
      expect(pathProxy.arr[123].toString()).toBe('/arr/123');
    });

    it('should generate correct paths for properties within array elements', () => {
      // Need to cast because TS doesn't know the element type at index 0 is the object
      // Cast specifically to the object shape within the union for this test
      const elementProxy = pathProxy.arr[0] as { id: number; value: string };
      expect(elementProxy.id.toString()).toBe('/arr/0/id');
      expect(elementProxy.value.toString()).toBe('/arr/0/value');
    });
  });

  describe('createPathProxy - Error Handling', () => {
    const pathProxy = createPathProxy<TestType>();

    it('should throw error when attempting to set properties', () => {
      expect(() => {
        (pathProxy as any).foo = 'goodbye';
      }).toThrow("Cannot set property 'foo' on path proxy");
    });

    it('should throw error when attempting to delete properties', () => {
      expect(() => {
        delete (pathProxy as any).foo;
      }).toThrow("Cannot delete property 'foo' on path proxy");
    });

    it('should throw helpful error messages for nested properties', () => {
      expect(() => {
        (pathProxy as any).nested.a = 'universe';
      }).toThrow("Cannot set property 'a' on path proxy");
    });

    it('should provide helpful error messages with usage instructions', () => {
      expect(() => {
        (pathProxy as any).foo = 'test';
      }).toThrow(/Use JSONPatch methods instead: patch\.replace\(path\.foo, value\)/);
    });
  });

  describe('JSONPatch integration with path proxy', () => {
    let patch: JSONPatch;
    let path: ReturnType<typeof createPathProxy<TestType>>;

    beforeEach(() => {
      patch = new JSONPatch();
      path = createPathProxy<TestType>();
    });

    it('should work with replace operations', () => {
      patch.replace(path.foo, 'new value');
      expect(patch.ops).toEqual([{ op: 'replace', path: '/foo', value: 'new value' }]);
    });

    it('should work with add operations', () => {
      patch.add(path.arr[0], 'new item');
      expect(patch.ops).toEqual([{ op: 'add', path: '/arr/0', value: 'new item' }]);
    });

    it('should work with remove operations', () => {
      patch.remove(path.bar!);
      expect(patch.ops).toEqual([{ op: 'remove', path: '/bar' }]);
    });

    it('should work with nested paths', () => {
      patch.replace(path.nested.a, 'universe');
      expect(patch.ops).toEqual([{ op: 'replace', path: '/nested/a', value: 'universe' }]);
    });

    it('should work with text operations using Delta', () => {
      patch.text(path.foo, new Delta().retain(5).insert(' beautiful'));
      expect(patch.ops[0]).toMatchObject({
        op: '@txt',
        path: '/foo',
      });
      // Verify the Delta was stored
      expect(patch.ops[0].value).toBeInstanceOf(Delta);
    });

    it('should work with increment operations', () => {
      patch.increment(path.bar!, 5);
      expect(patch.ops).toEqual([{ op: '@inc', path: '/bar', value: 5 }]);
    });

    it('should work with decrement operations', () => {
      patch.decrement(path.bar!, 3);
      expect(patch.ops).toEqual([{ op: '@inc', path: '/bar', value: -3 }]);
    });

    it('should work with bit operations', () => {
      patch.bit(path.bar!, 2, true);
      expect(patch.ops).toEqual([
        { op: '@bit', path: '/bar', value: 4 }, // bit 2 = 2^2 = 4
      ]);
    });

    it('should work with multiple operations', () => {
      patch.replace(path.foo, 'Hello');
      patch.increment(path.bar!, 5);
      patch.text(path.nested.a, new Delta().retain(5).insert(' beautiful'));
      patch.decrement(path.bar!, 2);

      expect(patch.ops[0]).toEqual({ op: 'replace', path: '/foo', value: 'Hello' });
      expect(patch.ops[1]).toEqual({ op: '@inc', path: '/bar', value: 5 });
      expect(patch.ops[2]).toMatchObject({ op: '@txt', path: '/nested/a' });
      expect(patch.ops[2].value).toBeInstanceOf(Delta);
      expect(patch.ops[3]).toEqual({ op: '@inc', path: '/bar', value: -2 });
    });
  });

  describe('Path proxy with complex array paths', () => {
    it('should handle array indices correctly', () => {
      const path = createPathProxy<{ items: Array<{ name: string; tags: string[] }> }>();

      expect(path.items[0].name.toString()).toBe('/items/0/name');
      expect(path.items[5].tags[2].toString()).toBe('/items/5/tags/2');
    });

    it('should work with JSONPatch for array operations', () => {
      const patch = new JSONPatch();
      const path = createPathProxy<{ items: string[] }>();

      patch.add(path.items[0], 'first item');
      patch.replace(path.items[1], 'second item');
      patch.remove(path.items[2]);

      expect(patch.ops).toEqual([
        { op: 'add', path: '/items/0', value: 'first item' },
        { op: 'replace', path: '/items/1', value: 'second item' },
        { op: 'remove', path: '/items/2' },
      ]);
    });
  });
});
