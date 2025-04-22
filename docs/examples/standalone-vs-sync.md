# Using Patches: Standalone vs. with Sync

This document shows how to use the Patches library in both standalone mode (local-only) and with network synchronization.

## Standalone Mode (Local-Only)

If you only need local document management without network synchronization, you can use the `Patches` class on its own:

```typescript
import { Patches } from '@dabble/patches';
import { IndexedDBStore } from '@dabble/patches/persist';

// Create a storage backend
const store = new IndexedDBStore('my-local-docs');

// Initialize Patches without a sync layer
const patches = new Patches({
  store,
  metadata: { user: 'local-user' },
});

// Open and use documents
async function example() {
  // Open a document
  const doc = await patches.openDoc('my-document-id');

  // Make changes
  doc.change(draft => {
    draft.title = 'New Title';
    draft.content = 'Hello, world!';
  });

  // Changes are automatically persisted to the store
  console.log(doc.state); // { title: 'New Title', content: 'Hello, world!' }

  // Close when done
  await patches.closeDoc('my-document-id');

  // Or completely shut down
  patches.close();
}
```

## With Network Synchronization

When you need real-time collaboration or syncing across devices, add `PatchesSync`:

```typescript
import { Patches } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';
import { IndexedDBStore } from '@dabble/patches/persist';

// Create a storage backend
const store = new IndexedDBStore('my-synced-docs');

// 1. First initialize Patches
const patches = new Patches({
  store,
  metadata: { user: 'alice@example.com' },
});

// 2. Then add synchronization
const patchesSync = new PatchesSync('wss://your-server.example.com/patches', patches, {
  wsOptions: {
    headers: {
      Authorization: 'Bearer your-auth-token',
    },
  },
  maxBatchSize: 100,
});

// Subscribe to connection state changes
patchesSync.onStateChange(state => {
  console.log('Connection state:', state);
  // { online: boolean, connected: boolean, syncing: 'initial' | 'updating' | null | Error }
});

// Subscribe to errors
patchesSync.onError((error, context) => {
  console.error('Sync error:', error, context);
});

// Usage example
async function example() {
  // Connect to the server
  await patchesSync.connect();

  // Track documents you want to sync
  await patchesSync.trackDocs(['doc1', 'doc2']);

  // Open a document (works the same as before)
  const doc = await patches.openDoc('doc1');

  // Make changes (automatically synced when online)
  doc.change(draft => {
    draft.title = 'Collaborative Document';
    draft.content = 'This will be synced to the server';
  });

  // Manually trigger sync for a specific document if needed
  await patchesSync.syncDoc('doc1');

  // Stop syncing a document (but keep it locally)
  await patchesSync.untrackDocs(['doc2']);

  // Close when done
  await patches.closeDoc('doc1');
  patchesSync.disconnect();
  patches.close();
}
```

## Benefits of Separation

This separation of concerns provides several benefits:

1. **Modularity**: Use `Patches` on its own for local-only applications, or add `PatchesSync` when network features are needed.
2. **Testing**: Easier to test components independently.
3. **Code organization**: Clearer separation between document management and network synchronization.
4. **Extensibility**: Create custom sync implementations for different network protocols without modifying core document logic.

## Migrating from Previous Versions

If you were using the previous combined API:

```typescript
// Old approach
const patches = new Patches({
  url: 'wss://example.com',
  store: new IndexedDBStore('my-docs'),
});
await patches.connect();
```

Convert it to:

```typescript
// New approach
const patches = new Patches({
  store: new IndexedDBStore('my-docs'),
});
const patchesSync = new PatchesSync('wss://example.com', patches);
await patchesSync.connect();
```

Most API methods have direct equivalents between the old and new approach, just moved to the appropriate class.
