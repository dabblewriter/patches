# Operational Transformation: How Collaborative Editing Actually Works

Ever wondered how your changes don't collide when multiple people edit the same document? That's Operational Transformation (OT) at work. Most articles about OT get lost in academic abstractions. Let's skip that and look at how Patches actually implements it.

After a major refactor, the OT logic lives in pure algorithm functions. This makes the code easier to understand, test, and reuse. The main classes orchestrate these algorithms rather than implementing OT themselves.

**Table of Contents**

- [Core Concepts](#core-concepts)
- [Architecture](#architecture)
- [Client-Server Flow](#client-server-flow)
- [Key Components](#key-components)
- [Algorithm Functions](#algorithm-functions)
- [Backend Store Interface](#backend-store-interface)
- [How Transformation Works](#how-transformation-works)
- [Why Centralized OT](#why-centralized-ot)

## Core Concepts

Here's what you actually need to know about Patches' OT system:

### Centralized Authority

Most OT systems attempt peer-to-peer coordination, which gets complicated fast. Patches takes a simpler approach: a central server acts as the ultimate decision-maker.

Instead of everyone shouting changes at each other and trying to figure out who goes first, everyone sends their changes to a referee (the server), who decides the official order.

This makes the whole system more predictable. No weird edge cases where Alice's changes and Bob's changes can't be reconciled. The server says "this is the order," and that's that.

### Rebasing

Patches uses a concept borrowed from Git: rebasing. When the server accepts new changes, clients need to "rebase" their pending local changes on top of the server changes.

Imagine you're editing a paragraph while someone else inserts a sentence at the beginning. The server will tell you: "Hey, someone added a sentence that shifts your edit position - let me adjust your changes to account for that." That's rebasing.

The key insight: your _intent_ is preserved, but the _positions_ get adjusted to account for what happened before you.

### Linear History

One big advantage of centralized OT: a single, linear history of changes. No branching timelines or parallel universes to reconcile - just one clear sequence of changes.

This makes versioning, history browsing, and "time travel" to previous document states straightforward to implement. See [PatchesHistoryManager](PatchesHistoryManager.md) for how this works.

### Changes and Revisions

Every change in Patches has:

1. A unique ID (generated client-side)
2. A set of [JSON Patch operations](json-patch.md) (add, remove, replace, etc.)
3. A `baseRev` (the server revision it was based on)
4. A `rev` (the server revision after applying this change)

When the server confirms a change, it assigns the next available revision number. This keeps everything ordered and helps clients know when they need to rebase.

## Architecture

The codebase separates concerns into distinct layers:

### Orchestration Layer

- **[Patches](Patches.md):** Main coordinator and public API
- **[PatchesSync](PatchesSync.md):** Sync coordinator between client and server
- **[PatchesDoc](PatchesDoc.md):** Document interface and local state manager
- **[OTServer](OTServer.md):** Server-side request handler

### Algorithm Layer

- **Client algorithms:** `makeChange`, `applyCommittedChanges`, `createStateFromSnapshot`
- **Shared algorithms:** `applyChanges`, `rebaseChanges` (the core OT logic)
- **Server algorithms:** Functions for transformation and state management

See [algorithms.md](algorithms.md) for the complete breakdown.

### Storage and Transport

- **[PatchesStore](persist.md):** Client-side persistence interface
- **[WebSocket/WebRTC](net.md):** Network transport options

This separation means:

1. **Pure algorithms** are easy to test - no mocking needed
2. **Main classes** focus on coordination, not math
3. **OT logic** is centralized and reusable
4. **Stores stay "dumb"** - they just save and load data

## Client-Server Flow

Here's how the pieces work together in a typical collaboration flow:

### 1. Client Makes a Change

Alice adds a paragraph to the document:

```typescript
doc.change(draft => {
  draft.paragraphs.push("Hello, this is Alice's new paragraph!");
});
```

Under the hood:

- `PatchesDoc.change()` calls the `makeChange` algorithm
- `makeChange` creates proper change objects with operations
- The change is applied locally (optimistic update)
- `PatchesDoc` emits change events
- `PatchesSync` hears the event and queues the change for sending

### 2. Client Sends Changes to Server

`PatchesSync` handles batching and transmission automatically:

```typescript
// PatchesSync batches and sends changes
const batches = breakChangesIntoBatches(pendingChanges, { maxPayloadBytes: 1_000_000 });
for (const batch of batches) {
  await transport.send('commitChanges', { docId, changes: batch });
}
```

### 3. Server Processes Changes

The server receives Alice's change based on revision 42, but Bob already submitted a change that was assigned revision 43.

The server:

1. Notices Alice's change is based on rev 42, but the current server revision is 43
2. Fetches Bob's change (rev 43)
3. Transforms Alice's operations against Bob's operations
4. Applies the transformed version of Alice's change
5. Assigns Alice's change revision 44

### 4. Server Confirms and Broadcasts

The server sends back two things to Alice:

1. Bob's change (rev 43) that she missed
2. Her own change, transformed and confirmed as revision 44

The server also broadcasts Alice's change to all other clients (including Bob).

### 5. Clients Apply Updates

This is where the `applyCommittedChanges` algorithm handles the complexity:

```typescript
// In PatchesSync when server changes arrive
const currentSnapshot = await store.getDoc(docId);
const newSnapshot = applyCommittedChanges(currentSnapshot, serverChanges);

// Update storage and notify open documents
await store.applyServerChanges(docId, serverChanges);

const doc = patches.getOpenDoc(docId);
if (doc) {
  doc.applyCommittedChanges(serverChanges, newSnapshot.changes);
}
```

Alice's `PatchesSync`:

- Uses `applyCommittedChanges` to merge Bob's change with her pending changes
- The algorithm calls `rebaseChanges` internally to transform her pending changes
- Updates her `PatchesDoc` with the new state

Bob's `PatchesSync`:

- Receives Alice's change and applies it normally
- If he has pending changes, they get rebased automatically

Both Alice and Bob see the same document, with both of their changes applied in the correct order.

## Key Components

### Patches

The main client-side coordinator. It handles:

- Opening and tracking documents
- Local storage and persistence
- Event coordination between components
- Public API surface

See [Patches.md](Patches.md) for details.

### PatchesSync

The sync conductor. It:

- Coordinates between Patches, store, and server
- Uses algorithm functions for all OT operations
- Handles connection management and batching
- Orchestrates the sync flow without implementing OT logic

See [PatchesSync.md](PatchesSync.md) for details.

### PatchesDoc

Focused on the app interface. It:

- Manages local state and provides the `change()` API
- Handles optimistic updates using the `makeChange` algorithm
- Emits events for UI updates
- Does not handle sync or OT logic directly

See [PatchesDoc.md](PatchesDoc.md) for details.

### Change Object

The data packet that represents a single edit:

```typescript
interface Change {
  id: string; // Unique identifier (generated client-side)
  ops: JSONPatchOp[]; // Array of operations (add, remove, replace, etc.)
  baseRev: number; // Server revision this change is based on
  rev: number; // Server-assigned revision after applying this change
  createdAt: number; // Unix timestamp (ms) when the change was created
  committedAt: number; // Unix timestamp (ms) when the server committed this change
  batchId?: string; // Optional group ID for related changes (multi-batch uploads)
}
```

### OTServer

The server-side authority that:

- Receives client changes via WebSocket/API
- Uses server algorithms to handle OT and state management
- Assigns official revision numbers
- Broadcasts changes to other clients
- Coordinates with storage backends

See [OTServer.md](OTServer.md) for details.

## Algorithm Functions

The heart of the OT system - pure functions that handle the mathematical operations:

### Client-Side Algorithms

- **`makeChange(snapshot, mutator, metadata?, maxBytes?)`**: Creates change objects from mutations
- **`applyCommittedChanges(snapshot, serverChanges)`**: Merges server changes with local state, returns updated snapshot
- **`createStateFromSnapshot(snapshot)`**: Builds current state from committed + pending

### Shared Algorithms

- **`applyChanges(state, changes)`**: Applies a list of changes to state
- **`rebaseChanges(serverChanges, localChanges)`**: The core OT transformation logic
- **`breakChanges(changes, maxBytes)`**: Splits large changes into smaller ones
- **`breakChangesIntoBatches(changes, options?)`**: Groups changes into network-sized batches

### Server-Side Algorithms

- **`transformIncomingChanges(...)`**: Transforms client changes against concurrent server changes
- **`commitChanges(...)`**: Complete change commit workflow with validation and persistence
- **`getStateAtRevision(store, docId, rev)`**: Retrieves state at a specific revision
- **`getSnapshotAtRevision(store, docId, rev)`**: Gets snapshot for a revision
- **`handleOfflineSessionsAndBatches(...)`**: Manages offline sync scenarios

These functions are pure - no side effects, easy to test, and reusable across different contexts.

See [algorithms.md](algorithms.md) for detailed documentation.

## Backend Store Interface

The server needs storage. Rather than tying you to a specific database, Patches defines interfaces you implement for your preferred storage solution.

### OTStoreBackend

The primary interface for OT storage operations:

```typescript
interface OTStoreBackend extends ServerStoreBackend, VersioningStoreBackend {
  /** Saves a batch of committed server changes. */
  saveChanges(docId: string, changes: Change[]): Promise<void>;

  /** Lists committed server changes based on revision numbers. */
  listChanges(docId: string, options: ListChangesOptions): Promise<Change[]>;

  /** Loads the original Change objects associated with a specific version ID. */
  loadVersionChanges(docId: string, versionId: string): Promise<Change[]>;

  /** Appends changes to an existing version (for multi-batch sessions). */
  appendVersionChanges(
    docId: string,
    versionId: string,
    changes: Change[],
    newEndedAt: number,
    newEndRev: number,
    newState: any
  ): Promise<void>;
}
```

### VersioningStoreBackend

For version/snapshot management:

```typescript
interface VersioningStoreBackend {
  /** Creates a version with metadata, state snapshot, and optionally changes. */
  createVersion(docId: string, metadata: VersionMetadata, state: any, changes?: Change[]): Promise<void>;

  /** Lists version metadata based on filtering/sorting options. */
  listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]>;

  /** Loads the state snapshot for a specific version ID. */
  loadVersionState(docId: string, versionId: string): Promise<any | undefined>;

  /** Update a version's metadata. */
  updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void>;
}
```

### BranchingStoreBackend

If you want to support document branching (see [branching.md](branching.md)):

```typescript
interface BranchingStoreBackend {
  /** Lists metadata records for branches originating from a document. */
  listBranches(docId: string): Promise<Branch[]>;

  /** Loads the metadata record for a specific branch ID. */
  loadBranch(branchId: string): Promise<Branch | null>;

  /** Creates a branch. */
  createBranch(branch: Branch): Promise<void>;

  /** Updates branch metadata. */
  updateBranch(branchId: string, updates: Partial<Pick<Branch, 'status' | 'name' | 'metadata'>>): Promise<void>;
}
```

Patches provides `InMemoryStore` for testing and simple use cases, and `IndexedDBStore` for browser-based client persistence. See [persist.md](persist.md) for details.

## How Transformation Works

This is where the real work happens. The core transformation logic lives in the `rebaseChanges` algorithm.

### The rebaseChanges Function

```typescript
// src/algorithms/shared/rebaseChanges.ts
export function rebaseChanges(serverChanges: Change[], localChanges: Change[]): Change[] {
  if (!serverChanges.length || !localChanges.length) {
    return localChanges;
  }

  const lastChange = serverChanges[serverChanges.length - 1];
  const receivedIds = new Set(serverChanges.map(change => change.id));
  const transformAgainstIds = new Set(receivedIds);

  // Filter out local changes that are already in server changes
  const filteredLocalChanges: Change[] = [];
  for (const change of localChanges) {
    if (receivedIds.has(change.id)) {
      transformAgainstIds.delete(change.id);
    } else {
      filteredLocalChanges.push(change);
    }
  }

  // Create a patch from server changes that need to be transformed against
  const transformPatch = new JSONPatch(
    serverChanges
      .filter(change => transformAgainstIds.has(change.id))
      .map(change => change.ops)
      .flat()
  );

  // Rebase local changes against server changes
  const baseRev = lastChange.rev;
  let rev = lastChange.rev;
  return filteredLocalChanges
    .map(change => {
      rev++;
      const ops = transformPatch.transform(change.ops).ops;
      if (!ops.length) return null;
      return { ...change, baseRev, rev, ops };
    })
    .filter(Boolean) as Change[];
}
```

Key details:

1. **Filters out duplicates** - If a local change ID appears in server changes, it's already committed
2. **Creates a transform patch** - Combines all server ops we need to transform against
3. **Transforms each local change** - Uses `JSONPatch.transform()` for the actual OT math
4. **Updates revision numbers** - Rebased changes get new revisions based on the latest server rev

### The JSONPatch.transform Method

The `JSONPatch` class (in `src/json-patch/`) handles the mathematical transformation:

```typescript
// Each operation type has its own handler that knows how to transform
transform(patch: JSONPatch | JSONPatchOp[], obj?: any): this {
  return new JSONPatch(
    transformPatch(obj, this.ops, Array.isArray(patch) ? patch : patch.ops, this.custom),
    this.custom
  );
}
```

See [json-patch.md](json-patch.md) for details on operations and transformation rules.

### Operation Handlers

Each type of operation (add, remove, replace, move, copy, test) has its own handler that knows how to:

1. **Apply** the operation to a document
2. **Transform** the operation against other operations
3. **Invert** the operation (for undo functionality)

For example, when transforming an "add" operation against a "remove" operation that comes before it in an array, the index path gets adjusted to account for the removal.

### How applyCommittedChanges Orchestrates Everything

This algorithm bridges server updates and local state:

```typescript
// Simplified from src/algorithms/client/applyCommittedChanges.ts
export function applyCommittedChanges(
  snapshot: PatchesSnapshot,
  committedChangesFromServer: Change[]
): PatchesSnapshot {
  let { state, rev, changes } = snapshot;

  // Filter out server changes already reflected in current revision
  const newServerChanges = committedChangesFromServer.filter(change => change.rev > rev);

  if (newServerChanges.length === 0) {
    return { state, rev, changes };
  }

  // 1. Apply server changes to committed state
  state = applyChanges(state, newServerChanges);

  // 2. Update committed revision
  rev = newServerChanges[newServerChanges.length - 1].rev;

  // 3. Rebase pending local changes against the newly applied server changes
  if (changes && changes.length > 0) {
    changes = rebaseChanges(newServerChanges, changes);
  }

  return { state, rev, changes };
}
```

## Why Centralized OT

The centralized approach gives you:

1. **Simplicity** - The server is the ultimate authority, eliminating edge cases
2. **Predictability** - Changes are applied in a definite order
3. **Performance** - Transformation is simpler and faster than in peer-to-peer OT
4. **Flexibility** - Works with any backend storage system
5. **Robustness** - Handles network disconnections gracefully
6. **Scalability** - Supports extremely large and long-lived documents

The tradeoff? You need a central server. But for most collaborative apps, you already have one anyway.

By combining this OT system with Patches' other features ([offline support](persist.md), [versioning](PatchesHistoryManager.md), [branching](branching.md)), you get a complete collaboration platform that handles the hard problems so you don't have to.

## Related Documentation

- [algorithms.md](algorithms.md) - Deep dive into all algorithm functions
- [json-patch.md](json-patch.md) - JSON Patch operations and transformation
- [OTServer.md](OTServer.md) - Server-side OT authority
- [PatchesSync.md](PatchesSync.md) - Client-side sync coordination
- [persist.md](persist.md) - Storage and persistence
- [branching.md](branching.md) - Branch and merge workflows
- [last-write-wins.md](last-write-wins.md) - Alternative sync algorithm for simpler use cases
