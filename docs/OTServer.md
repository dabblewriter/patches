# `OTServer`

The central authority for your OT system. It decides which changes go where and in what order.

`OTServer` is the server-side brain of Operational Transformation. Think of it as the referee: clients send their changes, the server decides the official order, transforms conflicts, and tells everyone what actually happened.

**Table of Contents**

- [Overview](#overview)
- [Initialization](#initialization)
- [Core Method: `commitChanges()`](#core-method-commitchanges)
- [Server-Side Changes with `change()`](#server-side-changes-with-change)
- [Document Retrieval](#document-retrieval)
- [Document Deletion](#document-deletion)
- [Versioning](#versioning)
- [Events](#events)
- [Backend Store Dependency](#backend-store-dependency)
- [JSON-RPC API](#json-rpc-api)

## Overview

`OTServer` handles five responsibilities:

1. **Central Authority**: The one source of truth that decides the correct order of operations
2. **Transformation**: Takes client changes and transforms them against concurrent changes from other clients
3. **State Management**: Maintains the authoritative document state and revision numbers
4. **Versioning**: Creates snapshots of document states based on editing sessions
5. **Persistence**: Delegates storage to your [`OTStoreBackend`](#backend-store-dependency) implementation

For the conceptual background on how OT works, see [Operational Transformation](operational-transformation.md).

## Initialization

```typescript
import { OTServer } from '@dabble/patches/server';
import { MyDatabaseStore } from './my-store'; // Your OTStoreBackend implementation

const store = new MyDatabaseStore();

const server = new OTServer(store, {
  // Create version snapshots after 30 minutes of inactivity (default)
  sessionTimeoutMinutes: 30,
});
```

### Options

| Option                  | Type     | Default | Description                                                  |
| ----------------------- | -------- | ------- | ------------------------------------------------------------ |
| `sessionTimeoutMinutes` | `number` | `30`    | Minutes of inactivity before creating a new version snapshot |

## Core Method: `commitChanges()`

This is where the work happens. When clients send changes, this method processes them, transforms them against concurrent changes, and keeps everything in sync.

```typescript
async commitChanges(
  docId: string,
  changes: ChangeInput[],
  options?: CommitChangesOptions
): Promise<{ changes: Change[]; docReloadRequired?: true }>
```

### Parameters

- **`docId`**: The document identifier
- **`changes`**: Array of changes from the client, each with a `baseRev` indicating which server revision they were based on
- **`options`**: Optional settings:
  - **`forceCommit`**: Save changes even if they result in no state modification. Useful for migrations where change history must be preserved exactly.
  - **`historicalImport`**: Import historical changes, preserving their original timestamps.

### What Happens Inside

The heavy lifting is handled by the `commitChanges` [algorithm](algorithms.md) in `src/algorithms/server/commitChanges.ts`. Here's the workflow:

1. **Validate and Normalize**
   - Empty changes array? Returns `[]`
   - Ensures all changes have consistent `baseRev`
   - Clamps `createdAt` timestamps to not be in the future
   - Assigns sequential revision numbers

2. **Check for Version Snapshots**
   - If enough time has passed since the last change (based on `sessionTimeoutMinutes`), creates a new version

3. **Filter Duplicates**
   - Checks change IDs to prevent reprocessing already-committed changes

4. **Handle Offline Work**
   - Detects offline sessions by time gaps between changes
   - Creates version snapshots for offline editing sessions
   - Groups multi-batch uploads by `batchId`

5. **Transform Against Concurrent Changes**
   - If there are changes committed since the client's `baseRev`, transforms incoming changes against them
   - This is the core [OT transformation](operational-transformation.md#how-transformation-actually-works)

6. **Persist and Return**
   - Saves transformed changes to the store
   - Emits `onChangesCommitted` event for broadcasting
   - Returns combined array: catchup changes first, then the client's committed changes

### Return Value

Returns an object with:

- **`changes`**: Combined array — catchup changes from other clients first, then the client's own changes after transformation (with assigned revisions)
- **`docReloadRequired`** _(optional)_: `true` when the client's local state is stale and it must call `getDoc` before continuing. This happens when an offline-first client (`baseRev: 0`) commits changes to a document that already has server history — the server commits the changes but cannot inline all the missed history.

```typescript
const { changes, docReloadRequired } = await server.commitChanges(docId, myChanges);
if (docReloadRequired) {
  const snapshot = await server.getDoc(docId);
  // reload local state from snapshot
}
```

### Error Handling

`commitChanges` throws errors for:

- **Invalid `baseRev`**: Client's `baseRev` is ahead of server revision (client needs to reload)
- **Root-level replace on existing doc**: Prevents stale clients from accidentally wiping documents
- **Inconsistent `baseRev`**: All changes in a batch must have the same `baseRev`
- **Store errors**: Backend storage failures

When clients receive errors, they typically need to resync with the server. Use HTTP `409 Conflict` for `baseRev` mismatches.

### Multi-Batch Uploads

Clients with many offline changes can split them into multiple batches using the same `batchId`. The server groups these correctly for OT and versioning.

```typescript
// Client sends batches with the same batchId
await server.commitChanges(docId, batch1); // batchId: 'abc123'
await server.commitChanges(docId, batch2); // batchId: 'abc123'
await server.commitChanges(docId, batch3); // batchId: 'abc123'
```

### Offline-First Behavior

When a client that has never synced (`baseRev: 0`) commits changes to an existing document, the server rebases the client's changes to the current revision and commits them. Because the server cannot inline potentially thousands of historical changes in the commit response, it sets `docReloadRequired: true`. The client must then call `getDoc` to fetch the full current state before continuing.

## Server-Side Changes with `change()`

Need to make changes from the server itself? Use the `change()` method:

```typescript
const change = await server.change<MyDoc>(
  docId,
  draft => {
    draft.status = 'approved';
    draft.approvedAt = Date.now();
  },
  { approvedBy: 'admin' }
); // Optional metadata

if (change) {
  console.log('Change committed:', change.rev);
}
// Returns null if the mutation made no actual changes
```

This creates a proper change, applies it through the standard OT flow, and triggers the `onChangesCommitted` event for broadcasting.

## Document Retrieval

### `getDoc()`

Get the current state of a document as a streaming JSON envelope:

```typescript
const stream = await server.getDoc(docId);
// stream contains: {"state":...,"rev":N,"changes":[...]}
```

Returns a `ReadableStream<string>` that emits the full document envelope without parsing the state blob. The `state` field comes from the latest version snapshot; `changes` contains any changes committed after that snapshot. Reconstruct the current state by applying the changes on top of the state.

### `getChangesSince()`

Get all changes after a specific revision:

```typescript
const changes = await server.getChangesSince(docId, 50);
// Returns all changes with rev > 50
```

Useful for clients reconnecting after being offline.

## Document Deletion

### `deleteDoc()`

Delete a document and all its associated data:

```typescript
await server.deleteDoc(docId);

// Skip tombstone creation (for testing or when you don't need undelete)
await server.deleteDoc(docId, { skipTombstone: true });
```

If your store implements `TombstoneStoreBackend`, a tombstone record is created before deletion, enabling potential recovery.

### `undeleteDoc()`

Remove a tombstone to allow recreating a deleted document:

```typescript
const wasDeleted = await server.undeleteDoc(docId);
// Returns true if tombstone was found and removed
```

## Versioning

`OTServer` automatically creates version snapshots to make history tracking and offline work manageable.

### Session-Based Snapshots

When the server processes changes, it checks the time gap since the last change. If it exceeds `sessionTimeoutMinutes`, a new version snapshot is created. This naturally captures editing sessions.

### Offline Snapshots

When clients submit changes after working offline (detected by time gaps in `createdAt` timestamps), the server generates snapshots:

- **Fast-forward (no concurrent changes)**: Versions created with `origin: 'main'` and `isOffline: true`
- **Divergent (has concurrent changes)**: Versions created with `origin: 'offline-branch'` to indicate transformation was required

### `captureCurrentVersion()`

Manually capture a version snapshot:

```typescript
const versionId = await server.captureCurrentVersion(docId, {
  name: 'Before major refactor',
  description: 'Saving state before restructuring',
});
// Returns null if the document has no changes since the last version
```

For querying version history, use [PatchesHistoryManager](PatchesHistoryManager.md).

## Events

`OTServer` emits signals you can subscribe to:

### `onChangesCommitted`

Fires when changes are successfully committed. Use this to broadcast updates to other clients:

```typescript
server.onChangesCommitted((docId, changes, options, originClientId) => {
  // Broadcast to all clients except the sender
  broadcastToClients(docId, changes, { exclude: originClientId });
});
```

### `onDocDeleted`

Fires when a document is deleted:

```typescript
server.onDocDeleted((docId, options, originClientId) => {
  // Notify clients the document is gone
  notifyClientsDocDeleted(docId, { exclude: originClientId });
});
```

## Backend Store Dependency

`OTServer` requires an implementation of `OTStoreBackend`. It doesn't do its own storage - it delegates everything to your backend.

```typescript
interface OTStoreBackend extends ServerStoreBackend, VersioningStoreBackend {
  // Revision tracking
  getCurrentRev(docId: string): Promise<number>;

  // Change operations
  saveChanges(docId: string, changes: Change[]): Promise<void>;
  listChanges(docId: string, options: ListChangesOptions): Promise<Change[]>;

  // Version operations (inherited from VersioningStoreBackend)
  // The store is responsible for building and persisting version state from the
  // supplied changes — inline or queued — and must throw if state creation fails.
  createVersion(docId: string, metadata: VersionMetadata, changes?: Change[]): Promise<void>;
  listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]>;
  loadVersion(docId: string, versionId: string): Promise<VersionMetadata | undefined>;
  loadVersionState(docId: string, versionId: string): Promise<string | ReadableStream<string> | undefined>;
  loadVersionChanges?(docId: string, versionId: string): Promise<Change[]>;
  updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void>;

  // Document deletion (inherited from ServerStoreBackend)
  deleteDoc(docId: string): Promise<void>;
}
```

For tombstone support (soft delete with recovery), also implement `TombstoneStoreBackend`.

For branching support, implement `BranchingStoreBackend` and use [OTBranchManager](PatchesBranchManager.md).

See [persist.md](persist.md) for storage implementation guidance.

## JSON-RPC API

`OTServer` includes a static API definition for use with the JSON-RPC server:

```typescript
import { JSONRPCServer } from '@dabble/patches/net';
import { OTServer } from '@dabble/patches/server';

const rpcServer = new JSONRPCServer();
rpcServer.register(server, OTServer.api);
```

The API definition maps methods to required access levels:

| Method            | Access Level |
| ----------------- | ------------ |
| `getDoc`          | `read`       |
| `getChangesSince` | `read`       |
| `commitChanges`   | `write`      |
| `deleteDoc`       | `write`      |
| `undeleteDoc`     | `write`      |

See [json-rpc.md](json-rpc.md) for the JSON-RPC protocol details and [websocket.md](websocket.md) for WebSocket transport setup.
