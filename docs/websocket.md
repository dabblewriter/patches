# WebSocket Transport: Your Real-Time Superhighway! 🚀

## What Is This Thing?

The WebSocket transport is your **direct line** to collaboration bliss. It's how your client app stays connected to your Patches server for that sweet, sweet real-time magic. Think of it as the digital nervous system that keeps everything in sync!

`PatchesWebSocket` gives you a super-friendly API to:

- Subscribe to documents (and get updates when they change)
- Send your changes (and watch them magically appear for everyone else)
- Work with document history and versions
- Keep everything running smoothly even when connections get wonky

## When Should You Use This?

Use WebSocket transport when you want:

- ⚡ **Real-time, super-fast collaboration** between clients
- 🤖 **Zero-hassle document updates** that just work
- 🔄 **Simple yet powerful versioning** for your docs
- 🧠 **Smart reconnection** when the internet hiccups
- 💪 **A robust connection** to your central server

## Let's Get This Party Started!

### 1. Import the Goods

```typescript
import { PatchesWebSocket } from '@dabble/patches/net';
```

### 2. Connect to Your Server

```typescript
// Create your WebSocket connection
const ws = new PatchesWebSocket('wss://your-awesome-server.example.com');

// Connect and you're off to the races!
await ws.connect();
```

### 3. Subscribe to Documents

```typescript
// Subscribe to one document
await ws.subscribe('doc123');

// Or subscribe to a bunch at once!
await ws.subscribe(['shopping-list', 'team-notes', 'project-plan']);
```

### 4. Listen for Updates From Others

```typescript
// Set up a listener for incoming changes
ws.onChangesCommitted(({ docId, changes }) => {
  console.log(`New changes for ${docId}!`);

  // Now you can update your local document state
  myDocsMap[docId].applyExternalServerUpdate(changes);

  // Or trigger a confetti explosion, your call 🎉
});
```

### 5. Send Your Own Changes

```typescript
// Got some local changes? Share them with the world!
try {
  const serverResponse = await ws.commitChanges('shopping-list', myChangesArray);

  // Tell your PatchesDoc that the server confirmed these changes
  myShoppingListDoc.applyServerConfirmation(serverResponse);

  console.log('Changes sent and confirmed! 🎉');
} catch (err) {
  console.error('Oops, something went wrong:', err);
}
```

### 6. Work With Document History

```typescript
// Just finished a major milestone? Create a named version!
const versionId = await ws.createVersion('project-plan', 'First Draft Complete');

// Want to see all versions?
const allVersions = await ws.listVersions('project-plan');
console.log(`You have ${allVersions.length} saved versions!`);

// Need to go back in time? Get a snapshot of a past version
const oldSnapshot = await ws.getVersionState('project-plan', versionId);
console.log('Here's what things looked like before:', oldSnapshot);
```

## The Cool Stuff You Can Do

Here are the key methods that make `PatchesWebSocket` so handy:

### Connection Management

- `connect()` - Start the WebSocket connection
- `disconnect()` - Close the connection gracefully
- `isConnected` - Check if you're still online
- `onConnectionStateChange` - React when connection status changes

### Document Subscriptions

- `subscribe(ids)` - Start getting updates for specific docs
- `unsubscribe(ids)` - Stop getting updates when you don't need them
- `getSubscribedIds()` - Check which docs you're currently subscribed to

### Document Operations

- `getDoc(docId)` - Fetch the latest state and revision
- `commitChanges(docId, changes)` - Send your changes to everyone
- `onChangesCommitted` - Get notified when someone makes changes

### Versioning (Your Personal Time Machine)

- `createVersion(docId, name?)` - Create a snapshot with an optional name
- `listVersions(docId, options?)` - See all versions with customizable filtering
- `getVersionState(docId, versionId)` - Get a document's state at a specific version
- `getVersionChanges(docId, versionId)` - See exactly what changed in a version
- `updateVersion(docId, versionId, metadata)` - Update version info like name or notes

## Real-World Example: A Complete Collaboration Setup

Here's how to wire everything up for a robust collaborative app:

