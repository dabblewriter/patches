# `Patches` — Main Client Entry Point

The `Patches` class is the main entry point for building collaborative, real-time applications with the Patches library. It manages document instances (`PatchesDoc`), handles persistence, and integrates with real-time sync (`PatchesSync`). Most applications should use `Patches` to open and manage documents, rather than instantiating `PatchesDoc` directly.

**Table of Contents**

- [Overview](#overview)
- [Initialization](#initialization)
- [Tracking and Managing Documents](#tracking-and-managing-documents)
  - [openDoc](#opendoc)
  - [trackDocs / untrackDocs](#trackdocs--untrackdocs)
  - [closeDoc](#closedoc)
- [Integration with Sync](#integration-with-sync)
- [Event Signals](#event-signals)
- [Example Usage](#example-usage)
- [Related Docs](#related-docs)

---

## Overview

- **Role:** `Patches` is the main client-side interface for collaborative apps. It manages the lifecycle of documents, persistence, and (optionally) real-time sync.
- **Pattern:** You create a single `Patches` instance per app/session, then open and manage documents through it.
- **Persistence:** Pluggable store (e.g., `InMemoryStore`, IndexedDB, custom backend).
- **Sync:** Integrates with `PatchesSync` for real-time server communication.

## Initialization

```typescript
import { Patches } from '@dabble/patches';
import { InMemoryStore } from '@dabble/patches/persist/InMemoryStore';

const store = new InMemoryStore();
const patches = new Patches({ store });
```

**Options:**

- `store`: Required. Any implementation of `PatchesStore` (see [InMemoryStore](./InMemoryStore.md)).
- `metadata`: Optional. Default metadata to attach to all changes from this client.

## Tracking and Managing Documents

### `openDoc`

Open (or create) a collaborative document by ID. Returns a `PatchesDoc` instance for editing and subscribing to updates.

```typescript
const doc = await patches.openDoc<MyDoc>('my-doc-id');
doc.onUpdate(newState => {
  /* ... */
});
doc.change(draft => {
  draft.title = 'Hello';
});
```

### `trackDocs` / `untrackDocs`

Track one or more document IDs for persistence and sync. You must track a doc before opening it.

```typescript
await patches.trackDocs(['my-doc-id']);
// ...
await patches.untrackDocs(['my-doc-id']);
```

### `closeDoc`

Close a document instance and clean up listeners/resources.

```typescript
await patches.closeDoc('my-doc-id');
```

## Integration with Sync

To enable real-time sync, use `PatchesSync`:

```typescript
import { PatchesSync } from '@dabble/patches/net/PatchesSync';
const sync = new PatchesSync('wss://your-server-url', patches);
await sync.connect();
```

- `PatchesSync` will automatically sync all tracked/open documents.
- See [PatchesSync documentation](./net.md) for details.

## Event Signals

`Patches` provides several event signals for app-level hooks:

- `onError`: `(error, context) => void` — Any error in doc/store/sync.
- `onServerCommit`: `(docId, changes) => void` — When server confirms changes.
- `onTrackDocs`: `(docIds) => void` — When docs are tracked.
- `onUntrackDocs`: `(docIds) => void` — When docs are untracked.
- `onDeleteDoc`: `(docId) => void` — When a doc is deleted.

Example:

```typescript
patches.onError((err, ctx) => {
  console.error('Patches error:', err, ctx);
});
```

## Example Usage

**Basic:**

```typescript
import { Patches } from '@dabble/patches';
import { InMemoryStore } from '@dabble/patches/persist/InMemoryStore';

const store = new InMemoryStore();
const patches = new Patches({ store });
await patches.trackDocs(['doc1']);
const doc = await patches.openDoc<{ text: string }>('doc1');
doc.onUpdate(state => console.log('Updated:', state));
doc.change(draft => {
  draft.text = 'Hello!';
});
```

**With Sync:**

```typescript
import { PatchesSync } from '@dabble/patches/net/PatchesSync';
const sync = new PatchesSync('wss://your-server-url', patches);
await sync.connect();
```

## Related Docs

- [PatchesDoc](./PatchesDoc.md) — Document instance API
- [PatchesSync](./net.md) — Real-time sync
- [InMemoryStore](./persist.md) — Example store implementation
- [Operational Transformation](./operational-transformation.md)

---

**Note:** Most applications should not instantiate `PatchesDoc` directly. Always use `patches.openDoc(docId)` to obtain a document instance.
