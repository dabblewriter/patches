# WebSocket Transport for Patches

## Overview

The WebSocket transport is the primary way to connect your client application to a Patches server for real-time collaboration. It provides a high-level API for subscribing to documents, sending and receiving changes, and working with document versions—all over a persistent WebSocket connection.

- **Class:** `PatchesWebSocket`
- **Location:** `@dabble/patches/src/net/websocket/PatchesWebSocket.ts`

## When to Use

Use the WebSocket transport when you want:

- Real-time, low-latency collaboration between clients and a central server
- Automatic handling of document updates, and versioning
- A simple API for subscribing to and editing documents

## Getting Started

### 1. Install and Import

```typescript
import { PatchesWebSocket } from '@dabble/patches';
```

### 2. Connect to the Server

```typescript
const ws = new PatchesWebSocket('wss://your-patches-server.example.com');
await ws.connect();
```

### 3. Subscribe to Documents

```typescript
await ws.subscribe('doc123'); // or multiple: ws.subscribe(['doc1', 'doc2'])
```

### 4. Listen for Document Updates

```typescript
ws.onChangesCommitted(params => {
  console.log('Received document changes:', params);
});
```

### 5. Send Changes

```typescript
// Use your PatchDoc to generate changes, then:
await ws.commitChanges('doc123', changesArray);
```

### 6. Versioning and History

```typescript
// Create a named version
const versionId = await ws.createVersion('doc123', 'Milestone 1');

// List versions
const versions = await ws.listVersions('doc123');

// Get a snapshot for a version
const snapshot = await ws.getVersionState('doc123', versionId);
```

## API Reference (Key Methods)

- `connect()` / `disconnect()` — Open/close the WebSocket connection
- `subscribe(ids)` / `unsubscribe(ids)` — Subscribe/unsubscribe to document updates
- `getDoc(docId)` — Fetch the latest state of a document
- `commitChanges(docId, changes)` — Send changes to the server
- `onChangesCommitted` — Signal for document changes from the server
- `createVersion`, `listVersions`, `getVersionState`, `getVersionChanges`, `updateVersion` — Versioning APIs

## Example: Real-World Client Integration

Below is a typical setup for a collaborative client using `PatchDoc` and `PatchesWebSocket` together. This pattern ensures robust, real-time sync with the server and other clients.

```typescript
import { PatchDoc, PatchesWebSocket } from '@dabble/patches';

// 1. Connect to the server and subscribe to a document
const ws = new PatchesWebSocket('wss://your-server');
await ws.connect();
await ws.subscribe('doc123');

// 2. Fetch the initial document state and revision from the server (pseudo-code)
const { state: initialState, rev: initialRev } = await ws.getDoc('doc123');

// 3. Create a PatchDoc instance with the initial state
const patchDoc = new PatchDoc(initialState, {}); // Optionally pass metadata as 2nd arg

// 4. Listen for document updates from the server (from other clients)
ws.onChangesCommitted(({ docId, changes }) => {
  if (docId === 'doc123') {
    patchDoc.applyExternalServerUpdate(changes);
  }
});

// 5. Listen for local changes and send them to the server
patchDoc.onChange(() => {
  // Only send if not already sending a batch
  if (!patchDoc.isSending && patchDoc.hasPending) {
    const changes = patchDoc.getUpdatesForServer();
    ws.commitChanges('doc123', changes)
      .then(serverCommit => {
        patchDoc.applyServerConfirmation(serverCommit);
      })
      .catch(err => {
        // Handle network/server error (retry, revert, etc.)
        console.error('Failed to send changes:', err);
      });
  }
});

// 8. Make local changes as usual
patchDoc.change(draft => {
  draft.title = 'New Title';
});
```

**Key Points:**

- All document state and OT logic is managed by `PatchDoc`.
- All network sync and versioning is handled by `PatchesWebSocket`.
- The sync loop is: local change → `onChange` → send to server → receive confirmation → `applyServerConfirmation`.
- Incoming changes from other clients are applied via `applyExternalServerUpdate`.

---

## Best Practices

- Always handle connection state changes (reconnect on drop, show offline UI, etc.)
- Use `PatchDoc` for local state and OT logic; use `PatchesWebSocket` for network sync
- Debounce or batch changes if your app generates many rapid edits
- Use versioning to allow users to restore or view history

## See Also

- [Awareness](./awareness.md) — How to use presence/cursor features
- [PatchDoc](./PatchDoc.md) — Client-side OT logic
- [operational-transformation.md](./operational-transformation.md) — Protocol details
