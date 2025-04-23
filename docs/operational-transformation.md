# Operational Transformation in Patches

This document provides an overview of how Operational Transformation (OT) is implemented and used within the Patches library.

**Table of Contents**

- [Core Concepts](#core-concepts)
  - [Centralized Authority](#centralized-authority)
  - [Rebasing](#rebasing)
  - [Linear History](#linear-history)
  - [Changes and Revisions](#changes-and-revisions)
- [Client-Server Interaction](#client-server-interaction)
  - [Client Sends Changes](#client-sends-changes)
  - [Server Processes Changes](#server-processes-changes)
  - [Server Confirms/Broadcasts](#server-confirmsbroadcasts)
  - [Client Receives Confirmation](#client-receives-confirmation)
  - [Client Receives External Changes](#client-receives-external-changes)
- [Key Components](#key-components)
  - [`Patches`](#patches)
  - [`PatchesDoc`](#patchesdoc)
  - [`Change` Object](#change-object)
  - [`PatchesServer`](#patchesserver)
- [Backend Store Interface](#backend-store-interface)
  - [`PatchesStoreBackend`](#patchstorebackend)
  - [`BranchingStoreBackend`](#branchingstorebackend)
- [Transformation Logic](#transformation-logic)
  - [The `transformPatch` Function](#the-transformpatch-function)
  - [Operation Handlers](#operation-handlers)
- [Comparison to Other OT Approaches](#comparison-to-other-ot-approaches)

## Core Concepts

Patches uses a specific flavor of OT designed for simplicity and robustness by leveraging a central server.

### Centralized Authority

Unlike some classic OT algorithms designed for peer-to-peer networks, Patches relies on a **central server** (`PatchesServer`) to be the single source of truth for the order of operations. All clients send their changes to the server, and the server determines the definitive sequence in which these changes are applied to the document.

This approach significantly simplifies the implementation and reasoning about concurrent changes compared to distributed OT systems which must guarantee convergence regardless of message delivery order.

> **Reference:** For a discussion on centralized vs. distributed OT, see Marijn Haverbeke's post: [Collaborative Editing in ProseMirror](https://marijnhaverbeke.nl/blog/collaborative-editing.html#centralization)

### Rebasing

When a client has made local changes that haven't been confirmed by the server yet, and it receives new changes from the server (either confirmation of its own changes, possibly modified, or changes from other clients), the client needs to adjust its remaining local changes. This process is called **rebasing**.

Patches implements rebasing by transforming the client's pending and/or sending changes _over_ the incoming server changes. This ensures that the client's local changes are modified to apply correctly on top of the updated server state.

The core function for this on the client-side (`PatchesDoc`) is `rebaseChanges`, which utilizes the underlying `transformPatch` logic.

### Linear History

The central server maintains a single, **linear history** of the document state. Each confirmed change applied by the server increments a global revision number for that document. This means `Document Version N+1` is always `Document Version N` + `Change N+1`.

This differs from systems like Git where history can branch and merge in complex ways. The linear history simplifies state management and transformation logic.

### Changes and Revisions

- **`Change` Object:** Represents a set of operations (`ops`, typically JSON Patch) along with metadata.
  - `id`: Unique client-generated ID.
  - `ops`: The JSON Patch operations.
  - `rev`: The _server-assigned_ revision number _after_ this change is committed.
  - `baseRev`: The _server revision_ number the client based this change on.
  - `created`: Client timestamp.
  - `metadata`: Optional user/session info.
- **Revision Numbers (`rev`, `baseRev`):** Integers managed by the server. `baseRev` is crucial for the server to know which historical changes a client's submission needs to be transformed against.

## Client-Server Interaction

The synchronization process follows these steps:

1.  **Client Sends Changes:**

    - The client (via `PatchesDoc`, obtained from `Patches`) makes local changes, applying them optimistically.
    - It calls `getUpdatesForServer()` which bundles pending changes.
    - Each change in the bundle is tagged with the client's current `committedRev` as its `baseRev`.
    - The client sends this bundle to the server.

2.  **Server Processes Changes (`PatchesServer.receiveChanges`):**

    - The server receives the client's `changes` and validates the `baseRev` against its current document revision.
    - If `baseRev` < server's current revision, the server retrieves all _historical_ server changes committed _after_ `baseRev`.
    - The server uses `transformPatch` to transform the incoming client `ops` against the `ops` of those historical changes, one by one.
    - The server applies the final, transformed `ops` to its current document state.
    - If the transformed `ops` are empty (the change was transformed away), the server notes this.

3.  **Server Confirms/Broadcasts:**

    - If the change resulted in a non-empty set of applied ops:
      - The server increments its document revision number.
      - It creates a single _new_ `Change` object representing the committed change, containing the _final applied ops_, the new `rev`, and metadata linking back to the original client change IDs.
      - This _single_ committed `Change` is saved to the backend store.
      - The server sends this _single_ `Change` back to the originating client as confirmation.
      - The server broadcasts this _single_ `Change` to all _other_ subscribed clients.
    - If the change resulted in empty ops (no-op):
      - The server sends an _empty array_ (`[]`) back to the originating client.
      - Nothing is broadcast to other clients.

4.  **Client Receives Confirmation (`PatchesDoc.applyServerConfirmation`):**

    - The originating client receives the response from the server.
    - If it receives a `Change` object:
      - It applies this server-authoritative change to its _committed_ state.
      - It updates its `committedRev` to the `rev` from the server change.
      - It discards the original changes it sent (which are now confirmed).
      - It _rebases_ any _new_ pending changes (made while the request was in flight) against the received server change.
      - It recalculates its optimistic local state.
    - If it receives an empty array (`[]`):
      - It discards the original changes it sent (they were a no-op).
      - It does _not_ update its committed state or revision.
      - It recalculates its optimistic local state (which might change if new pending changes were rebased against nothing).

5.  **Client Receives External Changes (`PatchesDoc.applyExternalServerUpdate`):**
    - When a client receives a broadcasted `Change` from the server (originated by _another_ client):
      - It validates the incoming change's `rev` against its own `committedRev`.
      - It applies the server change to its _committed_ state.
      - It updates its `committedRev`.
      - It _rebases_ both its `sendingChanges` (if any) and `pendingChanges` against the incoming server change.
      - It recalculates its optimistic local state.

## Key Components

- **[`PatchesServer`](./PatchesServer.md)**: Server-side orchestrator. Handles `receiveChanges`, transformation, persistence, versioning.
- **[`Patches`](./Patches.md)**: Main client entry point. Manages document instances, persistence, and sync. Use `patches.openDoc(docId)` to obtain a `PatchesDoc` for editing and sync.
- **[`PatchesDoc`](./PatchesDoc.md)**: Client-side document representation. Manages optimistic updates, local buffering, sending/receiving changes, rebasing.
- **[`Change` Object](../src/types.ts)**: The data structure passed between client and server, containing ops and metadata (especially `baseRev` and `rev`).

## Backend Store Interface

The OT system relies on a backend implementation provided by you.

### `PatchesStoreBackend`

(`src/types.ts`)
This interface defines the essential methods needed by [`PatchesServer`](./PatchesServer.md) and [`PatchesHistoryManager`](./PatchesHistoryManager.md) for basic OT and versioning.

```typescript
export interface PatchesStoreBackend {
  // Get latest revision number (returns 0 if doc doesn't exist)
  getLatestRevision(docId: string): Promise<number>;
  // Get latest document state (returns undefined if doc doesn't exist)
  getLatestState(docId: string): Promise<any | undefined>;
  // Get document state at a specific past revision
  getStateAtRevision(docId: string, rev: number): Promise<any | undefined>;

  // Save a single committed server change
  saveChange(docId: string, change: Change): Promise<void>;
  // List committed server changes based on revision filters
  listChanges(docId: string, options: PatchesStoreBackendListChangesOptions): Promise<Change[]>;

  // Save a version snapshot (metadata, state, original changes)
  saveVersion(docId: string, version: VersionMetadata): Promise<void>;
  // List version metadata based on filters
  listVersions(docId: string, options: PatchesStoreBackendListVersionsOptions): Promise<VersionMetadata[]>;
  // Load metadata for a specific version ID
  loadVersionMetadata(docId: string, versionId: string): Promise<VersionMetadata | null>;
  // Load the state snapshot for a specific version ID
  loadVersionState(docId: string, versionId: string): Promise<any | undefined>;
  // Load the original Change objects associated with a specific version ID
  loadVersionChanges(docId: string, versionId: string): Promise<Change[]>;
  // Get metadata for the most recently saved version snapshot
  getLatestVersionMetadata(docId: string): Promise<VersionMetadata | null>;
}
```

_(See [`src/types.ts`](../src/types.ts) for full details)_

### `BranchingStoreBackend`

(`src/types.ts`)
This interface extends `PatchesStoreBackend` with methods required by [`PatchesBranchManager`](./PatchesBranchManager.md).

```typescript
export interface BranchingStoreBackend extends PatchesStoreBackend {
  // List metadata for branches originating from a document
  listBranches(docId: string): Promise<Branch[]>;
  // Load metadata for a specific branch
  loadBranch(branchId: string): Promise<Branch | null>;
  // Create the metadata record for a new branch
  createBranch(branch: Branch): Promise<void>;
  // Update status, name, or metadata of an existing branch
  updateBranch(branchId: string, updates: Partial<Pick<Branch, 'status' | 'name' | 'metadata'>>): Promise<void>;
}
```

_(See [`src/types.ts`](../src/types.ts) for full details)_

**Implementation:** You must provide a concrete class that implements these methods using your chosen database or storage solution (e.g., PostgreSQL, MongoDB, Redis, filesystem).

## Transformation Logic

The core of the OT algorithm lies in transforming operations against each other.

- For details on the patch manipulation utilities (`transformPatch`, `invertPatch`, `composePatch`), see [Patch Utilities in JSON Patch](./json-patch.md#patch-utilities-transformpatch-invertpatch-composepatch).

The OT system relies on correct implementation of operation handlers for each patch type. See [Operation Handlers](./json-patch.md#operation-handlers) for more.

## Comparison to Other OT Approaches

- **vs. Google Wave/Docs OT:** Wave used a complex, distributed OT algorithm. Google Docs (despite being centralized) also historically used OT, though details are proprietary. Patches' centralized approach aims for simplicity.
- **vs. CRDTs (Conflict-free Replicated Data Types):** CRDTs are an alternative to OT. They design data structures and operations that are _inherently_ conflict-free, meaning operations can be applied in any order and eventually converge. This often avoids the need for complex transformation logic but can sometimes lead to less intuitive merge results compared to OT's intention preservation goal.
- **vs. ProseMirror:** Patches shares the concept of a centralized authority and rebasing with ProseMirror's collaborative editing approach, although the specific implementation details and operation types differ.
