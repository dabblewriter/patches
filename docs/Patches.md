# `Patches` - The Client Coordinator

`Patches` is the central hub of your collaborative app on the client side. One instance, many documents. It manages document lifecycle, coordinates events, and provides the public API your app interacts with.

**Table of Contents**

- [What It Does](#what-it-does)
- [Getting Started](#getting-started)
- [Working with Documents](#working-with-documents)
- [Real-Time Sync](#real-time-sync)
- [Events](#events)
- [Complete Example](#complete-example)
- [Related Components](#related-components)

## What It Does

`Patches` is a coordinator, not a worker. It doesn't do the heavy lifting - it orchestrates the pieces that do:

- **Document Management**: Opens, tracks, and closes your collaborative docs
- **Event Coordination**: Listens to document events and re-emits them for your app
- **Strategy Delegation**: Routes operations to the right sync strategy (OT or LWW)
- **Public API**: Provides the clean interface your app uses

The pattern: create **one** `Patches` instance for your whole app, then use it to open as many documents as you need.

## Getting Started

### The Easy Way: Factory Functions

For most apps, factory functions are the simplest way to get started:

```typescript
import { createOTPatches, createOTIndexedDBPatches } from '@dabble/patches';

// For testing or when persistence isn't needed
const patches = createOTPatches();

// For production with IndexedDB persistence
const patches = createOTIndexedDBPatches({ dbName: 'my-app' });
```

Available factories:

| Factory                                | Strategy | Storage   | Use Case                         |
| -------------------------------------- | -------- | --------- | -------------------------------- |
| `createOTPatches`                      | OT       | Memory    | Testing, ephemeral sessions      |
| `createOTIndexedDBPatches`             | OT       | IndexedDB | Production collaborative editing |
| `createLWWPatches`                     | LWW      | Memory    | Testing LWW features             |
| `createLWWIndexedDBPatches`            | LWW      | IndexedDB | Production settings/preferences  |
| `createMultiAlgorithmPatches`          | Both     | Memory    | Testing multi-strategy apps      |
| `createMultiAlgorithmIndexedDBPatches` | Both     | IndexedDB | Production multi-strategy apps   |

All factories accept optional `metadata` for attaching user info to changes:

```typescript
const patches = createOTIndexedDBPatches({
  dbName: 'my-app',
  metadata: {
    user: { id: 'user-123', name: 'Alice', color: '#FF5733' },
    deviceId: 'mobile-ios-12345',
  },
});
```

### The Manual Way: Full Configuration

If you need more control, construct `Patches` directly with a strategies map:

```typescript
import { Patches, OTStrategy, InMemoryStore } from '@dabble/patches';

const store = new InMemoryStore();
const otStrategy = new OTStrategy(store);

const patches = new Patches({
  strategies: { ot: otStrategy },
  defaultStrategy: 'ot',
  metadata: { user: { id: 'user-123' } },
});
```

This approach lets you:

- Use custom store implementations
- Configure strategy-specific options
- Mix strategies with different storage backends

### Choosing a Strategy

**OT (Operational Transformation)** is for collaborative editing where concurrent changes need intelligent merging. Multiple users editing the same paragraph? OT handles that.

**LWW (Last-Write-Wins)** is for simpler data where the most recent write should just... win. User settings, preferences, dashboard positions - timestamps resolve conflicts.

See [operational-transformation.md](operational-transformation.md) and [last-write-wins.md](last-write-wins.md) for deeper dives into each approach.

## Working with Documents

### Opening a Document

```typescript
// Define your document type
interface MyDoc {
  title: string;
  items: Array<{ id: string; text: string; done: boolean }>;
}

// Open a document (creates it if it doesn't exist)
const doc = await patches.openDoc<MyDoc>('shopping-list');

// Access the state
console.log(`Shopping List: ${doc.state.title}`);
console.log(`${doc.state.items.length} items`);

// Make changes
doc.change(draft => {
  draft.title = 'Grocery Shopping';
  draft.items.push({ id: Date.now().toString(), text: 'Milk', done: false });
});
```

The `openDoc` method:

- Returns a [`PatchesDoc<T>`](PatchesDoc.md) instance
- Creates the document if it doesn't exist
- Loads the latest state from your store
- Sets up change tracking

You can also specify a different strategy when opening:

```typescript
// Open with LWW strategy instead of default
const settingsDoc = await patches.openDoc('user-settings', { strategy: 'lww' });
```

### Tracking Documents

Before opening docs, you might want to tell Patches which ones you care about:

```typescript
// Start tracking a set of documents
await patches.trackDocs(['shopping-list', 'todo-list', 'workout-plan']);

// Later, when you're done with some
await patches.untrackDocs(['workout-plan']);
```

Tracked documents stay in sync with the server even when not open locally. This enables background syncing and receiving updates for documents you're not actively viewing.

### Closing Documents

When you're done with a document:

```typescript
// Close a document (saves pending changes, removes from memory)
await patches.closeDoc('shopping-list');

// Or close and also untrack it
await patches.closeDoc('shopping-list', { untrack: true });

// For permanent deletion
await patches.deleteDoc('old-shopping-list');
```

Closing docs frees memory and ensures pending changes are persisted.

## Real-Time Sync

`Patches` works with [`PatchesSync`](PatchesSync.md) for real-time collaboration:

```typescript
import { PatchesSync } from '@dabble/patches/net';

// Create sync connection (patches instance first, then URL)
const sync = new PatchesSync(patches, 'wss://your-server.example.com');

// Connect to the server
await sync.connect();

// That's it - changes now automatically sync to/from the server
```

The flow:

1. `Patches` emits events when documents change
2. `PatchesSync` listens and handles server communication
3. Server changes flow back through `PatchesSync` to update documents
4. All the sync logic happens in pure [algorithm functions](algorithms.md)
5. Your app just sees clean, coordinated state updates

## Events

Listen for important events from the `Patches` system:

```typescript
// When a document receives changes from the server
patches.onServerCommit((docId, changes) => {
  console.log(`Document ${docId} received ${changes.length} changes from server`);
});

// When there's an error (usually from sync operations)
patches.onError((error, context) => {
  console.error(`Error in document ${context?.docId}:`, error);
  showErrorNotification('Something went wrong. Retrying...');
});

// When any document has pending changes ready to send
patches.onChange(docId => {
  console.log(`Document ${docId} has pending changes`);
});

// When documents are tracked/untracked
patches.onTrackDocs(docIds => {
  console.log('Now tracking:', docIds);
});

patches.onUntrackDocs(docIds => {
  console.log('No longer tracking:', docIds);
});

// When a document is deleted
patches.onDeleteDoc(docId => {
  console.log(`Document ${docId} was deleted`);
});
```

## Complete Example

Here's a real-world setup for a collaborative application:

```typescript
import { createOTIndexedDBPatches } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

class CollaborativeApp {
  private patches;
  private sync;
  private activeDocuments = new Map();

  constructor() {
    // Create Patches with IndexedDB persistence and user info
    this.patches = createOTIndexedDBPatches({
      dbName: 'my-collaborative-app',
      metadata: {
        user: this.getCurrentUser(),
      },
    });

    // Set up error handling
    this.patches.onError(this.handleError.bind(this));

    // Set up sync
    this.sync = new PatchesSync(this.patches, 'wss://collab.example.com');

    // Handle connection state
    this.sync.onConnectionStateChange(state => {
      this.updateConnectionUI(state);
    });
  }

  async initialize() {
    // Track recently used documents
    const recentDocs = this.getRecentDocIds();
    await this.patches.trackDocs(recentDocs);

    // Connect to server
    await this.sync.connect();

    console.log('Collaborative app ready');
  }

  async openDocument(docId) {
    const doc = await this.patches.openDoc(docId);

    // Set up UI updates
    doc.onUpdate(state => {
      this.updateDocumentUI(docId, state);
    });

    this.activeDocuments.set(docId, doc);
    this.addToRecentDocs(docId);

    return doc;
  }

  makeChange(docId, changeFn) {
    const doc = this.activeDocuments.get(docId);
    if (doc) {
      doc.change(changeFn);
    }
  }

  async shutdown() {
    await this.patches.close();
  }

  // Helper methods
  private getCurrentUser() {
    /* ... */
  }
  private getRecentDocIds() {
    /* ... */
  }
  private addToRecentDocs(docId) {
    /* ... */
  }
  private updateDocumentUI(docId, state) {
    /* ... */
  }
  private updateConnectionUI(state) {
    /* ... */
  }
  private handleError(error, context) {
    /* ... */
  }
}

// Usage
const app = new CollaborativeApp();
await app.initialize();

const doc = await app.openDocument('project-notes');

app.makeChange('project-notes', draft => {
  draft.title = 'Project X Planning';
  draft.notes.push('Meeting scheduled for Friday');
});
```

## Related Components

`Patches` coordinates several other components. Understand these to get the full picture:

- [PatchesDoc](PatchesDoc.md) - Individual document instances that `Patches` creates for you
- [PatchesSync](PatchesSync.md) - Real-time synchronization coordinator
- [persist.md](persist.md) - Storage interfaces and implementations
- [algorithms.md](algorithms.md) - Pure functions that handle OT and change processing
- [OTServer](OTServer.md) - Server-side OT implementation
- [LWWServer](LWWServer.md) - Server-side LWW implementation
- [operational-transformation.md](operational-transformation.md) - Deep dive into OT concepts
- [last-write-wins.md](last-write-wins.md) - Deep dive into LWW concepts
