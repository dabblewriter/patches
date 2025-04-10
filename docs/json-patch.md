<!-- Placeholder for JSON Patch documentation -->

# JSON Patch Implementation

This library includes a comprehensive implementation of JSON Patch (RFC 6902), along with utilities for creating, applying, and manipulating patches. It introduces a **Compact Patch Format** for efficiency and utilizes this format internally, especially for Operational Transformation (OT) functions.

**Table of Contents**

- [Overview](#overview)
- [Compact Patch Format](#compact-patch-format)
  - [Structure](#structure)
  - [Symbols](#symbols)
  - [Rationale](#rationale)
  - [Conversion](#conversion)
- [`JSONPatch` Class](#jsonpatch-class)
  - [Initialization](#initialization)
  - [Standard Operations](#standard-operations) (`add`, `remove`, `replace`, `move`, `copy`)
  - [Custom Operations](#custom-operations) (`increment`, `decrement`, `bit`, `text`)
  - [Utility Methods](#utility-methods) (`addUpdates`, `apply`, `transform`, `invert`, `compose`, `concat`, `toJSON`, `fromJSON`)
- [`createJSONPatch()` Helper](#createjsonpatch-helper)
- [`createPatchProxy()` Utility](#createpatchproxy-utility)
  - [Path Generation Mode](#path-generation-mode)
  - [Automatic Patch Generation Mode](#automatic-patch-generation-mode)
- [`applyPatch()` Function](#applypatch-function)
- [Operation Handlers](#operation-handlers)

## Overview

JSON Patch defines a format for describing changes to a JSON document. It uses an array of operation objects, each specifying an operation (like `add`, `remove`, `replace`), a target path (using JSON Pointer syntax), and optionally a value or a source path (`from`).

This library provides:

- A `JSONPatch` class offering a fluent API for building patches using the compact format internally.
- Functions like `createJSONPatch` and `createPatchProxy` for generating compact patches from object modifications.
- An `applyPatch` function to apply patches (standard or compact) immutably.
- Support for custom operations beyond the standard RFC 6902 set, integrated into the compact format.
- Implementations for OT functions (`transform`, `invert`, `compose`) operating on the compact patch format.

## Compact Patch Format

(`src/types.ts`, `src/json-patch/compactPatch.ts`)

To optimize for size and improved readability in development tools, this library primarily uses a compact representation for patch operations (`CompactPatchOp`).

### Structure

A compact operation is represented as a tuple:

```typescript
// CompactPatchOp type
[`<symbol><path>`, valueOrFrom?]
```

- **Element 0:** A string combining a single-character operation symbol and the JSON Pointer path.
- **Element 1 (Optional, not used in `remove`):** The `value` for `add`/`replace`/custom ops, or the `from` path for `move`/`copy`.

### Symbols

The following symbols map to standard and custom operations:

| Symbol | Operation | Description                                     |
| :----- | :-------- | :---------------------------------------------- |
| `+`    | `add`     | Add a value                                     |
| `=`    | `replace` | Replace a value                                 |
| `-`    | `remove`  | Remove a value                                  |
| `>`    | `move`    | Move a value from another path                  |
| `&`    | `copy`    | Copy a value from another path                  |
| `T`    | `@txt`    | Apply a text delta (e.g., from `@dabble/delta`) |
| `^`    | `@inc`    | Increment/decrement a numeric value             |
| `~`    | `@bit`    | Apply a bitmask operation                       |

### Rationale

- **Size:** More compact than the standard JSON Patch object format, reducing transmission size.
- **Processing:** Can sometimes be parsed or processed more efficiently internally.
- **Readability:** While different, the symbol+path combination can be quite readable once familiar.

### Conversion

Utilities are provided to convert between standard `JSONPatchOp` and `CompactPatchOp` arrays:

```typescript
import { Compact, JSONPatchOp, CompactPatchOp } from '@dabble/patches';

const standardOps: JSONPatchOp[] = [
  { op: 'replace', path: '/name', value: 'New Name' },
  { op: 'remove', path: '/oldField' },
];

const compactOps: CompactPatchOp[] = [['=/name', 'New Name'], ['-/oldField']];

// Convert standard JSON Patch to Compact format
const convertedToCompact: CompactPatchOp[] = Compact.from(standardOps);
console.log(convertedToCompact); // [['=/name', 'New Name'], ['-/oldField']]

// Convert Compact format back to standard JSON Patch
const convertedFromCompact: JSONPatchOp[] = Compact.toJSON(compactOps);
console.log(convertedFromCompact);
// [ { op: 'replace', path: '/name', value: 'New Name' },
//   { op: 'remove', path: '/oldField' } ]

// Functions are idempotent (return input if already in the target format)
console.log(Compact.from(compactOps) === compactOps); // true
console.log(Compact.toJSON(standardOps) === standardOps); // true
```

Most core functions like `applyPatch`, `transformPatch`, `invertPatch`, and `composePatch` now operate directly on the `CompactPatchOp[]` format. The `JSONPatch` class uses it internally.

## `JSONPatch` Class

(`src/json-patch/JSONPatch.ts`)

This class is the main way to work with patches programmatically.

### Initialization

```typescript
import { JSONPatch, JSONPatchOp, CompactPatchOp } from '@dabble/patches';

// Create an empty patch
const patch1 = new JSONPatch();
console.log(patch1.ops); // [] (Internally stores CompactPatchOp[])

// Create with initial standard operations (will be converted internally)
const initialOps: JSONPatchOp[] = [{ op: 'replace', path: '/name', value: 'Initial' }];
const patch2 = new JSONPatch(initialOps);
console.log(patch2.ops); // [['=/name', 'Initial']]

// Create with initial compact operations
const initialCompactOps: CompactPatchOp[] = [['+/tags/-', 'Urgent']];
const patch3 = new JSONPatch(initialCompactOps);
console.log(patch3.ops); // [['+/tags/-', 'Urgent']]

// Create with custom operation handlers (see Operation Handlers section)
// const patch4 = new JSONPatch([], { '@myOp': myCustomHandler });
```

The `JSONPatch` class stores operations internally as an array of `CompactPatchOp`. When initialized with standard `JSONPatchOp` objects, it automatically converts them using `Compact.from()`.

### Standard Operations

The class provides methods corresponding to standard JSON Patch operations. These methods generate and append `CompactPatchOp` entries to the internal `ops` array.

- **`add(path: PathLike, value: any, options?: WriteOptions): this`**
  Adds an `add` operation.
  ```typescript
  patch.add('/tags/-', 'new');
  // Appends: ['+/tags/-', 'new']
  patch.add('/user/profile', { bio: '...' }, { soft: true });
  // Appends: ['+/user/profile', { bio: '...' }, 1]
  ```
- **`remove(path: PathLike): this`**
  Adds a `remove` operation.
  ```typescript
  patch.remove('/obsoleteField');
  // Appends: ['-/obsoleteField']
  ```
- **`replace(path: PathLike, value: any, options?: WriteOptions): this`**
  Adds a `replace` operation.
  ```typescript
  patch.replace('/config/timeout', 500);
  // Appends: ['=/config/timeout', 500]
  ```
- **`copy(from: PathLike, to: PathLike, options?: WriteOptions): this`**
  Adds a `copy` operation.
  ```typescript
  patch.copy('/user/name', '/backup/userName');
  // Appends: ['&/backup/userName', '/user/name']
  ```
- **`move(from: PathLike, to: PathLike): this`**
  Adds a `move` operation.
  ```typescript
  patch.move('/temporary/data', '/permanent/data');
  // Appends: ['>/permanent/data', '/temporary/data']
  ```

_Note on `PathLike`:_ The `path` and `from` arguments in these methods accept a `PathLike` type, which is defined as `string | { toString(): string }`. This means you can provide either:

- A standard JSON Pointer string (e.g., `'/user/name'`, `'/items/0/id'`). If the string doesn't start with `/`, it will be automatically prefixed.
- An object that has a `toString()` method returning a valid JSON Pointer string. This is primarily used with the type-safe path builder generated by [`createJSONPath()`](#path-generation-mode) (e.g., `pathProxy.user.name.toString()` results in `'/user/name'`).

_Note on `WriteOptions`:_ The `soft` option can sometimes allow `add`/`replace`/`copy` operations to proceed even if intermediate objects in the path don't exist, potentially avoiding errors in specific backend implementations, but use with caution as it deviates from strict RFC behavior.

### Custom Operations

These provide convenient methods for common custom operations included in the library:

- **`increment(path: PathLike, value: number = 1): this`**
  Adds an `@inc` operation (`^`).
  ```typescript
  patch.increment('/counter');
  patch.increment('/score', 10);
  // Appends: ['^/counter', 1]
  // Appends: ['^/score', 10]
  ```
- **`decrement(path: PathLike, value: number = 1): this`**
  Adds an `@inc` operation (`^`) with a negative value.
  ```typescript
  patch.decrement('/remaining', 5);
  // Appends: ['^/remaining', -5]
  ```
- **`bit(path: PathLike, index: number, on: boolean): this`**
  Adds an `@bit` operation (`~`).
  ```typescript
  patch.bit('/flags', 3, true);
  patch.bit('/flags', 0, false);
  // Appends: ['~/flags', 8]  // Value is the generated bitmask
  // Appends: ['~/flags', 32768]
  ```
- **`text(path: PathLike, delta: Delta | Op[]): this`**
  Adds an `@txt` operation (`T`).
  ```typescript
  // import { Delta } from '@dabble/delta';
  const delta = new Delta().insert('Hello');
  patch.text('/textContent', delta);
  // Appends: ['T/textContent', { ops: [{ insert: 'Hello'}] }]
  ```

### Utility Methods

- **`addUpdates(updates: { [key: string]: any }, pathPrefix: string = '/'): this`**
  Generates `replace` (`=`) or `remove` (`-`) compact operations for each key-value pair.
  ```typescript
  patch.addUpdates({ title: 'New', status: undefined }, '/doc');
  // Appends: ['=/doc/title', 'New']
  // Appends: ['-/doc/status']
  ```
- **`apply<T>(obj: T, options?: ApplyJSONPatchOptions): T`**
  Applies the patch's internal compact operations (`this.ops`) to the given object `obj`. Returns the new state. See [`applyPatch()`](#applypatch-function).
- **`transform(otherPatch: JSONPatch | JSONPatchOp[] | CompactPatchOp[], obj?: any): JSONPatch`**
  Transforms another patch (standard or compact) against this one's compact operations, assuming this patch happened first. Requires the original object state `obj` for accuracy. Uses logic from `transformPatch` which operates on compact patches. Returns a _new_ `JSONPatch` instance containing the transformed operations in compact format.
- **`invert(obj: any): JSONPatch`**
  Generates an inverse patch in compact format. Requires the object state `obj` _before_ this patch was applied. Uses logic from `invertPatch`. Returns a _new_ `JSONPatch` instance.
- **`compose(patch?: JSONPatch | JSONPatchOp[] | CompactPatchOp[]): JSONPatch`**
  Composes compact operations within this patch (and optionally another patch, which is converted to compact if necessary) into a more concise form. Uses logic from `composePatch`. Returns a _new_ `JSONPatch` instance.
- **`concat(patch: JSONPatch | JSONPatchOp[] | CompactPatchOp[]): JSONPatch`**
  Combines the compact operations from this patch and another (converting the other to compact if needed) into a single new patch. Returns a _new_ `JSONPatch` instance.
- **`toJSON(): CompactPatchOp[]`**
  Returns a copy of the internal array of operations in `CompactPatchOp` format. Note: Despite the name, this returns the compact format, not the standard `JSONPatchOp` format.
- **`static fromJSON<T>(this: { new (...) }, ops?: JSONPatchOp[] | CompactPatchOp[], custom?: JSONPatchOpHandlerMap): T`**
  Creates a new `JSONPatch` instance from an array of standard or compact operations (converting standard ops to compact internally).

## `createJSONPatch()` Helper

(`src/json-patch/createJSONPatch.ts`)

This function provides an Immer-like API for generating patches.

```typescript
import { createJSONPatch } from '@dabble/patches';

const myObj = { user: { name: 'Alice' }, count: 10, items: ['apple'] };

const patch = createJSONPatch(myObj, (draft, p) => {
  // Modify the draft object directly
  draft.user.name = 'Bob';
  draft.items.push('banana');
  delete draft.count;

  // Optionally, call methods on the patch instance `p` for custom ops
  // p.increment(p.path(draft).count); // Need a way to get path for custom ops
});

// `patch` now contains the generated operations in compact format:
console.log(patch.ops);
// [ ['=/user/name', 'Bob'],
//   ['+/items/1', 'banana'],
//   ['-/count'] ]
```

- It takes the initial `target` object and an `updater` function.
- The `updater` receives a mutable `proxy` (draft) of the target and a `JSONPatch` instance.
- Modifications to the `proxy` automatically generate `add`/`remove`/`replace` operations in **compact format** on the `JSONPatch` instance.
- You can also directly use the passed `patch` instance inside the updater to add standard or custom operations (which will also be stored in compact format).
- Returns the `JSONPatch` instance containing all generated compact operations.
- Uses [`createPatchProxy()`](#createpatchproxy-utility) internally.

## `createPatchProxy()` Utility

(`src/json-patch/patchProxy.ts`)

This is the underlying mechanism used by `createJSONPatch`. It can be used directly in two modes:

### Path Generation Mode

If called with just a type parameter, it creates a proxy where property access builds a JSON Pointer path string, accessible via `toString()`. This remains unchanged.

```typescript
import { createJSONPath } from '@dabble/patches'; // Note: Renamed from createPatchProxy for path generation

interface Config {
  settings: { timeout: number };
}

const configPath = createJSONPath<Config>();
const pathString = configPath.settings.timeout.toString(); // "/settings/timeout"

console.log(pathString);

// Usage with JSONPatch (still generates compact op)
const patch = new JSONPatch();
patch.replace(configPath.settings.timeout, 60);
console.log(patch.ops); // [['=/settings/timeout', 60]]
```

### Automatic Patch Generation Mode

If called with a `target` object and a `JSONPatch` instance, it creates a proxy that automatically generates **compact** patch operations when modified.

```typescript
import { createPatchProxy, JSONPatch } from '@dabble/patches'; // Use createPatchProxy for this mode

const data = { value: 1 };
const patch = new JSONPatch();
// Create proxy linked to the patch instance
const proxy = createPatchProxy(data, patch);

proxy.value = 2; // Automatically calls patch.replace('/value', 2) -> adds ['=/value', 2] to patch.ops

console.log(patch.ops); // [['=/value', 2]]
```

## `applyPatch()` Function

(`src/json-patch/applyPatch.ts`)

Applies an array of patch operations (either standard `JSONPatchOp[]` or `CompactPatchOp[]`) to an object immutably.

```typescript
import { applyPatch, JSONPatchOp, CompactPatchOp } from '@dabble/patches';

const doc = { name: 'A', count: 1 };

// Can apply standard operations (will be converted)
const standardOps: JSONPatchOp[] = [{ op: 'replace', path: '/name', value: 'B' }];
const result1 = applyPatch(doc, standardOps);
console.log(result1.doc); // { name: 'B', count: 1 }

// Can apply compact operations directly
const compactOps: CompactPatchOp[] = [['^/count', 1]]; // Increment count
const result2 = applyPatch(result1.doc, compactOps);

if (result2.errors.length > 0) {
  console.error('Patch failed:', result2.errors);
} else {
  console.log(result2.doc); // { name: 'B', count: 2 }
  console.log(doc); // { name: 'A', count: 1 } (original unchanged)
}
```

- Takes the `object`, `patches` array (standard or compact), optional `options`, and optional `custom` handlers.
- If `patches` are standard `JSONPatchOp[]`, they are converted internally to `CompactPatchOp[]` using `Compact.from()`.
- Returns `{ doc: T, errors: any[] }` where `doc` is the new state and `errors` is an array of any errors encountered during application.
- **Immutability:** Attempts to preserve object identity for parts of the tree that are not modified.
- **Options:**
  - `strict`: Throws on the first error.
  - `rigid`: Stops processing and returns the original object on the first error.
  - `createMissingObjects`: Allows `add`/`replace` to create necessary parent objects/arrays.
  - `atPath`: Applies all operations relative to a base path.

## Operation Handlers

(`src/json-patch/ops/`)

The library defines handlers for each standard and custom operation. These handlers contain the core logic for applying, inverting, transforming, and composing operations. They are designed to work with the **`CompactPatchOp`** format internally.

- `apply(state, path, value, from?, createMissingObjects?)`: Logic to apply the operation (receives parts derived from the compact op).
- `invert(state, op: CompactPatchOp, ...)`: Logic to generate the inverse compact operation.
- `transform(state, thisOp: CompactPatchOp, otherOps: CompactPatchOp[])`: Logic to transform concurrent compact `otherOps` against `thisOp`.
- `compose(state, value1, value2)`: (Optional) Logic to combine two consecutive operations (values derived from compact ops).

You can provide your own custom handlers when creating `JSONPatch` instances or using `applyPatch`.

See [`Operational Transformation > Operation Handlers`](./operational-transformation.md#operation-handlers) for more on their role in OT.
