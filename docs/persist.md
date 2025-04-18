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
   - Keyed by document ID
   - Contains: `{ docId: string; state: any; rev: number }`

2. **Committed Changes**

   - Records of server-confirmed changes
   - Used for history and state reconstruction
   - Cleaned up after snapshot compaction
   - Keyed by `[docId, rev]`
   - Contains: `Change & { docId: string }`

3. **Pending Changes**

   - Local changes awaiting server confirmation
   - Preserved across app restarts
   - Removed after successful sync
   - Keyed by `[docId, rev]`
   - Contains: `Change & { docId: string }`

4. **Deleted Documents**
   - Tombstones for deleted documents
   - Ensures proper cleanup on reconnect
   - Keyed by document ID
   - Contains: `{ docId: string }`

## Best Practices

1. **Storage Management**

   - Monitor storage usage
   - Implement cleanup strategies
   - Consider TTL for old documents
   - Use appropriate compaction thresholds (default: 200 changes)

2. **Offline Work**

   - Design for offline-first
   - Handle storage errors gracefully
   - Implement conflict resolution
   - Preserve pending changes across restarts

3. **Performance**
   - Batch changes when possible
   - Use appropriate compaction thresholds
   - Consider document size limits
   - Leverage IndexedDB transactions for atomic operations

## Implementation Details

The store uses a sophisticated compaction strategy:

1. Changes are stored in order with revision numbers
2. Snapshots are created after `SNAPSHOT_INTERVAL` changes (default: 200)
3. Snapshot creation is conditional:
   - Only occurs if there are no pending changes based on revisions older than the latest committed change
   - This ensures pending changes can be properly rebased
4. Old changes are cleaned up after snapshot creation
5. Pending changes are preserved until confirmed by the server

### Utility Functions

The store provides several utility functions for IndexedDB operations:

```typescript
// Promise-based request handling
promisifyRequest<T>(request: IDBRequest<T>): Promise<T>
promisifyTransaction(tx: IDBTransaction): Promise<void>

// Store operations
getAllFromStore<T>(store: IDBObjectStore, range?: IDBKeyRange, count?: number): Promise<T[]>
getFromStore<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined>
addToStore<T>(store: IDBObjectStore, value: T): Promise<IDBValidKey>
deleteFromStore(store: IDBObjectStore, key: IDBKeyRange | IDBValidKey): Promise<void>
countFromStore(store: IDBObjectStore, range?: IDBKeyRange): Promise<number>

// Cursor operations
getFirstFromCursor<T>(store: IDBObjectStore, range?: IDBKeyRange): Promise<T | undefined>
getLastFromCursor<T>(store: IDBObjectStore, range?: IDBKeyRange): Promise<T | undefined>
```

This approach balances:

- Quick document loading (via snapshots)
- Efficient storage (via compaction)
- Reliable offline work (via change queuing)
- Type safety (via TypeScript interfaces)
- Error handling (via Promise-based operations)

## See Also

- [net.md](./net.md) - Network synchronization
- [PatchDoc](./PatchDoc.md) - Document editing
- [operational-transformation.md](./operational-transformation.md) - Core OT concepts
