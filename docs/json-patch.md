# JSON Patch

Patches implements RFC 6902 JSON Patch with custom extensions for collaborative editing. If you're building real-time apps, you need operations that can be transformed, inverted, and composed. Standard JSON Patch gets you part of the way there. Our implementation gets you the rest.

**Table of Contents**

- [The Basics](#the-basics)
- [Array Append Syntax and OT](#array-append-syntax-and-ot)
- [The JSONPatch Class](#the-jsonpatch-class)
- [The createJSONPatch Helper](#the-createjsonpatch-helper)
- [Type-Safe Paths with createPathProxy](#type-safe-paths-with-createpathproxy)
- [Applying Patches](#applying-patches)
- [Supported Operations](#supported-operations)
- [OT Functions](#ot-functions)

## The Basics

JSON Patch is a format for describing changes to JSON documents. Instead of sending entire documents over the wire, you send a list of operations: add this, remove that, replace something else.

Each operation has:

- An `op` field (like `add`, `remove`, `replace`)
- A `path` pointing to the location (like `/users/0/name`)
- Usually a `value` (what to add or change to)
- Sometimes a `from` path (for `move` and `copy`)

```typescript
// A simple patch
const patch = [
  { op: 'replace', path: '/title', value: 'New Title' },
  { op: 'add', path: '/tags/-', value: 'important' },
  { op: 'remove', path: '/draft' },
];
```

The Patches library uses JSON Patch as its fundamental unit of change. When you call `doc.change()`, you're generating JSON Patch operations under the hood. See [PatchesDoc](PatchesDoc.md) for how this works in practice.

## Array Append Syntax and OT

The `-` character in paths like `/items/-` means "append to the end of the array." Convenient, but it creates problems for [Operational Transformation](operational-transformation.md).

### When `-` Works Fine

- Appending values that won't be modified afterward
- Appending before sync, when the operation commits to the server before any operations reference the item by index

### When `-` Causes Trouble

The issue:

1. You append an object with `/items/-`
2. You modify a property with `/items/3/name` (expecting it landed at index 3)

If concurrent operations insert or remove items, the index `3` gets transformed (maybe to `4`), but the `-` in the first operation cannot be transformed. It still means "end of array." Now your operations target different items.

The root cause: `-` is resolved at execution time, not creation time. OT algorithms need concrete indices to compute transformations.

### The Fix

For OT-heavy workflows, resolve `-` to a concrete index at operation creation time. If the array has 5 items, use `/items/5` instead of `/items/-`.

For simple append-only workflows where you never modify the appended items, `-` is fine.

## The JSONPatch Class

The `JSONPatch` class provides a fluent API for building patches:

```typescript
import { JSONPatch } from '@dabble/patches';

const patch = new JSONPatch()
  .add('/users/-', { id: 123, name: 'Alice' })
  .replace('/title', 'Updated Document')
  .remove('/metadata/draft')
  .move('/oldSection', '/archive/section1')
  .copy('/template', '/newSection')
  .test('/version', 5);
```

### Standard Operations

```typescript
// Add values
patch.add('/tags/-', 'collaborative'); // Append to array
patch.add('/user/address', { city: 'NYC' }); // Add object
patch.add('/count', 42); // Add primitive

// Remove values
patch.remove('/oldField');

// Replace values
patch.replace('/user/name', 'Bob');
patch.replace('/settings', { theme: 'dark' });

// Move values
patch.move('/temp/field', '/result/field');

// Copy values
patch.copy('/template', '/newItem');

// Test values (assertion - patch fails if value doesn't match)
patch.test('/user/id', 123);
```

### Custom Operations

These go beyond RFC 6902. They're designed for common collaborative editing patterns and work correctly with OT:

```typescript
// Increment/decrement numbers (no read-then-update race conditions)
patch.increment('/counter'); // +1
patch.increment('/points', 5); // +5
patch.decrement('/score', 10); // -10

// Min/max operations (great for timestamps like lastModifiedAt, createdAt)
patch.max('/lastSeen', '2024-01-15T10:00:00Z'); // Only updates if value is greater
patch.min('/firstSeen', '2024-01-01T00:00:00Z'); // Only updates if value is smaller

// Bitmask operations (pack up to 15 booleans in one number)
patch.bit('/permissions', 0, true); // Set bit 0 on
patch.bit('/permissions', 3, false); // Set bit 3 off
patch.bit('/flags', 7, true); // Set bit 7 on

// Rich text operations (Quill Delta format)
patch.text('/content', [
  { retain: 10 }, // Keep first 10 characters
  { delete: 5 }, // Delete next 5
  { insert: 'new text' }, // Insert this text
]);
```

### Why These Custom Operations Matter

Standard JSON Patch has a race condition problem. If two clients want to increment a counter:

1. Both read `counter: 5`
2. Both send `{ op: 'replace', path: '/counter', value: 6 }`
3. Final result: `counter: 6` (one increment lost)

The `@inc` operation solves this. Both clients send `increment by 1`, and OT composes them correctly. Same logic applies to `@bit`, `@max`, `@min`, and `@txt`.

### Utility Methods

```typescript
// Add raw operations
const moreOps = [{ op: 'add', path: '/tags/-', value: 'new' }];
patch.addUpdates({ field1: 'value1', field2: undefined }); // undefined = remove

// Apply the patch to a document (immutable)
const newState = patch.apply(currentState);

// Transform against another patch (OT)
const transformedPatch = patch.transform(otherPatch);

// Create inverse patch (for undo)
const undoPatch = patch.invert(originalState);

// Combine patches
const combined = patch.compose(laterPatch); // Collapse into fewer ops
const concatenated = patch.concat(anotherPatch); // Just append ops

// Serialization
const json = patch.toJSON();
const loaded = JSONPatch.fromJSON(json);
```

## The createJSONPatch Helper

Build patches with type-safe paths instead of string literals:

```typescript
import { createJSONPatch } from '@dabble/patches';

interface MyDoc {
  name: { first: string; last: string };
  age: number;
  tags: string[];
}

const patch = createJSONPatch<MyDoc>((patch, path) => {
  patch.replace(path.name.first, 'Bob'); // Type-safe: path is '/name/first'
  patch.increment(path.age, 1); // Type-safe: path is '/age'
  patch.add(path.tags[1], 'new-tag'); // Type-safe: path is '/tags/1'
});

console.log(patch.ops);
// [
//   { op: 'replace', path: '/name/first', value: 'Bob' },
//   { op: '@inc', path: '/age', value: 1 },
//   { op: 'add', path: '/tags/1', value: 'new-tag' }
// ]
```

The callback receives a `JSONPatch` instance and a path proxy. The proxy generates JSON Pointer strings as you access properties. TypeScript catches typos at compile time.

## Type-Safe Paths with createPathProxy

If you want just the path proxy without the callback pattern:

```typescript
import { createPathProxy, JSONPatch } from '@dabble/patches';

interface User {
  name: string;
  settings: { theme: string };
}

const path = createPathProxy<User>();
const patch = new JSONPatch()
  .replace(path.name, 'Alice') // '/name'
  .replace(path.settings.theme, 'dark'); // '/settings/theme'
```

The proxy throws errors if you try to set or delete properties directly. It's for path generation only. Use `JSONPatch` methods for mutations.

## Applying Patches

```typescript
import { applyPatch } from '@dabble/patches';

const doc = { name: 'Original', count: 5 };
const patch = [
  { op: 'replace', path: '/name', value: 'Updated' },
  { op: '@inc', path: '/count', value: 3 },
];

// Immutable application - original unchanged
const newDoc = applyPatch(doc, patch);
// Result: { name: 'Updated', count: 8 }

// Error handling
try {
  const result = applyPatch(doc, patch);
} catch (err) {
  console.error('Patch failed:', err.message);
  console.log('Failed at operation index:', err.index);
}
```

`applyPatch` creates a new document. The original stays untouched. This immutability is fundamental to how Patches handles state - see [Patches](Patches.md) for the bigger picture.

## Supported Operations

| Operation | Description                                                                                  |
| --------- | -------------------------------------------------------------------------------------------- |
| `add`     | Adds a value at the specified path. For arrays, inserts at the given index.                  |
| `remove`  | Removes the value at the specified path.                                                     |
| `replace` | Replaces the value at the specified path.                                                    |
| `move`    | Moves a value from one path to another.                                                      |
| `copy`    | Copies a value from one path to another.                                                     |
| `test`    | Asserts a value matches. Patch fails if it doesn't.                                          |
| `@inc`    | Increments (or decrements) a number. OT-safe: concurrent increments compose.                 |
| `@bit`    | Sets or clears a bit in a bitmask (indices 0-14). OT-safe: concurrent bit ops compose.       |
| `@max`    | Sets a value only if greater than current. Great for `lastModifiedAt` timestamps.            |
| `@min`    | Sets a value only if less than current. Great for `createdAt` timestamps.                    |
| `@txt`    | Applies a rich text delta (Quill Delta format). Full OT support for concurrent text editing. |

## OT Functions

For direct access to the transformation engine:

```typescript
import { transformPatch, invertPatch, composePatch } from '@dabble/patches';

// Transform otherOps against thisOps (thisOps happened first)
// Returns transformed version of otherOps
const transformed = transformPatch(currentState, thisOps, otherOps);

// Create an undo patch (requires the original state before patch was applied)
const undoPatch = invertPatch(originalState, patch);

// Collapse sequential operations into fewer operations
const collapsed = composePatch(ops);
```

These are the building blocks of the [OT system](operational-transformation.md). The [algorithms module](algorithms.md) uses them for rebasing client changes against server changes.

---

This JSON Patch implementation is battle-tested at scale. It handles documents with hundreds of thousands of operations. The custom operations (`@inc`, `@bit`, `@max`, `@min`, `@txt`) solve real problems that standard JSON Patch ignores.

Use it standalone for patch generation and application, or as part of the full Patches collaborative editing system.
