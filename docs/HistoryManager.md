# `HistoryManager`

The `HistoryManager` class provides an API for querying the historical data of a document managed by the Patches OT system. It interacts with the backend store to retrieve information about past versions (snapshots) and committed server changes.

**Table of Contents**

- [Overview](#overview)
- [Initialization](#initialization)
- [Querying Versions](#querying-versions)
  - [`listVersions()`](#listversions)
  - [`getVersionMetadata()`](#getversionmetadata)
  - [`getStateAtVersion()`](#getstateatversion)
  - [`getChangesForVersion()`](#getchangesforversion)
  - [`getParentState()`](#getparentstate)
- [Querying Server Changes](#querying-server-changes)
  - [`listServerChanges()`](#listserverchanges)
- [Backend Store Dependency](#backend-store-dependency)
- [Example Usage](#example-usage)

## Overview

`HistoryManager` allows you to access the history created by `PatchServer`, enabling features such as:

- Displaying a version history UI.
- Reverting a document to a previous state.
- Auditing changes made over time.
- Debugging synchronization issues by examining past states and changes.

It operates by querying the data persisted by `PatchServer` via a `PatchStoreBackend` implementation.

## Initialization

You instantiate `HistoryManager` by providing the specific `docId` you want to query and an implementation of the [`PatchStoreBackend`](./operational-transformation.md#patchstorebackend).

```typescript
import {
  HistoryManager,
  PatchStoreBackend, // Your backend needs to implement this
} from 'patches-ot';
import { MyDatabaseStore } from './my-store'; // Your backend implementation

const store = new MyDatabaseStore(/* ... */);
const docIdToQuery = 'document-456';

const historyManager = new HistoryManager(docIdToQuery, store);
```

- **`docId`**: The ID of the document whose history you want to access.
- **`store`**: An object implementing the `PatchStoreBackend` interface, used to fetch historical data.

## Querying Versions

Versions represent snapshots ([`VersionMetadata`](./types.ts)) of the document state, typically created automatically by [`PatchServer`](./PatchServer.md) based on time gaps or session boundaries (see [`PatchServer Versioning`](./PatchServer.md#versioning)).

### `listVersions()`

Retrieves a list of [`VersionMetadata`](./types.ts) objects for the document, supporting various filters defined in [`PatchStoreBackendListVersionsOptions`](./types.ts).

```typescript
async listVersions(
    options?: PatchStoreBackendListVersionsOptions
): Promise<VersionMetadata[]>;

// Example: Get the 10 most recent versions (online or offline)
const recentVersions = await historyManager.listVersions({
    limit: 10,
    reverse: true // Sort by date descending
});

// Example: Get all offline versions created after a specific timestamp
const offlineSinceDate = await historyManager.listVersions({
    origin: 'offline',
    startDateAfter: timestampMillis
});
```

- Uses `store.listVersions()`.
- Options allow filtering by `origin` (`'online'`, `'offline'`, `'branch'`), `groupId`, date ranges (`startDateAfter`, `endDateBefore`), and controlling the number (`limit`) and order (`reverse`) of results.
- Returns an array of `VersionMetadata` objects, each containing information like `id`, `parentId`, `origin`, `startDate`, `endDate`, `baseRev`, and crucially, the _original_ `changes` included in that version and the final `state` snapshot.

### `getVersionMetadata()`

Loads the metadata ([`VersionMetadata`](./types.ts)) for a single, specific version by its unique ID.

```typescript
async getVersionMetadata(versionId: string): Promise<VersionMetadata | null>;

const specificVersionInfo = await historyManager.getVersionMetadata(someVersionId);
if (specificVersionInfo) {
    console.log('Version Origin:', specificVersionInfo.origin);
    console.log('Changes in version:', specificVersionInfo.changes);
}
```

- Uses `store.loadVersionMetadata()`.
- Returns the `VersionMetadata` object or `null` if the ID is not found.

### `getStateAtVersion()`

Loads the full document state snapshot associated with a specific version ID.

```typescript
async getStateAtVersion(versionId: string): Promise<any>;

const stateSnapshot = await historyManager.getStateAtVersion(someVersionId);
// Now you can display or use this historical state.
```

- Uses `store.loadVersionState()`.
- Returns the document state as it was at the `endDate` of that version.
- Throws an error if the version ID is not found or the state cannot be loaded.

### `getChangesForVersion()`

Loads the array of _original_ [`Change`](./types.ts) objects that were included in a specific version.

```typescript
async getChangesForVersion(versionId: string): Promise<Change[]>;

const originalChanges = await historyManager.getChangesForVersion(someVersionId);
// Useful for replaying the exact sequence of ops within an offline session, for example.
```

- Uses `store.loadVersionChanges()`.
- Returns an array of `Change` objects.
- Throws an error if the version ID is not found or changes cannot be loaded.

### `getParentState()`

A convenience method to get the state snapshot of the _parent_ of a given version. This is useful for visualizing the state _before_ a specific version's changes were applied.

```typescript
async getParentState(versionId: string): Promise<any | undefined>;

const stateBeforeVersion = await historyManager.getParentState(someVersionId);
if (stateBeforeVersion) {
    // Display the state just before 'someVersionId' occurred.
}
```

- First calls `getVersionMetadata()` to find the `parentId`.
- If a `parentId` exists, it calls `getStateAtVersion()` with that parent ID.
- Returns the parent state, or `undefined` if the version is the root version, has no parent, or if the parent state cannot be loaded.

## Querying Server Changes

These methods deal with the raw, linear sequence of committed server changes ([`Change`](./types.ts) objects), identified by their revision numbers.

### `listServerChanges()`

Lists the committed server [`Change`](./types.ts) objects based on revision number ranges ([`PatchStoreBackendListChangesOptions`](./types.ts)).

```typescript
async listServerChanges(
    options?: PatchStoreBackendListChangesOptions
): Promise<Change[]>;

// Example: Get changes from revision 101 to 110
const changesInRange = await historyManager.listServerChanges({
    startAfterRev: 100,
    endBeforeRev: 111
});

// Example: Get the last 5 committed changes
const lastFiveChanges = await historyManager.listServerChanges({
    limit: 5,
    reverse: true // Sort by rev descending
});
```

- Uses `store.listChanges()`.
- Options allow filtering by revision ranges (`startAfterRev`, `endBeforeRev`) and controlling the limit and order (`reverse`).
- Returns an array of committed `Change` objects, each containing the final applied `ops` and the server-assigned `rev`.

## Backend Store Dependency

Like [`PatchServer`](./PatchServer.md), `HistoryManager` relies entirely on a provided [`PatchStoreBackend`](./operational-transformation.md#patchstorebackend) implementation to fetch the historical data.

## Example Usage

See the [example in this document](#example-usage) and the [main README examples](../README.md#examples).

```typescript
import {
  HistoryManager,
  MyDatabaseStore, // Your implementation
} from 'patches-ot';

const store = new MyDatabaseStore(/* ... */);
const docId = 'my-collaborative-doc';
const history = new HistoryManager(docId, store);

async function displayVersionHistory() {
  try {
    console.log(`Fetching history for ${docId}...`);
    const versions = await history.listVersions({ limit: 20, reverse: true });

    if (!versions.length) {
      console.log('No versions found.');
      return;
    }

    console.log('Recent Versions:');
    for (const version of versions) {
      console.log(`- ID: ${version.id}`);
      console.log(`  Origin: ${version.origin} ${version.groupId ? `(Group: ${version.groupId})` : ''}`);
      console.log(
        `  Date Range: ${new Date(version.startDate).toISOString()} - ${new Date(version.endDate).toISOString()}`
      );
      console.log(`  Base Revision: ${version.baseRev}`);
      console.log(`  Num Changes: ${version.changes.length}`);

      // Optionally load full state for a specific version
      // const state = await history.getStateAtVersion(version.id);
      // console.log('  State Snapshot:', state);
    }
  } catch (error) {
    console.error('Error fetching version history:', error);
  }
}

async function findChangesAroundRevision(targetRev: number) {
  try {
    const changes = await history.listServerChanges({
      startAfterRev: targetRev - 3, // Get a few before
      limit: 5, // Get a few after
    });
    console.log(`Changes around revision ${targetRev}:`, changes);
  } catch (error) {
    console.error(`Error fetching changes around revision ${targetRev}:`, error);
  }
}

// Example calls
// displayVersionHistory();
// findChangesAroundRevision(150);
```
