# Persistence Layer

The persistence layer provides local storage for Patches documents, enabling offline work and efficient state management.

## IndexedDBStore

The `IndexedDBStore` class provides efficient local storage using IndexedDB:

```typescript
import { IndexedDBStore } from '@dabble/patches/persist';
import { PatchesOfflineFirst } from '@dabble/patches/net';

// Create a store with optional database name
const store = new IndexedDBStore('my-app-db');

// Use with offline-first provider
const provider = new PatchesOfflineFirst('wss://server', { store });
```

## Storage Structure

The store maintains several tables:

1. **Snapshots**

   - Stores the last known committed state
   - Optimized for quick document loading
   - Automatically compacted to prevent bloat

2. **Committed Changes**

   - Records of server-confirmed changes
   - Used for history and state reconstruction
   - Cleaned up after snapshot compaction

3. **Pending Changes**

   - Local changes awaiting server confirmation
   - Preserved across app restarts
   - Removed after successful sync

4. **Deleted Documents**
   - Tombstones for deleted documents
   - Ensures proper cleanup on reconnect

## Best Practices

1. **Storage Management**

   - Monitor storage usage
   - Implement cleanup strategies
   - Consider TTL for old documents

2. **Offline Work**

   - Design for offline-first
   - Handle storage errors gracefully
   - Implement conflict resolution

3. **Performance**
   - Batch changes when possible
   - Use appropriate compaction thresholds
   - Consider document size limits

## Implementation Details

The store uses a sophisticated compaction strategy:

1. Changes are stored in order
2. Snapshots are created periodically (e.g., every 100 changes)
3. Old changes are cleaned up after snapshot creation
4. Pending changes are preserved until confirmed

This approach balances:

- Quick document loading (via snapshots)
- Efficient storage (via compaction)
- Reliable offline work (via change queuing)

## See Also

- [net.md](./net.md) - Network synchronization
- [PatchDoc](./PatchDoc.md) - Document editing
- [operational-transformation.md](./operational-transformation.md) - Core OT concepts
