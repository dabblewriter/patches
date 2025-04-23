# PatchesHistoryClient

Client-side interface for browsing, scrubbing, and inspecting document version history in Patches.

## Overview

`PatchesHistoryClient` provides a read-only, event-driven API for listing document versions, loading historical states and changes, and scrubbing through changes for a given document. It is designed for use in collaborative UIs, version browsers, and audit tools.

- **Read-only:** Does not modify document state on the server.
- **Event-driven:** Uses signals for UI reactivity.
- **Efficient:** Uses an LRU cache for version state and changes.
- **Pluggable transport:** Works with any compatible transport (WebSocket, REST, etc.), but ships with WebSocket support.

## Relationship to Other Components

- **PatchesHistoryManager:** The server-side authority for version history. `PatchesHistoryClient` mirrors its API for client-side consumption.
- **PatchesWebSocket:** The default transport for fetching version data in real time.
- **PatchesDoc:** Use `PatchesDoc` for editing and mutating documents; use `PatchesHistoryClient` for read-only history exploration.

## API Reference

### Constructor

```ts
new PatchesHistoryClient<T = any>(docId: string, transport: HistoryTransport)
```

- `docId`: The document ID to browse history for.
- `transport`: An object implementing the `HistoryTransport` interface (e.g., a `PatchesWebSocket` instance).
- `T`: (Optional) Type of the document state.

### Properties

- `id: string` — The document ID.
- `versions: VersionMetadata[]` — The current list of loaded versions.
- `state: T` — The current state (after scrubbing or loading a version).
- `onVersionsChange` — Signal: subscribe to version list updates.
- `onStateChange` — Signal: subscribe to state changes.

### Methods

- `listVersions(options?: ListVersionsOptions): Promise<VersionMetadata[]>`
  - Fetch and cache the list of versions. Emits `onVersionsChange`.
- `getStateAtVersion(versionId: string): Promise<T>`
  - Loads the state for a specific version. Emits `onStateChange`.
- `getChangesForVersion(versionId: string): Promise<Change[]>`
  - Loads the changes for a specific version.
- `scrubTo(versionId: string, changeIndex: number): Promise<void>`
  - Loads the parent state and applies changes up to `changeIndex`. Emits `onStateChange`.
- `clear(): void`
  - Clears all caches and resets state/signals.

## Usage Example

```ts
import { PatchesHistoryClient } from 'patches/client/PatchesHistoryClient';
import { PatchesWebSocket } from 'patches/net/PatchesWebSocket';

const ws = new PatchesWebSocket('wss://your-server');
const history = new PatchesHistoryClient('doc-123', ws);

// Listen for version list updates
const unsubVersions = history.onVersionsChange(versions => {
  console.log('Versions:', versions);
});

// Listen for state changes (e.g., after scrubbing)
const unsubState = history.onStateChange(state => {
  console.log('Scrubbed state:', state);
});

// List versions
await history.listVersions({ limit: 10, reverse: true });

// Scrub to the 3rd change in a version
await history.scrubTo('version-abc', 3);

// Clean up
unsubVersions();
unsubState();
history.clear();
```

## Caching

- Uses an LRU cache (default size: 5) for version state and changes.
- Cache is cleared on `clear()`.
- Frequently accessed versions remain in memory for fast scrubbing.

## Scrubbing

- `scrubTo(versionId, changeIndex)` loads the parent state and applies changes up to the given index.
- Uses the same OT logic as the main document engine (via `applyChanges`).
- Emits `onStateChange` with the new state.

## Integration & UI

- Designed for integration with reactive UI frameworks (Svelte, React, etc.).
- Use `onVersionsChange` and `onStateChange` to update UI components.
- Can be used alongside `PatchesDoc` for editing and live collaboration.

## Error Handling

- Errors from the transport are thrown as rejected promises.
- You can catch and handle errors in your UI as needed.

## TypeScript Generics

- Pass a type parameter to `PatchesHistoryClient<T>` for strong typing of document state.

## Best Practices

- Always call `clear()` when disposing of the client to avoid memory leaks.
- Use the event signals for UI reactivity instead of polling.
- Use version list options to limit and sort results for large histories.

## See Also

- [PatchesHistoryManager](./PatchesHistoryManager.md)
- [PatchesDoc](./PatchesDoc.md)
- [PatchesWebSocket](./websocket.md)
