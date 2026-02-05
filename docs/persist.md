# Persistence: Your Doc's Local Hideout

So, you're building something awesome and collaborative. But what happens when the internet decides to take a nap? Or when your users just want to work on their stuff locally without waiting for the network? That's where persistence swoops in, cape and all!

In the Patches world, persistence means giving your documents a cozy local home. This makes your app feel snappy, lets users work offline, and generally makes life better. The `Patches` client works with a **store** to manage all this local data goodness. `PatchesSync` then handles the job of talking to the server when a connection is available.

## The Store Family Tree

Patches uses a hierarchy of store interfaces, each adding capabilities for different sync strategies:

```
PatchesStore (base - shared by all strategies)
├── OTClientStore (for Operational Transformation)
└── LWWClientStore (for Last-Write-Wins)
```

**Why the split?** OT and LWW handle syncing very differently:

- **OT** tracks a history of changes that get rebased against server changes
- **LWW** tracks individual field values with timestamps - simpler, but different storage needs

The good news? You don't need to think about this much. Just pick the right store for your strategy and you're golden!

## Meet the Stores: Your Local Data Keepers

### OT Stores (For Collaborative Editing)

These stores work with OT (Operational Transformation) - perfect for collaborative editing where you need to merge concurrent changes intelligently.

#### `InMemoryStore`: Quick & Clean (But Not Forever)

Sometimes, you just need a place to stash things temporarily. Maybe for testing, a super short-lived session, or when you explicitly _don't_ want data to stick around.

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';

// Create an in-memory store
const store = new InMemoryStore();

// Hook it up to Patches
const patches = new Patches({ store });

// Now, when you use patches.getDoc(), etc.,
// data will be held in memory for this session.
// It's gone if you refresh the page!
```

`InMemoryStore` is your go-to for:

- Unit tests where you need a clean slate every time
- Scenarios where data persistence isn't a requirement
- Keeping things ultra-simple if you're just trying things out

#### `IndexedDBStore`: Robust & Ready for Offline

When you need your data to survive browser restarts, flaky connections, and the occasional coffee spill on the modem, `IndexedDBStore` is your champion. It uses the browser's IndexedDB to give your documents a proper, persistent home.

```typescript
import { Patches, IndexedDBStore } from '@dabble/patches';

// Create an IndexedDB store. Give your app's data a unique name!
const store = new IndexedDBStore('my-amazing-collab-app-data');

// Hook it up to Patches
const patches = new Patches({ store });

// Now, Patches will save document states and changes to IndexedDB.
// Users can close the tab, go offline, and their work will be waiting.
```

Use `IndexedDBStore` when:

- Offline capability is a must-have
- You want fast document loads from local storage
- You need to reliably queue up changes made offline for later syncing

### LWW Stores (For Settings & Preferences)

These stores work with LWW (Last-Write-Wins) - ideal for simpler data like user settings, preferences, or status where the most recent write should just... win.

#### `LWWInMemoryStore`: In-Memory LWW

The LWW equivalent of `InMemoryStore`. Great for testing LWW-based features.

```typescript
import { LWWInMemoryStore } from '@dabble/patches/client';

const store = new LWWInMemoryStore();
```

#### `LWWIndexedDBStore`: Persistent LWW

The LWW equivalent of `IndexedDBStore`. Persists field values and timestamps to IndexedDB.

```typescript
import { LWWIndexedDBStore } from '@dabble/patches/client';

