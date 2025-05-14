# Persistence: Your Doc's Local Hideout 🏠

So, you're building something awesome and collaborative. But what happens when the internet decides to take a nap? Or when your users just want to work on their stuff locally without waiting for the network? That's where persistence swoops in, cape and all!

In the Patches world, persistence means giving your documents a cozy local home. This makes your app feel snappy, lets users work offline, and generally makes life better. The main `Patches` class works with a **store** to manage all this local data goodness. `PatchesSync` then handles the job of talking to the server when a connection is available.

## Meet the Stores: Your Local Data Keepers

`Patches` uses an object that conforms to the `PatchesStoreBackend` interface to manage how documents and their changes are stored locally. We provide a couple of ready-to-go options:

### 1. `InMemoryStore`: Quick & Clean (But Not Forever)

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

- Unit tests where you need a clean slate every time.
- Scenarios where data persistence isn't a requirement.
- Keeping things ultra-simple if you're just trying things out.

### 2. `IndexedDBStore`: Robust & Ready for Offline

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

- Offline capability is a must-have.
- You want fast document loads from local storage.
- You need to reliably queue up changes made offline for later syncing with `PatchesSync`.

## How `Patches` and Your Store Work Together

Whether you pick `InMemoryStore` or `IndexedDBStore` (or even roll your own `PatchesStoreBackend`), `Patches` relies on the store to manage a few key types of information. Understanding this helps you see how offline changes are kept safe and how `PatchesSync` knows what to send to the server.

Think of the store as having a few dedicated shelves:

### Shelf 1: Snapshots (The Latest Good Copy) ✨

- **What:** The most recent server-confirmed state of each document.
- **Why:** For loading documents super-fast. When `patches.getDoc()` is called, this is often the first place it looks.
- **Details:** Keyed by document ID. Stores `{ docId: string; state: any; rev: number }`.

### Shelf 2: Committed Changes (The Official History) ✓

- **What:** A log of all changes that the server has successfully processed and confirmed.
- **Why:** Useful for history, and can be used to reconstruct a document state if needed (though snapshots are usually faster for current state).
- **Details:** Keyed by `[docId, rev]`. Stores your `Change` objects, plus the `docId`.

### Shelf 3: Pending Changes (Your Work-in-Progress) ⏳

- **What:** Changes you've made locally that `PatchesSync` hasn't yet sent to the server, or that are waiting for server confirmation.
- **Why:** This is CRITICAL for offline work! These are your unsaved changes, kept safe locally until they can be synced.
- **Details:** Keyed by `[docId, rev]`. Stores your `Change` objects, plus the `docId`.

### Shelf 4: Deleted Documents (The Tombstones) 🗑️

- **What:** A list of documents that have been marked for deletion.
- **Why:** Ensures that if a document is deleted locally (even offline), `PatchesSync` can later tell the server to delete it, and it won't magically reappear.
- **Details:** Keyed by document ID. Stores `{ docId: string }`.

`Patches` uses these "shelves" to:

- Load documents quickly.
- Apply your local changes optimistically.
- Keep track of what needs to be sent to the server by `PatchesSync`.
- Receive and correctly apply server changes relayed by `PatchesSync`.

## Pro Tips for Smooth Storing

- **IndexedDB Naming:** Choose a unique and descriptive name for your `IndexedDBStore` database (e.g., `'yourAppName-docs'`). This helps avoid conflicts if other apps on the same domain use IndexedDB.
- **Storage Limits & Quotas:** Browsers have limits on IndexedDB storage. While generous, it's not infinite. Be mindful of how much data you're storing, especially if users have many large documents. Provide ways for users to manage their local data if necessary.
- **Error Handling:** Operations with `IndexedDBStore` (like initializing `Patches` with it) can sometimes throw errors (e.g., if storage is full or the browser is in a weird state). Wrap your setup in try/catch blocks.
- **Compaction (for `IndexedDBStore`):** `IndexedDBStore` has a smart compaction strategy. Periodically, it will consolidate older changes into new snapshots to save space and keep reads fast. This usually happens automatically, but it's good to know it's there.

## Why This Local-First Approach is Sweet 🍭

Using `Patches` with a persistent store like `IndexedDBStore` gives you:

- **Real Offline Power:** Users can create, edit, and browse documents even with zero internet. Their work is safe.
- **Snappy Performance:** Loading data from a local store is way faster than waiting for the network every single time.
- **Resilience:** Your app feels more robust because it's not entirely dependent on a perfect network connection.
- **Automatic Syncing:** When a connection is available, `PatchesSync` picks up the pending changes from the store and gets them to the server.

It's about building apps that respect your users' time and work, no matter what their internet connection is doing.

## Want to Learn More?

- [Patches.md](./Patches.md) - The main client-side API that uses these stores.
- [net.md](./net.md) - How `PatchesSync` gets your locally stored changes talking to the server.
- [PatchesDoc.md](./PatchesDoc.md) - Working with individual documents (which are managed by `Patches` and the store).
- [operational-transformation.md](./operational-transformation.md) - The core OT magic that happens on the server, making sense of changes from various clients.
