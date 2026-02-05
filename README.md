# Patches

A TypeScript library for building real-time collaborative applications. You get two sync strategies: Operational Transformation for collaborative text, and Last-Write-Wins for everything else.

<img src="./patches.png" alt="Patches the Dog" style="width: 300px;">

## What Problem Does This Solve?

Building real-time collaborative features is hard. Users edit simultaneously, connections drop mid-change, and conflict resolution gets gnarly fast. Patches handles all of this so you don't have to.

Your document state is just JSON. Change it with a simple callback:

```js
doc.change(state => (state.title = 'New Title'));
```

Changes apply immediately for snappy UIs, then sync to the server in the background. Offline? No problem. Changes queue up and sync when you're back online.

## Two Sync Strategies

Patches gives you two conflict resolution approaches. Pick the right tool for the job.

**[Operational Transformation (OT)](./docs/operational-transformation.md)** - When users edit the same content simultaneously

- Changes get intelligently merged
- Required for collaborative text editing
- Example: Google Docs-style collaboration

**[Last-Write-Wins (LWW)](./docs/last-write-wins.md)** - When the latest timestamp should win

- Simpler, faster, more predictable
- Perfect for settings, dashboards, canvas objects
- [Figma uses this approach](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) for their multiplayer

**The decision is simple:** If users aren't editing the same _text_ collaboratively, use LWW. It's faster, easier to debug, and handles most real-time scenarios perfectly.

Need ordered lists with LWW? Use [fractional indexing](./docs/fractional-indexing.md) to maintain order without OT.

Most apps use both strategies: OT for document content, LWW for everything else.

## Table of Contents

