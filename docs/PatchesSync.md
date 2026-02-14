# PatchesSync: The Sync Coordinator

`PatchesSync` handles the WebSocket connection between your [Patches](Patches.md) client and the server. It coordinates document subscriptions, sends local changes, receives server changes, and manages connection state. You set it up once, and it handles the rest.

**Table of Contents**

- [What It Does](#what-it-does)
- [How It Fits Together](#how-it-fits-together)
- [Setting Up](#setting-up)
- [The Sync Flow](#the-sync-flow)
- [State Management](#state-management)
- [Per-Document Sync Status](#per-document-sync-status)
- [Event Handling](#event-handling)
- [Configuration Options](#configuration-options)
- [Real-World Example](#real-world-example)
- [Error Handling and Resilience](#error-handling-and-resilience)

## What It Does

`PatchesSync` sits between your local documents and the server. Here's what it handles:

- **WebSocket Connection**: Connects to your server, handles reconnection on failures
- **Document Subscriptions**: Subscribes to tracked documents so you receive server updates
- **Outgoing Changes**: Batches and sends local changes to the server
- **Incoming Changes**: Receives server changes and applies them locally via the appropriate [algorithm](algorithms.md)
- **State Tracking**: Reports online status, connection status, and sync status

The key insight: `PatchesSync` is algorithm-agnostic. It works with both [OT (Operational Transformation)](operational-transformation.md) and [LWW (Last-Write-Wins)](last-write-wins.md) documents. It delegates the actual sync logic to algorithm objects that know how to handle each type.

## How It Fits Together

Here's the architecture:

- **[Patches](Patches.md)**: The conductor - manages documents and provides your app's API
- **[PatchesDoc](PatchesDoc.md)**: Your document interface - handles local state and changes
- **PatchesSync**: The sync coordinator - manages server communication
- **[Algorithms](algorithms.md)**: Algorithm-specific sync logic (OT or LWW)
- **[Stores](persist.md)**: Persistence - saves documents and pending changes locally

`PatchesSync` listens to events from `Patches` (document changes, tracking changes) and coordinates with the server. When server changes arrive, it delegates to the appropriate algorithm to apply them.

## Setting Up

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

// Create your Patches instance
const patches = new Patches({
  store: new InMemoryStore(),
  metadata: {
    user: { id: 'user-123', name: 'Alice' },
  },
});

// Create PatchesSync with your server URL
const sync = new PatchesSync(patches, 'wss://your-server.example.com');

// Connect to start syncing
await sync.connect();

// That's it. Documents sync automatically.
```

### Constructor Signature

```typescript
const sync = new PatchesSync(patches, url, options?);
```

The constructor takes:

1. `patches` - Your [Patches](Patches.md) instance
2. `url` - WebSocket server URL
3. `options` - Optional configuration (see [Configuration Options](#configuration-options))

## The Sync Flow

### Local Changes Going Out

When you make a change:

```typescript
doc.change(draft => {
  draft.title = 'New Title';
});
```

Here's what happens:

1. [PatchesDoc](PatchesDoc.md) creates the change using [makeChange](algorithms.md)
2. [Patches](Patches.md) emits a change event
3. `PatchesSync` hears the event and flushes the document
4. Changes get batched using [breakChangesIntoBatches](algorithms.md) if they're large
5. Batches are sent to the server via WebSocket

### Server Changes Coming In

When the server sends changes (from other users or confirmations):

1. `PatchesSync` receives the changes via WebSocket
2. It gets the appropriate algorithm for the document (OT or LWW)
3. The algorithm applies the changes, handling any rebasing or conflict resolution
4. The store is updated with committed changes
5. Any open [PatchesDoc](PatchesDoc.md) instances get the new state
6. Your UI updates via the document's event system

### Conflict Resolution

When you and another user edit concurrently:

**With OT:**

1. Server sends changes your pending changes didn't know about
2. The OT algorithm uses [rebaseChanges](algorithms.md) to transform your pending changes
3. Your rebased changes get sent to the server

**With LWW:**

1. Server sends changes with timestamps
2. The LWW algorithm compares timestamps - higher timestamp wins
3. Your local state updates to reflect the resolution

See [Operational Transformation](operational-transformation.md) or [Last-Write-Wins](last-write-wins.md) for details on each approach.

## State Management

`PatchesSync` tracks three pieces of state:

```typescript
interface PatchesSyncState {
  online: boolean; // Is the browser online?
  connected: boolean; // Is the WebSocket connected?
  syncing: SyncingState; // 'initial' | 'updating' | null | Error
}
```

The `syncing` property tells you:

- `'initial'` - First sync in progress
- `'updating'` - Syncing with server
- `null` - Idle, fully synced
- `Error` - Sync failed

```typescript
// Check current state
console.log(sync.state);
// { online: true, connected: true, syncing: null }

// React to state changes
sync.onStateChange(state => {
  if (state.syncing instanceof Error) {
    showError('Sync failed: ' + state.syncing.message);
  } else if (state.syncing === 'updating') {
    showSpinner('Syncing...');
  } else if (state.connected) {
    showSuccess('All synced up!');
  }
});
```

## Per-Document Sync Status

The `state` property tells you about the connection. The `synced` property tells you about each document. It's a `Record<string, SyncedDoc>` — one entry per tracked document, updated in real time as sync events happen.

```typescript
type SyncedDocStatus = 'unsynced' | 'syncing' | 'synced' | 'error';

interface SyncedDoc {
  committedRev: number; // Last confirmed server revision. 0 = never synced.
  hasPending: boolean; // Has local changes not yet confirmed by server.
  status: SyncedDocStatus; // Current sync lifecycle state.
}
```

### Reading Sync Status

```typescript
// Get the full map
const synced = sync.synced;

// Check a specific document
const docStatus = synced['project-notes'];
if (docStatus?.status === 'error') {
  showError('Sync failed for project notes');
}

// Show an indicator per document
for (const [docId, info] of Object.entries(sync.synced)) {
  console.log(`${docId}: rev=${info.committedRev}, pending=${info.hasPending}, status=${info.status}`);
}
```

The `synced` object is immutable. Every change produces a new reference, so shallow comparison works for change detection.

### Listening for Changes

Use `onSyncedChange` to react when any document's sync status changes:

```typescript
sync.onSyncedChange(synced => {
  for (const [docId, info] of Object.entries(synced)) {
    updateDocIndicator(docId, info.status, info.hasPending);
  }
});
```

### Status Lifecycle

Here's exactly when each field changes:

| Event                  | Effect                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Doc tracked            | Entry added. `committedRev` from store, `hasPending` from pending check, `status` = `committedRev === 0 ? 'unsynced' : 'synced'` |
| `syncDoc` starts       | `status` → `'syncing'`                                                                                                           |
| Server changes applied | `committedRev` updated to last server change's revision                                                                          |
| `syncDoc` succeeds     | `status` → `'synced'`                                                                                                            |
| `syncDoc` fails        | `status` → `'error'`                                                                                                             |
| Local change made      | `hasPending` = `true`, `status` → `'syncing'` (if connected)                                                                      |
| `flushDoc` succeeds    | `hasPending` updated from remaining pending, `status` → `'synced'`                                                               |
| `flushDoc` fails       | `status` → `'error'`                                                                                                             |
| Doc untracked          | Entry removed                                                                                                                    |
| Doc remotely deleted   | Entry removed                                                                                                                    |

### Practical Example: Per-Document Save Indicator

```typescript
sync.onSyncedChange(synced => {
  for (const [docId, info] of Object.entries(synced)) {
    const el = document.getElementById(`status-${docId}`);
    if (!el) continue;

    switch (info.status) {
      case 'unsynced':
        el.textContent = 'Never synced';
        break;
      case 'syncing':
        el.textContent = info.hasPending ? 'Saving...' : 'Syncing...';
        break;
      case 'synced':
        el.textContent = info.hasPending ? 'Unsaved changes' : 'All saved';
        break;
      case 'error':
        el.textContent = 'Sync error';
        break;
    }
  }
});
```

The difference between `state.syncing` and `synced`: `state.syncing` tells you the overall connection-level sync status. `synced` tells you the status of each individual document. Use `state` for a global spinner. Use `synced` for per-document indicators.

## Event Handling

```typescript
// State changes (connection, online status, sync status)
sync.onStateChange(state => {
  updateConnectionIndicator(state);
});

// Errors (network issues, server errors)
sync.onError((error, context) => {
  console.error('Sync error:', error);
  if (context?.docId) {
    console.log('Error related to document:', context.docId);
  }
});

// Remote document deletion
sync.onRemoteDocDeleted((docId, pendingChanges) => {
  console.log(`Document ${docId} was deleted remotely`);
  if (pendingChanges.length > 0) {
    // Handle lost pending changes
    showWarning(`You had ${pendingChanges.length} unsaved changes`);
  }
});
```

### Available Events

| Event                | Parameters                                     | Description                        |
| -------------------- | ---------------------------------------------- | ---------------------------------- |
| `onStateChange`      | `(state: PatchesSyncState)`                    | Connection/sync state changed      |
| `onSyncedChange`     | `(synced: Record<string, SyncedDoc>)`          | Per-document sync status changed   |
| `onError`            | `(error: Error, context?: { docId?: string })` | An error occurred                  |
| `onRemoteDocDeleted` | `(docId: string, pendingChanges: Change[])`    | Document deleted by another client |

## Configuration Options

```typescript
interface PatchesSyncOptions {
  // Filter which tracked docs to subscribe to
  subscribeFilter?: (docIds: string[]) => string[];

  // WebSocket options (protocol subprotocols)
  websocket?: WebSocketOptions;

  // Maximum payload size for network transmission (default: 1MB)
  maxPayloadBytes?: number;

  // Per-change storage limit (falls back to patches.docOptions.maxStorageBytes)
  maxStorageBytes?: number;

  // Custom size calculator for storage limits
  sizeCalculator?: SizeCalculator;
}
```

### Batching and Payload Limits

Large changes get split into batches automatically:

```typescript
const sync = new PatchesSync(patches, url, {
  maxPayloadBytes: 1024 * 1024, // 1MB max per network message
  maxStorageBytes: 512 * 1024, // 512KB max per stored change
});
```

The [breakChangesIntoBatches](algorithms.md) algorithm handles splitting changes that exceed these limits.

### Subscribe Filtering

If you only want to subscribe to certain tracked documents:

```typescript
const sync = new PatchesSync(patches, url, {
  subscribeFilter: docIds => docIds.filter(id => !id.startsWith('local-')),
});
```

## Real-World Example

Here's a production-style setup:

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
        maxStorageBytes: 1024 * 1024, // 1MB max changes
      },
    });

    // Set up sync
    this.sync = new PatchesSync(this.patches, 'wss://api.myapp.com/sync', {
      maxPayloadBytes: 1024 * 1024,
    });

    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.sync.onStateChange(state => {
      this.updateUI({
        isOnline: state.online,
        isConnected: state.connected,
        isSyncing: state.syncing === 'updating',
        syncError: state.syncing instanceof Error ? state.syncing : null,
      });
    });

    this.sync.onError((error, context) => {
      console.error('Sync error:', error);
      this.showNotification({
        type: 'error',
        message: `Sync failed: ${error.message}`,
        docId: context?.docId,
      });
    });

    this.sync.onRemoteDocDeleted((docId, pendingChanges) => {
      this.showNotification({
        type: 'warning',
        message: `Document was deleted`,
        details: pendingChanges.length > 0 ? `${pendingChanges.length} unsaved changes were lost` : undefined,
      });
    });
  }

  async initialize() {
    // Track user's recent documents
    const recentDocs = await this.getUserRecentDocs();
    await this.patches.trackDocs(recentDocs);

    // Connect to server
    await this.sync.connect();

    console.log('App initialized and syncing');
  }

  async openDocument(docId: string) {
    const doc = await this.patches.openDoc(docId);

    doc.onUpdate(state => {
      this.renderDocument(docId, state);
    });

    return doc;
  }

  // Helper methods (implement based on your app)
  private getCurrentUser() {
    /* ... */
  }
  private getDeviceId() {
    /* ... */
  }
  private getUserRecentDocs(): Promise<string[]> {
    /* ... */
  }
  private updateUI(state: any) {
    /* ... */
  }
  private renderDocument(docId: string, state: any) {
    /* ... */
  }
  private showNotification(notification: any) {
    /* ... */
  }
}

// Usage
const app = new CollaborativeApp();
await app.initialize();

const doc = await app.openDocument('project-notes');
doc.change(draft => {
  draft.title = 'Updated Project Notes';
  draft.sections.push({
    id: 'new-section',
    content: 'This change syncs automatically',
  });
});
```

## Error Handling and Resilience

### Automatic Reconnection

`PatchesSync` handles reconnection automatically with exponential backoff:

```typescript
sync.onStateChange(state => {
  if (!state.connected && state.online) {
    // PatchesSync is attempting to reconnect
    showMessage('Reconnecting...');
  }
});
```

The WebSocket transport starts with a 1-second delay and backs off up to 30 seconds between attempts. It resets the backoff on successful connection.

### Offline Handling

Changes made while offline are stored locally and sent when you reconnect:

```typescript
sync.onStateChange(state => {
  if (!state.online) {
    showMessage('Offline - changes will sync when reconnected');
  } else if (state.connected) {
    showMessage('Back online and syncing');
  }
});
```

The [IndexedDBStore](persist.md) persists pending changes, so they survive browser restarts.

### Error Recovery

```typescript
sync.onError((error, context) => {
  if (error.message.includes('authentication')) {
    this.refreshAuthToken();
    this.sync.disconnect();
    this.sync.connect(); // Reconnect with new token
  }
});
```

### Document Tombstones

When a document is deleted locally while offline, `PatchesSync` creates a tombstone. On reconnect, it attempts to delete the document on the server. If that succeeds, the tombstone is removed. If it fails, the tombstone persists for retry.

## Related Documentation

- [Patches](Patches.md) - The main client coordinator
- [PatchesDoc](PatchesDoc.md) - Document interface
- [Persistence](persist.md) - Storage options
- [Algorithms](algorithms.md) - Sync algorithm implementations and pure functions
- [Networking Overview](net.md) - Network layer architecture
- [WebSocket Transport](websocket.md) - WebSocket implementation details
- [JSON-RPC Protocol](json-rpc.md) - Wire protocol
- [OT Server](OTServer.md) - Server-side OT implementation
- [LWW Server](LWWServer.md) - Server-side LWW implementation
