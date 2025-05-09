# `PatchesServer`

The `PatchesServer` class is the central authority in the Patches OT system. It resides on the server and is responsible for receiving changes from clients, transforming them against concurrent edits, applying them to the authoritative document state, managing revisions, creating version snapshots, and persisting data via a backend store.

**Table of Contents**

- [Overview](#overview)
- [Initialization](#initialization)
- [Core Method: `commitChanges()`](#core-method-commitchanges)
  - [Input](#input)
  - [Processing Steps](#processing-steps)
  - [Output](#output)
  - [Error Handling](#error-handling)
  - [Multi-Batch Uploads and `batchId`](#multi-batch-uploads-and-batchid)
- [Versioning](#versioning)
  - [Offline Snapshots](#offline-snapshots)
  - [Online Snapshots](#online-snapshots)
  - [Configuration (`sessionTimeoutMinutes`)](#configuration-sessiontimeoutminutes)
- [State and History Retrieval](#state-and-history-retrieval)
  - [`getDoc()`](#getdoc)
  - [`_getStateAtRevision()`](#_getstateatrevision)
  - [`getVersionState()`](#getversionstate)
  - [`listVersions()`](#listversions)
- [Subscription Operations](#subscription-operations)
- [Backend Store Dependency](#backend-store-dependency)
- [Example Usage](#example-usage)

## Overview

Key responsibilities of `PatchesServer`:

1.  **Central Authority:** Defines the canonical order of operations.
2.  **Transformation:** Ensures concurrent client changes converge correctly using OT.
3.  **State Management:** Maintains the authoritative document state and revision number.
4.  **Persistence:** Interacts with a `PatchesStoreBackend` to save/load document data, changes, and versions.
5.  **Versioning:** Creates snapshots (`VersionMetadata`) of the document state, particularly useful for offline support and history features.

## Initialization

You instantiate `PatchesServer` by providing an implementation of the [`PatchesStoreBackend`](./operational-transformation.md#patchstorebackend) (or [`BranchingStoreBackend`](./operational-transformation.md#branchingstorebackend) if using branching features) and optional configuration.

```typescript
import { PatchesServer, PatchesServerOptions } from '@dabble/patches/server';
import { MyDatabaseStore } from './my-store'; // Your backend implementation

// Instantiate your backend store
const store = new MyDatabaseStore(/* connection details, etc. */);

// Configure options (optional)
const options: PatchesServerOptions = {
  // Create version snapshots if gap between ops in a batch > 15 mins
  sessionTimeoutMinutes: 15,
};

const server = new PatchesServer(store, options);
```

## Core Method: `commitChanges()`

This is the main entry point for processing changes submitted by clients.

```typescript
async commitChanges(docId: string, changes: Change[]): Promise<[Change[], Change[]]> {
    // ... implementation ...
}
```

### Input

- **`docId`**: The unique identifier of the document being modified.
- **`changes`**: An array of `Change` objects from a single client batch. Critically, each `Change` object _must_ include a `baseRev` property indicating the server revision the client based these changes upon.

### Processing Steps

1.  **Validation:**
    - Checks if the `changes` array is empty (returns `[]` if so).
    - Validates that all `changes` in the batch share the same, valid `baseRev`.
    - Retrieves the server's current state and revision (`currentState` and `currentRev`) for the `docId` using `_getSnapshotAtRevision()`.
    - Throws an error if `baseRev` is invalid (e.g., > `currentRev`), indicating the client needs to sync/rebase.
2.  **Ensure Changes Integrity:**
    - Ensures all changes' `created` timestamps are not in the future
    - Updates each change's `rev` field to be sequential, starting from `baseRev + 1`
    - Makes sure each change has the correct `baseRev` set
3.  **Version Snapshot Check:**
    - Checks if the last change was created more than a session ago (based on `sessionTimeoutMinutes`) and if so, creates a new version
4.  **Check for Duplicates:**
    - Fetches committed changes that occurred after `baseRev`
    - Filters out any incoming changes that have already been committed (based on their `id`)
5.  **Offline Session Handling:**
    - Checks if the first incoming change was created longer than a session timeout ago
    - If it's an offline session, groups changes into sessions based on time gaps
    - Creates version snapshots for each offline session with `origin: 'offline'`
    - Collapses offline changes into a single change for transformation
6.  **Transformation:**
    - Fetches the state at the client's `baseRev`
    - Transforms the incoming changes' operations against the operations of changes committed since `baseRev` using `transformPatch`
7.  **Return Result:**
    - Returns the committed changes followed by successfully transformed incoming changes

### Output

- `Promise<[Change[], Change[]]>`: A promise that resolves to a tuple containing:
  - `committedChanges`: An array of changes that were already committed to the server after the client's base revision. These changes are returned to help the client catch up with the server state.
  - `transformedChanges`: An array of changes that have been transformed against any concurrent changes. These changes can be applied to the client's state to bring it up to date with the server.

### Error Handling

`commitChanges` throws errors in several situations:

- **Invalid `baseRev`:** If the client's `baseRev` is missing, inconsistent within the batch, or ahead of the server's revision.
- **Transformation Failure:** If the underlying `transformPatch` or specific operation transform handlers encounter an error.
- **Application Failure:** If applying the changes fails.
- **Store Errors:** If interactions with the backend store fail.

Clients should handle these errors, typically by informing the user and potentially triggering a state resynchronization with the server.
A `409 Conflict` HTTP status code is often appropriate for `baseRev` mismatches.

### Multi-Batch Uploads and `batchId`

When a client needs to submit a large set of changes (for example, after working offline or making a very large edit), it may split the changes into multiple batches for upload. To ensure correct operational transformation and versioning, all changes that belong to the same logical batch should include the same `batchId` property (a unique string, typically generated by the client at the start of the edit session).

When `commitChanges` processes a batch potentially representing offline work (indicated by time gaps between `created` timestamps within the `changes` array exceeding `sessionTimeoutMinutes`), it generates one or more version snapshots to preserve the document state at key points in time.

When `commitChanges` processes a new set of changes, it checks if `sessionTimeoutMinutes` has elapsed since the last change was created. If the timeout is exceeded, it creates a new version using the `_createVersion` method.

## Versioning

`PatchesServer` automatically creates version snapshots ([`VersionMetadata`](./types.ts)) to facilitate history tracking and understanding offline edits.

- See [`PatchesHistoryManager`](./PatchesHistoryManager.md) for querying versions.

### Offline Snapshots

When `commitChanges` processes a batch potentially representing offline work (indicated by time gaps between `created` timestamps within the `changes` array exceeding `sessionTimeoutMinutes`), it generates one or more version snapshots to preserve the document state at key points in time.

### Online Snapshots

When `commitChanges` processes a new set of changes, it checks if `sessionTimeoutMinutes` has elapsed since the last change was created. If the timeout is exceeded, it creates a new version using the `_createVersion` method.

- It captures the current state and all changes since the last version
- Assigns a unique `id` for the version
- Sets the version metadata including `name` (if provided), `origin: 'main'`, and timestamps
- Records the `rev` and `baseRev` values from the changes
- Stores this version using the backend store

### Configuration (`sessionTimeoutMinutes`)

The `sessionTimeoutMinutes` option passed during `PatchesServer` construction controls the threshold for creating both offline and online version snapshots. The default is 30 minutes.

## State and History Retrieval

`PatchesServer` provides methods (which typically delegate to the backend store) for retrieving document state and version information.

### `getDoc()`

Gets the latest version of a document and changes since the last version.

```typescript
const { state, rev, changes } = await server.getDoc(docId);
// Use this to initialize new clients

// You can also specify a revision to get the state at that revision:
const snapshot = await server.getDoc(docId, 50);
```

### `_getStateAtRevision()`

Retrieves the document state as it was _after_ a specific historical revision `rev` was committed. This is an internal method used by other PatchesServer methods.

```typescript
const { state, rev } = await server._getStateAtRevision(docId, 50);
```

### `getVersionState()`

Gets the state snapshot for a specific version ID.

```typescript
const versionState = await server.getVersionState(docId, specificVersionId);
```

### `listVersions()`

Lists `VersionMetadata` objects, supporting various filtering and sorting options (limit, reverse, origin, date ranges, etc.).

```typescript
// Get the last 10 offline version snapshots
const offlineVersions = await server.listVersions(docId, {
  origin: 'offline',
  limit: 10,
  reverse: true, // Latest first
  orderBy: 'startDate',
});
```

## Subscription Operations

PatchesServer provides methods for managing client subscriptions to documents.

### `subscribe()`

Subscribes a client to one or more documents.

```typescript
const subscribedIds = await server.subscribe(clientId, docId);
// or with multiple document IDs:
const subscribedIds = await server.subscribe(clientId, [docId1, docId2]);
```

### `unsubscribe()`

Unsubscribes a client from one or more documents.

```typescript
const unsubscribedIds = await server.unsubscribe(clientId, docId);
// or with multiple document IDs:
const unsubscribedIds = await server.unsubscribe(clientId, [docId1, docId2]);
```

## Backend Store Dependency

`PatchesServer` is entirely dependent on a functional implementation of the [`PatchesStoreBackend`](./operational-transformation.md#patchstorebackend) interface provided during construction. It does not manage persistence itself but delegates all storage operations (saving/loading states, changes, versions) to the backend.

See [Backend Store Interface](./operational-transformation.md#backend-store-interface) for details.

## Example Usage

See the [Simple Server Setup example in the main README.md](../README.md#simple-server-setup).
Also see related client example: [Simple Client Setup example in the main README.md](../README.md#simple-client-setup).
