# `Patches` - The Client Coordinator

`Patches` is the central hub of your collaborative app on the client side. One instance, many documents. It manages document lifecycle, coordinates events, and provides the public API your app interacts with.

**Table of Contents**

- [What It Does](#what-it-does)
- [Getting Started](#getting-started)
- [Working with Documents](#working-with-documents)
- [Real-Time Sync](#real-time-sync)
- [Events](#events)
- [Complete Example](#complete-example)
- [Related Components](#related-components)

## What It Does

`Patches` is a coordinator, not a worker. It doesn't do the heavy lifting - it orchestrates the pieces that do:

- **Document Management**: Opens, tracks, and closes your collaborative docs
- **Event Coordination**: Listens to document events and re-emits them for your app
- **Algorithm Delegation**: Routes operations to the right sync algorithm (OT or LWW)
- **Public API**: Provides the clean interface your app uses

The pattern: create **one** `Patches` instance for your whole app, then use it to open as many documents as you need.

## Getting Started

### The Easy Way: Factory Functions

For most apps, factory functions are the simplest way to get started:

```typescript
import { createOTPatches, createOTIndexedDBPatches } from '@dabble/patches';

// For testing or when persistence isn't needed
const patches = createOTPatches();

// For production with IndexedDB persistence
const patches = createOTIndexedDBPatches({ dbName: 'my-app' });
```

Available factories:

| Factory                                 | Algorithm | Storage      | Use Case                         |
| --------------------------------------- | --------- | ------------ | -------------------------------- |
| `createOTPatches`                       | OT        | Memory       | Testing, ephemeral sessions      |
| `createOTIndexedDBPatches`              | OT        | IndexedDB    | Production collaborative editing |
| `createLWWPatches`                      | LWW       | Memory       | Testing LWW features             |
| `createLWWIndexedDBPatches`             | LWW       | IndexedDB    | Production settings/preferences  |
| `createMultiAlgorithmPatches`           | Both      | Memory       | Testing multi-algorithm apps     |
| `createMultiAlgorithmIndexedDBPatches`  | Both      | IndexedDB    | Production multi-algorithm apps  |
| `createMultiAlgorithmExternalDBPatches` | Both      | External IDB | Hosting Patches in your own DB   |

All factories accept optional `metadata` for attaching user info to changes:

```typescript
const patches = createOTIndexedDBPatches({
  dbName: 'my-app',
  metadata: {
    user: { id: 'user-123', name: 'Alice', color: '#FF5733' },
    deviceId: 'mobile-ios-12345',
  },
});
```

### The Manual Way: Full Configuration

If you need more control, construct `Patches` directly with an algorithms map:

```typescript
import { Patches, OTAlgorithm, InMemoryStore } from '@dabble/patches';

const store = new InMemoryStore();
const otAlgorithm = new OTAlgorithm(store);

const patches = new Patches({
  algorithms: { ot: otAlgorithm },
  defaultAlgorithm: 'ot',
  metadata: { user: { id: 'user-123' } },
});
```

This approach lets you:

- Use custom store implementations
- Configure algorithm-specific options
- Mix algorithms with different storage backends

### Choosing an Algorithm

**OT (Operational Transformation)** is for collaborative editing where concurrent changes need intelligent merging. Multiple users editing the same paragraph? OT handles that.

**LWW (Last-Write-Wins)** is for simpler data where the most recent write should just... win. User settings, preferences, dashboard positions - timestamps resolve conflicts.

See [operational-transformation.md](operational-transformation.md) and [last-write-wins.md](last-write-wins.md) for deeper dives into each approach.

## Working with Documents

### Opening a Document

```typescript
// Define your document type
interface MyDoc {
  title: string;
  items: Array<{ id: string; text: string; done: boolean }>;
}

// Open a document (creates it if it doesn't exist)
const doc = await patches.openDoc<MyDoc>('shopping-list');

// Access the state
console.log(`Shopping List: ${doc.state.title}`);
console.log(`${doc.state.items.length} items`);

// Make changes
doc.change(draft => {
  draft.title = 'Grocery Shopping';
  draft.items.push({ id: Date.now().toString(), text: 'Milk', done: false });
});
```

The `openDoc` method:

- Returns a [`PatchesDoc<T>`](PatchesDoc.md) instance
- Creates the document if it doesn't exist
- Loads the latest state from your store
- Sets up change tracking

You can also specify a different algorithm when opening:

```typescript
// Open with LWW algorithm instead of default
const settingsDoc = await patches.openDoc('user-settings', { algorithm: 'lww' });
```

### Tracking Documents

Before opening docs, you might want to tell Patches which ones you care about:

```typescript
// Start tracking a set of documents
await patches.trackDocs(['shopping-list', 'todo-list', 'workout-plan']);

// Later, when you're done with some
await patches.untrackDocs(['workout-plan']);
```

Tracked documents stay in sync with the server even when not open locally. This enables background syncing and receiving updates for documents you're not actively viewing.

### Closing Documents

When you're done with a document:

```typescript
// Close a document (saves pending changes, removes from memory)
await patches.closeDoc('shopping-list');

// Or close and also untrack it
await patches.closeDoc('shopping-list', { untrack: true });

// For permanent deletion
await patches.deleteDoc('old-shopping-list');
```

Closing docs frees memory and ensures pending changes are persisted.

### Applying External Snapshots

`PatchesSync` handles snapshots that flow over its own connection. Any other transport that delivers snapshots out-of-band (multi-tab broadcast hubs, WebRTC peer mesh, custom server-push channels) has a race: a snapshot can land mid-`openDoc`, before the doc is in `getOpenDoc()`. Looking the doc up and calling `doc.import()` silently drops the snapshot in that window.

`applySnapshot` makes the window disappear:

```typescript
// Hub tab broadcasts a fresh snapshot; spoke tab applies it.
hub.onSnapshot((docId, snapshot) => {
  patches.applySnapshot(docId, snapshot);
});
```

What it does, based on the doc's state:

- **Already open** — imports immediately if `snapshot.rev > doc.committedRev`. Equal-rev and older snapshots are dropped (a `doc.import` at equal rev would reset internal pending-state that the user may still be filling).
- **`openDoc` in flight** — stashes in a single slot, keeping the highest-rev snapshot seen so out-of-order delivery doesn't lose newer state. `openDoc` drains the slot before resolving.
- **Neither open nor opening** — dropped. Patches doesn't hold onto snapshots for docs it isn't managing.

Idempotent, no-throw, and safe to call from any transport callback. Use it instead of the `getOpenDoc(id)?.import(snapshot)` pattern.

## Real-Time Sync

`Patches` works with [`PatchesSync`](PatchesSync.md) for real-time collaboration:

```typescript
import { PatchesSync } from '@dabble/patches/net';

// Create sync connection (patches instance first, then URL)
const sync = new PatchesSync(patches, 'wss://your-server.example.com');

// Connect to the server
await sync.connect();

// That's it - changes now automatically sync to/from the server
```

The flow:

1. `Patches` emits events when documents change
2. `PatchesSync` listens and handles server communication
3. Server changes flow back through `PatchesSync` to update documents
4. All the sync logic happens in pure [algorithm functions](algorithms.md)
5. Your app just sees clean, coordinated state updates

## Events

Listen for important events from the `Patches` system:

```typescript
// When a document receives changes from the server
patches.onServerCommit((docId, changes) => {
  console.log(`Document ${docId} received ${changes.length} changes from server`);
});
// Fires at the durable choke point, not when changes land on the wire: by the time it
// emits, the server changes are persisted and any open doc has been updated.

// When there's an error (usually from sync operations)
patches.onError((error, context) => {
  console.error(`Error in document ${context?.docId}:`, error);
  showErrorNotification('Something went wrong. Retrying...');
});
```

### Change-submit failure classes

For a failed change submit, `context.kind` classifies the failure and `context.willRetry` says
whether the ops were kept for re-submission. There are three classes:

- **`rejection`** (`willRetry: false`) — the server/store authoritatively refused the change
  (terminal `StatusError`: 401/402/403/404/410). The optimistic ops were **rolled back**; surface
  the error.
- **`defective`** (`willRetry: false`) — the change's own data can never be persisted: a
  non-cloneable value or a key/shape violation (`DataCloneError` / `DataError` / `ConstraintError`
  out of IndexedDB). This is a bug in the code that produced the change, so retrying is useless and
  working around the value is forbidden. The optimistic ops were **rolled back**; the app must
  alert the user (their edit could not be saved). This is the fix for the failure mode where a
  single non-cloneable change retried forever and silently blocked every later save.
  > `DataError` / `ConstraintError` count as defective because the shipped `OTIndexedDBStore`
  > (which `put`s and re-stamps `rev` in-transaction) never raises them transiently. A **custom**
  > store that used `add` or a unique secondary index could raise a _transient_ `ConstraintError`;
  > such a store must wrap that reject as a storage fault (see `toStorageError`) so it lands in the
  > `environment` bucket and is retried, rather than being discarded here as defective.
- **`environment`** — a transport/storage failure that is **not** a verdict on the ops (timeout,
  abort, network death, storage fault); the write may have landed or may land later. The ops are
  **kept applied** and re-submitted with backoff under the same stable change id (id-based dedup
  makes the retry idempotent) up to a bounded number of attempts. While retrying, `willRetry: true`
  — show a "retrying" state. If the attempts are exhausted the doc's **write path is latched**
  (`willRetry: false`) with the ops still applied in memory: nothing more is minted or sent for
  that doc until you call `retrySavingChanges`. This stops a broken storage environment from
  silently swallowing just-typed words forever — the app is told, so it can tell the user.

While a doc is latched, further changes stay applied optimistically (the user's text remains
visible) but are not persisted; each emits `onError` with `latched: true`.

### Store-refused changes are still sent: the outbox

With the OT algorithm, a change whose persist exhausted its attempts is not only latched — it is
handed to an in-memory **outbox** and sent to the server on the next flush, behind whatever the
store's queue holds, under the same stable change id the failed persist used. The store refused the
change; the server can still take it. `context.unstored` on the `onError` emit says whether that
happened (`false` for an algorithm without an outbox, such as LWW).

- The outbox is the **failure branch** of the write path, not a bypass of local durability: the
  store is still written first on every change, and only rows the store never accepted enter the
  outbox.
- A row leaves the outbox when its committed echo arrives, when the server resolves it away, or
  when the store accepts it after all (a `retrySavingChanges` re-drive minting under the same id).
  The open doc recognises the echo as its own and confirms the memory-only entry exactly once.
- The outbox is **memory only** — a reload loses it. `onUnstoredQueued` fires with the provisional
  change so the app can shelve it elsewhere as well.
- Rows are confirmed from the **commit response** of the flush that sent them, before the response
  is applied to the store — reported once, and no longer listed or counted as pending — so a store
  that refuses the apply as well cannot keep a row unconfirmed. The row itself stays in the outbox
  as a **stub** until the open doc's frame covers its committed rev: the doc only advances when the
  apply succeeds, and until then every later edit is minted on top of the row, so the stub rides
  in every batch (the server dedupes it by id and keeps its committed copy out of the transform
  set) and the later edits stay in its shadow. The doc's own echo or import retires it. Stubs
  count toward the ceiling below.
- Every row goes out at the committed frame its ops are really in (a row from an open doc is
  re-minted from the doc; a row the doc has closed on, or one accepted from another context, at
  its own `baseRev`), and is walked forward through every committed batch that extends that
  frame, so it is never relabeled into a frame it was not transformed into. When the doc jumps
  over a span (a rebuild from the store, a snapshot reload) the store supplies it; if the store
  cannot and the row was expressed over pending rows still in that frame, the span is read from
  the server instead (`PatchesSync` wires `getChangesSince` in), and if that is not possible
  either the row is dropped from the outbox and reported as `UnstoredFrameLostError` (its ops as
  they stood) so the app can shelve it — a row that depends on a pending row is never frozen at
  the old frame, where it would flush alone after that row and be transformed against its
  committed copy.
- The outbox is **bounded**: 500 rows or 2 MiB of serialised ops per doc. Past that, new rows are
  refused (never evicted — a queued row is unconfirmed content) and reported once per episode
  through `onError` as `UnstoredOutboxOverflowError`; the refused change's own `onError` emit says
  `unstored: false`, so the app can move to its shelf.
- A pending row held back from a flush a second time because it sits on a different committed
  frame than the head of the queue (see `PendingDeferredError`) is reported through
  `PatchesSync.onError` once per row — the first deferral is the designed one-frame-per-flush
  behaviour; the second means the follow-up flush did not clear it.

```typescript
patches.onUnstoredQueued((docId, change) => {
  // The store refused this change; it is queued to be sent from memory.
  shelfSomewhereDurable(docId, change);
});

patches.onUnstoredCommitted((docId, changes) => {
  // Outbox rows the server has now committed (their committed copies).
  telemetry('sync_unstored_sent', { docId, count: changes.length });
});

patches.listUnstoredChanges(docId); // the rows still queued, as they would go on the wire
```

**One elected sender.** If only one tab syncs, a non-sending tab cannot flush its own outbox.
Forward its `onUnstoredQueued` payload to the sender, which calls
`patches.acceptUnstoredChanges(docId, [change])`; when the sender's `onUnstoredCommitted` fires,
forward the committed copies back so the minting tab can call
`patches.noteUnstoredCommitted(docId, changes)` and drop its memory-only entries.

### Recovering from a latched write path

```typescript
// True while the doc's write path is latched (bounded retries exhausted).
if (patches.isWriteLatched(docId)) {
  // Prompt the user, then, once you believe storage/connectivity has recovered:
  await patches.retrySavingChanges(docId); // omit docId to retry every latched doc
}

// All currently latched docs (read-only snapshot):
patches.writeLatchedDocs; // string[]
```

`retrySavingChanges` clears the latch and re-drives the doc's retained optimistic changes through
the normal submit path, in capture order. If the environment is still broken the doc simply
re-latches; if the server now authoritatively rejects, that change rolls back.

```typescript
// When any document has pending changes ready to send
patches.onChange(docId => {
  console.log(`Document ${docId} has pending changes`);
});

// When documents are tracked/untracked
patches.onTrackDocs(docIds => {
  console.log('Now tracking:', docIds);
});

patches.onUntrackDocs(docIds => {
  console.log('No longer tracking:', docIds);
});

// When a document is deleted
patches.onDeleteDoc(docId => {
  console.log(`Document ${docId} was deleted`);
});
```

## Complete Example

Here's a real-world setup for a collaborative application:

```typescript
import { createOTIndexedDBPatches } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

class CollaborativeApp {
  private patches;
  private sync;
  private activeDocuments = new Map();

  constructor() {
    // Create Patches with IndexedDB persistence and user info
    this.patches = createOTIndexedDBPatches({
      dbName: 'my-collaborative-app',
      metadata: {
        user: this.getCurrentUser(),
      },
    });

    // Set up error handling
    this.patches.onError(this.handleError.bind(this));

    // Set up sync
    this.sync = new PatchesSync(this.patches, 'wss://collab.example.com');

    // Handle connection state
    this.sync.subscribe(state => {
      this.updateConnectionUI(state);
    });
  }

  async initialize() {
    // Track recently used documents
    const recentDocs = this.getRecentDocIds();
    await this.patches.trackDocs(recentDocs);

    // Connect to server
    await this.sync.connect();

    console.log('Collaborative app ready');
  }

  async openDocument(docId) {
    const doc = await this.patches.openDoc(docId);

    // Set up UI updates
    doc.subscribe(state => {
      this.updateDocumentUI(docId, state);
    });

    this.activeDocuments.set(docId, doc);
    this.addToRecentDocs(docId);

    return doc;
  }

  makeChange(docId, changeFn) {
    const doc = this.activeDocuments.get(docId);
    if (doc) {
      doc.change(changeFn);
    }
  }

  async shutdown() {
    await this.patches.close();
  }

  // Helper methods
  private getCurrentUser() {
    /* ... */
  }
  private getRecentDocIds() {
    /* ... */
  }
  private addToRecentDocs(docId) {
    /* ... */
  }
  private updateDocumentUI(docId, state) {
    /* ... */
  }
  private updateConnectionUI(state) {
    /* ... */
  }
  private handleError(error, context) {
    /* ... */
  }
}

// Usage
const app = new CollaborativeApp();
await app.initialize();

const doc = await app.openDocument('project-notes');

app.makeChange('project-notes', draft => {
  draft.title = 'Project X Planning';
  draft.notes.push('Meeting scheduled for Friday');
});
```

## Related Components

`Patches` coordinates several other components. Understand these to get the full picture:

- [PatchesDoc](PatchesDoc.md) - Individual document instances that `Patches` creates for you
- [PatchesSync](PatchesSync.md) - Real-time synchronization coordinator
- [persist.md](persist.md) - Storage interfaces and implementations
- [algorithms.md](algorithms.md) - Pure functions that handle OT and change processing
- [OTServer](OTServer.md) - Server-side OT implementation
- [LWWServer](LWWServer.md) - Server-side LWW implementation
- [operational-transformation.md](operational-transformation.md) - Deep dive into OT concepts
- [last-write-wins.md](last-write-wins.md) - Deep dive into LWW concepts
