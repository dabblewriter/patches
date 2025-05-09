# Persistence Layer

Let's talk about **keeping your stuff around**! 🏪

The persistence layer is where your collaborative documents hang out when they're not actively flashing across the internet. It's what enables that sweet, sweet offline work and makes your app feel lightning-fast even when the internet is acting up.

## IndexedDBStore

Ready to save stuff in the browser? `IndexedDBStore` has your back!

```typescript
import { IndexedDBStore } from '@dabble/patches/persist';
import { PatchesOfflineFirst } from '@dabble/patches/net';

// Create a store with your own cool database name
const store = new IndexedDBStore('my-awesome-app-db');

// Hook it up to your provider
const provider = new PatchesOfflineFirst('wss://server', { store });
```

## What's Going On Under the Hood?

Your data isn't just thrown into a big bucket - it's meticulously organized into different tables:

### 1. Snapshots Table ✨

This is where the magic happens:

- Stores the latest server-confirmed state of each document
- Super-optimized for blazing-fast loading
- Automatically compacted so your app doesn't bloat
- Each entry is keyed by document ID
- Contains: `{ docId: string; state: any; rev: number }`

Think of this as the "known good" state of your document that you can always fall back to!

### 2. Committed Changes Table ✓

All the changes that got the server's stamp of approval:

- Records of every change that made it through
- Helps reconstruct document history
- Gets cleaned up when no longer needed
- Keyed by `[docId, rev]` pairs
- Contains: `Change & { docId: string }`

This is your document's paper trail!

### 3. Pending Changes Table ⏳

Changes you made but the server hasn't confirmed yet:

- Your local edits waiting for the server to say "yes"
- Preserved even if your user closes the browser
- Removed once they're successfully synced
- Keyed by `[docId, rev]`
- Contains: `Change & { docId: string }`

This is what keeps your work safe while waiting for confirmation!

### 4. Deleted Documents Table 🗑️

Keeps track of what's been thrown away:

- Acts as tombstones for deleted documents
- Makes sure deleted docs stay deleted when reconnecting
- Keyed by document ID
- Contains: `{ docId: string }`

## Pro Tips for Storage Success

### Storage Management

Don't let your app become a digital hoarder!

- Keep an eye on how much storage you're using
- Clean up old documents that haven't been accessed in ages
- Consider setting time-to-live for documents
- Tweak compaction thresholds if your changes are large

### Offline-First Design

Embrace the disconnected life:

- Design your app assuming the internet will vanish at any moment
- Handle storage errors gracefully (quota exceeded, anyone?)
- Have a plan for conflict resolution
- Make sure pending changes survive browser restarts

### Performance Hacks

Speed things up even more:

- Batch your changes when possible
- Adjust compaction thresholds for your document sizes
- Set reasonable document size limits
- Use IndexedDB transactions for maximum efficiency

## Smart Compaction Strategy

The store doesn't just save everything forever. It's smart about managing space:

1. Changes are stored in order with their revision numbers
2. After 200 changes (customizable!), it creates a new snapshot
3. But it's careful - it only makes snapshots when it's safe:
   - No pending changes that would be affected
   - This ensures your pending changes can still be properly rebased
4. Old changes get cleaned up after a new snapshot
5. Pending changes are protected until the server confirms them

This gives you the perfect balance of speed, storage efficiency, and reliability!

### Helpful Utility Functions

The store comes with a bunch of utility functions that make working with IndexedDB way less painful:

```typescript
// No more callback hell - everything is Promise-based!
promisifyRequest<T>(request: IDBRequest<T>): Promise<T>
promisifyTransaction(tx: IDBTransaction): Promise<void>

// Easy store operations
getAllFromStore<T>(store: IDBObjectStore, range?: IDBKeyRange, count?: number): Promise<T[]>
getFromStore<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined>
addToStore<T>(store: IDBObjectStore, value: T): Promise<IDBValidKey>
deleteFromStore(store: IDBObjectStore, key: IDBKeyRange | IDBValidKey): Promise<void>
countFromStore(store: IDBObjectStore, range?: IDBKeyRange): Promise<number>

// Cursor operations made simple
getFirstFromCursor<T>(store: IDBObjectStore, range?: IDBKeyRange): Promise<T | undefined>
getLastFromCursor<T>(store: IDBObjectStore, range?: IDBKeyRange): Promise<T | undefined>
```

## Why This Approach Rocks

The persistence layer gives you:

- **Lightning-fast** document loading through snapshots
- **Space efficiency** through smart compaction
- **Bulletproof reliability** for offline work
- **Type safety** with TypeScript
- **Clean error handling** with Promises

## Want to Learn More?

- [net.md](./net.md) - How to sync your changes over the network
- [PatchesDoc](./PatchesDoc.md) - Working with documents
- [operational-transformation.md](./operational-transformation.md) - The core OT magic
