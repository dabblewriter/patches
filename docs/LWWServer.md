# `LWWServer`

The central authority for your [LWW](last-write-wins.md) system.

`LWWServer` is the server-side implementation for Last-Write-Wins conflict resolution. Think of it as a referee who doesn't care about technique - just timestamps. Whoever has the later timestamp wins. Period. It's simpler than [OT](operational-transformation.md) because there's no transformation, no rebasing, no algorithmic gymnastics. Just timestamps.

**Table of Contents**

- [Overview](#overview)
- [When to Use LWW vs OT](#when-to-use-lww-vs-ot)
- [Initialization](#initialization)
- [Core Method: `commitChanges()`](#core-method-commitchanges)
- [Retries and Idempotency](#retries-and-idempotency)
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

| OTServer                         | LWWServer                              |
| -------------------------------- | -------------------------------------- |
| Stores change history            | Stores current field values            |
| Transforms concurrent operations | Compares timestamps                    |
| Complex rebasing logic           | Simple: later timestamp wins           |
| Best for collaborative editing   | Best for settings, preferences, status |

What `LWWServer` does:

1. **Timestamp Authority:** Assigns timestamps to operations that don't have them, and clamps every client timestamp to at most server time
2. **Retry Dedup:** Drops changes it already committed, when the store records change ids (see [Retries and Idempotency](#retries-and-idempotency))
3. **Field Storage:** Keeps track of field values and their timestamps
4. **LWW Resolution:** Uses the [`consolidateOps`](algorithms.md#consolidateops) algorithm to determine winners
5. **Delta Operations:** Converts special ops like `@inc` and `@bit` to concrete values
6. **Automatic Compaction:** Creates snapshots every N revisions to keep storage efficient
7. **Catchup Support:** Returns ops the client missed since their last known revision

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

| Option             | Type     | Default | Description                                                                                                                                                                                                                  |
| ------------------ | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshotInterval` | `number` | `200`   | Number of revisions between automatic snapshots. Lower values = more storage, faster state reconstruction.                                                                                                                   |
| `changeIdTTL`      | `number` | 30 days | How long committed change ids are retained for retry dedup, in ms. Only used when the store implements `seenChangeIds()`. Keep it long enough to cover offline clients that restart and retry a persisted change days later. |

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

1. **Retry Dedup** (only when the store implements `seenChangeIds()`)
   - Changes whose ids the store already committed are dropped instead of re-applied
   - The response still echoes the committed ops for the paths they touched, so a retrying client converges
   - See [Retries and Idempotency](#retries-and-idempotency)

2. **Timestamp Assignment and Clamping**
   - Ops without timestamps get the change's `createdAt`, falling back to server time
   - Every timestamp is clamped to at most server time. A client with a fast clock can't stamp a value ten minutes into the future and wedge that field against every other writer

3. **Load Existing Ops**
   - Fetches all current field values from storage via `listOps()`

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
   - Records the fresh change ids in the same `saveOps()` call, so ids and ops commit or fail together
   - Deletes child paths when parent is overwritten

8. **Compact if Needed**
   - Every `snapshotInterval` revisions, saves a snapshot
   - Keeps state reconstruction fast

9. **Build Catchup Response**
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

## Retries and Idempotency

LWW compacts ops per path and keeps no change log. Great for storage. Terrible for retries.

Here's the failure: a client commits a change, the server applies it, and the ack gets lost (network drop, server restart, laptop lid). The client retries the same change. [OT](OTServer.md) shrugs this off because its change log retains ids and the duplicate is recognized. LWW has no such log. For `replace` ops the replay is harmless. For delta ops (`@inc`, `@bit`, `@max`, `@min`) it double-counts: increment a counter by 5, retry, and you've incremented by 10.

The fix is a short-term memory of committed change ids. When the store implements `seenChangeIds()`, `commitChanges()`:

1. Asks the store which incoming change ids it already committed
2. Drops those changes instead of re-applying them
3. Echoes the currently committed ops for the paths they touched, so the retrying client confirms its sending layer and converges on the server's value
4. Records the ids of fresh changes in the same `saveOps()` call that persists their ops

Step 4's atomicity is not optional. If ids were persisted in a separate call, a crash between the two could ack the ops but lose the ids, silently re-enabling the double-apply on the next retry.

Ids are retained for `changeIdTTL` (default 30 days). That sounds long, and it should be: an offline client can persist a sending change, sit closed for a week, then restart and retry it. Expiry is the backend's job. The server passes `expireAt` alongside every batch of ids so implementations can use a database TTL index or prune lazily.

One caveat: ids are only recorded when `saveOps()` runs. A change whose ops all lose the timestamp comparison stores nothing and records nothing. That's fine: replaying it just loses again.

If your store does not implement `seenChangeIds()`, nothing changes: no dedup, and retried delta ops re-apply exactly as before.

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
server.onChangesCommitted((docId, changes, options, originClientId) => {
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
server.onDocDeleted((docId, options, originClientId) => {
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

  // Save ops and atomically increment revision; changeIds (when given) must
  // persist in the same transaction as the ops
  saveOps(docId: string, ops: JSONPatchOp[], pathsToDelete?: string[], changeIds?: CommittedChangeIds): Promise<number>;

  // Optional: which of these change ids were committed and have not expired?
  // Implementing this enables retry dedup (see Retries and Idempotency)
  seenChangeIds?(docId: string, ids: string[]): Promise<string[]>;

  // Delete document and all data (from ServerStoreBackend)
  deleteDoc(docId: string): Promise<void>;
}

interface CommittedChangeIds {
  ids: string[];
  expireAt: number; // Unix ms after which the ids may be discarded (TTL index hint)
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
5. **Persist `changeIds.ids`** (when provided) in the same transaction as the ops. A separate write can ack the ops and lose the ids, silently re-enabling double-applied retries.

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
server.onChangesCommitted((docId, changes, options, clientId) => {
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
