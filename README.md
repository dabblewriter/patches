# Patches

**Hello, friend!** Meet your new favorite realtime library. It's based on operational transformations, but don't let that scare you!

<img src="./patches.png" alt="Patches the Dog" style="width: 300px;">

## What Is This Thing?

Patches is a TypeScript library that makes building collaborative apps _delightfully_ straightforward. You know, the kind where multiple people can edit the same document at once without everything exploding? Yeah, those!

It uses something called Operational Transformation (fancy, I know) with a centralized server model. Translation: Your users can collaborate without weird conflicts, even when their internet connection gets flaky.

The BEST part? It handles massive documents with loooong histories. We're talking documents with 480,000+ operations that load in 1-2ms. Not a typo!

## Why You'll Love It

When working with Patches, you're just using normal JavaScript data. If JSON supports it, Patches supports it. Your document's `state` is immutable (fancy word for "won't change unexpectedly"). When you want to change something, you just do:

```js
doc.change(state => (state.prop = 'new value'));
```

And bam! You get a fresh new state with your changes applied.

## Table of Contents

- [Why Operational Transformations?](#why-operational-transformations)
- [Key Concepts](#key-concepts)
- [Installation](#installation)
- [Getting Started](#getting-started)
  - [Client Example](#client-example)
  - [Server Example](#server-example)
- [Core Components](#core-components)
- [Basic Workflow](#basic-workflow)
- [Examples](#examples)
- [Advanced Topics](#advanced-topics)
- [JSON Patch (Legacy)](#json-patch-legacy)
- [Contributing](#contributing)
- [License](#license)

## Why Operational Transformations?

**"Wait, shouldn't I be using CRDTs instead?"**

Look, there are [lots](https://thom.ee/blog/crdt-vs-operational-transformation/) of [opinions](https://www.tiny.cloud/blog/real-time-collaboration-ot-vs-crdt/) about [this](https://fiberplane.com/blog/why-we-at-fiberplane-use-operational-transformation-instead-of-crdt/). Here's the deal: at [Dabble Writer](https://www.dabblewriter.com/), we tried CRDTs. We REALLY wanted them to work. Even the super-optimized [Y.js](https://yjs.dev/) couldn't handle our power users' documents.

Some of our users have projects with 480k+ operations. 😱 These monsters took hours to re-create in Y.js, ~4 seconds to load in optimized Y.js, and ~20ms to add a change. With our OT library? 1-2ms to load and 0.2ms to apply a change.

As projects grow larger or longer-lived, OT performance stays zippy while CRDTs slow down. For most use cases, CRDTs might be perfect! But if you have very large or long-lived documents (especially ones that accumulate tons of changes over time), OT could save your bacon.

## Key Concepts

- **Centralized OT:** Using a server as the authority makes everything WAY simpler. No complicated peer-to-peer conflict resolution!
- **Rebasing:** Client changes get "rebased" on top of server changes. Like git rebase, but for your real-time edits!
- **Linear History:** The server keeps one straight timeline of revisions. No timeline branches = no headaches.
- **Client-Server Dance:** Clients send batches of changes tagged with the server revision they're based on. The server transforms them, applies them, gives them a new revision number, and broadcasts them back.

**Why Centralized?**

We use an algorithm that only transforms operations in one direction (like git rebase), inspired by [Marijn Haverbeke's article](https://marijnhaverbeke.nl/blog/collaborative-editing.html). Originally, we made the server reject changes if new ones came in before them, forcing clients to transform and resubmit. BUT! This could theoretically make slow clients keep resubmitting forever and never committing.

So we leveled up! Now the server does the transform and commit, sending back both new changes AND the transformed submitted ones. Everyone gets equal time with the server, even the slowpokes!

**Snapshots = Performance Magic**

OT documents are just arrays of changes. To create the current document state, you replay each change from first to last. For looooong documents (like our 480k changes monster), this would be painfully slow.

That's why we snapshot the data every so often. Grab the latest snapshot, add recent changes, and you're good to go! This is how OT maintains consistent performance over time.

**Versions as Snapshots**

Most collaborative work happens in bursts. We combine snapshots with versions by creating new snapshots when there's a 30+ minute gap between changes. This clever trick turns a technical requirement into a user-facing feature – versioning!

**Immutable State**

Patches uses gentleman's immutability – each change creates a new object, keeping unchanged objects as-is and only replacing what changed. This brings tons of [benefits](https://www.freecodecamp.org/news/immutable-javascript-improve-application-performance/) for [performance](http://www.cowtowncoder.com/blog/archives/2010/08/entry_409.html) and [code quality](https://medium.com/@mohitgadhavi1/the-power-of-immutability-improving-javascript-performance-and-code-quality-96d82134d8da).

## Installation

```bash
npm install @dabble/patches
# or
yarn add @dabble/patches
```

## Getting Started

Let's set up a basic client and server. (These examples are simplified – real-world apps need error handling, proper network communication, auth, and persistence.)

### Client Example

Here's how to get rolling with Patches on the client:

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

interface MyDoc {
  text: string;
  count: number;
}

// 1. Create a store (just using in-memory for this demo)
const store = new InMemoryStore();

// 2. Create the main Patches client
const patches = new Patches({ store });

// 3. Set up real-time sync with your server
const sync = new PatchesSync('wss://your-server-url', patches);
await sync.connect(); // Connect to the server!

// 4. Open or create a document by ID
const doc = await patches.openDoc<MyDoc>('my-doc-1');

// 5. React to updates (update your UI here)
doc.onUpdate(newState => {
  console.log('Document updated:', newState);
  // Update your UI here
});

// 6. Make local changes
// (Changes apply immediately locally and sync to the server automatically)
doc.change(draft => {
  draft.text = 'Hello World!';
  draft.count = (draft.count || 0) + 1;
});

// 7. That's it! Changes sync automatically with PatchesSync
```

### Server Example

Here's a basic Express server using `PatchesServer`:

```typescript
import express from 'express';
import { PatchesServer, PatchesStoreBackend, Change } from '@dabble/patches/server';

// Server Setup
const store = new InMemoryStore(); // Use a real database in production!
const server = new PatchesServer(store);
const app = express();
app.use(express.json());

// Endpoint to receive changes
app.post('/docs/:docId/changes', async (req, res) => {
  const docId = req.params.docId;
  const clientChanges = req.body.changes;

  if (!Array.isArray(clientChanges)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    // Process incoming changes
    const committedChanges = await server.receiveChanges(docId, clientChanges);
    // Send confirmation back to the sender
    res.json(committedChanges);
    // Broadcast committed changes to other connected clients (via WebSockets, etc.)
    // broadcastChanges(docId, committedChanges, req.headers['x-client-id']);
  } catch (error) {
    console.error(`Error processing changes for ${docId}:`, error);
    const statusCode = error.message.includes('out of sync') ? 409 : 500;
    res.status(statusCode).json({ error: error.message });
  }
});

// Endpoint to get initial state
app.get('/docs/:docId', async (req, res) => {
  const docId = req.params.docId;
  try {
    const { state, rev } = await server.getLatestDocumentStateAndRev(docId);
    res.json({ state: state ?? {}, rev }); // Default to empty obj if new
  } catch (error) {
    console.error(`Error fetching state for ${docId}:`, error);
    res.status(500).json({ error: 'Failed to fetch document state.' });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
```

For more details and advanced features, check out the rest of the docs!

## Core Components

Centralized OT has two very different areas: server and client. They do completely different jobs!

### Patches (Main Client)

([`docs/Patches.md`](./docs/Patches.md))

This is your main entry point on the client. It manages document instances and persistence. You get a `PatchesDoc` by calling `patches.openDoc(docId)`.

- **Document Management:** Opens, tracks, and closes collaborative documents
- **Persistence:** Works with pluggable storage (in-memory, IndexedDB, custom)
- **Sync Integration:** Pairs with `PatchesSync` for real-time server communication
- **Event Emitters:** Hooks like `onError` and `onServerCommit` for reacting to events

### PatchesDoc (Document Instance)

([`docs/PatchesDoc.md`](./docs/PatchesDoc.md))

This represents a single collaborative document. You don't create this directly; use `patches.openDoc(docId)` instead.

- **Local State Management:** Tracks committed state, sending changes, and pending changes
- **Optimistic Updates:** Applies local changes immediately for snappy UIs
- **Synchronization:** Handles client-side OT magic:
  - Sends pending changes to server
  - Applies server confirmations
  - Applies external updates, rebasing local changes as needed
- **Event Emitters:** Hooks like `onUpdate` and `onChange` to react to state changes

### PatchesServer

([`docs/PatchesServer.md`](./docs/PatchesServer.md))

The heart of server-side logic!

- **Receives Changes:** Handles incoming `Change` objects from clients
- **Transformation:** Transforms client changes against concurrent server changes
- **Applies Changes:** Applies transformed changes to the authoritative document state
- **Versioning:** Creates version snapshots based on user sessions
- **Persistence:** Uses `PatchesStoreBackend` to save/load document state and history

### PatchesHistoryManager

([`docs/PatchesHistoryManager.md`](./docs/PatchesHistoryManager.md))

Helps you query document history.

- **List Versions:** Get metadata about saved document versions
- **Get Version State/Changes:** Load the full state or specific changes for a version
- **List Server Changes:** Query raw server changes by revision numbers

### PatchesBranchManager

([`docs/PatchesBranchManager.md`](./docs/PatchesBranchManager.md))

Manages branching and merging workflows.

- **Create Branch:** Makes a new document branching off from a source doc
- **List Branches:** Shows info about existing branches
- **Merge Branch:** Merges changes back into the source document
- **Close Branch:** Marks a branch as closed, merged, or abandoned

### Backend Store

([`docs/operational-transformation.md#backend-store-interface`](./docs/operational-transformation.md#backend-store-interface))

This is an interface you implement, not a specific class. It defines how the server components interact with your chosen storage (database, file system, memory).

You're responsible for making it work with your backend!

### Transport & Networking

Patches gives you flexible networking options:

- **WebSocket Transport:** For most apps, use [`PatchesWebSocket`](./docs/websocket.md) to connect to a central server
- **WebRTC Transport:** For peer-to-peer, use [`WebRTCTransport`](./docs/operational-transformation.md#webrtc) and [`WebRTCAwareness`](./docs/awareness.md)

**When to use which?**

- WebSocket for most collaborative apps with a central server
- WebRTC for peer-to-peer or to reduce server load for awareness/presence

### Awareness (Presence, Cursors, etc.)

"Awareness" lets you show who's online, where their cursor is, and more. Patches supports awareness over both WebSocket and WebRTC.

Check the [Awareness documentation](./docs/awareness.md) for how to build collaborative cursors, user lists, and other cool features.

## Basic Workflow

### Client-Side

1. **Initialize `Patches`** with a store
2. **Track and Open a Document** with `patches.trackDocs([docId])` and `patches.openDoc(docId)`
3. **Subscribe to Updates** with `doc.onUpdate`
4. **Make Local Changes** with `doc.change()`
5. **Sync Changes** automatically with `PatchesSync` or manually with your own logic

### Server-Side

1. **Initialize `PatchesServer`** with your backend store
2. **Receive Client Changes** with `server.receiveChanges()`
3. **Handle History/Branching** with `PatchesHistoryManager` and `PatchesBranchManager`

## Examples

### Simple Client Setup

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';

interface MyDoc {
  text: string;
  count: number;
}

const store = new InMemoryStore();
const patches = new Patches({ store });
const docId = 'doc123';
await patches.trackDocs([docId]);
const doc = await patches.openDoc<MyDoc>(docId);

doc.onUpdate(newState => {
  console.log('Document updated:', newState);
});

doc.change(draft => {
  draft.text = 'Hello';
  draft.count = 0;
});
// With PatchesSync, changes sync automatically
```

### Simple Server Setup

```typescript
import express from 'express';
import {
  PatchesServer,
  PatchesStoreBackend,
  Change,
  VersionMetadata, //... other types
} from '@dabble/patches/server';

// --- Basic In-Memory Store (Use a real database!) ---
class InMemoryStore implements PatchesStoreBackend {
  private docs = new Map<string, { state: any; rev: number; changes: Change[]; versions: VersionMetadata[] }>();

  // Implementation details omitted for brevity...
}

// --- Server Setup ---
const store = new InMemoryStore();
const server = new PatchesServer(store);
const app = express();
app.use(express.json());

// API endpoints for changes and state...
// (see full example in code)

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
```

## Advanced Topics

### Offline Support & Versioning

See [`PatchesServer Versioning`](./docs/PatchesServer.md#versioning) and [`PatchesHistoryManager`](./docs/PatchesHistoryManager.md).

### Branching and Merging

See [`PatchesBranchManager`](./docs/PatchesBranchManager.md).

### Custom OT Types

See [`Operational Transformation > Operation Handlers`](./docs/operational-transformation.md#operation-handlers).

## JSON Patch (Legacy)

For legacy JSON Patch features, see [`docs/json-patch.md`](./docs/json-patch.md).

## Contributing

Contributions are welcome! Please feel free to open issues or submit pull requests.

_(TODO: Add contribution guidelines)_

## License

[MIT](./LICENSE_MIT)