- [Why Operational Transformations?](#why-operational-transformations)
- [Key Concepts](#key-concepts)
- [Installation](#installation)
- [Getting Started](#getting-started)
  - [Client Example](#client-example)
  - [Server Example](#server-example)
  - [LWW Quick Start](#lww-quick-start)
- [Core Components](#core-components)
- [Basic Workflow](#basic-workflow)
- [Examples](#examples)
- [Advanced Topics](#advanced-topics)
- [Contributing](#contributing)
- [License](#license)

## Why Operational Transformations?

"Shouldn't I use CRDTs instead?"

There are [lots](https://thom.ee/blog/crdt-vs-operational-transformation/) of [opinions](https://www.tiny.cloud/blog/real-time-collaboration-ot-vs-crdt/) about [this](https://fiberplane.com/blog/why-we-at-fiberplane-use-operational-transformation-instead-of-crdt/). Here's what we learned at [Dabble Writer](https://www.dabblewriter.com/): CRDTs don't scale for long-lived documents.

Some of our users have projects with 480,000+ operations. These monsters took hours to rebuild in [Y.js](https://yjs.dev/), ~4 seconds to load in optimized Y.js, and ~20ms to add a change. With our OT library? **1-2ms to load and 0.2ms to apply a change.**

As documents grow larger or live longer, OT performance stays flat while CRDTs slow down. For most use cases, CRDTs work fine. But if you're building for scale or longevity, OT wins.

## Key Concepts

**Centralized OT** - A server acts as the single source of truth. No peer-to-peer complexity, no vector clocks, no distributed consensus headaches. The server sees all changes in order and broadcasts the canonical state.

**Rebasing** - When the server has new changes your client hasn't seen, your pending changes get "rebased" on top. Think `git rebase`, but for real-time edits.

**Linear History** - The server maintains one straight timeline. No branches, no forks, no merge conflicts at the infrastructure level.

**Snapshots** - OT documents accumulate changes over time. To avoid replaying 480k operations on load, we snapshot periodically. Load the latest snapshot, apply recent changes, done.

**Immutable State** - Every change creates a new state object. Unchanged parts stay unchanged. This makes React/Vue/Solid rendering trivial and enables cheap equality checks.

Read more: [Operational Transformation deep dive](./docs/operational-transformation.md) | [Algorithm functions](./docs/algorithms.md)

## Installation

```bash
npm install @dabble/patches
```

## Getting Started

### Client Example

```typescript
import { Patches, OTStrategy, InMemoryStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

interface MyDoc {
  text: string;
  count: number;
}

// 1. Create a strategy with its store
const strategy = new OTStrategy(new InMemoryStore());

// 2. Create the Patches instance
const patches = new Patches({
  strategies: { ot: strategy },
  defaultStrategy: 'ot',
});

// 3. Set up real-time sync
const sync = new PatchesSync(patches, 'wss://your-server-url');
await sync.connect();

// 4. Open a document
const doc = await patches.openDoc<MyDoc>('my-doc-1');

// 5. React to updates
doc.onUpdate(newState => {
  console.log('Document updated:', newState);
  // Update your UI here
});

// 6. Make changes - they sync automatically
doc.change(draft => {
  draft.text = 'Hello World!';
  draft.count = (draft.count || 0) + 1;
});
```

See [Patches](./docs/Patches.md), [PatchesDoc](./docs/PatchesDoc.md), and [PatchesSync](./docs/PatchesSync.md) for full API documentation.

### Server Example

```typescript
import express from 'express';
import { OTServer } from '@dabble/patches/server';

// Your backend store implementation
const store = new MyOTStoreBackend();
const server = new OTServer(store);

const app = express();
app.use(express.json());

// Get document state
app.get('/docs/:docId', async (req, res) => {
  const { state, rev } = await server.getDoc(req.params.docId);
  res.json({ state: state ?? {}, rev });
});

// Commit changes
app.post('/docs/:docId/changes', async (req, res) => {
  try {
    const changes = await server.commitChanges(req.params.docId, req.body.changes);
    res.json(changes);
    // Broadcast to other clients via WebSocket
  } catch (error) {
    const status = error.message.includes('out of sync') ? 409 : 500;
    res.status(status).json({ error: error.message });
  }
});

app.listen(3000);
```

See [OTServer](./docs/OTServer.md) for full API documentation.

### LWW Quick Start

For Last-Write-Wins sync, use LWW-specific stores and strategies:

```typescript
// Client
import { Patches, LWWStrategy, LWWInMemoryStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

const strategy = new LWWStrategy(new LWWInMemoryStore());
const patches = new Patches({
  strategies: { lww: strategy },
  defaultStrategy: 'lww',
});

const sync = new PatchesSync(patches, 'wss://your-server-url');
await sync.connect();

const doc = await patches.openDoc<UserPrefs>('user-prefs');

doc.change(draft => {
  draft.theme = 'dark';
  draft.fontSize = 16;
});
```

```typescript
// Server
import { LWWServer } from '@dabble/patches/server';

const store = new MyLWWStoreBackend();
const server = new LWWServer(store);

app.post('/docs/:docId/changes', async (req, res) => {
  const result = await server.commitChanges(req.params.docId, req.body.changes);
  res.json(result);
});
```

See [LWWServer](./docs/LWWServer.md) and [Last-Write-Wins concepts](./docs/last-write-wins.md) for more details.

## Core Components

### Client Side

**[Patches](./docs/Patches.md)** - Main entry point. Manages document lifecycle, coordinates strategies, handles persistence.

**[PatchesDoc](./docs/PatchesDoc.md)** - A single collaborative document. Tracks state, applies changes optimistically, emits update events.

**[PatchesSync](./docs/PatchesSync.md)** - WebSocket connection manager. Handles reconnection, batching, and bidirectional sync.

**Strategies** - Algorithm-specific logic:

- `OTStrategy` - Owns an `OTClientStore`, handles rebasing and change tracking
- `LWWStrategy` - Owns an `LWWClientStore`, handles timestamp consolidation

**Stores** - Persistence adapters:

- `InMemoryStore` / `LWWInMemoryStore` - For testing and simple apps
- `OTIndexedDBStore` / `LWWIndexedDBStore` - Browser persistence with offline support

### Server Side

**[OTServer](./docs/OTServer.md)** - OT authority. Transforms concurrent changes, assigns revisions, maintains history.

**[LWWServer](./docs/LWWServer.md)** - LWW authority. Compares timestamps, stores current field values, no history.

**[PatchesHistoryManager](./docs/PatchesHistoryManager.md)** - Query document versions and history.

**[PatchesBranchManager](./docs/PatchesBranchManager.md)** - Create, list, and merge branches.

**Backend Stores** - You implement these interfaces for your database:

- `OTStoreBackend` - For OT: changes, snapshots, versions
- `LWWStoreBackend` - For LWW: fields with timestamps, snapshots

See [Persistence](./docs/persist.md) for storage patterns and [Backend Store Interface](./docs/operational-transformation.md#backend-store-interface) for implementation details.

### Networking

**[WebSocket Transport](./docs/websocket.md)** - Standard server-mediated communication via `PatchesWebSocket`.

**[WebRTC Transport](./docs/net.md)** - Peer-to-peer for awareness features (cursors, presence).

**[JSON-RPC Protocol](./docs/json-rpc.md)** - The wire protocol between client and server.

When to use which? WebSocket for document sync. WebRTC for presence/cursors to reduce server load. See [Networking overview](./docs/net.md).

### Awareness (Presence & Cursors)

Show who's online, where their cursor is, what they're selecting. Works over both WebSocket and WebRTC.

See [Awareness documentation](./docs/awareness.md) for implementation details.

## Basic Workflow

### Client

1. Create a `Patches` instance with strategies
2. Connect `PatchesSync` to your server
3. Open documents with `patches.openDoc(docId)`
4. Subscribe to updates with `doc.onUpdate()`
5. Make changes with `doc.change()` - they sync automatically

### Server

1. Create `OTServer` or `LWWServer` with your backend store
2. Handle `commitChanges()` requests
3. Broadcast committed changes to other clients
4. Optionally use `PatchesHistoryManager` for versioning and `PatchesBranchManager` for branching

## Examples

### Complete Client Setup

```typescript
import { Patches, OTStrategy, OTIndexedDBStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

interface MyDoc {
  title: string;
  content: string;
}

// Production setup with IndexedDB for offline support
const strategy = new OTStrategy(new OTIndexedDBStore('my-app'));
const patches = new Patches({
  strategies: { ot: strategy },
});

const sync = new PatchesSync(patches, 'wss://api.example.com/sync');

// Handle connection state
sync.onStateChange(state => {
  if (state.connected) {
    console.log('Connected and syncing');
  } else if (!state.online) {
    console.log('Offline - changes saved locally');
  }
});

// Handle errors
sync.onError((error, context) => {
  console.error(`Sync error for ${context?.docId}:`, error);
});

await sync.connect();

// Open and use a document
const doc = await patches.openDoc<MyDoc>('doc-123');

doc.onUpdate(state => {
  renderUI(state);
});

doc.change(draft => {
  draft.title = 'My Document';
  draft.content = 'Hello, world!';
});
```

### Using Both Strategies

```typescript
import { Patches, OTStrategy, LWWStrategy, InMemoryStore, LWWInMemoryStore } from '@dabble/patches';

// Configure both strategies
const patches = new Patches({
  strategies: {
    ot: new OTStrategy(new InMemoryStore()),
    lww: new LWWStrategy(new LWWInMemoryStore()),
  },
  defaultStrategy: 'ot',
});

// OT for collaborative document editing
const manuscript = await patches.openDoc('manuscript-123'); // Uses default (ot)

// LWW for user settings
const settings = await patches.openDoc('settings-user-456', { strategy: 'lww' });
```

## Advanced Topics

### Versioning & History

Documents automatically snapshot after 30 minutes of inactivity. Browse versions with `PatchesHistoryManager`.

See [OTServer Versioning](./docs/OTServer.md#versioning) and [PatchesHistoryManager](./docs/PatchesHistoryManager.md).

### Branching

Create document branches, work in isolation, merge back. Useful for "what if" scenarios or staged editing.

See [Branching](./docs/branching.md) and [PatchesBranchManager](./docs/PatchesBranchManager.md).

### SharedWorker

Run Patches in a SharedWorker for cross-tab coordination and reduced memory usage.

See [SharedWorker documentation](./docs/shared-worker.md).

### Framework Integrations

- **Vue 3**: See [src/vue/README.md](src/vue/README.md)
- **Solid.js**: See [src/solid/README.md](src/solid/README.md)

### Custom OT Operations

Extend the operation handlers for domain-specific transformations.

See [Operation Handlers](./docs/operational-transformation.md#operation-handlers).

### JSON Patch

Patches uses JSON Patch (RFC 6902) under the hood. You rarely need to work with it directly, but it's there.

See [JSON Patch documentation](./docs/json-patch.md).

## Contributing

Contributions welcome. Open issues or submit pull requests.

## License

[MIT](./LICENSE_MIT)
