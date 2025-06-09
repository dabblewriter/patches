# Operational Transformation: The Magic Behind the Curtain 🧙‍♂️

Ever wondered how your changes don't collide when multiple people edit the same document? That's Operational Transformation (OT) at work - and Patches has a particularly clever implementation!

After our big refactor, the OT logic has been moved into pure algorithm functions, making it easier to understand, test, and reuse. The main classes now orchestrate these algorithms rather than implementing OT themselves.

**Table of Contents**

- [Core Concepts](#core-concepts)
- [The New Architecture](#the-new-architecture)
- [Client-Server Dance](#client-server-dance)
- [The Key Players](#the-key-players)
- [Algorithm Functions](#algorithm-functions)
- [Backend Store Interface](#backend-store-interface)
- [How Transformation Actually Works](#how-transformation-actually-works)
- [Why Our Approach Rocks](#why-our-approach-rocks)

## Core Concepts

Let's break down the big ideas behind Patches' OT system in plain English:

### Centralized Authority 🏛️

Most OT systems try to work in a peer-to-peer way, which gets SUPER complicated. We decided to make things simpler (and WAY more reliable) by using a central server as the ultimate decision-maker.

Think of it like this: instead of everyone shouting changes at each other and trying to figure out who goes first, everyone sends their changes to a referee (the server), who decides the official order.

This approach makes the whole system more predictable and easier to reason about. No more weird edge cases where Alice's changes and Bob's changes can't be reconciled!

### Rebasing 🔄

Patches uses a concept borrowed from Git: rebasing. When the server accepts new changes, clients need to "rebase" their pending local changes on top of the server changes.

Imagine you're editing a paragraph while someone else inserts a sentence at the beginning. The server will tell you: "Hey, someone added a sentence that shifts your edit position - let me adjust your changes to account for that." That's rebasing!

### Linear History 📚

One big advantage of our approach is that we get a single, linear history of changes. There are no branching timelines or parallel universes to reconcile - just one clear sequence of changes.

This makes it easier to implement features like versioning, history browsing, and "time travel" to previous document states.

### Changes and Revisions 🔢

Every change in Patches has:

1. A unique ID
2. A set of operations (add text, delete character, move property, etc.)
3. A `baseRev` (the server revision it was based on)
4. A `rev` (the server revision after applying this change)

When the server confirms a change, it assigns the next available revision number. This keeps everything in order and helps clients know when they need to rebase.

## The New Architecture

With the refactor, we've separated concerns beautifully:

### Orchestration Layer
- **Patches:** Main coordinator and public API
- **PatchesSync:** Sync coordinator between client and server
- **PatchesDoc:** Document interface and local state manager
- **PatchesServer:** Server-side request handler

### Algorithm Layer
- **Client algorithms:** `makeChange`, `applyCommittedChanges`, `createStateFromSnapshot`, etc.
- **Shared algorithms:** `applyChanges`, `rebaseChanges` (the core OT logic)
- **Server algorithms:** Functions for server-side state management

### Storage & Transport
- **PatchesStore:** Persistence interface
- **WebSocket/WebRTC:** Network transport

This separation means:
1. **Pure algorithms** are easy to test and reason about
2. **Main classes** focus on coordination and user interface
3. **OT logic** is centralized and reusable
4. **Testing** is much simpler with isolated functions

## Client-Server Dance

Let's see how all these pieces work together in a typical collaboration flow:

### 1. Client Makes a Change 💻

Alice adds a paragraph to the document:

```typescript
doc.change(draft => {
  draft.paragraphs.push("Hello, this is Alice's new paragraph!");
});
```

Here's what happens under the hood:

- `PatchesDoc.change()` calls the `makeChange` algorithm
- `makeChange` creates proper change objects with operations
- The change is applied locally (optimistic update)
- `PatchesDoc` emits change events
- `PatchesSync` hears the event and queues the change for sending

### 2. Client Sends Changes to Server 📤

`PatchesSync` automatically handles this:

```typescript
// PatchesSync batches and sends changes
// Uses breakIntoBatches algorithm if needed
const batches = breakIntoBatches(pendingChanges, maxPayloadBytes);
for (const batch of batches) {
  await websocket.send('commitChanges', { docId, changes: batch });
}
```

### 3. Server Processes Changes ⚙️

The server receives Alice's change based on revision 42, but oh no! Bob already submitted a change that was assigned revision 43.

The server:

1. Notices Alice's change is based on rev 42, but the current server revision is 43
2. Fetches Bob's change (rev 43)
3. Transforms Alice's operations against Bob's operations
4. Applies the transformed version of Alice's change
5. Assigns Alice's change revision 44

### 4. Server Confirms and Broadcasts 📢

The server sends back two things to Alice:

1. Bob's change (rev 43) that she missed
2. Her own change, transformed and confirmed as revision 44

The server also broadcasts Alice's change to all other clients (including Bob).

### 5. Clients Apply Updates 📥

This is where the `applyCommittedChanges` algorithm shines:

```typescript
// In PatchesSync when server changes arrive
const currentSnapshot = await store.getDoc(docId);
const { state, rev, changes: rebasedPending } = applyCommittedChanges(
  currentSnapshot, 
  serverChanges
);

// Update storage and notify open documents
await store.saveCommittedChanges(docId, serverChanges);
await store.replacePendingChanges(docId, rebasedPending);

const doc = patches.getOpenDoc(docId);
if (doc) {
  doc.applyCommittedChanges(serverChanges, rebasedPending);
}
```

Alice's `PatchesSync`:
- Uses `applyCommittedChanges` to merge Bob's change with her pending changes
- The algorithm calls `rebaseChanges` internally to transform her pending changes
- Updates her `PatchesDoc` with the new state

Bob's `PatchesSync`:
- Receives Alice's change and applies it normally
- If he has pending changes, they get rebased automatically

And just like that, both Alice and Bob see the same document, with both of their changes applied in the correct order!

## The Key Players

### `Patches` 🎯

The main client-side coordinator. It handles:

- Opening and tracking documents
- Local storage and persistence
- Event coordination between components
- Public API surface

### `PatchesSync` 🎼

The sync conductor (new with the refactor). It:

- Coordinates between Patches, store, and server
- Uses algorithm functions for all OT operations
- Handles connection management and batching
- Orchestrates the sync flow without implementing OT logic

### `PatchesDoc` 📄

Now focused on the app interface. It:

- Manages local state and provides the `change()` API
- Handles optimistic updates using the `makeChange` algorithm
- Emits events for UI updates
- No longer handles sync or OT logic directly

### `Change` Object 📦

The data packet that represents a single edit:

```typescript
interface Change {
  id: string; // Unique identifier
  ops: Operation[]; // Array of operations (add, remove, replace, etc.)
  baseRev: number; // Server revision this change is based on
  rev: number; // Server-assigned revision after applying this change
  created: number; // Timestamp when this change was created
  batchId?: string; // Optional group ID for related changes
}
```

### `PatchesServer` 🏢

The server-side authority that:

- Receives client changes via WebSocket/API
- Uses server algorithms to handle OT and state management
- Assigns official revision numbers
- Broadcasts changes to other clients
- Coordinates with storage backends

## Algorithm Functions

The heart of the OT system - pure functions that handle the mathematical operations:

### Client-Side Algorithms

- **`makeChange(snapshot, mutator, metadata?, maxBytes?)`**: Creates change objects from mutations
- **`applyCommittedChanges(snapshot, serverChanges)`**: Merges server changes with local state
- **`createStateFromSnapshot(snapshot)`**: Builds current state from committed + pending
- **`breakChange(change, maxBytes)`**: Splits large changes into smaller ones
- **`breakIntoBatches(changes, maxBytes?)`**: Groups changes into network-sized batches

### Shared Algorithms

- **`applyChanges(state, changes)`**: Applies a list of changes to state
- **`rebaseChanges(serverChanges, localChanges)`**: The core OT transformation logic

### Server-Side Algorithms

- **`getStateAtRevision(docId, rev)`**: Retrieves state at a specific revision
- **`getSnapshotAtRevision(docId, rev)`**: Gets snapshot for a revision
- **`handleOfflineSessionsAndBatches(...)`**: Manages offline sync scenarios

These functions are pure - no side effects, easy to test, and reusable across different contexts.

## Backend Store Interface

The server needs somewhere to store all this data. Rather than tying you to a specific database, Patches defines interfaces you can implement for your preferred storage solution.

### `PatchesStoreBackend` 💾

This interface handles the core storage operations:

```typescript
interface PatchesStoreBackend {
  // Core revision management
  getLatestRevision(docId: string): Promise<number>;
  getLatestState(docId: string): Promise<any | undefined>;
  getStateAtRevision(docId: string, rev: number): Promise<any | undefined>;

  // Change management
  saveChange(docId: string, change: Change): Promise<void>;
  listChanges(docId: string, options: ChangesQueryOptions): Promise<Change[]>;

  // Version/snapshot management
  saveVersion(docId: string, version: VersionMetadata): Promise<void>;
  listVersions(docId: string, options: VersionQueryOptions): Promise<VersionMetadata[]>;
  loadVersionMetadata(docId: string, versionId: string): Promise<VersionMetadata | null>;
  loadVersionState(docId: string, versionId: string): Promise<any | undefined>;
  loadVersionChanges(docId: string, versionId: string): Promise<Change[]>;
  getLatestVersionMetadata(docId: string): Promise<VersionMetadata | null>;
}
```

### `BranchingStoreBackend` 🌿

If you want to support document branching, implement this extended interface:

```typescript
interface BranchingStoreBackend extends PatchesStoreBackend {
  // Branch-specific operations
  createBranch(branch: Branch): Promise<void>;
  updateBranch(docId: string, branchId: string, updates: Partial<Branch>): Promise<void>;
  getBranch(docId: string, branchId: string): Promise<Branch | null>;
  listBranches(docId: string, options?: BranchQueryOptions): Promise<Branch[]>;
}
```

Patches provides an in-memory implementation (`InMemoryStore`) for testing and simple use cases, and `IndexedDBStore` for browser-based client persistence.

## How Transformation Actually Works

This is where the real magic happens! The core transformation logic lives in the `rebaseChanges` algorithm:

### The `rebaseChanges` Function ✨

```typescript
// src/algorithms/shared/rebaseChanges.ts
export function rebaseChanges(serverChanges: Change[], localChanges: Change[]): Change[] {
  // Transform each local change against all server changes
  return localChanges.map(localChange => {
    let transformedOps = localChange.ops;
    
    // Transform against each server change
    for (const serverChange of serverChanges) {
      transformedOps = transformPatch(transformedOps, serverChange.ops);
    }
    
    // Return new change with transformed operations
    return { ...localChange, ops: transformedOps };
  });
}
```

### The `transformPatch` Function 🔧

This function (in the JSON Patch module) handles the mathematical transformation:

```typescript
function transformPatch(sourceOps: Operation[], againstOps: Operation[]): Operation[] {
  // For each source operation...
  return sourceOps.map(sourceOp => {
    // Get the appropriate transformer for this operation type
    const transformer = operationHandlers[sourceOp.op];

    // Transform it against each operation we're transforming against
    return againstOps.reduce((op, againstOp) => {
      return transformer.transform(op, againstOp);
    }, sourceOp);
  });
}
```

### Operation Handlers 🔧

Each type of operation (add, remove, replace, etc.) has its own handler that knows how to:

1. **Apply** the operation to a document
2. **Transform** the operation against other operations
3. **Invert** the operation (for undo functionality)

For example, when transforming an "add" operation against a "remove" operation that comes before it, the path might need to be adjusted if the removal changed the structure.

### How `applyCommittedChanges` Orchestrates Everything

This algorithm is the bridge between server updates and local state:

```typescript
// Simplified version of the algorithm
export function applyCommittedChanges<T>(
  snapshot: PatchesSnapshot<T>,
  serverChanges: Change[]
): { state: T; rev: number; changes: Change[] } {
  // Apply server changes to committed state
  const newCommittedState = applyChanges(snapshot.state, serverChanges);
  const newRev = serverChanges[serverChanges.length - 1]?.rev ?? snapshot.rev;
  
  // Rebase pending changes on top of new committed state
  const rebasedPending = rebaseChanges(serverChanges, snapshot.changes);
  
  // Create final state (committed + rebased pending)
  const finalState = applyChanges(newCommittedState, rebasedPending);
  
  return {
    state: finalState,
    rev: newRev,
    changes: rebasedPending
  };
}
```

## Why Our Approach Rocks

Our centralized OT approach gives you:

1. **Simplicity** - The server is the ultimate authority, eliminating weird edge cases
2. **Predictability** - Changes are applied in a definite order
3. **Performance** - Transformation is simpler and faster than in peer-to-peer OT
4. **Flexibility** - Works with any back-end storage system
5. **Robustness** - Handles network disconnections gracefully
6. **Scalability** - Supports extremely large and long-lived documents

The tradeoff? You need a central server. But for most collaborative apps, you already have one anyway!

By combining this OT system with Patches' other features (offline support, versioning, branching), you get a complete collaboration platform that's both powerful and easy to use.

Now you know the secret sauce that makes Patches so magical! ✨
