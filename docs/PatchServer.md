# `PatchServer`

The `PatchServer` class is the central authority in the Patches OT system. It resides on the server and is responsible for receiving changes from clients, transforming them against concurrent edits, applying them to the authoritative document state, managing revisions, creating version snapshots, and persisting data via a backend store.

**Table of Contents**

- [Overview](#overview)
- [Initialization](#initialization)
- [Core Method: `receiveChanges()`](#core-method-receivechanges)
  - [Input](#input)
  - [Processing Steps](#processing-steps)
  - [Output](#output)
  - [Error Handling](#error-handling)
- [Versioning](#versioning)
  - [Offline Snapshots](#offline-snapshots)
  - [Online Snapshots](#online-snapshots)
  - [Configuration (`sessionTimeoutMinutes`)](#configuration-sessiontimeoutminutes)
- [State and History Retrieval](#state-and-history-retrieval)
  - [`getLatestDocumentStateAndRev()`](#getlatestdocumentstateandrev)
  - [`getStateAtRevision()`](#getstateatrevision)
  - [`getVersionMetadata()`](#getversionmetadata)
  - [`listVersions()`](#listversions)
- [Backend Store Dependency](#backend-store-dependency)
- [Example Usage](#example-usage)

## Overview

Key responsibilities of `PatchServer`:

1.  **Central Authority:** Defines the canonical order of operations.
2.  **Transformation:** Ensures concurrent client changes converge correctly using OT.
3.  **State Management:** Maintains the authoritative document state and revision number.
4.  **Persistence:** Interacts with a `PatchStoreBackend` to save/load document data, changes, and versions.
5.  **Versioning:** Creates snapshots (`VersionMetadata`) of the document state, particularly useful for offline support and history features.

## Initialization

You instantiate `PatchServer` by providing an implementation of the [`PatchStoreBackend`](./operational-transformation.md#patchstorebackend) (or [`BranchingStoreBackend`](./operational-transformation.md#branchingstorebackend) if using branching features) and optional configuration.

```typescript
import { PatchServer, PatchServerOptions } from 'patches-ot';
import { MyDatabaseStore } from './my-store'; // Your backend implementation

// Instantiate your backend store
const store = new MyDatabaseStore(/* connection details, etc. */);

// Configure options (optional)
const options: PatchServerOptions = {
  // Create version snapshots if gap between ops in a batch > 15 mins
  sessionTimeoutMinutes: 15,
};

const server = new PatchServer(store, options);
```

## Core Method: `receiveChanges()`

This is the main entry point for processing changes submitted by clients.

```typescript
async receiveChanges(docId: string, changes: Change[]): Promise<Change[]> {
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
    - Retrieves the server's current revision (`currentRev`) for the `docId` from the store.
    - Throws an error if `baseRev` is invalid (e.g., > `currentRev`), indicating the client needs to sync/rebase.
2.  **Offline Version Snapshotting (Internal):**
    - If the incoming `changes` batch contains significant time gaps between operations (based on `sessionTimeoutMinutes`), it creates `VersionMetadata` snapshots with `origin: 'offline'`. These capture the state and original operations of distinct editing sessions within the batch.
3.  **Load Concurrent History:**
    - If `baseRev < currentRev`, it fetches all server-committed `Change` objects from the store that occurred _after_ `baseRev` (`historicalChanges`).
4.  **Transformation:**
    - Extracts all individual JSON Patch operations (`ops`) from the incoming client `changes`.
    - If `historicalChanges` exist, it iteratively transforms the client `ops` over the `ops` of each historical change using the `transformPatch` function. This adjusts the client `ops` to account for the concurrent server history.
5.  **Apply Transformed Operations:**
    - Applies the final, transformed `ops` to the server's current authoritative state for the document.
    - If the transformation resulted in an empty set of `ops` (meaning the client's changes were entirely cancelled out or made redundant by concurrent edits), the process stops here, and an empty array `[]` is prepared as the result.
6.  **Commit and Save:**
    - If the application was successful and resulted in changes:
      - Increments the server's revision number (`newRev = currentRev + 1`).
      - Creates a _single_, new `Change` object (`committedServerChange`) containing:
        - A new server-generated `id`.
        - The final, _transformed_ `ops` that were actually applied.
        - The new server revision (`rev: newRev`).
        - The original `baseRev` from the client batch.
        - A server timestamp (`created`).
        - Metadata linking back to the original client `Change` IDs.
      - Saves this `committedServerChange` to the backend store using `store.saveChange()`.
7.  **Online Version Snapshotting (Internal):**
    - Checks if enough time has passed since the last version snapshot was created (based on `sessionTimeoutMinutes`). If so, it creates and saves a new `VersionMetadata` snapshot with `origin: 'online'`, containing the `committedServerChange` and the resulting `finalState`.
8.  **Return Result:**
    - Returns an array containing the single `committedServerChange` if changes were applied.
    - Returns an empty array `[]` if the client's batch resulted in a no-op after transformation.

### Output

- `Promise<Change[]>`: A promise that resolves to:
  - An array containing the single, newly committed server `Change` object if the client's batch resulted in a state change.
  - An empty array `[]` if the client's batch was transformed into a no-op.

### Error Handling

`receiveChanges` throws errors in several situations:

- **Invalid `baseRev`:** If the client's `baseRev` is missing, inconsistent within the batch, or ahead of the server's revision.
- **Transformation Failure:** If the underlying `transformPatch` or specific operation transform handlers encounter an error.
- **Application Failure:** If applying the final transformed `ops` fails (e.g., due to an invalid patch operation that survived transformation).
- **Store Errors:** If interactions with the backend store fail.

Clients should handle these errors, typically by informing the user and potentially triggering a state resynchronization with the server.
A `409 Conflict` HTTP status code is often appropriate for `baseRev` mismatches.

## Versioning

`PatchServer` automatically creates version snapshots ([`VersionMetadata`](./types.ts)) to facilitate history tracking and understanding offline edits.

- See [`HistoryManager`](./HistoryManager.md) for querying versions.

### Offline Snapshots

When `receiveChanges` processes a batch potentially representing offline work (indicated by time gaps between `created` timestamps within the `changes` array exceeding `sessionTimeoutMinutes`), it generates one or more `VersionMetadata` objects with `origin: 'offline'`. Each snapshot:

- Is linked via a common `groupId` specific to that batch.
- Has a `parentId` linking it to the previous snapshot within the same batch.
- Stores the `baseRev` of the _entire_ batch.
- Stores the _original_ (untransformed) `Change` objects for that specific session within the batch.
- Stores the document `state` as it was _after_ applying those original changes to the state at `baseRev`.

### Online Snapshots

After successfully committing a change (from any client), `PatchServer` checks if `sessionTimeoutMinutes` has elapsed since the _last_ version snapshot (of any origin) was saved. If the timeout is exceeded, it creates a single `VersionMetadata` object with `origin: 'online'`.

- `parentId` links to the previous version snapshot.
- `groupId` is typically `null`.
- `baseRev` is the server revision _before_ the current commit.
- `changes` contains the single `committedServerChange`.
- `state` is the document state _after_ applying the `committedServerChange`.
- `startDate` and `endDate` are both set to the commit timestamp.

### Configuration (`sessionTimeoutMinutes`)

The `sessionTimeoutMinutes` option passed during `PatchServer` construction controls the threshold for creating both offline and online version snapshots. The default is 30 minutes.

## State and History Retrieval

`PatchServer` provides methods (which typically delegate to the backend store) for retrieving document state and version information. These are often used in conjunction with [`HistoryManager`](./HistoryManager.md).

### `getLatestDocumentStateAndRev()`

Fetches the most recent committed state and its corresponding revision number.

```typescript
const { state, rev } = await server.getLatestDocumentStateAndRev(docId);
// Use this to initialize new clients
```

### `getStateAtRevision()`

Retrieves the document state as it was _after_ a specific historical revision `rev` was committed. Requires the backend store to be able to reconstruct or retrieve this state (e.g., from version snapshots or by replaying changes).

```typescript
const pastState = await server.getStateAtRevision(docId, 50);
```

### `getVersionMetadata()`

Loads the metadata for a single version snapshot by its unique `versionId`.

```typescript
const versionInfo = await server.getVersionMetadata(docId, specificVersionId);
```

### `listVersions()`

Lists `VersionMetadata` objects, supporting various filtering and sorting options (limit, reverse, origin, date ranges, etc.). See [`PatchStoreBackendListVersionsOptions`](./types.ts).

```typescript
// Get the last 10 offline version snapshots
const offlineVersions = await server.listVersions(docId, {
  origin: 'offline',
  limit: 10,
  reverse: true, // Latest first
});
```

## Backend Store Dependency

`PatchServer` is entirely dependent on a functional implementation of the [`PatchStoreBackend`](./operational-transformation.md#patchstorebackend) interface provided during construction. It does not manage persistence itself but delegates all storage operations (saving/loading states, changes, versions) to the backend.

See [Backend Store Interface](./operational-transformation.md#backend-store-interface) for details.

## Example Usage

See the [Simple Server Setup example in the main README.md](../README.md#simple-server-setup).
Also see related client example: [Simple Client Setup example in the main README.md](../README.md#simple-client-setup).