```typescript
import { Patches, PatchesDoc } from '@dabble/patches';
import { PatchesWebSocket } from '@dabble/patches/net';
import { IndexedDBStore } from '@dabble/patches/persist';

class CollaborativeEditor {
  private patches: Patches;
  private ws: PatchesWebSocket;
  private docs: Map<string, PatchesDoc<any>> = new Map();

  constructor() {
    // 1. Set up persistence for offline support
    const store = new IndexedDBStore('my-cool-app');
    this.patches = new Patches({ store });

    // 2. Create WebSocket connection
    this.ws = new PatchesWebSocket('wss://your-server.example');

    // 3. Set up connection state handling
    this.ws.onConnectionStateChange(state => {
      if (state === 'connected') {
        this.showOnlineStatus();
      } else {
        this.showOfflineWarning();
      }
    });

    // 4. Listen for incoming changes
    this.ws.onChangesCommitted(({ docId, changes }) => {
      const doc = this.docs.get(docId);
      if (doc) {
        doc.applyExternalServerUpdate(changes);
      }
    });
  }

  async start() {
    // Connect to the server
    await this.ws.connect();
    console.log('Connected and ready!');
  }

  async openDocument(docId: string) {
    // 1. Subscribe to updates from the server
    await this.ws.subscribe(docId);

    // 2. Open or create the document locally
    const doc = await this.patches.openDoc(docId);
    this.docs.set(docId, doc);

    // 3. Set up a change handler to sync to server
    doc.onChange(() => {
      if (doc.hasPending && !doc.isSending) {
        const changes = doc.getUpdatesForServer();

        this.ws
          .commitChanges(docId, changes)
          .then(serverCommit => {
            doc.applyServerConfirmation(serverCommit);
          })
          .catch(err => {
            console.error('Failed to send changes:', err);
            doc.handleSendFailure();
            this.showRetryNotification();
          });
      }
    });

    return doc;
  }

  async createVersion(docId: string, name: string) {
    return await this.ws.createVersion(docId, name);
  }

  async loadVersion(docId: string, versionId: string) {
    const versionState = await this.ws.getVersionState(docId, versionId);
    // Now you can display this historical state or revert to it
    return versionState;
  }

  // UI helper methods
  private showOnlineStatus() {
    /* ... */
  }
  private showOfflineWarning() {
    /* ... */
  }
  private showRetryNotification() {
    /* ... */
  }
}

// Usage:
const editor = new CollaborativeEditor();
await editor.start();

// Open a document and start editing
const doc = await editor.openDocument('my-novel');

// Make changes locally
doc.change(draft => {
  draft.chapters[0].title = 'A New Beginning';
});

// Create a version after significant changes
await editor.createVersion('my-novel', 'Chapter 1 Complete');
```

## Pro Tips for WebSocket Champions

### 1. Handle Connection Drops Like a Pro

```typescript
ws.onConnectionStateChange(state => {
  if (state === 'connecting') {
    showSpinner();
  } else if (state === 'connected') {
    hideSpinner();
    showGreenStatus();
  } else if (state === 'disconnected') {
    showRedStatus();
    showReconnectingMessage();
  }
});
```

### 2. Batch Your Changes for Better Performance

Instead of sending every tiny change, consider batching them:

```typescript
// Track if we should send changes
let shouldSendChanges = false;
let sendTimer = null;

// Listen for document changes
doc.onChange(() => {
  shouldSendChanges = true;

  // If we don't already have a timer, set one
  if (!sendTimer) {
    sendTimer = setTimeout(() => {
      if (shouldSendChanges && doc.hasPending) {
        const changes = doc.getUpdatesForServer();
        ws.commitChanges(docId, changes).then(/*...*/);

        shouldSendChanges = false;
      }
      sendTimer = null;
    }, 300); // Adjust timing based on your app's needs
  }
});
```

### 3. Version Your Document at Smart Moments

Don't just create versions randomly - do it at meaningful moments:

```typescript
// Create a version when a user explicitly saves
async function handleSaveButton() {
  const name = await promptUserForVersionName();
  const versionId = await ws.createVersion(docId, name);
  showSavedNotification(name);

  // Add to version history UI
  updateVersionHistoryList();
}

// Or automatically version at key points
function detectMilestone(changes) {
  // Example: If a new chapter is added to a book
  return changes.some(change => change.ops.some(op => op.path.match(/^\/chapters\/\d+$/) && op.op === 'add'));
}

doc.onChange(change => {
  if (detectMilestone(change)) {
    ws.createVersion(docId, 'New Chapter Added');
  }
});
```

## Why WebSockets Rock for Real-Time Apps

Using WebSockets for your collaborative app gives you:

1. **Lightning-fast updates** - changes appear almost instantly
2. **Efficient network usage** - no polling overhead
3. **Stateful connections** - the server knows who's editing what
4. **Built-in reconnection** - keeps working even with shaky internet
5. **Two-way communication** - both pull and push in one connection

## Want to Learn More?

- [Awareness](./awareness.md) - Add collaborative cursors and presence
- [PatchesDoc](./PatchesDoc.md) - How to work with document state locally
- [operational-transformation.md](./operational-transformation.md) - The magic under the hood

Now go forth and build amazing collaborative experiences! 🚀
