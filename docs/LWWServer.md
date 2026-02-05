# `LWWServer`

The central authority for your [LWW](last-write-wins.md) system.

`LWWServer` is the server-side implementation for Last-Write-Wins conflict resolution. Think of it as a referee who doesn't care about technique - just timestamps. Whoever has the later timestamp wins. Period. It's simpler than [OT](operational-transformation.md) because there's no transformation, no rebasing, no algorithmic gymnastics. Just timestamps.

**Table of Contents**

- [Overview](#overview)
- [When to Use LWW vs OT](#when-to-use-lww-vs-ot)
- [Initialization](#initialization)
- [Core Method: `commitChanges()`](#core-method-commitchanges)
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

| OTServer                         | LWWServer                              |
| -------------------------------- | -------------------------------------- |
| Stores change history            | Stores current field values            |
| Transforms concurrent operations | Compares timestamps                    |
| Complex rebasing logic           | Simple: later timestamp wins           |
| Best for collaborative editing   | Best for settings, preferences, status |

What `LWWServer` does:

1. **Timestamp Authority:** Assigns timestamps to operations that don't have them
2. **Field Storage:** Keeps track of field values and their timestamps
3. **LWW Resolution:** Uses the [`consolidateOps`](algorithms.md#consolidateops) algorithm to determine winners
4. **Delta Operations:** Converts special ops like `@inc` and `@bit` to concrete values
5. **Automatic Compaction:** Creates snapshots every N revisions to keep storage efficient
6. **Catchup Support:** Returns ops the client missed since their last known revision

## When to Use LWW vs OT

For the full breakdown, see [Last-Write-Wins: Simple Sync That Actually Works](last-write-wins.md). Here's the short version:

**Use LWW when:**

- Data doesn't need merging (settings, preferences, user status)
- "Last one to save wins" is the correct behavior
- You want simpler server logic and debugging
- Conflicts are rare or acceptable to resolve by timestamp

**Use [OT](operational-transformation.md) when:**

- Users edit the same content simultaneously (collaborative documents)
- You need to merge concurrent changes intelligently
- Conflict resolution needs to preserve everyone's work

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

3. **Consolidate Using LWW Rules**
   - Uses the [`consolidateOps`](algorithms.md#consolidateops) algorithm
   - For each incoming op, compares timestamps with existing values
   - Later timestamp wins. On ties, incoming wins.
   - Special handling for combinable ops (`@inc`, `@bit`, `@max`, `@min`)

4. **Parent Hierarchy Validation**
   - If you try to set `/user/name` but `/user` is a primitive, returns a correction op
   - Prevents invalid hierarchies (you can't have children under a string)

5. **Convert Delta Ops**
   - `@inc` ops become `replace` with computed sum
   - `@bit` ops become `replace` with combined bitmask
   - `@max`/`@min` ops become `replace` with the winning value

6. **Save Winning Ops**
   - Persists ops that won the timestamp comparison
   - Deletes child paths when parent is overwritten

7. **Compact if Needed**
   - Every `snapshotInterval` revisions, saves a snapshot
   - Keeps state reconstruction fast

8. **Build Catchup Response**
   - Returns ops the client missed since their `rev`
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

LWW versioning is **optional** - not all LWW documents need user-visible version history. If you do need it, your store must implement [`LWWVersioningStoreBackend`](#lwwversioningstorebackend-optional).

This is different from OT, where versioning is baked in via [PatchesHistoryManager](PatchesHistoryManager.md). LWW keeps it simple by default.

### `captureCurrentVersion()`

Manually capture a snapshot of the current document state as a named version.

```typescript
// Only works if store implements LWWVersioningStoreBackend
const versionId = await server.captureCurrentVersion('doc-123', {
  name: 'Before migration',
});
// Returns version ID (8-character string), or null if document doesn't exist
```

Throws an error if the store doesn't support versioning:

```typescript
// Error: LWW versioning requires a store that implements LWWVersioningStoreBackend
```

### Automatic Compaction

`LWWServer` automatically creates internal snapshots every `snapshotInterval` revisions. These aren't user-visible versions - they're for performance optimization. State reconstruction only needs to apply ops since the last snapshot, not rebuild from scratch.

Don't confuse these with user-visible versions. Internal snapshots are housekeeping; `captureCurrentVersion()` creates versions users can browse.

## Events

`LWWServer` emits signals when things happen. Use these to broadcast updates to connected clients. See the [networking docs](net.md) for how [PatchesSync](PatchesSync.md) handles the client side.

### `onChangesCommitted`

Fires after changes are successfully committed - specifically, when `opsToStore.length > 0` (when the server actually persisted new ops).

```typescript
server.onChangesCommitted.add((docId, changes, originClientId) => {
  // Broadcast to all subscribed clients except the origin
  broadcastToSubscribers(docId, changes, { exclude: originClientId });
});
```

Parameters:

- `docId`: The document that changed
- `changes`: Array of committed changes (always 1 for LWW). The change contains only the ops that were actually stored, not catchup ops.
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

### `LWWVersioningStoreBackend` (Optional)

Extends `LWWStoreBackend` with version creation:

```typescript
interface LWWVersioningStoreBackend extends LWWStoreBackend {
  createVersion(
    docId: string,
    versionId: string,
    state: any,
    rev: number,
    metadata?: EditableVersionMetadata
  ): Promise<void>;
}
```

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
server.onChangesCommitted.add((docId, changes, clientId) => {
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

## Related Documentation

- **[Last-Write-Wins](last-write-wins.md)** - Core LWW concepts, when to use LWW vs OT, client-server flow
- **[OTServer](OTServer.md)** - The OT equivalent for collaborative editing use cases
- **[Algorithms](algorithms.md)** - The `consolidateOps` and other pure functions under the hood
- **[JSON Patch](json-patch.md)** - Operation format specification
- **[JSON-RPC](json-rpc.md)** - Protocol for client-server communication
- **[Persistence](persist.md)** - Client-side storage options
- **[Networking](net.md)** - Transport layer and WebSocket setup
- **[Branching](branching.md)** - If you need LWW with branches, see [LWWBranchManager](PatchesBranchManager.md)
