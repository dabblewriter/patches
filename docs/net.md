# Network Layer: Keeping Everyone in Sync! 🔄

Let's talk about the network magic that makes real-time collaboration possible! The Patches network layer handles all the tricky bits of keeping documents in sync between users - whether they're online, offline, or somewhere in between.

## Pick Your Sync Strategy! 🧠

### PatchesRealtime: For When You Need It NOW! ⚡

Want changes to fly across the internet instantly? This is your go-to provider:

```typescript
import { PatchesRealtime } from '@dabble/patches/net';

// Create and connect to your server
const provider = new PatchesRealtime('wss://your-awesome-server.com');
await provider.connect();

// Open a document and get editing right away
const doc = await provider.openDoc<MyDocType>('shared-doc-123');

// Make changes - they sync immediately!
doc.change(draft => {
  draft.title = 'Instant Changes FTW!';
  draft.lastEditor = 'Alice';
});

// When you're all done
provider.close();
```

With PatchesRealtime, every change zips off to the server immediately. It's perfect for when you need that real-time feel!

### PatchesOfflineFirst: Never Lose a Change! 💪 (Coming Soon!)

Working on a spotty connection? On a plane? In a tunnel? No problem! OfflineFirst has got your back:

```typescript
import { PatchesOfflineFirst } from '@dabble/patches/net';
import { IndexedDBStore } from '@dabble/patches/persist';

// Set up with local storage
const store = new IndexedDBStore('my-super-app');
const provider = new PatchesOfflineFirst('wss://your-server.com', { store });

// Connect (but it works even if this fails!)
await provider.connect();

// Open a document (works offline!)
const doc = await provider.openDoc<MyDocType>('important-doc');

// Make changes - they're saved locally first
doc.change(draft => {
  draft.notes.push('This works even without internet!');
});

// Don't worry - changes sync automatically when you're back online
```

PatchesOfflineFirst follows this smart process:

1. Save every change locally first (instantly!)
2. Queue changes for background syncing
3. Send changes to the server when a connection is available
4. Handle conflicts intelligently when you reconnect

## How the WebSocket Transport Works 🔌

Under the hood, a WebSocket transport powers everything:

- **Connection Management**: Handles connect, disconnect, reconnect
- **JSON-RPC Protocol**: Structured messages for reliable communication
- **Document Subscription**: Tells the server which docs to sync
- **Change Synchronization**: Bidirectional flow of document changes

It's like a digital mail carrier that never sleeps, constantly delivering changes back and forth!

## Under the Hood: The JSON-RPC Sandwich 🥪

At the center of Patches' networking sits a **tiny but mighty JSON-RPC 2.0 layer**. Think of it as the peanut-butter between the bread (your transport) and the jam (the OT logic):

1. **ClientTransport / ServerTransport** – These minimal interfaces only care about _sending raw strings_ and _notifying when one arrives_. Nothing more. That means you can swap WebSockets for anything that talks bytes… WebRTC data channels, TCP sockets, even a `postMessage` shim for iframes.
2. **JSONRPCClient / JSONRPCServer** – Give them a transport and they'll take care of framing your method calls, pairing requests with responses, and firing notifications. No duplicate-id headaches, no parsing boilerplate.
3. **PatchesWebSocket & WebSocketServer** – Sweet convenience wrappers that pair the JSON-RPC layer with the built-in WebSocket transport and map every RPC method to a clean TypeScript API.

Because the pieces are _decoupled_, you can:

- Embed Patches in Electron and dial it over IPC.
- Run a headless server that speaks plain TCP.
- Unit-test your app with an in-memory mock transport.

Swap the bread, keep the filling. 🥖✨

## The Protocol Speak 📡

Our network layer uses a super clean JSON-RPC protocol:

### Client → Server Requests

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "commitChanges",
  "params": {
    "docId": "doc123",
    "changes": [{ "op": "replace", "path": "/title", "value": "New Title" }]
  }
}
```

### Server → Client Responses

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "result": {
    "changes": [{ "op": "replace", "path": "/title", "value": "New Title", "rev": 42 }]
  }
}
```

### Server → Client Notifications

```json
{
  "jsonrpc": "2.0",
  "method": "changesCommitted",
  "params": {
    "docId": "doc123",
    "changes": [{ "op": "replace", "path": "/title", "value": "Someone Else's Title", "rev": 43 }]
  }
}
```

## Pro Tips for Network Awesomeness 🏆

### 1. Handle Connection Changes Like a Boss

```typescript
provider.onStateChange(state => {
  if (state === 'connected') {
    hideOfflineWarning();
    showGreenStatus();
  } else if (state === 'disconnected') {
    showOfflineWarning();
    showRedStatus();
    startReconnectTimer();
  } else if (state === 'connecting') {
    showYellowStatus();
    showConnectingSpinner();
  }
});
```

### 2. Batch Those Changes for Efficiency

For high-frequency edits (like tracking cursor positions), consider batching:

```typescript
// Instead of sending every keystroke:
let pendingChanges = [];

// Collect changes
function trackChange(change) {
  pendingChanges.push(change);
  if (!syncScheduled) {
    syncScheduled = true;
    setTimeout(sendBatch, 100); // 10 times per second
  }
}

// Send in batches
function sendBatch() {
  if (pendingChanges.length) {
    provider.commitChanges(docId, pendingChanges);
    pendingChanges = [];
  }
  syncScheduled = false;
}
```

### 3. Error Handling with Style

```typescript
provider.onError((error, context) => {
  console.error(`Error with ${context.docId}:`, error);

  if (error.retryable) {
    // Show a temporary error and retry
    showTemporaryError('Hiccup in the connection - retrying...');
    setTimeout(() => retry(context), 1000);
  } else {
    // Show a permanent error
    showError('Something went wrong. Please refresh the page.');
  }
});
```

## Choosing the Right Provider for Your App 🤔

**Use PatchesRealtime when:**

- Users expect instant collaboration (like Google Docs)
- Your app is primarily used in online environments
- Low latency is critical to the user experience

**Use PatchesOfflineFirst when:**

- Users need to work offline regularly
- Your app targets mobile users with spotty connections
- You want maximum reliability in all network conditions
- Data preservation is mission-critical

## How It All Fits Together 🧩

The network layer is just one piece of the puzzle:

1. **PatchesDoc**: Creates and tracks changes locally
2. **Network Provider**: Syncs changes with the server
3. **PatchesServer**: Processes changes and manages document history
4. **Persistence Layer**: Stores documents for offline use

Together, they create a seamless collaborative experience that works everywhere - from fiber internet to airplane mode!

## Want to Learn More?

Check out these related guides:

- [PatchesDoc](./PatchesDoc.md) - How to work with documents locally
- [persist.md](./persist.md) - Local storage for offline power
- [awareness.md](./awareness.md) - Adding cursors and presence indicators
- [websocket.md](./websocket.md) - Deeper dive into the WebSocket transport
- [json-rpc.md](./json-rpc.md) - All about the tiny RPC layer that runs the show

Happy syncing! 🚀
