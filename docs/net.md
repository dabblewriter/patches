# Network Layer: Keeping Your Data in Sync

The Patches network layer handles all communication between your client and the server. It ensures every user's view of a document stays consistent - whether they're actively collaborating in real-time or coming back online after a lunch break.

## PatchesSync: The Sync Coordinator

Stop juggling multiple providers for different scenarios. `PatchesSync` is your single point of contact for connecting a local [Patches](Patches.md) instance to a remote server.

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

// 1. Set up your Patches instance with a store
const store = new InMemoryStore();
const patches = new Patches({ store });

// 2. Create and connect PatchesSync (note: Patches first, URL second)
const sync = new PatchesSync(patches, 'wss://your-server.example.com', {
  websocket: {
    /* WebSocket options if needed */
  },
});

try {
  await sync.connect();
  console.log('Connected and syncing');

  // 3. Open a document - PatchesSync handles the rest
  const doc = await patches.getDoc<MyDocType>('shared-doc-123');

  // Make changes - they sync automatically
  doc.change(draft => {
    draft.title = 'Updated Title';
    draft.lastEditor = 'alice';
  });
} catch (error) {
  console.error('Connection failed:', error);
}

// When done
// sync.disconnect();
```

### What PatchesSync Does

- **Connection Management**: Establishes and maintains a WebSocket connection via [PatchesWebSocket](websocket.md)
- **State Tracking**: Monitors `online` (browser connectivity), `connected` (WebSocket status), and `syncing` (sync progress) states
- **Document Tracking**: Automatically subscribes to server updates for documents your Patches instance tracks
- **Outgoing Changes**: When you call [doc.change()](PatchesDoc.md), PatchesSync batches and sends changes to the server
- **Incoming Changes**: Receives server changes and applies them using the appropriate [algorithm functions](algorithms.md)
- **Batching**: Splits large changesets into smaller network payloads when `maxPayloadBytes` is configured
- **Offline Handling**: Listens to browser online/offline events and reconnects automatically

The goal: you work with your documents, and PatchesSync handles the plumbing.

## The Architecture

Under the hood, `PatchesSync` uses `PatchesWebSocket`, which relies on `WebSocketTransport`. This layered approach handles:

- **Connection Management**: Connect, disconnect, and reconnect logic
- **JSON-RPC Protocol**: Structured, reliable message framing (see [json-rpc.md](json-rpc.md))
- **Document Subscription**: Tells the server which documents the client cares about
- **Change Synchronization**: Bidirectional flow of document changes

For more details on the WebSocket layer specifically, see [websocket.md](websocket.md).

## The JSON-RPC Layer

At the core of Patches networking is a lean JSON-RPC 2.0 layer. This is the common language between client and server.

1. **ClientTransport / ServerTransport** - Minimal interfaces. Send raw strings, receive raw strings. Swap WebSockets for WebRTC data channels or anything else that moves bytes.
2. **JSONRPCClient / JSONRPCServer** - Handle method calls, request/response matching, and notifications. No manual JSON parsing required.
3. **PatchesWebSocket & WebSocketServer** - Pair the JSON-RPC layer with WebSocket transport and map RPC methods to a clean TypeScript API.

This decoupled design means flexibility and testability. Implement the transport interface and the rest just works.

## Protocol Messages

Patches uses JSON-RPC 2.0 for all communication. Here's what the messages look like:

### Client to Server Request

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "commitChanges",
  "params": ["doc123", [{ "ops": [...], "rev": 10, "id": "change-id" }]]
}
```

