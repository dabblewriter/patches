# WebSocket Transport

The WebSocket transport is the primary way Patches clients communicate with servers. It handles the bidirectional, persistent connection that makes real-time collaboration possible.

This document covers two levels of WebSocket usage:

1. **Client-side**: `PatchesWebSocket` and the higher-level `PatchesSync`
2. **Server-side**: `WebSocketServer` for building your backend

Most applications should use [PatchesSync](PatchesSync.md) rather than `PatchesWebSocket` directly. `PatchesSync` handles all the coordination between your documents and the server automatically.

## Client-Side: PatchesWebSocket

`PatchesWebSocket` is a thin wrapper around `WebSocketTransport` that provides the [Patches API](json-rpc.md) over a WebSocket connection. It inherits from `PatchesClient`, giving you methods for subscriptions, document operations, versioning, and branching.

### When to Use PatchesWebSocket Directly

You probably don't need to. `PatchesSync` uses `PatchesWebSocket` internally and handles:

- Automatic subscription management
- Change batching and sending
- Server change application
- Reconnection and offline handling
- Document lifecycle coordination

Use `PatchesWebSocket` directly only if you're building custom sync logic or need fine-grained control over the protocol.

### Basic Usage

```typescript
import { PatchesWebSocket } from '@dabble/patches/net';

const ws = new PatchesWebSocket('wss://your-server.example.com');

await ws.connect();

// Subscribe to documents
await ws.subscribe(['doc-1', 'doc-2']);

// Listen for changes from other clients
ws.onChangesCommitted((docId, changes, options) => {
  console.log(`Received ${changes.length} changes for ${docId}`);
});

// Send changes to the server
const committed = await ws.commitChanges('doc-1', myChanges);
```

### API Reference

**Connection Management:**

- `connect()` - Establish the WebSocket connection
- `disconnect()` - Close the connection
- `onStateChange` - Signal for connection state changes (`connecting`, `connected`, `disconnected`, `error`)

**Subscriptions:**

- `subscribe(ids: string | string[])` - Subscribe to document updates
- `unsubscribe(ids: string | string[])` - Unsubscribe from documents

**Document Operations:**

- `getDoc(docId, atRev?)` - Fetch document state (optionally at a specific revision)
- `getChangesSince(docId, rev)` - Get changes after a revision
- `commitChanges(docId, changes, options?)` - Send changes to the server
- `deleteDoc(docId, options?)` - Delete a document

**Versioning:**

- `createVersion(docId, metadata)` - Create a named snapshot
- `listVersions(docId, options?)` - List saved versions
- `getVersionState(docId, versionId)` - Get state at a version
- `getVersionChanges(docId, versionId)` - Get changes for a version
- `updateVersion(docId, versionId, metadata)` - Update version metadata

**Branching:**

- `listBranches(docId)` - List document branches
- `createBranch(docId, rev, metadata?)` - Create a branch at a revision
- `closeBranch(branchId)` - Close a branch
- `mergeBranch(branchId)` - Merge a branch back

**Events:**

- `onChangesCommitted` - Signal when server pushes changes
- `onDocDeleted` - Signal when a document is deleted

## The Recommended Approach: PatchesSync

For actual applications, use [PatchesSync](PatchesSync.md). It coordinates between [Patches](Patches.md), the store, and the WebSocket connection automatically.

```typescript
import { Patches, IndexedDBStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

// Set up your client
const patches = new Patches({
  store: new IndexedDBStore('my-app'),
});

// Create and connect PatchesSync
const sync = new PatchesSync(patches, 'wss://your-server.example.com');
await sync.connect();

// Now just work with documents normally
const doc = await patches.getDoc('project-notes');

doc.change(draft => {
  draft.title = 'Updated Title';
});
// Changes sync automatically - no manual handling needed
```

`PatchesSync` listens to [Patches](Patches.md) events, tracks which documents need syncing, handles batching, applies server changes correctly (including [OT rebasing](operational-transformation.md) or [LWW merging](last-write-wins.md)), and manages reconnection. You write application code; it handles the plumbing.

### Handling Connection State

```typescript
sync.onStateChange(state => {
  // state.online - browser online/offline
  // state.connected - WebSocket connected
  // state.syncing - null, 'initial', 'updating', or Error

  if (!state.online) {
    showOfflineBanner();
  } else if (!state.connected) {
    showReconnectingMessage();
  } else if (state.syncing === 'updating') {
    showSyncingIndicator();
  } else if (state.syncing instanceof Error) {
    showSyncError(state.syncing);
  } else {
    showConnectedStatus();
  }
});
```

### Error Handling

```typescript
sync.onError((error, context) => {
  if (context?.docId) {
    console.error(`Error syncing ${context.docId}:`, error);
  } else {
    console.error('Sync error:', error);
  }
});
```

## Server-Side: WebSocketServer

`WebSocketServer` handles subscription management and message routing on your backend. It works with a `JSONRPCServer` that has your Patches servers registered.

### Architecture

