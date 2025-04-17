# Network Layer

The network layer provides real-time and offline-first synchronization for Patches documents. It handles WebSocket connections, protocol communication, and document synchronization.

## Providers

### PatchesRealtime

The real-time provider offers immediate synchronization with the server. Changes are sent as soon as they're made locally.

```typescript
import { PatchesRealtime } from '@dabble/patches/net';

// Create and connect
const provider = new PatchesRealtime('wss://your-server.com');
await provider.connect();

// Open a document
const doc = await provider.openDoc<MyDocType>('doc123');

// Make changes - sync happens automatically
doc.change(draft => {
  draft.title = 'New Title';
});

// When done
provider.close();
```

### PatchesOfflineFirst (Coming Soon)

The offline-first provider prioritizes local persistence and background synchronization. Changes are:

1. Saved locally first
2. Queued for background sync
3. Sent to server when online

```typescript
import { PatchesOfflineFirst } from '@dabble/patches/net';
import { IndexedDBStore } from '@dabble/patches/persist';

// Create with optional IndexedDB store
const store = new IndexedDBStore('my-app-db');
const provider = new PatchesOfflineFirst('wss://your-server.com', { store });
await provider.connect();

// Open a document - works offline
const doc = await provider.openDoc<MyDocType>('doc123');

// Make changes - saved locally first
doc.change(draft => {
  draft.title = 'Works offline!';
});

// Changes sync in background when online
```

## WebSocket Transport

The WebSocket transport handles the low-level communication with the server:

- Connection management
- JSON-RPC protocol
- Document subscription
- Change synchronization

## Protocol

The network layer uses a JSON-RPC protocol for communication:

- **Requests**: Client-initiated operations (subscribe, patch, etc.)
- **Responses**: Server acknowledgments
- **Notifications**: Server-pushed updates (changes, presence)

## Best Practices

1. **Connection Management**

   - Handle connection state changes
   - Implement reconnection logic
   - Show offline indicators

2. **Change Batching**

   - Consider batching rapid edits
   - Use debouncing for high-frequency changes

3. **Error Handling**
   - Handle network errors gracefully
   - Implement retry strategies
   - Consider offline-first for critical apps

## See Also

- [PatchDoc](./PatchDoc.md) - Document editing
- [persist.md](./persist.md) - Storage and offline support
- [awareness.md](./awareness.md) - Presence and collaboration features