### Server Response

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "result": [
    { "ops": [...], "rev": 10, "id": "change-id", "committedRev": 101 }
  ]
}
```

### Server Notification (pushed to other clients)

```json
{
  "jsonrpc": "2.0",
  "method": "changesCommitted",
  "params": {
    "docId": "doc123",
    "changes": [{ "ops": [...], "rev": 11, "committedRev": 102 }]
  }
}
```

For the full protocol reference, see [json-rpc.md](json-rpc.md).

## Working with Connection State

Your app should react to connection changes. `PatchesSync` provides an `onStateChange` signal:

```typescript
sync.onStateChange(state => {
  // state: { online: boolean, connected: boolean, syncing: SyncingState }
  // where SyncingState = 'initial' | 'updating' | null | Error

  if (state.connected) {
    hideOfflineWarning();
    updateStatusUI('Connected');
  } else if (!state.online) {
    showOfflineWarning('You are offline. Changes saved locally.');
  } else if (state.syncing === 'initial' || state.syncing === 'updating') {
    showSyncingIndicator('Syncing...');
  } else if (state.syncing instanceof Error) {
    showErrorUI('Sync failed: ' + state.syncing.message);
  } else {
    showOfflineWarning('Disconnected. Reconnecting...');
  }
});
```

## Error Handling

Network operations fail. Handle them gracefully:

```typescript
sync.onError((error, context) => {
  console.error(`Sync error for doc ${context?.docId || 'general'}:`, error);

  // Log to monitoring, display user message, etc.
  if (isRetryableError(error)) {
    showTemporaryError('Network hiccup. Retrying...');
  } else {
    showPersistentError('Connection problem. Check your internet.');
  }
});
```

## Handling Remote Document Deletion

When a document is deleted by another client (or discovered deleted when coming back online), `PatchesSync` notifies you:

```typescript
sync.onRemoteDocDeleted((docId, pendingChanges) => {
  console.log(`Document ${docId} was deleted remotely`);

  if (pendingChanges.length > 0) {
    // User had unsaved changes - you might want to handle this
    showWarning(`Your changes to "${docId}" were lost because the document was deleted.`);
  }

  // Update your UI to reflect the deletion
  removeDocumentFromList(docId);
});
```

## Configuration Options

### PatchesSyncOptions

```typescript
interface PatchesSyncOptions {
  // Filter which docs to subscribe to (useful for multi-tenant apps)
  subscribeFilter?: (docIds: string[]) => string[];

  // WebSocket connection options
  websocket?: WebSocketOptions;

  // Max bytes per network message (default: 1MB)
  maxPayloadBytes?: number;

  // Per-change storage limit for backend
  maxStorageBytes?: number;

  // Custom size calculator
  sizeCalculator?: SizeCalculator;
}
```

### Handling Large Changes

If you anticipate large changes (e.g., embedding base64 images), configure `maxPayloadBytes` to automatically batch them:

```typescript
const patches = new Patches({
  store,
  docOptions: { maxPayloadBytes: 1024 * 100 }, // 100KB
});

// or on sync directly
const sync = new PatchesSync(patches, url, {
  maxPayloadBytes: 1024 * 100,
});
```

This prevents issues with WebSocket message size limits on servers or proxies.

### Subscribe Filtering

For multi-tenant apps or when you need fine-grained control over subscriptions:

```typescript
const sync = new PatchesSync(patches, url, {
  subscribeFilter: docIds => {
    // Only subscribe to docs the current user can access
    return docIds.filter(id => userCanAccess(id));
  },
});
```

## How It All Fits Together

The network layer is one piece of the collaborative puzzle:

1. **[PatchesDoc](PatchesDoc.md)**: Your document interface. Creates and tracks changes locally.
2. **[Patches](Patches.md)**: The client orchestrator. Manages multiple docs, stores, and sync.
3. **[PatchesStore](persist.md)**: Local persistence. Crucial for offline support and fast loads.
4. **PatchesSync**: Connects to the server, sends queued changes, receives remote changes.
5. **Server ([OTServer](OTServer.md) or [LWWServer](LWWServer.md))**: Receives changes, resolves conflicts, broadcasts to other clients.

## OT vs LWW Sync

Patches supports two sync algorithms, and PatchesSync handles both:

**OT (Operational Transformation)**: For collaborative editing where concurrent changes need intelligent merging. Uses [algorithms](algorithms.md) like `rebaseChanges` to handle conflicts. See [operational-transformation.md](operational-transformation.md).

**LWW (Last-Write-Wins)**: For settings, preferences, and status data where the most recent write should simply win. Uses timestamp comparison instead of transformation. See [last-write-wins.md](last-write-wins.md).

PatchesSync is algorithm-agnostic - it delegates to the appropriate algorithm for each document type.

## Accessing the RPC Layer

Need to make custom RPC calls beyond the Patches protocol? Access the underlying JSON-RPC client:

```typescript
// Make custom RPC calls
const result = await sync.rpc.call('myCustomMethod', arg1, arg2);

// Listen for custom notifications
sync.rpc.on('myCustomNotification', params => {
  console.log('Custom notification:', params);
});
```

## Related Documentation

- [Patches](Patches.md) - The main client-side entry point
- [PatchesDoc](PatchesDoc.md) - Working with individual documents
- [persist.md](persist.md) - Local storage and how PatchesStore works
- [websocket.md](websocket.md) - WebSocket transport details
- [json-rpc.md](json-rpc.md) - The JSON-RPC protocol layer
- [awareness.md](awareness.md) - Presence indicators using WebRTC
- [OTServer](OTServer.md) - Server-side OT implementation
- [LWWServer](LWWServer.md) - Server-side LWW implementation
- [algorithms.md](algorithms.md) - Pure functions that power sync operations
