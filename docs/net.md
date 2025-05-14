# Network Layer: Keeping Your Data in Harmony! 🔄

Alright, let's dive into the networking nuts and bolts that make your collaborative magic happen. The Patches network layer is all about ensuring that every user's view of a document stays consistent and up-to-date, whether they're hammering away in real-time or have just come back online after a coffee break.

## Meet `PatchesSync`: Your Sync Conductor 🎶

Forget juggling different "providers" for different scenarios. The star of our show is `PatchesSync`. This class is your main point of contact for getting your local `Patches` instance talking to a remote server.

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

// 1. Set up your Patches instance (with a store)
const store = new InMemoryStore();
const patches = new Patches({ store });

// 2. Create and connect PatchesSync
const sync = new PatchesSync('wss://your-awesome-server.com', patches, {
  wsOptions: {
    /* ... any custom WebSocket options ... */
  },
});

try {
  await sync.connect();
  console.log('Connected and ready to sync!');

  // 3. Open a document through Patches - PatchesSync will handle the rest
  const doc = await patches.getDoc<MyDocType>('shared-doc-123');

  // Make changes - Patches tells PatchesSync, which sends them off
  doc.change(draft => {
    draft.title = 'Syncing Like a Boss!';
    draft.lastEditor = 'Me';
  });
} catch (error) {
  console.error("Couldn't connect:", error);
  // Handle connection errors, maybe retry or inform the user
}