The server side has a clean separation:

- **ServerTransport** - Raw WebSocket handling (you provide this for your framework)
- **JSONRPCServer** - Handles the RPC protocol layer
- **WebSocketServer** - Manages subscriptions and notification routing
- **OTServer / LWWServer** - The actual document logic

### Basic Setup

```typescript
import { JSONRPCServer, WebSocketServer } from '@dabble/patches/net';
import { OTServer } from '@dabble/patches/server';

// 1. Create your document server
const otServer = new OTServer(storeBackend);

// 2. Create the RPC server and register your document server
const rpc = new JSONRPCServer();
rpc.register(otServer); // Registers getDoc, getChangesSince, commitChanges, deleteDoc

// 3. Create your transport adaptor (framework-specific)
const transport = new MyWebSocketTransportAdaptor(httpServer);

// 4. Create the WebSocket server
const wsServer = new WebSocketServer({
  transport,
  rpc,
  auth: myAuthProvider, // Optional authorization
});

// 5. Wire up the commit notification to broadcast changes
otServer.onChangesCommitted((docId, changes, options, originClientId) => {
  rpc.notify('changesCommitted', { docId, changes, options }, originClientId);
});
```

### Adding History and Branching

```typescript
import { PatchesHistoryManager, OTBranchManager } from '@dabble/patches/server';

const history = new PatchesHistoryManager(otServer, storeBackend);
const branches = new OTBranchManager(branchStore, otServer);

// Register their methods with the RPC server
rpc.register(history); // Adds listVersions, createVersion, getVersionState, etc.
rpc.register(branches); // Adds listBranches, createBranch, closeBranch, mergeBranch
```

When you register these managers, their methods become available to clients automatically. See [PatchesHistoryManager](PatchesHistoryManager.md) and [PatchesBranchManager](PatchesBranchManager.md) for details.

### Authorization

The `auth` parameter accepts an `AuthorizationProvider` that controls access:

```typescript
const auth: AuthorizationProvider = {
  async canAccess(ctx, docId, accessType, method, params) {
    // ctx contains clientId and any data you attached during connection
    // accessType is 'read' or 'write'
    // method is the RPC method being called

    const user = await getUserFromSession(ctx.sessionId);
    if (!user) return false;

    const doc = await getDocumentMeta(docId);
    if (accessType === 'write') {
      return doc.editors.includes(user.id);
    }
    return doc.viewers.includes(user.id) || doc.editors.includes(user.id);
  },
};
```

If you don't provide an auth provider, the default denies all access. This is intentional - you should always implement authorization for production.

### Message Processing

Your transport adaptor should call `processMessage` for each incoming message:

```typescript
// In your WebSocket handler
ws.on('message', async data => {
  const ctx = { clientId: ws.id, sessionId: ws.sessionId };
  const response = await wsServer.processMessage(data.toString(), ctx);
  if (response) {
    ws.send(response);
  }
});
```

### Notification Fan-Out

When a client commits changes, `WebSocketServer` automatically notifies all other subscribed clients. This happens through the RPC server's `onNotify` callback, which the `WebSocketServer` wires up in its constructor.

## Protocol Details

The WebSocket transport uses [JSON-RPC 2.0](json-rpc.md) for all communication. Request/response pairs use IDs; notifications (like `changesCommitted`) don't.

Example commit request:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "commitChanges",
  "params": {
    "docId": "doc-1",
    "changes": [...]
  }
}
```

Example notification to other clients:

```json
{
  "jsonrpc": "2.0",
  "method": "changesCommitted",
  "params": {
    "docId": "doc-1",
    "changes": [...]
  }
}
```

## Performance Considerations

### Change Batching

Large changes get split into batches automatically. Configure this via `PatchesSyncOptions`:

```typescript
const sync = new PatchesSync(patches, url, {
  maxPayloadBytes: 1024 * 1024, // 1MB per batch (wire limit)
  maxStorageBytes: 100 * 1024, // 100KB per change (storage limit)
});
```

Batching prevents WebSocket message size limits from causing failures and keeps your backend storage efficient.

### Subscription Filtering

If you have many tracked documents but only want to subscribe to some:

```typescript
const sync = new PatchesSync(patches, url, {
  subscribeFilter: docIds => {
    // Only subscribe to active project documents
    return docIds.filter(id => id.startsWith('project-'));
  },
});
```

## Related Documentation

- [PatchesSync](PatchesSync.md) - The sync coordinator (what you should actually use)
- [net.md](net.md) - Network layer overview
- [json-rpc.md](json-rpc.md) - The underlying protocol
- [OTServer](OTServer.md) - Server-side OT implementation
- [LWWServer](LWWServer.md) - Server-side LWW implementation
- [operational-transformation.md](operational-transformation.md) - How OT conflict resolution works
- [last-write-wins.md](last-write-wins.md) - How LWW resolution works
- [persist.md](persist.md) - Client-side storage
- [awareness.md](awareness.md) - Presence and cursors (complements WebSocket sync)
