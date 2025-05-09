# JSON Patch: The Ultimate Document Changer! 🔄

Wanna track and apply changes to JSON documents? That's what JSON Patch is all about! This library includes a full-featured implementation of the JSON Patch standard (RFC 6902) with some extra superpowers sprinkled on top!

**Table of Contents**

- [What is JSON Patch?](#what-is-json-patch)
- [The Awesome `JSONPatch` Class](#the-awesome-jsonpatch-class)
- [The Magical `createJSONPatch()` Helper](#the-magical-createjsonpatch-helper)
- [The Super Cool Proxy Approach](#the-super-cool-proxy-approach)
- [Applying Patches like a Pro](#applying-patches-like-a-pro)
- [Patch Operation Handlers](#patch-operation-handlers)
- [Advanced Patch Magic](#advanced-patch-magic)

## What is JSON Patch?

JSON Patch is like a recipe for changing JSON documents. Instead of sending the whole document every time something changes, you just send little instructions like:

- "Add this value here" ✨
- "Remove that part there" ❌
- "Replace this with that" 🔄
- "Move this over there" 🚚
- "Copy this to there" 📋
- "Check that this matches" ✅

It's super efficient, especially for large documents where you're only changing a tiny bit!

Each patch is an array of operations, and each operation has:

- An `op` (like "add", "remove", "replace")
- A `path` to where the change happens (like "/users/0/name")
- Usually a `value` (what to add or change to)
- Sometimes a `from` path (for move and copy operations)

## The Awesome `JSONPatch` Class

The `JSONPatch` class gives you a delightful way to build patches:

```typescript
import { JSONPatch } from '@dabble/patches';

// Create a shiny new patch
const patch = new JSONPatch()
  .add('/users/-', { id: 123, name: 'Alice' }) // Add a user to the end of the array
  .replace('/title', 'My Awesome Document') // Change the title
  .remove('/metadata/draft') // Remove the draft flag
  .move('/oldSection', '/archive/section1') // Move content to archive
  .copy('/template', '/newSection') // Clone a template
  .test('/version', 5); // Verify the version
```

### Standard Operations - The Basics!

```typescript
// Add stuff!
patch.add('/tags/-', 'collaborative'); // Add to an array
patch.add('/user/address', { city: 'NYC' }); // Add an object
patch.add('/count', 42); // Add a value

// Remove stuff!
patch.remove('/oldField'); // Bye bye field!

// Replace stuff!
patch.replace('/user/name', 'Bob'); // New name!
patch.replace('/settings', { theme: 'dark' }); // All new settings!

// Move stuff!
patch.move('/temp/field', '/result/field'); // Moving things around

// Copy stuff!
patch.copy('/template', '/newItem'); // Cloning!

// Test stuff!
patch.test('/user/id', 123); // Make sure value matches
```

### Custom Operations - The Power-Ups! 💪

Our JSON Patch adds some super useful custom operations:

```typescript
// Increment a number (no need to read-then-update!)
patch.increment('/counter'); // +1
patch.increment('/points', 5); // +5
patch.increment('/score', -10); // -10

// Bit operations - play with binary flags!
patch.bit('/permissions', 0b001); // OR operation (add a permission)
patch.bit('/permissions', 0b010, 'and'); // AND operation (check a permission)
patch.bit('/permissions', 0b100, 'xor'); // XOR operation (toggle a permission)

// Text operations - for collaborative text editing!
patch.text('/content', [
  { retain: 10 }, // Keep first 10 characters
  { delete: 5 }, // Delete next 5
  { insert: 'new text' }, // Insert this text
]);
```

### Utility Methods - The Toolbox! 🧰

`JSONPatch` comes with a bunch of handy methods:

```typescript
// Add more operations
const moreOps = [{ op: 'add', path: '/tags/-', value: 'new' }];
patch.addUpdates(moreOps);

// Apply the patch to a document
const newState = patch.apply(currentState);

// Transform this patch against another one (OT magic!)
const transformedPatch = patch.transform(otherPatch);

// Create the opposite patch (for undo!)
const undoPatch = patch.invert(originalState);

// Combine two patches into one
const combinedPatch = patch.compose(laterPatch);

// Merge patches
const bigPatch = patch.concat(anotherPatch);

// Convert to/from JSON
const patchData = patch.toJSON();
const loadedPatch = JSONPatch.fromJSON(patchData);
```

## The Magical `createJSONPatch()` Helper

Don't want to build operations by hand? Use this helper to generate a patch by comparing objects:

```typescript
import { createJSONPatch } from '@dabble/patches';

const before = { name: 'Alice', count: 5, tags: ['old'] };
const after = { name: 'Alice', count: 6, tags: ['old', 'new'] };

// Creates a patch with the minimal changes needed
const patch = createJSONPatch(before, after);
// Result: [
//   { op: 'replace', path: '/count', value: 6 },
//   { op: 'add', path: '/tags/-', value: 'new' }
// ]
```

This is perfect when you have a before and after state and need to figure out what changed!

## The Super Cool Proxy Approach

Want something even cooler? Use a proxy to track changes as you make them:

```typescript
import { createPatchProxy } from '@dabble/patches';

// Path Generation Mode (manual patch creation)
const obj = { users: [{ name: 'Alice' }], count: 0 };
const proxy = createPatchProxy(obj);

// These lines just build paths!
const path1 = proxy.users[0].name; // '/users/0/name'
const path2 = proxy.count; // '/count'

// Now create your patch
const patch = new JSONPatch().replace(path1, 'Alicia').increment(path2, 5);

// Automatic Patch Generation Mode
const [newObj, generatedPatch] = createPatchProxy(obj, true);

// Every change you make is tracked automatically!
newObj.users[0].name = 'Bob';
newObj.count = 10;
newObj.users.push({ name: 'Charlie' });
delete newObj.users[0].oldProp;

// generatedPatch now contains all these operations!
```

This proxy approach is pure magic - especially the automatic mode! Make changes naturally and get a patch for free! 🎁

## Applying Patches like a Pro

Need to apply a patch? We've got you covered:

```typescript
import { applyPatch } from '@dabble/patches';

const doc = { name: 'Original', count: 5 };
const patch = [
  { op: 'replace', path: '/name', value: 'Updated' },
  { op: 'increment', path: '/count', value: 3 },
];

// Apply the patch! (immutably - the original doesn't change)
const newDoc = applyPatch(doc, patch);
// Result: { name: 'Updated', count: 8 }

// Handle errors gracefully
try {
  const result = applyPatch(doc, patch);
} catch (err) {
  console.error('Patch failed:', err.message);
  console.log('Failed at operation:', err.index);
}
```

The `applyPatch` function:

- Creates a new document (immutable!)
- Validates the patch format
- Applies each operation in sequence
- Provides clear error messages if something goes wrong

## Patch Operation Handlers

Each operation type has its own handler that knows how to:

- **Apply** the operation to a document
- **Transform** it against other operations
- **Invert** it (for undo)
- **Validate** it has the correct format

This modular system makes it easy to add custom operations while maintaining all the OT functionality!

## Advanced Patch Magic

For the true JSON Patch wizards, we've got some standalone utilities:

```typescript
import { transformPatch, invertPatch, composePatch } from '@dabble/patches';

// Transform patch A against patch B (OT style)
const transformed = transformPatch(patchA, patchB);

// Create an undo patch
const undoPatch = invertPatch(patch, originalDoc);

// Combine sequential patches into one
const combined = composePatch(patchA, patchB);
```

### Supported Operations

| Operation | Description                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------- |
| `add`     | Adds a value at the specified path. For arrays, inserts at the given index.                         |
| `remove`  | Removes the value at the specified path. For arrays, removes the item at the given index.           |
| `replace` | Replaces the value at the specified path with a new value.                                          |
| `move`    | Moves a value from one path to another.                                                             |
| `copy`    | Copies a value from one path to another.                                                            |
| `test`    | Tests that a value at the specified path matches the provided value. Used for assertions.           |
| `@inc`    | Increments (or decrements) a number at the specified path by the given value.                       |
| `@bit`    | Sets or clears a specific bit in a bitmask at the specified path. Useful for compact boolean flags. |
| `@txt`    | Applies a rich text delta (e.g., Quill Delta) to a text field at the specified path.                |

These utilities are the core of our Operational Transformation engine - they make sure concurrent edits play nice together!

---

Even though our library is focusing more on the core OT functionality now, this JSON Patch implementation remains super powerful and battle-tested. You can use it standalone or as part of the full collaborative editing system!

Happy patching! 🩹✨
