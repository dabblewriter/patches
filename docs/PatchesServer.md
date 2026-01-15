# `PatchesServer`

Meet the boss of your OT system! 🏢

`PatchesServer` is the central authority that keeps everything running smoothly. It's like the air traffic controller for your collaborative documents – directing traffic, preventing collisions, and making sure everyone sees the same thing.

**Table of Contents**

- [Overview](#overview)
- [Initialization](#initialization)
- [Core Method: `commitChanges()`](#core-method-commitchanges)
- [Versioning](#versioning)
- [State and History Retrieval](#state-and-history-retrieval)
- [Subscription Operations](#subscription-operations)
- [Backend Store Dependency](#backend-store-dependency)
- [Example Usage](#example-usage)

## Overview

`PatchesServer` does **all the important stuff**:

1. **Central Authority:** It's the one source of truth that decides the correct order of operations
2. **Transformation:** Takes client changes and transforms them against other clients' changes so everything works perfectly
3. **State Management:** Keeps track of the real, authoritative document state and revision numbers
4. **Algorithm Integration:** Uses server-side algorithm functions for state retrieval and offline session handling
5. **Persistence:** Works with your backend store to save everything important
6. **Versioning:** Creates snapshots of document states at key moments (perfect for history features!)

## Initialization

Getting started is super easy. Just give `PatchesServer` a store that implements [`PatchesStoreBackend`](./operational-transformation.md#patchstorebackend) and some optional config options:

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

This is where the **magic happens**! When clients send changes, this method processes them, transforms them against concurrent changes, and makes sure everything stays in sync.

```typescript
async commitChanges(
  docId: string,
  changes: Change[],
  options?: CommitChangesOptions
): Promise<[Change[], Change[]]> {
    // ... implementation ...
}
```

### What Goes In

- **`docId`**: Which document are we changing?
- **`changes`**: An array of `Change` objects from a client with a `baseRev` property telling us what server revision they were based on
- **`options`**: Optional commit settings:
  - **`forceCommit`**: If `true`, save changes even if they result in no state modification. Useful for migrations where change history must be preserved exactly.

### What Happens Inside

The heavy lifting is handled by the `commitChanges` algorithm in `src/algorithms/server/commitChanges.ts`. Here's the workflow:

1. **Validation First!**
   - Is the changes array empty? (Returns `[]` if so)
   - Do all changes have the same `baseRev`?
   - Is the `baseRev` valid? (Not greater than the current server revision)

2. **Clean Up Changes**
   - Make sure no timestamps are from the future
   - Update each change's `rev` to be sequential (baseRev + 1, baseRev + 2, etc.)
   - Set the correct `baseRev` on each change

3. **Check for Version Snapshots**
   - Were these changes made after a long idle period? Create a new version if so!

4. **Filter Out Duplicates**
   - Have we already seen any of these changes? (Checked using their `id`)

5. **Handle Offline Work**
   - Did the client make these changes offline? Group them by time gaps
   - Create version snapshots for each offline session
   - Check if there are concurrent server changes to transform against:
     - **No concurrent changes (fast-forward):** Save changes directly with `origin: 'main'`
     - **Has concurrent changes (divergent):** Collapse offline changes and transform

6. **Transform Against Concurrent Changes** (if divergent)
   - Get any changes committed since `baseRev`
   - Transform the incoming ops against already-committed ops
   - This is where OT saves the day!

7. **Persist and Return**
   - Save the transformed changes to the store
   - Send back both committed changes by others AND the transformed version of the client's changes

### What Comes Out

- `Promise<[Change[], Change[]]>`: A tuple containing:
  - `committedChanges`: Changes already committed since the client's base revision
  - `transformedChanges`: The client's changes after transformation

### Error Handling

`commitChanges` might throw errors if:

- **Invalid `baseRev`:** Missing, inconsistent, or ahead of the server
- **Transformation Failure:** Something went wrong during OT transformation
- **Application Failure:** Couldn't apply the changes
- **Store Errors:** Backend store issues

If a client gets an error, they might need to resync with the server. Use `409 Conflict` for `baseRev` mismatches.

### Multi-Batch Uploads

Got a client submitting a ton of changes (maybe after being offline)? They can split them into multiple batches and include the same `batchId` in each batch. This helps with correct OT and versioning.

## Versioning

`PatchesServer` automatically creates version snapshots to make history tracking and offline work a breeze.

### Offline Snapshots

When a client submits changes after working offline (detected by time gaps between `createdAt` timestamps), the server generates snapshots to preserve the document state at key points in time.

- **Fast-forward (no concurrent changes):** Versions are created with `origin: 'main'` and `isOffline: true`. The offline changes become a seamless part of the main timeline.
- **Divergent (has concurrent changes):** Versions are created with `origin: 'offline-branch'` to indicate they diverged from main and required transformation.

### Online Snapshots

Each time the server processes changes, it checks if enough time has passed since the last change (based on `sessionTimeoutMinutes`). If so, it creates a new version snapshot.

### Configuration (`sessionTimeoutMinutes`)

Defaults to 30 minutes. This setting controls when new version snapshots are created for both offline and online changes. Adjust it to balance storage usage vs. version granularity.

## State and History Retrieval

Need to get document state or history? `PatchesServer` has you covered!

### `getDoc()`

Get the latest version of a document and changes since the last version.

```typescript
const { state, rev, changes } = await server.getDoc(docId);
// Perfect for initializing new clients!

// Want a specific revision? No problem:
const snapshot = await server.getDoc(docId, 50);
```

### `getVersionState()`

Get a snapshot of a specific version.

```typescript
const versionState = await server.getVersionState(docId, specificVersionId);
```

### `listVersions()`

List version metadata with tons of filtering options.

```typescript
// Get the last 10 divergent offline version snapshots (had concurrent changes)
const offlineBranchVersions = await server.listVersions(docId, {
  origin: 'offline-branch',
  limit: 10,
  reverse: true, // Latest first
  orderBy: 'startedAt',
});
```

## Subscription Operations

Manage which clients are subscribed to which documents.

### `subscribe()`

Sign a client up for updates on one or more documents.

```typescript
const subscribedIds = await server.subscribe(clientId, docId);
// Or subscribe to multiple docs at once:
const subscribedIds = await server.subscribe(clientId, [docId1, docId2]);
```

### `unsubscribe()`

Remove a client's subscriptions.

```typescript
const unsubscribedIds = await server.unsubscribe(clientId, docId);
// Or unsubscribe from multiple docs:
const unsubscribedIds = await server.unsubscribe(clientId, [docId1, docId2]);
```

## Backend Store Dependency

`PatchesServer` relies 100% on your implementation of the [`PatchesStoreBackend`](./operational-transformation.md#patchstorebackend) interface. It doesn't do its own storage – it delegates all that to your backend.

Check out the [Backend Store Interface](./operational-transformation.md#backend-store-interface) for all the methods you need to implement.

## Example Usage

See the [Simple Server Setup example in the main README.md](../README.md#simple-server-setup).

Also check the [Simple Client Setup example](../README.md#simple-client-setup) to see how clients interact with the server.
