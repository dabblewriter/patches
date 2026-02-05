# PatchesHistoryClient

A client-side interface for exploring document history. Read-only by design, so you can browse, scrub, and inspect without worrying about accidentally modifying anything.

## What It Does

`PatchesHistoryClient` connects to the [PatchesHistoryManager](PatchesHistoryManager.md) on the server and lets you:

- List all versions of a document
- Load the state at any version
- Scrub through individual changes within a version (think video timeline scrubbing)
- Create and update named versions (snapshots)
- React to changes via event signals

This is the foundation for building version history UIs, restore functionality, and change diff viewers.

## Quick Start

```typescript
import { PatchesHistoryClient } from '@dabble/patches/client';
import { PatchesWebSocket } from '@dabble/patches/net';

// Connect to your server
const ws = new PatchesWebSocket('wss://your-server.com');
await ws.connect();

// Create a history client for a specific document
const history = new PatchesHistoryClient('doc-id', ws);

// Load the version list
const versions = await history.listVersions({ limit: 10, reverse: true });

// Load a specific version's state
const state = await history.getVersionState(versions[0].id);
```

## API Reference

### Constructor

```typescript
new PatchesHistoryClient<T>(id: string, api: PatchesAPI)
```

- `id` - Document ID to browse history for
- `api` - Any object implementing `PatchesAPI` (like [PatchesWebSocket](websocket.md))
- Generic type `T` provides type safety for the document state

### Properties

| Property           | Type                | Description                                                |
| ------------------ | ------------------- | ---------------------------------------------------------- |
| `id`               | `string`            | Document ID                                                |
| `versions`         | `VersionMetadata[]` | Currently loaded version list                              |
| `state`            | `T`                 | Current state (updated by `getVersionState` and `scrubTo`) |
| `onVersionsChange` | `Signal`            | Fires when version list changes                            |
| `onStateChange`    | `Signal`            | Fires when state changes (including during scrubbing)      |

### Methods

#### `listVersions(options?)`

Fetches version metadata from the server. Emits `onVersionsChange`.

```typescript
const versions = await history.listVersions({
  limit: 20,
  reverse: true, // Newest first
  orderBy: 'startedAt', // 'startedAt' | 'endRev' | 'startRev'
  origin: 'main', // 'main' | 'offline-branch' | 'branch'
  groupId: 'batch-abc', // Filter by branch/batch ID
  startAfter: 1706000000, // Pagination cursor
  endBefore: 1707000000,
});
```

See [ListVersionsOptions](../src/types.ts) for all options.

#### `getVersionState(versionId)`

Loads and caches the document state at a specific version. Emits `onStateChange`.

```typescript
const state = await history.getVersionState('version-123');
console.log(state.title); // Access your document structure
```

#### `getVersionChanges(versionId)`

Loads and caches the individual changes within a version.

```typescript
const changes = await history.getVersionChanges('version-123');
console.log(`${changes.length} changes in this version`);
```

#### `scrubTo(versionId, changeIndex)`

Scrubs to a specific change within a version. The `changeIndex` is **1-based**:

- `0` shows the parent version's state (before any changes in this version)
- `1` shows state after the first change
- `n` shows state after the nth change

Emits `onStateChange`.

```typescript
// Get changes first to know the range
const changes = await history.getVersionChanges('version-123');

// Scrub through each change
for (let i = 0; i <= changes.length; i++) {
  await history.scrubTo('version-123', i);
  // UI updates via onStateChange
}
```

#### `createVersion(metadata)`

Creates a new named version (snapshot) of the document's current state. Useful for marking milestones.

```typescript
const versionId = await history.createVersion({
  name: 'Draft Complete',
  description: 'First complete draft ready for review',
});
```

#### `updateVersion(versionId, metadata)`

Updates metadata for an existing version.

```typescript
await history.updateVersion('version-123', {
  name: 'Final Draft',
  description: 'Updated with reviewer feedback',
});
```

#### `clear()`

Resets all state, clears caches, and removes event listeners. Call this when you're done with the history client.

```typescript
history.clear();
```

## Caching

`PatchesHistoryClient` uses an LRU cache (6 entries by default) to store version states and changes. Frequently accessed versions stay in memory for fast scrubbing. The cache automatically evicts least-recently-used entries when full.

This means:

- Scrubbing back and forth within cached versions is instant
- Loading many versions will eventually evict older ones
- `clear()` empties the cache entirely

## Type Safety

Pass a generic type for full TypeScript support:

```typescript
interface MyDoc {
  title: string;
  content: string;
  author: { id: string; name: string };
}

const history = new PatchesHistoryClient<MyDoc>('doc-id', ws);

history.onStateChange(state => {
  // state is typed as MyDoc
  console.log(state.title);
});
```

## Example: Version History Browser

Here's a practical implementation of a version history UI:

```typescript
import { PatchesHistoryClient } from '@dabble/patches/client';
import { PatchesWebSocket } from '@dabble/patches/net';

class VersionHistoryBrowser {
  private ws: PatchesWebSocket;
  private history: PatchesHistoryClient;
  private currentVersionId: string | null = null;

  constructor(docId: string, serverUrl: string) {
    this.ws = new PatchesWebSocket(serverUrl);
    this.history = new PatchesHistoryClient(docId, this.ws);

    // Wire up reactive updates
    this.history.onVersionsChange(versions => {
      this.renderVersionList(versions);
    });

    this.history.onStateChange(state => {
      this.renderPreview(state);
    });
  }

  async connect() {
    await this.ws.connect();
    await this.history.listVersions({ limit: 50, reverse: true });
  }

  async selectVersion(versionId: string) {
    this.currentVersionId = versionId;
    await this.history.getVersionState(versionId);

    // Load changes for the scrub bar
    const changes = await this.history.getVersionChanges(versionId);
    this.renderScrubBar(changes.length);
  }

  async scrub(position: number) {
    if (!this.currentVersionId) return;
    await this.history.scrubTo(this.currentVersionId, position);
  }

  async createSnapshot(name: string) {
    await this.history.createVersion({ name });
    // Version list auto-refreshes after creation
  }

  disconnect() {
    this.history.clear();
    this.ws.disconnect();
  }

  // UI rendering methods (implement based on your framework)
  private renderVersionList(versions: any[]) {
    /* ... */
  }
  private renderPreview(state: any) {
    /* ... */
  }
  private renderScrubBar(totalChanges: number) {
    /* ... */
  }
}
```

## Best Practices

1. **Always call `clear()` when done** - Frees memory and removes listeners
2. **Use event signals for reactive UIs** - Don't poll; subscribe to `onVersionsChange` and `onStateChange`
3. **Paginate large histories** - Use `limit` and cursor options in `listVersions()`
4. **Handle errors** - Wrap API calls in try/catch for network failures
5. **Load versions list before scrubbing** - `scrubTo` needs the versions array to find parent relationships

## Related Documentation

- [PatchesHistoryManager](PatchesHistoryManager.md) - Server-side history management
- [PatchesDoc](PatchesDoc.md) - Document editing (the write side)
- [Patches](Patches.md) - Main client coordinator
- [WebSocket Transport](websocket.md) - Connection details
- [Operational Transformation](operational-transformation.md) - How changes are tracked
