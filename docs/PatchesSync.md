# PatchesSync: Your Sync Conductor 🎼

Meet `PatchesSync` - the maestro that orchestrates the beautiful symphony of real-time collaboration! This is where all the sync magic happens, coordinating between your local documents and the server to keep everyone in perfect harmony.

**Table of Contents**

- [What's the Big Deal?](#whats-the-big-deal)
- [How It Fits Into the Orchestra](#how-it-fits-into-the-orchestra)
- [Setting Up Your Sync Connection](#setting-up-your-sync-connection)
- [The Sync Dance](#the-sync-dance)
- [State Management](#state-management)
- [Event Handling](#event-handling)
- [Configuration Options](#configuration-options)
- [Real-World Example](#real-world-example)
- [Error Handling and Resilience](#error-handling-and-resilience)

## What's the Big Deal?

`PatchesSync` is the brain behind real-time collaboration. While `PatchesDoc` focuses on your app's interface and the algorithms handle the mathematical heavy lifting, `PatchesSync` is the coordinator that makes everything work together seamlessly.

Here's what makes it special:

- **Sync Orchestration:** Coordinates between Patches, PatchesStore, and the server
- **Algorithm Integration:** Uses the pure algorithm functions for all OT operations
- **Connection Management:** Handles WebSocket connections, reconnections, and offline scenarios
- **Event Coordination:** Listens to document changes and server updates, routing them properly
- **Batching Intelligence:** Groups changes efficiently for network transmission

The key insight: `PatchesSync` doesn't do the complex OT math itself - it calls the right algorithm functions at the right time with the right data.

## How It Fits Into the Orchestra

Think of your collaborative system like a symphony orchestra:

- **Patches:** The conductor - coordinates everything and provides the public API
- **PatchesDoc:** The musicians - each plays their part (manages local document state)
- **PatchesSync:** The section leader - ensures everyone stays in sync with the sheet music (server state)
- **Algorithms:** The sheet music - the pure logic that tells everyone exactly what to do
- **PatchesStore:** The music library - stores and retrieves all the documents and changes

`PatchesSync` sits between your local world (Patches + PatchesDoc) and the server world, translating and coordinating between them.

## Setting Up Your Sync Connection

Getting started with `PatchesSync` is straightforward:

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

// First, create your Patches instance
const patches = new Patches({
  store: new InMemoryStore(),
  metadata: {
    user: { id: 'user-123', name: 'Alice' },
  },
});

// Then create PatchesSync with your server URL
const sync = new PatchesSync(patches, 'wss://your-server.example.com');

// Connect to start syncing
await sync.connect();

// That's it! Your documents will now sync automatically
```

### Constructor Options

```typescript
const sync = new PatchesSync(patches, url, {
  // WebSocket connection options
  reconnectInterval: 1000, // How long to wait before reconnecting
  maxReconnectAttempts: 10, // Max reconnection attempts
  pingInterval: 30000, // Heartbeat interval

  // Custom headers for authentication
  headers: {
    Authorization: 'Bearer your-token-here',
  },
});
```

## The Sync Dance

Here's how `PatchesSync` orchestrates the collaboration dance:

### 1. Local Changes Flow Out

When you make a change in a `PatchesDoc`:

```typescript
doc.change(draft => {
  draft.title = 'New Title';
});
```

Behind the scenes:

1. `PatchesDoc` uses the `makeChange` algorithm to create change objects
2. `PatchesDoc` emits a change event
3. `PatchesSync` hears this event and queues the changes for sending
4. `PatchesSync` batches changes using the `breakChangesIntoBatches` algorithm
5. Changes are sent to the server via WebSocket

### 2. Server Changes Flow In

When the server sends changes (from other users or confirmations):

1. `PatchesSync` receives the changes via WebSocket
2. It uses the `applyCommittedChanges` algorithm to figure out the new state
3. It updates the `PatchesStore` with the new committed changes
4. It updates any open `PatchesDoc` instances with the new state
5. Your UI gets updated via the `PatchesDoc` event system

### 3. Conflict Resolution

When conflicts happen (you and someone else edit the same thing):

1. Server sends you their changes that you didn't know about
2. `PatchesSync` uses `applyCommittedChanges` which internally calls `rebaseChanges`
3. The algorithm transforms your pending changes to work on top of their changes
4. Your UI updates to show the merged result
5. Your rebased changes get sent to the server

## State Management

`PatchesSync` tracks several important states:

```typescript
interface PatchesSyncState {
  online: boolean; // Are we connected to the internet?
  connected: boolean; // Are we connected to the server?
  syncing: SyncingState; // Are we currently syncing? (null | 'syncing' | Error)
}

// Check the current state
console.log(sync.state);
// { online: true, connected: true, syncing: null }

// Listen for state changes
sync.onStateChange(state => {
  if (state.syncing instanceof Error) {
    showError('Sync failed: ' + state.syncing.message);
  } else if (state.syncing === 'syncing') {
    showSpinner('Syncing...');
  } else if (state.connected) {
    showSuccess('All synced up!');
  }
});
```

## Event Handling

`PatchesSync` provides clean event handling:

```typescript
// State changes (connection, online status, sync status)
sync.onStateChange(state => {
  updateConnectionIndicator(state);
});

// Errors (network issues, server errors, etc.)
sync.onError((error, context) => {
  console.error('Sync error:', error);
  if (context?.docId) {
    console.log('Error was related to document:', context.docId);
  }
});
```

## Configuration Options

### Batching and Performance

```typescript
const sync = new PatchesSync(patches, url, {
  // Batch changes for efficiency
  maxBatchSize: 1024 * 1024, // 1MB max per batch
  batchDelay: 100, // Wait 100ms to batch changes together

  // Connection tuning
  reconnectInterval: 2000, // Wait 2s between reconnection attempts
  maxReconnectAttempts: 5, // Give up after 5 attempts
});
```

### Document Tracking

`PatchesSync` automatically syncs documents that your `Patches` instance is tracking:

```typescript
// Track documents for background syncing
await patches.trackDocs(['doc1', 'doc2', 'doc3']);

// PatchesSync will automatically:
// 1. Subscribe to these docs on the server
// 2. Receive updates even when docs aren't open locally
// 3. Keep the store updated with latest changes

// Open a tracked doc (it's already synced!)
const doc = await patches.openDoc('doc1'); // Already up to date!
```

## Real-World Example

Here's how you might use `PatchesSync` in a real application:

```typescript
import { Patches, IndexedDBStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

class CollaborativeApp {
  private patches: Patches;
  private sync: PatchesSync;

  constructor() {
    // Set up persistence
    const store = new IndexedDBStore('my-collaborative-app');

    // Create Patches with user metadata
    this.patches = new Patches({
      store,
      metadata: {
        user: this.getCurrentUser(),
        deviceId: this.getDeviceId(),
      },
      docOptions: {
        maxPayloadBytes: 1024 * 1024, // 1MB max changes
      },
    });

    // Set up sync
    this.sync = new PatchesSync(this.patches, 'wss://api.myapp.com/sync', {
      headers: {
        Authorization: `Bearer ${this.getAuthToken()}`,
      },
      reconnectInterval: 2000,
      maxReconnectAttempts: 10,
    });

    this.setupEventListeners();
  }

  private setupEventListeners() {
    // Handle sync state changes
    this.sync.onStateChange(state => {
      this.updateUI({
        isOnline: state.online,
        isConnected: state.connected,
        isSyncing: state.syncing === 'syncing',
        syncError: state.syncing instanceof Error ? state.syncing : null,
      });
    });

    // Handle sync errors
    this.sync.onError((error, context) => {
      console.error('Sync error:', error);
      this.showNotification({
        type: 'error',
        message: `Sync failed: ${error.message}`,
        docId: context?.docId,
      });
    });
  }

  async initialize() {
    // Track user's recent documents
    const recentDocs = await this.getUserRecentDocs();
    await this.patches.trackDocs(recentDocs);

    // Connect to server
    await this.sync.connect();

    console.log('App initialized and syncing!');
  }

  async openDocument(docId: string) {
    // Document is already synced if tracked
    const doc = await this.patches.openDoc(docId);

    // Set up UI bindings
    doc.onUpdate(state => {
      this.renderDocument(docId, state);
    });

    doc.onSyncing(syncState => {
      this.updateDocumentSyncStatus(docId, syncState);
    });

    return doc;
  }

  makeDocumentChange(docId: string, changeFn: (draft: any) => void) {
    const doc = this.patches.getOpenDoc(docId);
    if (doc) {
      // This change will automatically sync via PatchesSync
      doc.change(changeFn);
    }
  }

  // Helper methods
  private getCurrentUser() {
    /* ... */
  }
  private getDeviceId() {
    /* ... */
  }
  private getAuthToken() {
    /* ... */
  }
  private getUserRecentDocs() {
    /* ... */
  }
  private updateUI(state: any) {
    /* ... */
  }
  private renderDocument(docId: string, state: any) {
    /* ... */
  }
  private updateDocumentSyncStatus(docId: string, syncState: any) {
    /* ... */
  }
  private showNotification(notification: any) {
    /* ... */
  }
}

// Usage
const app = new CollaborativeApp();
await app.initialize();

// Open and edit a document
const doc = await app.openDocument('project-notes');
app.makeDocumentChange('project-notes', draft => {
  draft.title = 'Updated Project Notes';
  draft.sections.push({
    id: 'new-section',
    content: 'This change will sync automatically!',
  });
});
```

## Error Handling and Resilience

`PatchesSync` is built to be resilient:

### Automatic Reconnection

```typescript
// PatchesSync handles reconnection automatically
sync.onStateChange(state => {
  if (!state.connected && state.online) {
    // PatchesSync is attempting to reconnect
    showMessage('Reconnecting...');
  }
});
```

### Offline Handling

```typescript
// Changes made while offline are queued and sent when reconnected
sync.onStateChange(state => {
  if (!state.online) {
    showMessage('Offline - changes will sync when reconnected');
  } else if (state.connected) {
    showMessage('Back online and syncing!');
  }
});
```

### Error Recovery

```typescript
sync.onError((error, context) => {
  if (error.message.includes('authentication')) {
    // Handle auth errors
    this.refreshAuthToken();
  } else if (error.message.includes('network')) {
    // Handle network errors
    this.showRetryOption();
  }
});
```

`PatchesSync` makes real-time collaboration feel effortless by handling all the complex coordination behind the scenes. Set it up once, and your documents just work together automatically! 🎯
