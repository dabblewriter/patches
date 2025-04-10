# Patches

A friendly realtime library based on operational transformations.

<img src="./patches.png" alt="Patches the Dog" style="width: 300px;">

Patches is a TypeScript library designed for building real-time collaborative applications. It leverages Operational Transformation (OT) with a centralized server model to ensure document consistency across multiple clients. It supports versioning, offline work, branching, and can handle very large and very long-lived documents.

When working with a document in Patches, you are working with regular JavaScript data types. If it is supported by JSON, you can have it in your document. The `state` in your `doc.state` is your immutable data. When you modify your document with `doc.update(state => state.prop = 'new value')` the doc will get a new immutable `state` object with those changes applied.

## Table of Contents

- [Why Operational Transformations?](#why-operational-transformations)
- [Key Concepts](#key-concepts)
- [Installation](#installation)
- [Core Components](#core-components)
  - [PatchDoc](#patchdoc)
  - [PatchServer](#patchserver)
  - [HistoryManager](#historymanager)
  - [BranchManager](#branchmanager)
  - [Backend Store](#backend-store)
- [Basic Workflow](#basic-workflow)
  - [Client-Side](#client-side)
  - [Server-Side](#server-side)
- [Examples](#examples)
  - [Simple Client Setup](#simple-client-setup)
  - [Simple Server Setup](#simple-server-setup)
- [Advanced Topics](#advanced-topics)
  - [Offline Support & Versioning](#offline-support--versioning)
  - [Branching and Merging](#branching-and-merging)
  - [Custom OT Types](#custom-ot-types)
- [JSON Patch (Legacy)](#json-patch-legacy)
- [Contributing](#contributing)
- [License](#license)

## Why Operational Transformations?

**OT vs CRDT**
[Conflict-Free Replicated Datatypes](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type) are the newest and improved algorithm for collaborative editing, so why use [Operational Transformation](https://en.wikipedia.org/wiki/Operational_transformation)? There [are](https://thom.ee/blog/crdt-vs-operational-transformation/) [various](https://www.tiny.cloud/blog/real-time-collaboration-ot-vs-crdt/) [opinions](https://fiberplane.com/blog/why-we-at-fiberplane-use-operational-transformation-instead-of-crdt/) about which to use. We found that at [Dabble Writer](https://www.dabblewriter.com/), the performance of CRDTs was not good enough for some of the extremely large or long-lived documents for our customers. Even the highly optimized [Y.js](https://yjs.dev/) which we really hoped would work for us didn't cut it. And since our service requires a central server anyway, we decided to double-down on our OT library, spruce it up, deck it out, improve the [DX](https://en.wikipedia.org/wiki/User_experience#Developer_experience) for ourselves, but hopefully it is useful for you too.

**What about Y.js?**
For those who may want to let us know that Y.js can handle large documents, we did run tests ourselves. We were impressed with what Y.js offers and were hopeful it would work for us. We prefer to focus on the user experience than on our syncing library. However, it was not to be.

Our longest project contains over 480k operations in it. 😳 And considering we save written text in 30-second chunks, not character-by-character, you can start to understand how *extra* some of our customers are in their writing. That project took a few hours to re-create in Y.js from our OT patches, ~4 seconds to load in an optimized, GCed Y.js doc on a fast Mac Studio, and ~20ms to add a new change to it. Compare that to our (this) OT library which takes 1-2ms to load the doc and 0.2ms to apply a new change to it. As projects grow larger or longer, OT's performance remains constant and CRDT's diminish. For _most_ use-cases CRDTs may be better, but if you have very large—or more importantly long-lived (many changes over time)—documents, you may find OT a better choice.

## Key Concepts

- **Centralized OT:** Uses a central authority (the server) to definitively order operations, simplifying conflict resolution compared to fully distributed OT systems. ([Learn more about centralized vs. distributed OT](https://marijnhaverbeke.nl/blog/collaborative-editing.html#centralization)).
- **Rebasing:** Client changes are "rebased" on top of changes they receive from the server, ensuring local edits are adjusted correctly based on the server's history.
- **Linear History:** The server maintains a single, linear history of document revisions.
- **Client-Server Communication:** Clients send batches of changes (`Change` objects) tagged with the server revision they were based on (`baseRev`). The server transforms these changes, applies them, assigns a new revision number, and broadcasts the committed change back to clients.

**Why Centralized?**
There are many papers and algorithms for OT. There are problems—edge-cases—with those that don't rely on a central authority. To simplify, we use an algorithm that only transforms operations in one direction, rather than in 2. It is more like a git *rebase*. This method was inspired by [Marijn Haverbeke’s article](https://marijnhaverbeke.nl/blog/collaborative-editing.html) about the topic, and we originally had the server reject changes if new ones came in before them and require the client to transform (rebase) them and resubmit. This comes with a theoretical downside, however. Slow connections and quickly changing documents may keep slower clients resubmitting over and over and never committing. For example, if you had an OT document that tracked all the mouse movements of every client connected to a document, a slow client might have severe jitter while it tries to commit its mouse position. I wouldn't suggest using OT for this use-case, but as I said, it is a theoretical downside. So we have modified our approach to make the server do the transform and commit, sending back any new changes *and* the transformed submitted ones for the client to apply. This ensures all clients "get equal time with the server", even with slow connections.

**Snapshots**
OT documents are essentially an array of changes. To create the in-memory state of the document, the `doc.state` that you view, you must replay each change from the first to the last. You may recognize a problem here. For long documents (like ones with 480k changes), this could take some time. For this reason, OT will snapshot the data every X number of changes (200, 500, etc). This allows you to grab the latest snapshot and then any changes after it was created and replay those change on top of the snapshot to get the latest state. This is what allows OT to have consistent performance over time.

**Versioning as Snapshots**
Most realtime collaborative documents are accessed and changed in bursts—user sessions—where a person sits down to write, design, edit, whiteboard, etc. Most of these use-cases benefit from "versioning" features where the user can go back in time to see old versions of their project. Patches combines the concept of snapshots and versions. Instead of using X number of changes to decide when to create a snapshot, Patches creates a new versions/snapshots after there is more than 30 minutes between any 2 changes. Some versions or snapshots may only reflect 1 change. Others may reflect 100s. As long as your document isn't being constantly updated, the requirement of snapshots turns into a feature you can provide your users. *If you have an [IoT](https://en.wikipedia.org/wiki/Internet_of_things) use-case or something similar where there is no break to create versions, we'd be happy for a pull request that allows Patches to support both. But we didn't want to make the code more complex for something that may not be used.*

**Immutable State**
Patches uses immutable data. That is, it uses gentleman's (and lady's) immutability, meaning, you *shouldn't* change the structure, but for performance the objects aren't frozen. Each change creates a new object in memory, keeping the old objects that didn't change and replacing only those that did. There are [articles](https://www.freecodecamp.org/news/immutable-javascript-improve-application-performance/) [about](http://www.cowtowncoder.com/blog/archives/2010/08/entry_409.html) the [benefits](https://medium.com/@mohitgadhavi1/the-power-of-immutability-improving-javascript-performance-and-code-quality-96d82134d8da) of using immutable data, but suffice it to say, Patches assumes you won't be changing the state data outside of the `doc.update(stateProxy => {...})` method (which uses a proxy, BTW, and does not operate on the state directly).

## Installation

```bash
npm install @dabble/patches
# or
yarn add @dabble/patches
```

## Core Components

Centralized OT has two different areas of focus, the server and the client. They both have very different jobs and interaction patterns.

These are the main classes you'll interact with when building a collaborative application with Patches.

### PatchDoc

(`PatchDoc` Documentation: [`docs/PatchDoc.md`](./docs/PatchDoc.md))

This is what you'll be working with on the client in your app. It is the client-side view of a collaborative document. You can check out [`docs/operational-transformation.md#patchdoc`](./docs/operational-transformation.md#patchdoc) to learn more about its role in the OT flow.

- **Local State Management:** Maintains the *committed* state (last known server state), sending changes (awaiting server confirmation), and pending changes (local edits not yet sent).
- **Optimistic Updates:** Applies local changes immediately for a responsive UI.
- **Synchronization:** Implements the client-side OT logic:
  - Sends pending changes to the server (`getUpdatesForServer`).
  - Applies server confirmations (`applyServerConfirmation`).
  - Applies external server updates from other clients (`applyExternalServerUpdate`), rebasing local changes as needed.
- **Event Emitters:** Provides hooks (`onUpdate`, `onChange`, etc.) to react to state changes.

See [`docs/PatchDoc.md`](./docs/PatchDoc.md) for detailed usage and examples.

### PatchServer

(`PatchServer` Documentation: [`docs/PatchServer.md`](./docs/PatchServer.md))

The heart of the server-side logic. See [`docs/operational-transformation.md#patchserver`](./docs/operational-transformation.md#patchserver) for its role in the OT flow.

- **Receives Changes:** Handles incoming `Change` objects from clients.
- **Transformation:** Transforms client changes against concurrent server changes using the OT algorithm.
- **Applies Changes:** Applies the final transformed changes to the authoritative document state.
- **Versioning:** Creates version snapshots based on time-based sessions or explicit triggers (useful for history and offline support).
- **Persistence:** Uses a `PatchStoreBackend` implementation to save/load document state, changes, and versions.

See [`docs/PatchServer.md`](./docs/PatchServer.md) for detailed usage and examples.

### HistoryManager

(`HistoryManager` Documentation: [`docs/HistoryManager.md`](./docs/HistoryManager.md))

Provides an API for querying the history ([`VersionMetadata`](./docs/types.ts)) of a document.

- **List Versions:** Retrieve metadata about saved document versions (snapshots).
- **Get Version State/Changes:** Load the full state or the specific changes associated with a past version.
- **List Server Changes:** Query the raw sequence of committed server changes based on revision numbers.

See [`docs/HistoryManager.md`](./docs/HistoryManager.md) for detailed usage and examples.

### BranchManager

(`BranchManager` Documentation: [`docs/BranchManager.md`](./docs/BranchManager.md))

Manages branching ([`Branch`](./docs/types.ts)) and merging workflows.

- **Create Branch:** Creates a new document branching off from a source document at a specific revision.
- **List Branches:** Retrieves information about existing branches.
- **Merge Branch:** Merges the changes made on a branch back into its source document (requires OT on the server to handle conflicts).
- **Close Branch:** Marks a branch as closed, merged, or abandoned.

See [`docs/BranchManager.md`](./docs/BranchManager.md) for detailed usage and examples.

### Backend Store

([`PatchStoreBackend` / `BranchingStoreBackend`](./docs/operational-transformation.md#backend-store-interface) Documentation: [`docs/operational-transformation.md#backend-store-interface`](./docs/operational-transformation.md#backend-store-interface))

This isn't a specific class provided by the library, but rather an _interface_ (`PatchStoreBackend` and `BranchingStoreBackend`) that you need to implement. This interface defines how the `PatchServer`, `HistoryManager`, and `BranchManager` interact with your chosen persistence layer (e.g., a database, file system, in-memory store).

You are responsible for providing an implementation that fulfills the methods defined in the interface (e.g., `getLatestRevision`, `saveChange`, `listVersions`, `createBranch`).

See [`docs/operational-transformation.md#backend-store-interface`](./docs/operational-transformation.md#backend-store-interface) for the interface definition.

## Basic Workflow

### Client-Side (`PatchDoc`)

1.  **Initialize `PatchDoc`:** Create an instance. See [`docs/PatchDoc.md#initialization`](./docs/PatchDoc.md#initialization).
2.  **Subscribe to Updates:** Use [`doc.onUpdate`](./docs/PatchDoc.md#onupdate).
3.  **Make Local Changes:** Use [`doc.update()`](./docs/PatchDoc.md#update).
4.  **Send Changes:** Use [`doc.getUpdatesForServer()`](./docs/PatchDoc.md#getupdatesforserver) and [`doc.applyServerConfirmation()`](./docs/PatchDoc.md#applyserverconfirmation).
5.  **Receive Server Changes:** Use [`doc.applyExternalServerUpdate()`](./docs/PatchDoc.md#applyexternalserverupdate).

### Server-Side (`PatchServer`)

1.  **Initialize `PatchServer`:** Create an instance. See [`docs/PatchServer.md#initialization`](./docs/PatchServer.md#initialization).
2.  **Receive Client Changes:** Use [`server.receiveChanges()`](./docs/PatchServer.md#core-method-receivechanges).
3.  **Handle History/Branching:** Use [`HistoryManager`](./docs/HistoryManager.md) and [`BranchManager`](./docs/BranchManager.md).

## Examples

_(Note: These are simplified examples. Real-world implementations require proper error handling, network communication, authentication, and backend setup.)_

### Simple Client Setup

```typescript
import { PatchDoc, Change } from '@dabble/patches';

interface MyDoc {
  text: string;
  count: number;
}

// Assume these are fetched initially
const initialDocId = 'doc123';
const initialServerState: MyDoc = { text: 'Hello', count: 0 };
const initialServerRev = 5; // Revision corresponding to initialServerState

// Your function to send changes and receive the server's commit
async function sendChangesToServer(docId: string, changes: Change[]): Promise<Change[]> {
  const response = await fetch(`/docs/${docId}/changes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || `Server error: ${response.status}`);
  }
  return await response.json();
}

// --- Initialize PatchDoc ---
const patchDoc = new PatchDoc<MyDoc>(initialServerState, initialServerRev);

// --- UI Update Logic ---
patchDoc.onUpdate(newState => {
  console.log('Document updated:', newState);
  // Update your UI element displaying newState.text, newState.count, etc.
});

// --- Making a Local Change ---
function handleTextInput(newText: string) {
  patchDoc.update(draft => {
    draft.text = newText;
  });
  // Trigger sending changes (e.g., debounced)
  sendLocalChanges();
}

function handleIncrement() {
  patchDoc.update(draft => {
    draft.count = (draft.count || 0) + 1;
  });
  sendLocalChanges();
}

// --- Sending Changes ---
let isSending = false;
async function sendLocalChanges() {
  if (isSending || !patchDoc.hasPending) return;

  isSending = true;
  try {
    const changesToSend = patchDoc.getUpdatesForServer();
    if (changesToSend.length > 0) {
      console.log('Sending changes:', changesToSend);
      const serverCommit = await sendChangesToServer(initialDocId, changesToSend);
      console.log('Received confirmation:', serverCommit);
      patchDoc.applyServerConfirmation(serverCommit);
    }
  } catch (error) {
    console.error('Failed to send changes:', error);
    // Handle error - maybe retry, revert local changes, or force resync
    // For simplicity, just log here. PatchDoc state might be inconsistent.
  } finally {
    isSending = false;
    // Check again in case new changes came in while sending
    if (patchDoc.hasPending) {
      setTimeout(sendLocalChanges, 100); // Basic retry/check again
    }
  }
}

// --- Receiving External Changes (e.g., via WebSocket) ---
function handleServerBroadcast(externalChanges: Change[]) {
  if (!externalChanges || externalChanges.length === 0) return;
  console.log('Received external changes:', externalChanges);
  try {
    patchDoc.applyExternalServerUpdate(externalChanges);
  } catch (error) {
    console.error('Error applying external server changes:', error);
    // Critical error - likely need to resync the document state
  }
}

// --- Example Usage ---
// handleTextInput("Hello World!");
// handleIncrement();
// Assume setup for receiving broadcasts via `handleServerBroadcast`
```

### Simple Server Setup

```typescript
import express from 'express';
import {
  PatchServer,
  PatchStoreBackend,
  Change,
  VersionMetadata, //... other types
} from '@dabble/patches';

// --- Basic In-Memory Store (Replace with a real backend!) ---
class InMemoryStore implements PatchStoreBackend {
  private docs: Map<string, { state: any; rev: number; changes: Change[]; versions: VersionMetadata[] }> = new Map();

  async getLatestRevision(docId: string): Promise<number> {
    return this.docs.get(docId)?.rev ?? 0;
  }
  async getLatestState(docId: string): Promise<any | undefined> {
    const doc = this.docs.get(docId);
    // Return a deep copy to prevent accidental mutation
    return doc ? JSON.parse(JSON.stringify(doc.state)) : undefined;
  }
  async getStateAtRevision(docId: string, rev: number): Promise<any | undefined> {
    // IMPORTANT: In-memory store cannot easily reconstruct past states without snapshots.
    // A real implementation would replay changes or load version snapshots.
    // This basic version only returns the latest state if rev matches.
    const doc = this.docs.get(docId);
    if (doc && doc.rev === rev) {
      return JSON.parse(JSON.stringify(doc.state)); // Return copy
    }
    // Try finding a version snapshot matching the revision
    const version = doc?.versions.find(v => v.endDate === rev); // Approximation!
    if (version) {
      return JSON.parse(JSON.stringify(version.state));
    }
    // Fallback: Cannot reconstruct this revision
    if (rev === 0 && !doc) return {}; // Initial empty state at rev 0
    console.warn(
      `In-Memory Store: Cannot get state at revision ${rev} for doc ${docId}. Returning latest or undefined.`
    );
    return doc ? JSON.parse(JSON.stringify(doc.state)) : undefined; // Or throw error
  }
  async saveChange(docId: string, change: Change): Promise<void> {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = { state: {}, rev: 0, changes: [], versions: [] };
      this.docs.set(docId, doc);
    }
    // Apply change to get new state (use library's apply function)
    const { applyChanges } = await import('@dabble/patches'); // Assuming exported
    doc.state = applyChanges(doc.state, [change]);
    doc.rev = change.rev;
    doc.changes.push(change); // Store history of changes
    console.log(`[Store] Saved change rev ${change.rev} for doc ${docId}. New state:`, doc.state);
  }
  async listChanges(docId: string, options: any): Promise<Change[]> {
    const doc = this.docs.get(docId);
    if (!doc) return [];
    let changes = doc.changes;
    if (options.startAfterRev !== undefined) {
      changes = changes.filter(c => c.rev > options.startAfterRev!);
    }
    // Add other filter/limit/sort logic here based on options
    changes.sort((a, b) => a.rev - b.rev); // Ensure ascending order
    if (options.limit) {
      changes = changes.slice(0, options.limit);
    }
    return changes;
  }
  async saveVersion(docId: string, version: VersionMetadata): Promise<void> {
    const doc = this.docs.get(docId);
    if (!doc) {
      // This case is less likely if saveChange created the doc, but handle defensively
      console.warn(`[Store] Cannot save version for non-existent doc ${docId}`);
      return;
    }
    // Simple: just add to list. A real store might index/optimize.
    doc.versions.push(version);
    console.log(`[Store] Saved version ${version.id} (${version.origin}) for doc ${docId}.`);
  }
  async listVersions(docId: string, options: any): Promise<VersionMetadata[]> {
    const doc = this.docs.get(docId);
    if (!doc) return [];
    let versions = doc.versions;
    // Apply filtering/sorting based on options (simplified)
    if (options.origin) {
      versions = versions.filter(v => v.origin === options.origin);
    }
    if (options.groupId) {
      versions = versions.filter(v => v.groupId === options.groupId);
    }
    // ... other filters ...
    versions.sort((a, b) => (options.reverse ? b.startDate - a.startDate : a.startDate - b.startDate));
    if (options.limit) {
      versions = versions.slice(0, options.limit);
    }
    return versions;
  }
  async loadVersionMetadata(docId: string, versionId: string): Promise<VersionMetadata | null> {
    const doc = this.docs.get(docId);
    return doc?.versions.find(v => v.id === versionId) ?? null;
  }
  async loadVersionState(docId: string, versionId: string): Promise<any | undefined> {
    const meta = await this.loadVersionMetadata(docId, versionId);
    return meta ? JSON.parse(JSON.stringify(meta.state)) : undefined; // Return copy
  }
  async loadVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    const meta = await this.loadVersionMetadata(docId, versionId);
    return meta ? meta.changes : [];
  }
  async getLatestVersionMetadata(docId: string): Promise<VersionMetadata | null> {
    const doc = this.docs.get(docId);
    if (!doc || doc.versions.length === 0) return null;
    // Find version with the latest endDate
    return doc.versions.reduce(
      (latest, current) => (!latest || current.endDate > latest.endDate ? current : latest),
      null as VersionMetadata | null
    );
  }
  // Implement BranchingStoreBackend methods if needed...
}

// --- Server Setup ---
const store = new InMemoryStore();
const server = new PatchServer(store);
const app = express();
app.use(express.json());

// --- Mock Broadcast (Replace with WebSocket/SSE etc.) ---
const clients = new Map<string, Set<any>>(); // docId -> Set<client connections>
function broadcastChanges(docId: string, changes: Change[], senderClientId: string | null) {
  console.log(`Broadcasting changes for ${docId} to other clients:`, changes);
  // Implement actual broadcast logic here (e.g., WebSockets)
  // clients.get(docId)?.forEach(client => {
  //     if (client.id !== senderClientId) { // Don't send back to sender
  //         client.send(JSON.stringify({ type: 'changes', docId, changes }));
  //     }
  // });
}

// --- API Endpoint ---
app.post('/docs/:docId/changes', async (req, res) => {
  const docId = req.params.docId;
  const clientChanges: Change[] = req.body.changes;
  const clientId = req.headers['x-client-id'] as string | null; // Example client ID header

  // Basic validation
  if (!Array.isArray(clientChanges)) {
    return res.status(400).json({ error: 'Invalid request: expected changes array.' });
  }

  console.log(`Received ${clientChanges.length} changes for doc ${docId} from client ${clientId || 'unknown'}`);

  try {
    const committedChanges = await server.receiveChanges(docId, clientChanges);
    console.log(`Committed ${committedChanges.length} changes for doc ${docId}, rev: ${committedChanges[0]?.rev}`);
    res.json(committedChanges); // Send confirmation back to sender

    // Broadcast to others if changes were made
    if (committedChanges.length > 0) {
      broadcastChanges(docId, committedChanges, clientId);
    }
  } catch (error: any) {
    console.error(`Error processing changes for doc ${docId}:`, error);
    // Use 409 Conflict for revision mismatches, 500 for others
    const statusCode = error.message.includes('out of sync') ? 409 : 500;
    res.status(statusCode).json({ error: error.message });
  }
});

// Endpoint to get latest state (for new clients)
app.get('/docs/:docId', async (req, res) => {
  const docId = req.params.docId;
  try {
    const { state, rev } = await server.getLatestDocumentStateAndRev(docId);
    res.json({ state: state ?? {}, rev }); // Provide empty object if state is undefined
  } catch (error: any) {
    console.error(`Error fetching state for doc ${docId}:`, error);
    res.status(500).json({ error: 'Failed to fetch document state.' });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
```

## Advanced Topics

### Offline Support & Versioning

See [`PatchServer Versioning`](./docs/PatchServer.md#versioning) and [`HistoryManager`](./docs/HistoryManager.md).

### Branching and Merging

See [`BranchManager`](./docs/BranchManager.md).

### Custom OT Types

See [`Operational Transformation > Operation Handlers`](./docs/operational-transformation.md#operation-handlers).

## JSON Patch (Legacy)

See [`docs/json-patch.md`](./docs/json-patch.md) for documentation on the JSON Patch features, including [`JSONPatch`](./docs/json-patch.md#jsonpatch-class) and [`createJSONPatch`](./docs/json-patch.md#createjsonpatch-helper).

## Contributing

Contributions are welcome! Please feel free to open issues or submit pull requests.

_(TODO: Add contribution guidelines)_

## License

[MIT](./LICENSE_MIT)
