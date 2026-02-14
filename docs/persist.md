# Persistence: Local Storage for Offline Support

Real-time collaboration is great when you have a network connection. But networks fail, go offline, or just get flaky. Your users will close laptop lids, walk into tunnels, and switch between WiFi networks.

Without local persistence, every one of these scenarios means lost work or a frustrating "reconnecting..." spinner.

Patches solves this by giving documents a local home. The [Patches](Patches.md) client works with a **store** that manages local data, while [PatchesSync](PatchesSync.md) handles server communication when a connection is available. Your users can keep working regardless of network state.

## The Store Interface Hierarchy

Patches uses a hierarchy of store interfaces because OT and LWW have different storage needs:

```
PatchesStore (base interface - 9 methods)
├── OTClientStore (+3 methods for change rebasing)
└── LWWClientStore (+6 methods for field-level operations)
```

**Why the split?**

- **OT** tracks a history of changes that get rebased against server changes. It needs to store pending changes and apply server changes atomically.
- **LWW** tracks individual field values with timestamps. It needs path-based storage and a "sending change" lifecycle for idempotent retries.

You don't need to understand these internals. Just pick the right store for your sync algorithm.

## Available Stores

### OT Stores (For Collaborative Editing)

Use these with [Operational Transformation](operational-transformation.md) for collaborative editing where concurrent changes need intelligent merging.

#### `InMemoryStore`

Data lives only in memory. Gone when you refresh the page.

```typescript
import { Patches, InMemoryStore } from '@dabble/patches/client';

const store = new InMemoryStore();
const patches = new Patches({ store });
```

Use `InMemoryStore` for:

- Unit tests where you need a clean slate every time
- Scenarios where persistence isn't required
- Quick prototyping

#### `OTIndexedDBStore`

Persists to the browser's IndexedDB. Survives browser restarts, crashes, and offline periods.

```typescript
import { Patches, OTIndexedDBStore } from '@dabble/patches/client';

const store = new OTIndexedDBStore('my-app-documents');
const patches = new Patches({ store });
```

Use `OTIndexedDBStore` when:

- Offline capability is a requirement
- You want fast document loads from local storage
- You need to reliably queue changes made offline for later syncing

### LWW Stores (For Settings and Status Data)

Use these with [Last-Write-Wins](last-write-wins.md) for simpler data where the most recent write should just win.

#### `LWWInMemoryStore`

In-memory storage for LWW. Great for testing LWW features.

```typescript
import { Patches, LWWInMemoryStore } from '@dabble/patches/client';

const store = new LWWInMemoryStore();
const patches = new Patches({ store });
```

#### `LWWIndexedDBStore`

Persistent storage for LWW. Stores field values and timestamps to IndexedDB.

```typescript
import { Patches, LWWIndexedDBStore } from '@dabble/patches/client';

const store = new LWWIndexedDBStore('my-app-settings');
const patches = new Patches({ store });
```

## How OT Stores Organize Data

OT stores (both `InMemoryStore` and `OTIndexedDBStore`) maintain four categories of data:

### 1. Snapshots

The most recent compacted state of each document. When you load a document, this is the starting point.

- Stored as: `{ docId, state, rev }`
- Updated periodically via compaction (every 200 committed changes)

### 2. Committed Changes

Server-confirmed changes that haven't been compacted into a snapshot yet. Applied on top of the snapshot to reconstruct current state.

- Stored as: `Change` objects keyed by `[docId, rev]`
- Cleared when compacted into a snapshot

### 3. Pending Changes

Local edits that haven't been confirmed by the server. These are your unsaved changes, kept safe locally until they can sync.

- Stored as: `Change` objects keyed by `[docId, rev]`
- Rebased when server changes arrive

### 4. Document Metadata

Tracking information for each document: whether it's being tracked, the last committed revision, and deletion status (tombstones).

**State reconstruction:**

```
snapshot state + committed changes = current server state
current server state + pending changes = local state
```

## How LWW Stores Organize Data

LWW stores organize data differently because they don't need change history:

### 1. Snapshots

Same as OT - the compacted base state.

### 2. Committed Ops

Server-confirmed operations stored by path. Each path maps to a single operation (the latest value wins).

### 3. Pending Ops

Local changes waiting to be sent. Stored as JSON Patch operations keyed by path. Multiple edits to the same path consolidate into one op.

### 4. Sending Change

The in-flight change currently being sent to the server. Stays put until the server acknowledges it. This enables idempotent retries - if you lose connection mid-send, you can retry the exact same change on reconnect.

**State reconstruction:**

```
snapshot -> apply committed ops -> apply sending change -> apply pending ops -> done
```

## Stores Are "Dumb"

Stores just save and load data. The smart stuff - rebasing changes against server updates, consolidating field edits, timestamp comparison - happens in **algorithm implementations**.

- `OTAlgorithm` works with `OTClientStore` implementations
- `LWWAlgorithm` works with `LWWClientStore` implementations

See [algorithms.md](algorithms.md) for the pure functions that handle sync logic.

## Compaction

Both `OTIndexedDBStore` and `LWWIndexedDBStore` compact automatically. After 200 changes (or 200 ops for LWW), the store consolidates committed data into a new snapshot and clears the old records.

This keeps storage bounded and reads fast. You don't need to manage this manually.

## Practical Considerations

**Database naming:** Use a unique, descriptive name for your IndexedDB database (e.g., `'myapp-documents'` or `'myapp-settings'`). This prevents conflicts if other apps on the same origin use IndexedDB.

**Storage quotas:** Browsers have limits on IndexedDB storage. While typically generous (50MB-unlimited depending on browser), be mindful with very large documents or many offline edits.

**Error handling:** IndexedDB operations can throw errors (storage full, private browsing mode, etc.). Handle these gracefully:

```typescript
try {
  const store = new OTIndexedDBStore('my-app');
  const patches = new Patches({ store });
} catch (error) {
  // Fall back to in-memory, warn user, etc.
  const store = new InMemoryStore();
  const patches = new Patches({ store });
}
```

## Why Local-First Matters

Using Patches with a persistent store gives you:

- **Real offline capability:** Users create, edit, and browse documents with zero internet. Their work is safe.
- **Fast performance:** Loading from local storage is orders of magnitude faster than waiting for a network round-trip.
- **Resilience:** Your app works even when the network doesn't.
- **Automatic sync:** When a connection returns, [PatchesSync](PatchesSync.md) picks up pending changes and gets them to the server.

This isn't just a nice-to-have. Users lose trust in apps that lose their work. Local persistence is table stakes for any serious collaborative application.

## When to Use OT vs LWW

| Use Case                   | Algorithm | Reason                                          |
| -------------------------- | --------- | ----------------------------------------------- |
| Collaborative text editing | OT        | Concurrent character-level changes need merging |
| Rich document editing      | OT        | Multiple users editing same content             |
| User preferences           | LWW       | Last setting wins, no merging needed            |
| Application settings       | LWW       | Simple key-value updates                        |
| Presence/status data       | LWW       | Latest status is what matters                   |

## Related Documentation

- [Patches.md](Patches.md) - The main client-side API that uses these stores
- [PatchesDoc.md](PatchesDoc.md) - Working with individual documents
- [PatchesSync.md](PatchesSync.md) - How sync gets your locally stored changes to the server
- [algorithms.md](algorithms.md) - The pure functions that handle sync logic
- [operational-transformation.md](operational-transformation.md) - Deep dive into OT concepts
- [last-write-wins.md](last-write-wins.md) - Deep dive into LWW concepts
- [net.md](net.md) - Networking and transport layer overview
