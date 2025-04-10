# Patches - A friendly and loyal realtime library using operational transformations

<img src="./patches.png" alt="Patches the Dog" style="max-width: 300px;">

Patches is a TypeScript library designed for building real-time collaborative applications. It leverages Operational Transformation (OT) with a centralized server model to ensure document consistency across multiple clients.

While originally including JSON Patch functionality, the focus is now on providing a robust and understandable OT system for collaborative editing scenarios.

**Key Concepts:**

- **Centralized OT:** Uses a central authority (the server) to definitively order operations, simplifying conflict resolution compared to fully distributed OT systems. ([Learn more about centralized vs. distributed OT](https://marijnhaverbeke.nl/blog/collaborative-editing.html#centralization)).
- **Rebasing:** Client changes are "rebased" on top of changes they receive from the server, ensuring local edits are adjusted correctly based on the server's history.
- **Linear History:** The server maintains a single, linear history of document revisions.
- **Client-Server Communication:** Clients send batches of changes (`Change` objects) tagged with the server revision they were based on (`baseRev`). The server transforms these changes, applies them, assigns a new revision number, and broadcasts the committed change back to clients.

## Table of Contents

- [Installation](#installation)
- [Core Components](#core-components)
  - [PatchServer](#patchserver)
  - [PatchDoc](#patchdoc)
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

## Installation

```bash
npm install @dabble/patches
# or
yarn add @dabble/patches
```

## Core Components

These are the main classes you'll interact with when building a collaborative application with Patches.

### PatchServer

(`PatchServer` Documentation: [`docs/PatchServer.md`](./docs/PatchServer.md))

The heart of the server-side logic. See [`docs/operational-transformation.md#patchserver`](./docs/operational-transformation.md#patchserver) for its role in the OT flow.

- **Receives Changes:** Handles incoming `Change` objects from clients.
- **Transformation:** Transforms client changes against concurrent server changes using the OT algorithm.
- **Applies Changes:** Applies the final transformed changes to the authoritative document state.
- **Versioning:** Creates version snapshots based on time-based sessions or explicit triggers (useful for history and offline support).
- **Persistence:** Uses a `PatchStoreBackend` implementation to save/load document state, changes, and versions.

See [`docs/PatchServer.md`](./docs/PatchServer.md) for detailed usage and examples.

### PatchDoc

(`PatchDoc` Documentation: [`docs/PatchDoc.md`](./docs/PatchDoc.md))

Represents the client-side view of a collaborative document. See [`docs/operational-transformation.md#patchdoc`](./docs/operational-transformation.md#patchdoc) for its role in the OT flow.

- **Local State Management:** Maintains the committed state (last known server state), sending changes (awaiting server confirmation), and pending changes (local edits not yet sent).
- **Optimistic Updates:** Applies local changes immediately for a responsive UI.
- **Synchronization:** Implements the client-side OT logic:
  - Sends pending changes to the server (`getUpdatesForServer`).
  - Applies server confirmations (`applyServerConfirmation`).
  - Applies external server updates from other clients (`applyExternalServerUpdate`), rebasing local changes as needed.
- **Event Emitters:** Provides hooks (`onUpdate`, `onChange`, etc.) to react to state changes.

See [`docs/PatchDoc.md`](./docs/PatchDoc.md) for detailed usage and examples.

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