const store = new LWWIndexedDBStore('my-app-settings');
```

## How OT Stores Work: The Shelves

When you're using OT stores (`InMemoryStore` or `IndexedDBStore`), think of the store as having a few dedicated shelves:

### Shelf 1: Snapshots (The Latest Good Copy)

- **What:** The most recent server-confirmed state of each document
- **Why:** For loading documents super-fast. When `patches.getDoc()` is called, this is often the first place it looks
- **Details:** Keyed by document ID. Stores `{ docId, state, rev }`

### Shelf 2: Committed Changes (The Official History)

- **What:** A log of all changes that the server has successfully processed and confirmed
- **Why:** Useful for history, and can be used to reconstruct a document state if needed
- **Details:** Keyed by `[docId, rev]`. Stores your `Change` objects

### Shelf 3: Pending Changes (Your Work-in-Progress)

- **What:** Changes you've made locally that haven't been sent to the server yet, or are waiting for confirmation
- **Why:** This is CRITICAL for offline work! These are your unsaved changes, kept safe locally until they can be synced
- **Details:** Keyed by `[docId, rev]`. Stores your `Change` objects

### Shelf 4: Deleted Documents (The Tombstones)

- **What:** A list of documents that have been marked for deletion
- **Why:** Ensures that if a document is deleted locally (even offline), the server will be notified later
- **Details:** Keyed by document ID

## How LWW Stores Work: A Different Approach

LWW stores organize things differently because they don't need change history:

### Committed Fields

Server-confirmed field values. Each field path maps to its current value.

### Pending Ops

Local changes waiting to be sent. Stored as JSON Patch operations keyed by path.

### Sending Change

The in-flight change currently being sent to the server. Stays put until the server acknowledges it (idempotency!).

**State reconstruction** works like this:

```
snapshot → apply committed fields → apply sending change → apply pending ops → done!
```

## The Strategy Connection

Here's the thing: stores are intentionally "dumb". They just save and load data. The smart stuff - like consolidating multiple edits to the same field, or rebasing changes against server updates - happens in **strategies**.

- `OTStrategy` works with `OTClientStore` implementations
- `LWWStrategy` works with `LWWClientStore` implementations

This separation keeps stores simple and testable, while strategies handle the algorithm-specific logic.

## Pro Tips for Smooth Storing

- **IndexedDB Naming:** Choose a unique and descriptive name for your store database (e.g., `'yourAppName-docs'`). This helps avoid conflicts if other apps on the same domain use IndexedDB.
- **Storage Limits & Quotas:** Browsers have limits on IndexedDB storage. While generous, it's not infinite. Be mindful of how much data you're storing.
- **Error Handling:** Operations with IndexedDB stores can sometimes throw errors (e.g., if storage is full). Wrap your setup in try/catch blocks.
- **Compaction:** `IndexedDBStore` has a smart compaction strategy. Periodically, it consolidates older changes into new snapshots to save space and keep reads fast.

## Why This Local-First Approach is Sweet

Using `Patches` with a persistent store gives you:

- **Real Offline Power:** Users can create, edit, and browse documents even with zero internet. Their work is safe.
- **Snappy Performance:** Loading data from a local store is way faster than waiting for the network every single time.
- **Resilience:** Your app feels more robust because it's not entirely dependent on a perfect network connection.
- **Automatic Syncing:** When a connection is available, `PatchesSync` picks up the pending changes and gets them to the server.

It's about building apps that respect your users' time and work, no matter what their internet connection is doing.

## When to Use OT vs LWW

| Use Case                   | Strategy | Why                                              |
| -------------------------- | -------- | ------------------------------------------------ |
| Collaborative text editing | OT       | Need to merge concurrent character-level changes |
| Rich document editing      | OT       | Multiple users editing same content              |
| User preferences           | LWW      | Last setting should win, no merging needed       |
| Application settings       | LWW      | Simple key-value updates                         |
| Presence/status data       | LWW      | Latest status is what matters                    |

## Want to Learn More?

- [Patches.md](./Patches.md) - The main client-side API that uses these stores
- [net.md](./net.md) - How `PatchesSync` gets your locally stored changes talking to the server
- [PatchesDoc.md](./PatchesDoc.md) - Working with individual documents
- [algorithms.md](./algorithms.md) - The pure functions that handle sync logic
- [operational-transformation.md](./operational-transformation.md) - Deep dive into OT
