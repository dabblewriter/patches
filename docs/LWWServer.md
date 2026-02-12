# `LWWServer`

The central authority for your [LWW](last-write-wins.md) system.

`LWWServer` is the server-side implementation for Last-Write-Wins conflict resolution. Think of it as a referee who doesn't care about technique - just timestamps. Whoever has the later timestamp wins. Period. It's simpler than [OT](operational-transformation.md) because there's no transformation, no rebasing, no algorithmic gymnastics. Just timestamps. And when you need collaborative rich text on specific fields, `@txt` ops give you Delta-based OT scoped to individual fields - no need to switch your whole document to full OT.

**Table of Contents**

- [Overview](#overview)
- [When to Use LWW vs OT](#when-to-use-lww-vs-ot)
- [Initialization](#initialization)
- [Core Method: `commitChanges()`](#core-method-commitchanges)
- [Rich Text Support (`@txt`)](#rich-text-support-txt)
- [Server-Side Changes with `change()`](#server-side-changes-with-change)
- [State Retrieval](#state-retrieval)
- [Document Lifecycle](#document-lifecycle)
- [Versioning](#versioning)
- [Events](#events)
- [Backend Store Dependency](#backend-store-dependency)
- [Example Usage](#example-usage)
- [Related Documentation](#related-documentation)

## Overview

`LWWServer` stores **fields with timestamps**, not changes. When conflicts occur, the later timestamp wins. That's the whole algorithm. No transformation wizardry required.

Key differences from [OTServer](OTServer.md):

| OTServer                         | LWWServer                                          |
| -------------------------------- | -------------------------------------------------- |
| Stores change history            | Stores current field values                        |
| Transforms concurrent operations | Compares timestamps (+ Delta OT for `@txt` fields) |
| Complex rebasing logic           | Simple: later timestamp wins                       |
| Best for collaborative editing   | Best for settings, preferences, status             |
| Full-document OT                 | Field-level LWW with opt-in rich text via `@txt`   |

What `LWWServer` does:

1. **Timestamp Authority:** Assigns timestamps to operations that don't have them
2. **Field Storage:** Keeps track of field values and their timestamps
3. **LWW Resolution:** Uses the [`consolidateOps`](algorithms.md#consolidateops) algorithm to determine winners
4. **Delta Operations:** Converts special ops like `@inc` and `@bit` to concrete values
5. **Rich Text (`@txt`):** Supports collaborative rich text editing via Delta OT when the store implements `TextDeltaStoreBackend`
6. **Automatic Compaction:** Creates snapshots every N revisions to keep storage efficient
7. **Catchup Support:** Returns ops the client missed since their last known revision

## When to Use LWW vs OT

For the full breakdown, see [Last-Write-Wins: Simple Sync That Actually Works](last-write-wins.md). Here's the short version:

**Use LWW when:**

- Data doesn't need merging (settings, preferences, user status)
- "Last one to save wins" is the correct behavior
- You want simpler server logic and debugging
- Conflicts are rare or acceptable to resolve by timestamp
- You need collaborative rich text on specific fields while keeping the rest of the document simple (use `@txt` ops - see [Rich Text Support](#rich-text-support-txt))

**Use [OT](operational-transformation.md) when:**

- Users edit the same content simultaneously (collaborative documents)
- You need to merge concurrent changes intelligently
- Conflict resolution needs to preserve everyone's work

> **Note:** LWW now supports collaborative rich text editing via `@txt` ops, so you don't need to switch to full OT just because some fields require character-level merging. If your document is mostly settings/preferences with a few rich text fields, LWW with `@txt` gives you the best of both worlds.

## Initialization

Create an `LWWServer` with a store that implements [`LWWStoreBackend`](#backend-store-dependency). You'll need to build your own backend implementation - see the [persistence docs](persist.md) for the client-side equivalents.

```typescript
import { LWWServer, LWWServerOptions } from '@dabble/patches/server';
import { MyLWWStore } from './my-store'; // Your backend implementation

// Instantiate your backend store
const store = new MyLWWStore(/* connection details, etc. */);

// Configure options (optional)
const options: LWWServerOptions = {
  // Create snapshots every N revisions (default: 200)
  snapshotInterval: 200,
};

const server = new LWWServer(store, options);
```

### Configuration Options

| Option             | Type     | Default | Description                                                                                                |
| ------------------ | -------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `snapshotInterval` | `number` | `200`   | Number of revisions between automatic snapshots. Lower values = more storage, faster state reconstruction. |

## Core Method: `commitChanges()`

This is where the LWW logic happens. Clients send changes, and this method figures out which values win based on timestamps.

```typescript
async commitChanges(
  docId: string,
  changes: ChangeInput[],
  options?: CommitChangesOptions
): Promise<Change[]>
```

### What Goes In

- **`docId`**: Which document are we changing?
- **`changes`**: An array of `ChangeInput` objects. LWW processes only the first change - if you send multiple, only `changes[0]` gets processed. This differs from OT which can batch multiple changes.
- **`options`**: Optional commit settings (currently ignored for LWW)

Each change contains ops with timestamps. See [JSON Patch operations](json-patch.md) for the full op specification.

```typescript
const change: ChangeInput = {
  id: 'change-123',
  rev: 5, // Client's last known revision
  ops: [
    { op: 'replace', path: '/name', value: 'Alice', ts: 1699900000000 },
    { op: 'replace', path: '/email', value: 'alice@example.com', ts: 1699900000000 },
  ],
};
```

### What Happens Inside

1. **Timestamp Assignment**
   - Ops without timestamps get the current server time (`Date.now()`)
   - This ensures all ops have a consistent timestamp basis

2. **Load Existing Ops**
   - Fetches all current field values from storage via `listOps()`

3. **Separate `@txt` Ops**
   - `@txt` ops are pulled out of the incoming change before LWW consolidation
   - Non-text ops proceed through standard LWW timestamp resolution
   - `@txt` ops are handled separately via Delta OT (see [Rich Text Support](#rich-text-support-txt))

4. **Consolidate Using LWW Rules**
   - Uses the [`consolidateOps`](algorithms.md#consolidateops) algorithm
   - For each incoming op, compares timestamps with existing values
   - Later timestamp wins. On ties, incoming wins.
   - Special handling for combinable ops (`@inc`, `@bit`, `@max`, `@min`)

5. **Parent Hierarchy Validation**
   - If you try to set `/user/name` but `/user` is a primitive, returns a correction op
   - Prevents invalid hierarchies (you can't have children under a string)

6. **Convert Delta Ops**
   - `@inc` ops become `replace` with computed sum
   - `@bit` ops become `replace` with combined bitmask
   - `@max`/`@min` ops become `replace` with the winning value

7. **Save Winning Ops**
   - Persists ops that won the timestamp comparison
   - Deletes child paths when parent is overwritten

8. **Process `@txt` Ops (if present)**
   - Transforms incoming deltas against concurrent server deltas from the delta log using Delta OT
   - Composes the transformed delta into the field store (which always holds the full composed text as a `replace` op)
   - Appends the transformed delta to the delta log for future transforms and client catchup
   - If a text field was deleted or overwritten by a non-`@txt` op in this commit, stale `@txt` ops fall back to LWW timestamp comparison
   - Requires [`TextDeltaStoreBackend`](#textdeltastorebackend-optional) -- without it, `@txt` ops fall back to regular LWW (timestamp-based replace, no character-level merge)

9. **Compact if Needed**
   - Every `snapshotInterval` revisions, saves a snapshot
   - Also prunes the text delta log (delta log isn't needed for state reconstruction since the field store has composed text)

10. **Build Catchup Response**
    - Returns ops the client missed since their `rev`
    - For text fields, returns `@txt` ops (composed deltas from the delta log) instead of full text values, so clients can transform against their local pending state
    - Filters out ops the client just sent (and their children)

### What Comes Out

Always returns an array containing exactly 1 change (or empty array if input was empty):

```typescript
[{
  id: 'change-123',        // Same ID as input
  baseRev: 5,              // Client's rev
  rev: 8,                  // New server revision
  ops: [...],              // Catchup ops + correction ops
  createdAt: 1699900000000,
  committedAt: 1699900001000,
}]
```

The response ops include:

- **Correction ops:** If the client's hierarchy was invalid (trying to write children under a primitive)
- **Catchup ops:** Field values changed since the client's last known revision, sorted by timestamp

### Error Handling

`commitChanges` might throw errors if:

- **Store Errors:** Backend storage issues (connection problems, etc.)
- **Invalid Operations:** Malformed ops that can't be processed

Unlike [OT](OTServer.md), there's no transformation failure or invalid `baseRev` errors - LWW is more forgiving since it just compares timestamps.

### Combinable Operations

Some operations combine rather than replace. This is the one place where LWW isn't purely "last write wins" - these ops are designed to merge intelligently:

| Op     | Behavior                                            |
| ------ | --------------------------------------------------- |
| `@inc` | Sums values: existing `5` + incoming `3` = `8`      |
| `@bit` | Combines bitmasks: `{ set: 0b0011, clear: 0b1100 }` |
| `@max` | Keeps the maximum value                             |
| `@min` | Keeps the minimum value                             |

These ops always combine regardless of timestamp:

```typescript
// Client A: @inc by 5
// Client B: @inc by 3
// Result: increment by 8 (not last-write-wins)
```

For more on these operations, see the [algorithms documentation](algorithms.md#lww-algorithms).

## Rich Text Support (`@txt`)

LWW is great for settings and preferences, but what about rich text? You don't want "last write wins" on an entire paragraph - you want character-level merging so two people can type in the same document without stomping on each other.

That's what `@txt` ops provide. While standard LWW fields use timestamp-based conflict resolution, `@txt` fields use **Delta-based Operational Transformation** for character-level merge of concurrent edits. You get the simplicity of LWW for most of your data, with real collaborative editing where you need it.

### How It Works

`@txt` ops carry a [Delta](https://quilljs.com/docs/delta/) (the same format used by Quill) describing text insertions, deletions, and formatting changes. Instead of replacing the entire field value, the server transforms concurrent deltas against each other - just like OT, but scoped to individual fields within an LWW document.

Here's the flow:

1. Client sends a change containing `@txt` ops (with a `rev` indicating the client's last known server revision)
2. Server separates `@txt` ops from regular LWW ops
3. Regular ops go through normal timestamp-based consolidation
4. `@txt` ops are transformed against any concurrent server deltas (deltas committed since the client's `rev`) using Delta OT
5. The transformed delta is composed into the field store (which always holds the current full text as a `replace` op)
6. The transformed delta is also appended to a delta log, used for future transforms and client catchup
7. The broadcast sends `@txt` ops (not the composed `replace`) so other clients can transform against their own local pending state

### The Two Storage Layers

For text fields, the server maintains two representations:

- **Field store** (via `LWWStoreBackend`): Always contains the current composed text as a `replace` op. This is the source of truth for state reconstruction - `getDoc()` just reads it like any other field.
- **Delta log** (via `TextDeltaStoreBackend`): Stores individual deltas with their revision numbers. Used for transforming incoming `@txt` ops and for `getChangesSince()` catchup.

The delta log is not required for state reconstruction. It's an optimization for collaborative editing. If you lose it, you lose the ability to transform concurrent edits and do incremental catchup, but the document state itself is safe in the field store.

### Enabling `@txt` Support

`@txt` support requires your store to implement [`TextDeltaStoreBackend`](#textdeltastorebackend-optional). If it doesn't, `@txt` ops silently fall back to regular LWW - the entire delta replaces the field value based on timestamps, with no character-level merging. This means you can start without text support and add it later without changing your client code.

```typescript
// Store WITHOUT TextDeltaStoreBackend:
// @txt ops treated as regular LWW replace ops (no merge)

// Store WITH TextDeltaStoreBackend:
// @txt ops get Delta OT transformation and character-level merge
```

### Text Field Deletion

When a text field is deleted or overwritten by a non-`@txt` op, the delta log for that field is pruned. If a stale `@txt` op arrives after the field has been deleted, it falls back to LWW timestamp comparison rather than attempting a delta transform against a field that no longer exists.

### Example: Collaborative Rich Text

```typescript
// Client A sends:
const changeA: ChangeInput = {
  id: 'change-a',
  rev: 5,
  ops: [
    { op: '@txt', path: '/content', value: [{ retain: 10 }, { insert: 'Hello ' }] },
  ],
};

// Client B sends concurrently:
const changeB: ChangeInput = {
  id: 'change-b',
  rev: 5, // Same base revision - these are concurrent
  ops: [
    { op: '@txt', path: '/content', value: [{ retain: 10 }, { insert: 'World ' }] },
  ],
};

// Server processes change A first:
// - No concurrent deltas since rev 5, so delta is applied as-is
// - Field store updated with composed text
// - Delta appended to log at rev 6

// Server processes change B:
// - Finds delta from rev 6 in the log (change A's delta)
// - Transforms change B's delta against it
// - Both insertions are preserved at the correct positions
// - Field store updated, delta appended at rev 7
```

Both edits are preserved. No one's work is lost. That's the whole point.

## Server-Side Changes with `change()`

Need to make changes from the server itself? Use the `change()` method:

```typescript
const change = await server.change<MyDoc>(
  docId,
  (patch, path) => {
    patch.replace(path.status, 'approved');
    patch.replace(path.approvedAt, Date.now());
  },
  { approvedBy: 'admin' }
); // Optional metadata

if (change) {
  console.log('Change committed:', change.rev);
}
// Returns null if the mutation made no actual changes
```

This creates a proper change with server timestamps, applies it through `commitChanges()`, and triggers the `onChangesCommitted` event for broadcasting.

## State Retrieval

### `getDoc()`

Get the current state of a document. Reconstructs state from the latest snapshot plus any ops changed since that snapshot.

```typescript
const { state, rev } = await server.getDoc('doc-123');
// { state: { name: 'Alice', settings: {...} }, rev: 47 }
```

Returns `{ state: {}, rev: 0 }` if the document doesn't exist. This matches the behavior of [OTServer.getDoc()](OTServer.md) for consistency across strategies.

### `getChangesSince()`

Get changes that occurred after a specific revision. Since LWW doesn't store change history (just current field values), this synthesizes a single change from stored ops.

```typescript
const changes = await server.getChangesSince('doc-123', 40);
// Returns 0 or 1 changes with all ops since revision 40
```

This is useful for clients reconnecting after being offline - they get one change with everything they missed. The ops in the returned change are sorted by timestamp so older ops apply first.

**Text field handling:** For fields with `@txt` history, `getChangesSince()` returns composed deltas from the delta log instead of the full text `replace` values from the field store. This allows reconnecting clients to transform those deltas against their own local pending state, preserving any edits they made while offline. Non-text fields still come from the field store as usual.

## Document Lifecycle

### `deleteDoc()`

Delete a document. Creates a tombstone (if the store supports [`TombstoneStoreBackend`](#tombstone-support-optional)) to inform late-connecting clients that the document was deleted rather than never existing.

```typescript
await server.deleteDoc('doc-123');

// Skip tombstone creation (for testing/migrations)
await server.deleteDoc('doc-123', { skipTombstone: true });
```

Emits `onDocDeleted` after deletion completes.

### `undeleteDoc()`

Remove the tombstone for a deleted document, allowing it to be recreated.

```typescript
const wasDeleted = await server.undeleteDoc('doc-123');
// true if tombstone was found and removed
// false if no tombstone existed
```

This is a recovery mechanism, not an undo. The document data is gone - you're just clearing the tombstone so a new document can be created with the same ID.

## Versioning

LWW versioning is **optional** - not all LWW documents need user-visible version history. If you do need it, your store must implement [`VersioningStoreBackend`](#versioningstorebackend-optional).

This is different from OT, where versioning is baked in via [PatchesHistoryManager](PatchesHistoryManager.md). LWW keeps it simple by default.

### `captureCurrentVersion()`

Manually capture a snapshot of the current document state as a named version.

```typescript
// Only works if store implements VersioningStoreBackend
const versionId = await server.captureCurrentVersion('doc-123', {
  name: 'Before migration',
});
// Returns version ID (8-character string), or null if document doesn't exist
```

Throws an error if the store doesn't support versioning:

```typescript
// Error: LWW versioning requires a store that implements VersioningStoreBackend
```

### Automatic Compaction

`LWWServer` automatically creates internal snapshots every `snapshotInterval` revisions. These aren't user-visible versions - they're for performance optimization. State reconstruction only needs to apply ops since the last snapshot, not rebuild from scratch.

Don't confuse these with user-visible versions. Internal snapshots are housekeeping; `captureCurrentVersion()` creates versions users can browse.

## Events

`LWWServer` emits signals when things happen. Use these to broadcast updates to connected clients. See the [networking docs](net.md) for how [PatchesSync](PatchesSync.md) handles the client side.

### `onChangesCommitted`

Fires after changes are successfully committed - specifically, when `opsToStore.length > 0` (when the server actually persisted new ops).

```typescript
server.onChangesCommitted.add((docId, changes, options, originClientId) => {
  // Broadcast to all subscribed clients except the origin
  broadcastToSubscribers(docId, changes, { exclude: originClientId });
});
```

Parameters:

- `docId`: The document that changed
- `changes`: Array of committed changes (always 1 for LWW). The change contains only the ops that were actually stored, not catchup ops.
- `options`: Optional commit options that were passed to `commitChanges` (e.g., `forceCommit`, `historicalImport`)
- `originClientId`: The client that made the change (for excluding from broadcast). Comes from server context, not the change itself.

### `onDocDeleted`

Fires when a document is deleted.

```typescript
server.onDocDeleted.add((docId, options, originClientId) => {
  // Notify subscribers the document is gone
  notifyDeletion(docId, { exclude: originClientId });
});
```

## Backend Store Dependency

`LWWServer` relies 100% on your implementation of the `LWWStoreBackend` interface. It doesn't do its own storage - it delegates all that to your backend.

For client-side storage, see the [persistence docs](persist.md). The server-side interfaces here are different because servers don't need the same pending/sending change lifecycle.

### `LWWStoreBackend` Interface

```typescript
interface LWWStoreBackend extends ServerStoreBackend {
  // Get current revision without reconstructing state
  getCurrentRev(docId: string): Promise<number>;

  // Get latest snapshot
  getSnapshot(docId: string): Promise<{ state: any; rev: number } | null>;

  // Save a snapshot (overwrites previous)
  saveSnapshot(docId: string, state: any, rev: number): Promise<void>;

  // List ops, optionally filtered
  listOps(docId: string, options?: ListFieldsOptions): Promise<JSONPatchOp[]>;

  // Save ops and atomically increment revision
  saveOps(docId: string, ops: JSONPatchOp[], pathsToDelete?: string[]): Promise<number>;

  // Delete document and all data (from ServerStoreBackend)
  deleteDoc(docId: string): Promise<void>;
}
```

### `ListFieldsOptions`

Two mutually exclusive filtering modes - use one or the other, not both:

```typescript
// Get fields changed since a revision
{ sinceRev: number }

// Get fields at specific paths
{ paths: string[] }
```

If you pass no options, `listOps()` returns all ops for the document.

### Implementation Requirements for `saveOps()`

This is the most critical method to get right. Your implementation must:

1. **Atomically increment** the document revision
2. **Set `rev`** on all saved ops to the new revision
3. **Delete child paths** when saving a parent (e.g., saving `/obj` deletes `/obj/name`)
4. **Delete paths in `pathsToDelete`** atomically with saving ops

If you can't do all of this atomically, you risk inconsistent state.

### `VersioningStoreBackend` (Optional)

The same `VersioningStoreBackend` interface used by OT. This means a single store backend can handle both OT and LWW versioning:

```typescript
interface VersioningStoreBackend {
  createVersion(docId: string, metadata: VersionMetadata, state: any, changes?: Change[]): Promise<void>;
  listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]>;
  loadVersionState(docId: string, versionId: string): Promise<any | undefined>;
  updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void>;
}
```

### `TextDeltaStoreBackend` (Optional)

To enable collaborative rich text editing via `@txt` ops, your store can implement `TextDeltaStoreBackend`. Without it, `@txt` ops fall back to regular LWW (timestamp-based replace, no character-level merge).

```typescript
interface TextDeltaStoreBackend {
  // Append a transformed delta to the log
  appendTextDelta(docId: string, path: string, delta: any[], rev: number): Promise<void>;

  // Get deltas for a specific path since a revision (for transforming incoming ops)
  getTextDeltasSince(docId: string, path: string, sinceRev: number): Promise<TextDeltaEntry[]>;

  // Get all deltas across all paths since a revision (for getChangesSince catchup)
  getAllTextDeltasSince(docId: string, sinceRev: number): Promise<TextDeltaEntry[]>;

  // Prune deltas at or before a revision (called during compaction)
  // If paths provided, only prune those paths (used when a text field is deleted)
  pruneTextDeltas(docId: string, atOrBeforeRev: number, paths?: string[]): Promise<void>;
}

interface TextDeltaEntry {
  path: string;
  delta: any[];
  rev: number;
}
```

#### SQL Schema

If you're implementing this with a relational database, here's a reference schema:

```sql
CREATE TABLE text_deltas (
  doc_id TEXT NOT NULL,
  path TEXT NOT NULL,
  rev INTEGER NOT NULL,
  delta JSON NOT NULL,
  PRIMARY KEY (doc_id, path, rev)
);

-- Index for getAllTextDeltasSince queries
CREATE INDEX idx_text_deltas_since ON text_deltas (doc_id, rev);
```

The primary key on `(doc_id, path, rev)` ensures one delta per path per revision. The index on `(doc_id, rev)` speeds up the `getAllTextDeltasSince` query used during client catchup.

#### Implementation Notes

- **`appendTextDelta`**: Called after each `@txt` op is transformed and applied. The `rev` is the revision assigned to the commit containing this delta.
- **`getTextDeltasSince`**: Must return deltas ordered by `rev` ascending. Used to transform incoming `@txt` ops against concurrent server history.
- **`getAllTextDeltasSince`**: Returns deltas across all paths, ordered by `rev`. Used by `getChangesSince()` to build catchup responses with `@txt` ops instead of full text values.
- **`pruneTextDeltas`**: Called during automatic compaction (snapshot creation) and when text fields are deleted. With `paths` specified, only those paths are pruned (e.g., when a text field is overwritten by a non-`@txt` op). Without `paths`, all deltas at or before the revision are pruned.

### Tombstone Support (Optional)

For soft-delete capabilities, your store can also implement `TombstoneStoreBackend`:

```typescript
interface TombstoneStoreBackend {
  createTombstone(tombstone: DocumentTombstone): Promise<void>;
  getTombstone(docId: string): Promise<DocumentTombstone | undefined>;
  removeTombstone(docId: string): Promise<void>;
}
```

This interface is shared with OT stores - same tombstone behavior for both strategies.

## Example Usage

### Basic Server Setup

```typescript
import { LWWServer } from '@dabble/patches/server';
import { MyLWWStore } from './my-store';

const store = new MyLWWStore({ connectionString: '...' });
const server = new LWWServer(store, { snapshotInterval: 100 });

// Listen for committed changes
server.onChangesCommitted.add((docId, changes, options, clientId) => {
  console.log(`Doc ${docId} updated by ${clientId}`);
  // Broadcast to other clients...
});
```

### Express Endpoint Example

```typescript
import express from 'express';
import { LWWServer } from '@dabble/patches/server';

const app = express();
const server = new LWWServer(store);

// Get document state
app.get('/docs/:id', async (req, res) => {
  const { state, rev } = await server.getDoc(req.params.id);
  res.json({ state, rev });
});

// Commit changes
app.post('/docs/:id/changes', async (req, res) => {
  const changes = await server.commitChanges(req.params.id, req.body.changes);
  res.json({ changes });
});

// Get changes since revision (for reconnecting clients)
app.get('/docs/:id/changes', async (req, res) => {
  const sinceRev = parseInt(req.query.since as string) || 0;
  const changes = await server.getChangesSince(req.params.id, sinceRev);
  res.json({ changes });
});

// Delete document
app.delete('/docs/:id', async (req, res) => {
  await server.deleteDoc(req.params.id);
  res.status(204).send();
});
```

### Using with JSON-RPC

`LWWServer` includes a static API definition for use with the [JSON-RPC server](json-rpc.md):

```typescript
import { JSONRPCServer } from '@dabble/patches/net';
import { LWWServer } from '@dabble/patches/server';

const server = new LWWServer(store);
const rpc = new JSONRPCServer();

// Register all LWW methods with access control
rpc.register(server, LWWServer.api);
// Registers: getDoc (read), getChangesSince (read), commitChanges (write),
//            deleteDoc (write), undeleteDoc (write)
```

The `api` definition maps method names to access levels. "read" methods can be called by any authenticated client; "write" methods may require additional authorization depending on your setup.

### LWW with Rich Text (`@txt`)

A document that mixes regular LWW fields with collaborative rich text:

```typescript
import { LWWServer } from '@dabble/patches/server';
import { MyLWWStoreWithTextDeltas } from './my-store';

// Store implements both LWWStoreBackend and TextDeltaStoreBackend
const store = new MyLWWStoreWithTextDeltas({ connectionString: '...' });
const server = new LWWServer(store);

// Regular LWW fields + rich text in the same document
const change: ChangeInput = {
  id: 'change-1',
  rev: 0,
  ops: [
    // Regular LWW fields - timestamp-based conflict resolution
    { op: 'replace', path: '/title', value: 'My Document', ts: Date.now() },
    { op: 'replace', path: '/status', value: 'draft', ts: Date.now() },

    // Rich text field - Delta OT for character-level merge
    { op: '@txt', path: '/body', value: [{ insert: 'Hello, world!' }] },
  ],
};

const result = await server.commitChanges('doc-1', [change]);
// /title and /status use LWW timestamps
// /body uses Delta OT - concurrent edits are merged character-by-character
```

When a client reconnects after being offline:

```typescript
// Client was last at revision 5, now server is at revision 12
const changes = await server.getChangesSince('doc-1', 5);

// changes[0].ops contains:
// - Regular fields: replace ops with current values (from field store)
// - Text fields: @txt ops with composed deltas (from delta log)
// The client can transform text deltas against its local pending state
```

## Related Documentation

- **[Last-Write-Wins](last-write-wins.md)** - Core LWW concepts, when to use LWW vs OT, client-server flow
- **[OTServer](OTServer.md)** - The OT equivalent for collaborative editing use cases
- **[Algorithms](algorithms.md)** - The `consolidateOps` and other pure functions under the hood
- **[JSON Patch](json-patch.md)** - Operation format specification
- **[JSON-RPC](json-rpc.md)** - Protocol for client-server communication
- **[Persistence](persist.md)** - Client-side storage options
- **[Networking](net.md)** - Transport layer and WebSocket setup
- **[Branching](branching.md)** - If you need LWW with branches, see [LWWBranchManager](PatchesBranchManager.md)
