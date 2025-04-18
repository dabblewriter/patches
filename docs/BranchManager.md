# `BranchManager`

The `BranchManager` class provides functionality for creating and managing document branches within the Patches OT system. Branching allows you to create a separate, editable copy of a document based on a specific point in its history, work on it independently, and potentially merge the changes back into the original document later.

**Table of Contents**

- [Overview](#overview)
- [Initialization](#initialization)
- [Core Methods](#core-methods)
  - [`createBranch()`](#createbranch)
  - [`listBranches()`](#listbranches)
  - [`mergeBranch()`](#mergebranch)
  - [`closeBranch()`](#closebranch)
- [Backend Store Dependency](#backend-store-dependency)
- [Example Usage](#example-usage)

## Overview

Branching is useful for scenarios like:

- **Feature Development:** Work on a new feature in a document without affecting the main version until it's ready.
- **Experimentation:** Try out significant changes without risk.
- **Review Processes:** Create a branch for review and merge approved changes.

`BranchManager` interacts with both the `PatchServer` (for merging) and a `BranchingStoreBackend` (for storing branch metadata and versioned document data).

## Initialization

You instantiate `BranchManager` by providing an implementation of the [`BranchingStoreBackend`](./operational-transformation.md#branchingstorebackend) and an instance of [`PatchServer`](./PatchServer.md).

```typescript
import {
  PatchServer,
  BranchManager,
  BranchingStoreBackend, // Your backend needs to implement this
} from '@dabble/patches';
import { MyDatabaseStore } from './my-store'; // Your backend implementation

const store = new MyDatabaseStore(/* ... */);
const server = new PatchServer(store);
const branchManager = new BranchManager(store, server);
```

- **`store`**: An object implementing the `BranchingStoreBackend` interface. This is where branch metadata and the branched document's data will be stored.
- **`patchServer`**: An instance of `PatchServer`, used by `mergeBranch` to submit the branch's changes back to the source document's OT history.

## Core Methods

### `createBranch()`

Creates a new branch from an existing document.

```typescript
async createBranch(
    docId: string,          // ID of the source document
    rev: number,            // Revision number on the source document to branch from
    branchName?: string,    // Optional name for the branch
    metadata?: Record<string, any> // Optional metadata for the branch
): Promise<string>;         // Returns the new document ID for the branch
```

**Steps:**

1.  Retrieves the state of the source document (`docId`) at the specified `rev` using `store.getStateAtRevision()`.
2.  Generates a new unique document ID (`branchDocId`) for the branch.
3.  Creates an initial version (`VersionMetadata` with `origin: 'branch'`) for the new `branchDocId`. This version's state is the state retrieved in step 1, and its `baseRev` is the source `rev`.
4.  Saves this initial version using `store.saveVersion()`.
5.  Creates a `Branch` metadata record containing information about the source document, revision, name, status ('open'), etc.
6.  Saves the `Branch` metadata using `store.createBranch()`.
7.  Returns the `branchDocId`.

The newly created branch document (`branchDocId`) can now be edited independently using `PatchDoc` and `PatchServer`, just like any other document.

### `listBranches()`

Retrieves metadata for all branches associated with a specific source document.

```typescript
async listBranches(docId: string): Promise<Branch[]>;
```

- Calls `store.listBranches(docId)` to fetch the `Branch` metadata records.
- Useful for displaying available branches to the user.

### `mergeBranch()`

Attempts to merge the changes made on a branch back into its original source document.

```typescript
async mergeBranch(branchId: string): Promise<Change[]>;
```

**Steps:**

1.  **Load Branch Info:** Loads the `Branch` metadata for `branchId` using `store.loadBranch()`.
2.  **Validation:** Checks if the branch exists and if its `status` is 'open'. Throws an error if not.
3.  **Get Branch Changes:** Retrieves all committed server changes (`Change` objects) made to the _branch document_ (`branchId`) since it was created, using `store.listChanges()`.
4.  **Handle No Changes:** If there are no changes on the branch, marks the branch as 'merged' and returns an empty array.
5.  **Prepare Changes for Server:** Maps the retrieved `branchChanges`. **Crucially**, it sets the `baseRev` for these changes to the revision number where the branch originally started on the _source_ document (`branch.branchedRev`).
6.  **Submit to PatchServer:** Submits the prepared `branchChanges` to the source document (`branch.branchedFromId`) using `patchServer.receiveChanges()`. The `PatchServer` handles the necessary Operational Transformation to integrate these changes correctly based on their `baseRev`.
7.  **Handle Merge Result:**
    - If `patchServer.receiveChanges()` succeeds, it returns the final `Change` object(s) committed to the source document.
    - If it fails (e.g., due to complex conflicts during transformation), an error is thrown.
8.  **Update Branch Status:** If the merge was successful, updates the branch's status to 'merged' using `store.updateBranch()`.
9.  **Return Committed Changes:** Returns the array of `Change` objects that were actually committed to the source document by the `PatchServer`.

**Important Note on Rebasing:** The current implementation assumes `PatchServer.receiveChanges` handles all necessary rebasing based on the provided `baseRev`. A more sophisticated `mergeBranch` implementation _might_ pre-emptively fetch changes made to the source document since the branch point and manually rebase the branch changes _before_ submitting them to `PatchServer`, potentially allowing for more granular conflict detection or resolution strategies if needed.

### `closeBranch()`

Updates the status of a branch (e.g., to 'closed', 'archived', 'abandoned').

```typescript
async closeBranch(branchId: string, status?: BranchStatus = 'closed'): Promise<void>;
```

- Calls `store.updateBranch(branchId, { status })` to persist the status change.
- This is typically called after a successful merge or if a branch is being discarded.

## Backend Store Dependency

`BranchManager` requires a backend store implementation that conforms to the `BranchingStoreBackend` interface. This interface extends `PatchStoreBackend` with methods specifically for managing branch metadata (`listBranches`, `loadBranch`, `createBranch`, `updateBranch`).

See [Backend Store Interface](./operational-transformation.md#backend-store-interface) for details.

## Example Usage

```typescript
import {
  PatchServer,
  BranchManager,
  HistoryManager,
  MyDatabaseStore, // Your implementation
} from '@dabble/patches';

const store = new MyDatabaseStore(/* ... */);
const server = new PatchServer(store);
const branchManager = new BranchManager(store, server);
const historyManager = new HistoryManager(store); // History often uses the same store

const sourceDocId = 'main-document-123';

async function setupBranch() {
  try {
    // 1. Get the latest revision of the source document
    const latestRev = await store.getLatestRevision(sourceDocId);

    // 2. Create a new branch from the latest revision
    const branchDocId = await branchManager.createBranch(sourceDocId, latestRev, 'feature-x-branch', {
      createdBy: 'user-abc',
    });
    console.log(`Created branch with ID: ${branchDocId}`);

    // 3. Now, clients can connect and edit the document with ID `branchDocId`
    // using PatchDoc and PatchServer like any other document.
  } catch (error) {
    console.error('Error creating branch:', error);
  }
}

async function mergeFeatureBranch(branchDocId: string) {
  try {
    console.log(`Attempting to merge branch ${branchDocId}...`);
    // 4. Merge the changes from the branch back to the source
    const committedChanges = await branchManager.mergeBranch(branchDocId);

    if (committedChanges.length > 0) {
      console.log(`Successfully merged branch ${branchDocId}. Committed changes on source:`, committedChanges);
      // Optionally broadcast these committedChanges to clients watching the source document
    } else {
      console.log(`Branch ${branchDocId} had no new changes to merge.`);
    }
  } catch (error) {
    console.error(`Error merging branch ${branchDocId}:`, error);
    // Handle merge conflicts or other errors
  }
}

async function listMyBranches() {
  const branches = await branchManager.listBranches(sourceDocId);
  console.log(`Branches for ${sourceDocId}:`, branches);
}

// Example calls
// setupBranch();
// listMyBranches();
// mergeFeatureBranch('branch-doc-id-xyz'); // Use the ID returned by createBranch
```
