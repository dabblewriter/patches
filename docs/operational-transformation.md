# Operational Transformation: The Magic Behind the Curtain 🧙‍♂️

Ever wondered how your changes don't collide when multiple people edit the same document? That's Operational Transformation (OT) at work - and Patches has a particularly clever implementation!

**Table of Contents**

- [Core Concepts](#core-concepts)
- [Client-Server Dance](#client-server-dance)
- [The Key Players](#the-key-players)
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

## Client-Server Dance

Let's see how all these pieces work together in a typical collaboration flow:

### 1. Client Makes a Change 💻

Alice adds a paragraph to the document:

```typescript
doc.change(draft => {
  draft.paragraphs.push("Hello, this is Alice's new paragraph!");
});
```

Patches immediately:

- Applies this change to Alice's local document (so she sees it right away)
- Records that this change is based on the latest revision she knows about (let's say rev 42)
- Adds this change to a pending queue

### 2. Client Sends Changes to Server 📤

Alice's client sends the change to the server:

```typescript
// This usually happens automatically with PatchesSync
const pendingChanges = doc.getUpdatesForServer();
const serverResponse = await server.commitChanges('doc123', pendingChanges);
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

Alice's client:

- Applies Bob's change (rev 43) to her committed state
- Confirms her own change as revision 44
- Updates the UI with the new state

Bob's client:

- Receives Alice's change (rev 44)
- Applies it to his local state
- Rebases any pending changes he might have

And just like that, both Alice and Bob see the same document, with both of their changes applied in the correct order!

## The Key Players

### `Patches` 🎯

This is the main client-side coordinator. It handles:

- Opening and tracking documents
- Local storage and persistence
- Client-side event coordination

### `PatchesDoc` 📄

The star of the show for each document. It:

- Manages local state (committed + pending changes)
- Handles optimistic updates
- Takes care of rebasing local changes
- Provides a simple API for making changes

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

The authority that:

- Receives client changes
- Transforms them against concurrent changes
- Assigns official revision numbers
- Broadcasts changes to other clients
- Handles versioning and snapshotting

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

This is where the real magic happens!

### The `transformPatch` Function ✨

This core function takes two changes, A and B, and transforms A's operations against B's operations. The result is a new set of operations for A that achieve the same intent but work correctly when applied after B.

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
