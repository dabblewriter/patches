# `Patches` — Your Collaboration Command Center 🎮

Meet `Patches` - the brains of your collaborative app operation! This class is where it all starts - your home base for managing documents, keeping everything in sync, and making the magic happen.

**Table of Contents**

- [What Is It?](#what-is-it)
- [Getting Started](#getting-started)
- [Working with Documents](#working-with-documents)
- [Plugging Into Real-Time Sync](#plugging-into-real-time-sync)
- [Event Hooks](#event-hooks)
- [See It in Action](#see-it-in-action)
- [The Rest of the Family](#the-rest-of-the-family)

## What Is It?

`Patches` is like the conductor of your collaborative symphony. After the refactor, it's focused on coordination rather than doing the heavy lifting itself. It:

- **Document Management**: Opens, tracks, and closes your collaborative docs
- **Event Coordination**: Listens to document events and re-emits them for your app
- **Storage Interface**: Manages persistence through your chosen PatchesStore
- **Public API**: Provides the clean interface your app uses

Here's the key: You create **one** `Patches` instance for your whole app, then use it to open as many documents as you need. Think of it as your document orchestrator and public API.

## Getting Started

Starting with `Patches` is super simple:

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';

// Create a store for persistence
const store = new InMemoryStore(); // For testing - use IndexedDBStore for production!

// Create your main Patches instance
const patches = new Patches({ store });

// You're ready to rock! 🎸
```

### Configuration Options

When creating your `Patches` instance, you can customize it:

```typescript
const patches = new Patches({
  // REQUIRED: Where should changes be saved?
  store: new IndexedDBStore('my-cool-app'),

  // OPTIONAL: Default metadata for changes from this client
  metadata: {
    user: {
      id: 'user-123',
      name: 'Alice',
      color: '#FF5733',
    },
    deviceId: 'mobile-ios-12345',
  },
});
```

The metadata is super handy for tracking who made what changes!

## Working with Documents

Now for the fun part - actually working with documents!

### Opening a Document

```typescript
// Define your document type (TypeScript goodness!)
interface MyDoc {
  title: string;
  items: Array<{ id: string; text: string; done: boolean }>;
}

// Open a document (creates it if it doesn't exist)
const doc = await patches.openDoc<MyDoc>('shopping-list');

// Now you can access the state
console.log(`Shopping List: ${doc.state.title}`);
console.log(`${doc.state.items.length} items`);

// And make changes
doc.change(draft => {
  draft.title = 'Grocery Shopping';
  draft.items.push({ id: Date.now().toString(), text: 'Milk', done: false });
});
```

The `openDoc` method:

- Returns a `PatchesDoc<T>` instance
- Creates the document if it doesn't exist
- Loads the latest state from your store
- Sets up change tracking

### Tracking Documents

Before opening docs, you might want to tell Patches which ones you care about:

```typescript
// Start tracking a set of documents (loads metadata from store)
await patches.trackDocs(['shopping-list', 'todo-list', 'workout-plan']);

// Later, when you're done with some
await patches.untrackDocs(['workout-plan']);
```

Tracking helps Patches be smart about loading and managing documents.

### Closing Documents

When you're done with a document, let Patches know:

```typescript
// Close a document (saves pending changes, removes from memory)
await patches.closeDoc('shopping-list');

// Or if you're done with it FOREVER:
await patches.deleteDoc('old-shopping-list');
```

Closing docs helps free up memory and ensures everything is saved properly.

## Plugging Into Real-Time Sync

`Patches` works beautifully with `PatchesSync` for real-time collaboration:

```typescript
import { PatchesSync } from '@dabble/patches/net';

// Create your sync connection (note the parameter order!)
const sync = new PatchesSync(patches, 'wss://your-server.example.com');

// Connect to the server
await sync.connect();

// That's it! Changes now automatically sync to/from the server
```

The magic of this setup:

- `Patches` emits events when documents change
- `PatchesSync` listens to these events and handles server communication
- Server changes flow back through `PatchesSync` to update documents
- All the complex OT logic happens in pure algorithm functions
- Your app just sees clean, coordinated state updates

## Event Hooks

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

// When any document changes locally
patches.onChange((docId, changes) => {
  console.log(`Document ${docId} changed locally:`, changes);
  updateRecentActivity(docId);
});

// When documents are tracked/untracked
patches.onTrackDocs(docIds => {
  console.log('Now tracking:', docIds);
});

patches.onUntrackDocs(docIds => {
  console.log('No longer tracking:', docIds);
});
```

## See It in Action

Here's a complete example of using `Patches` in a real application:

```typescript
import { Patches, IndexedDBStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

class CollaborativeApp {
  private patches: Patches;
  private sync: PatchesSync;
  private activeDocuments = new Map();

  constructor() {
    // Set up persistence
    const store = new IndexedDBStore('my-collaborative-app');

    // Create Patches instance with user info
    this.patches = new Patches({
      store,
      metadata: {
        user: this.getCurrentUser(),
      },
    });

    // Set up error handling
    this.patches.onError(this.handleError.bind(this));

    // Set up sync (note: patches comes first now)
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

    console.log('Collaborative app ready!');
  }

  async openDocument(docId) {
    // Open the document
    const doc = await this.patches.openDoc(docId);

    // Set up listeners
    doc.onUpdate(state => {
      this.updateDocumentUI(docId, state);
    });

    // Remember this document
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

// Open a document
const doc = await app.openDocument('project-notes');

// Make changes
app.makeChange('project-notes', draft => {
  draft.title = 'Project X Planning';
  draft.notes.push('Meeting scheduled for Friday');
});
```

## The Rest of the Family

The `Patches` class is just one piece of the puzzle. Check out these related components:

- [`PatchesDoc`](./PatchesDoc.md) - Individual document instances that `Patches` creates for you
- [`PatchesSync`](./PatchesSync.md) - Real-time synchronization coordinator with a server
- [`PatchesStore`](./persist.md) - The interface for document persistence
- [`PatchesServer`](./PatchesServer.md) - The server-side component that handles collaboration
- [`Algorithms`](./algorithms.md) - The pure functions that handle OT and change processing

Remember, `Patches` is your friendly neighborhood document orchestrator. It coordinates everything so you can focus on building an awesome collaborative experience! 🚀