// When you're all done (e.g., app closing)
// sync.disconnect();
```

`PatchesSync` takes on several key responsibilities:

- **Connecting to the Server**: It establishes and manages a WebSocket connection using `PatchesWebSocket` under the hood.
- **State Management**: Keeps track of `online` status (browser online/offline), `connected` status (WebSocket connected/disconnected), and `syncing` status (initial sync, updating, or idle). You can listen to its `onStateChange` signal to react to these changes in your UI.
- **Document Tracking**: It automatically knows which documents your `Patches` instance is tracking and handles subscribing for server updates for those documents.
- **Outgoing Changes**: When you make local changes using `PatchesDoc.change()`, `Patches` notifies `PatchesSync`, which then efficiently sends these changes to the server.
- **Incoming Changes**: When the server sends new changes for a document, `PatchesSync` receives them, tells the `PatchesStore` to save them, and then instructs your `Patches` instance to apply these changes to the local `PatchesDoc`.
- **Batching**: If you have `maxPayloadBytes` configured, `PatchesSync` (with help from `Patches`) will break down large sets of changes into smaller batches for transmission.
- **Offline/Online Transitions**: It listens to browser online/offline events. When the browser comes back online, it will attempt to reconnect the WebSocket and resume syncing.

The goal is to make synchronization as straightforward as possible: you work with your `Patches` documents, and `PatchesSync` does the heavy lifting of keeping them aligned with the server.

## How the WebSocket Transport Works 🔌

Under the hood, `PatchesSync` uses `PatchesWebSocket`, which itself relies on `WebSocketTransport`. This layered approach handles:

- **Connection Management**: Handles connect, disconnect, and reconnect logic for the WebSocket.
- **JSON-RPC Protocol**: Ensures structured and reliable messages (more on this below).
- **Document Subscription**: Tells the server which documents the client is interested in.
- **Change Synchronization**: Manages the bidirectional flow of document changes.

It's the engine room that powers the real-time communication.

## Under the Hood: The JSON-RPC Sandwich 🥪

At the heart of Patches' networking is a **lean, mean JSON-RPC 2.0 layer**. This is the common language spoken between your client and the server.

1.  **ClientTransport / ServerTransport** – These are super minimal interfaces. Their only job is to send raw strings and let you know when one arrives. This means you could, in theory, swap out WebSockets for other transports if needed (like WebRTC data channels, though `PatchesSync` is currently wired for WebSockets).
2.  **JSONRPCClient / JSONRPCServer** – Give these a transport, and they handle the nitty-gritty of framing method calls, matching requests with responses, and managing notifications. No more manual JSON parsing or ID tracking for you!
3.  **PatchesWebSocket & WebSocketServer** – These are convenience wrappers that pair the JSON-RPC layer with the WebSocket transport and map RPC methods to a clean TypeScript API for `PatchesSync` and your server-side setup.

This decoupled design means greater flexibility and testability. You can focus on your application logic, knowing the communication details are well-handled.

## The Protocol Speak 📡

Our network layer uses a clean JSON-RPC protocol for communication. Here's a quick peek:

### Client → Server Requests (e.g., committing changes)

```json
{
  "jsonrpc": "2.0",
  "id": 123, // Unique request ID
  "method": "commitChanges",
  "params": {
    "docId": "doc123",
    "changes": [{ "op": "replace", "path": "/title", "value": "New Title", "rev": 10, "baseRev": 9 }]
  }
}
```

### Server → Client Responses (e.g., acknowledging committed changes)

```json
{
  "jsonrpc": "2.0",
  "id": 123, // Corresponds to the request ID
  "result": {
    // Usually includes the committed changes, possibly transformed or with server-assigned revs
    "changes": [
      { "op": "replace", "path": "/title", "value": "New Title", "rev": 10, "baseRev": 9, "committedRev": 101 }
    ]
  }
}
```

### Server → Client Notifications (e.g., new changes from another user)

```json
{
  "jsonrpc": "2.0",
  "method": "changesCommitted", // No ID, it's a notification
  "params": {
    "docId": "doc123",
    "changes": [{ "op": "replace", "path": "/content", "value": "...", "rev": 11, "baseRev": 10, "committedRev": 102 }]
  }
}
```

(Note: The exact structure of `changes` within the protocol messages will align with your `Change` type, including necessary metadata like `rev`, `baseRev`, `id`, etc.)

## Pro Tips for Network Zen 🙏

### 1. Gracefully Handle Connection State Changes

Your app should react to changes in the connection. `PatchesSync` helps by providing an `onStateChange` signal:

```typescript
sync.onStateChange(state => {
  console.log('Sync state changed:', state);
  if (state.connected) {
    // Green light! Things are good.
    hideOfflineWarning();
    updateStatusUI('Connected');
  } else if (!state.online) {
    // Browser is offline
    showOfflineWarning('You are offline. Changes saved locally.');
  } else if (state.syncing === 'initial' || state.syncing === 'updating') {
    // Working on it...
    showSyncingIndicator('Syncing...');
  } else if (state.syncing instanceof Error) {
    // Uh oh, sync ran into an issue.
    showErrorUI('Sync failed: ' + state.syncing.message);
  } else {
    // Disconnected, but browser is online. May attempt to reconnect.
    showOfflineWarning('Disconnected. Trying to reconnect...');
  }
});
```

### 2. Smart Error Handling

Network operations can fail. `PatchesSync` also emits an `onError` signal:

```typescript
sync.onError((error, context) => {
  console.error(`Network error for doc ${context?.docId || 'general'}:`, error);

  // You might want to log this to a monitoring service
  // or display a user-friendly message.
  if (isRetryableError(error)) {
    // You'd define isRetryableError
    showTemporaryError("A network blip occurred. We'll keep trying.");
  } else {
    showPersistentError('A connection problem occurred. Please check your internet.');
  }
});
```

### 3. Understand `maxPayloadBytes` for Large Changes

If you anticipate very large changes (e.g., embedding a big base64 image in one go), `Patches` (and by extension `PatchesSync`) can automatically break these into smaller network messages if you set `maxPayloadBytes` in `PatchesOptions` (passed to `Patches` constructor) or `PatchesSyncOptions`.

```typescript
const patches = new Patches({
  store,
  docOptions: { maxPayloadBytes: 1024 * 100 }, // e.g., 100KB
});
// or
const sync = new PatchesSync(URL, patches, { maxPayloadBytes: 1024 * 100 });
```

This helps prevent issues with WebSocket message size limits on servers or intermediaries.

## How It All Fits Together 🧩

The network layer is a key piece of the collaborative puzzle:

1.  **`PatchesDoc`**: Your client-side document representation. It creates and tracks changes locally.
2.  **`Patches`**: The main client-side orchestrator. It manages multiple `PatchesDoc` instances and interfaces with `PatchesStore` and `PatchesSync`.
3.  **`PatchesStore`**: Handles local persistence of document state and changes, crucial for resilience and quick load times.
4.  **`PatchesSync`**: Connects to the server, sends local changes queued by `Patches` (via the store), and receives remote changes to be applied.
5.  **Server-Side (`PatchesServer`, etc.)**: Your backend receives changes, applies Operational Transformation for conflict resolution, and broadcasts changes to other connected clients.

Together, these components aim to provide a robust and relatively seamless collaborative experience.

## Want to Learn More?

Check out these related guides:

- [PatchesDoc](./PatchesDoc.md) - How to work with documents on the client.
- [Patches](./Patches.md) - The main client-side entry point (you might need to create this doc if it focuses on `Patches` itself).
- [persist.md](./persist.md) - Delve into local storage and how `PatchesStore` works.
- [awareness.md](./awareness.md) - Adding presence indicators (cursors, selections) using WebRTC, which can complement the WebSocket sync.
- `json-patch.md` - If you're using or interested in the JSON Patch capabilities.

Happy syncing! 🚀
