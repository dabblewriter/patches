# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

- **Install dependencies**: `npm install`
- **Development mode**: `npm run dev` (runs Vite in development mode)
- **Build the library**: `npm run build` (uses svelte-package to build the library)
- **Run tests**: `npm run test` (runs all Vitest tests)
- **Test-driven development**: `npm run tdd` (runs Vitest in watch mode)
- **Lint code**: `npm run lint` (runs ESLint on src and tests)
- **Fix linting issues**: `npm run lint:fix` (auto-fixes ESLint issues)

## Project Overview

Patches is a TypeScript library for building real-time collaborative applications. It supports two sync strategies:
- **OT (Operational Transformation)**: Centralized server model with change rebasing for collaborative editing
- **LWW (Last-Write-Wins)**: Simpler timestamp-based resolution for settings, preferences, and status data

### Import Paths

The library uses subpath exports. Use these import paths:

- Main/Client: `@dabble/patches`
- Client-specific: `@dabble/patches/client`
- Server components: `@dabble/patches/server`
- Networking: `@dabble/patches/net`
- WebRTC: `@dabble/patches/webrtc`
- Vue 3 integration: `@dabble/patches/vue`

### Key Features

- **Centralized OT**: Uses a central server to definitively order operations
- **Immutable State**: Document state is immutable, with changes creating new objects
- **Linear History**: Server maintains a single, linear history of document revisions
- **Offline Support**: Includes versioning and snapshot functionality
- **Branching**: Supports branch creation and merging for concurrent work
- **Transport Options**: WebSocket and WebRTC support for networking

## Architecture

The codebase is divided into client-side and server-side components:

### Client-Side Components

1. **Patches**: Main client coordinator and public API
   - Document lifecycle management and event coordination
2. **PatchesDoc**: Document interface focused on app interaction
   - Local state management and change API
   - Uses algorithm functions for change creation
3. **PatchesSync**: Sync coordinator between client and server
   - Orchestrates sync operations using algorithm functions
   - Handles connection management and batching
4. **SyncStrategy**: Algorithm-specific sync logic
   - `OTStrategy`: OT-specific operations (rebasing, change tracking)
   - `LWWStrategy`: LWW-specific operations (field consolidation, timestamp handling)
5. **PatchesStore**: Client-side storage interface hierarchy
   ```
   PatchesStore (base - 9 methods: track, list, get, save, delete, close)
   ├── OTClientStore (+3 methods: getPendingChanges, savePendingChanges, applyServerChanges)
   └── LWWClientStore (+6 methods: getPendingOps, savePendingOps, getSendingChange, saveSendingChange, confirmSendingChange, applyServerChanges)
   ```
   - OT implementations: `InMemoryStore`, `IndexedDBStore` (via `OTIndexedDBStore`)
   - LWW implementations: `LWWInMemoryStore`, `LWWIndexedDBStore`

### Server-Side Components

1. **OTServer**: Core server-side OT authority (implements PatchesServer interface)
   - Processes incoming changes, assigns revisions
   - Uses server algorithm functions for state management
   - Maintains document history
2. **LWWServer**: Server-side LWW authority
   - Field-based storage with timestamp comparison
   - No change history, just current field values
3. **PatchesStoreBackend**: Server-side storage interface
   - `LWWStoreBackend`: LWW-specific storage (fields, snapshots)
4. **PatchesHistoryManager**: Handles document history and versioning
5. **OTBranchManager / LWWBranchManager**: Manages branching and merging workflows

### Algorithm Layer

1. **Client Algorithms**: Pure functions for client-side operations
   - `makeChange`: Creates change objects from mutations
   - `applyCommittedChanges`: Merges server updates with local state
   - `createStateFromSnapshot`: Builds current state from snapshots

2. **LWW Algorithms**: LWW-specific operations
   - `makeLWWChange`: Creates LWW change objects with timestamps
   - `applyLWWChange`: Applies LWW changes with timestamp comparison

3. **Shared Algorithms**: Core OT logic used by both client and server
   - `applyChanges`: Applies change sequences to states
   - `rebaseChanges`: Core operational transformation logic
   - `breakChanges`, `breakChangesIntoBatches`: Handles large change splitting for network transmission

4. **Server Algorithms**: Server-specific state management
   - `getStateAtRevision`, `getSnapshotAtRevision`: Historical state retrieval
   - `handleOfflineSessionsAndBatches`: Offline sync processing

**Note**: Strategies invoke algorithm functions; stores are "dumb storage" that persist data without algorithm logic.

### Networking & Persistence

1. **Transport Layer**:
   - **WebSocketTransport**: Server-mediated communication
   - **WebRTCTransport**: Peer-to-peer communication

### Sync Strategy Implementation

**OT (Operational Transformation)**:
- Uses JSON Patch operations (RFC 6902) with custom OT transformations
- Stores maintain change history for rebasing
- Server transforms concurrent changes and assigns revisions
- Best for: collaborative editing where concurrent changes need merging

**LWW (Last-Write-Wins)**:
- Uses JSON Patch operations with timestamps
- Stores maintain current field values, no change history
- Server compares timestamps: `incoming.ts >= existing.ts` → incoming wins
- Best for: settings, preferences, status data where last write should win

Both strategies use pure algorithm functions, making them easy to test and reuse.

## Code Structure

- `/src/client`: Client-side implementation
  - Stores: `InMemoryStore`, `IndexedDBStore`, `LWWInMemoryStore`, `LWWIndexedDBStore`
  - Strategies: `OTStrategy`, `LWWStrategy`
  - Store interfaces: `PatchesStore`, `OTClientStore`, `LWWClientStore`
- `/src/server`: Server-side implementation
  - Servers: `OTServer`, `LWWServer`
  - Branch managers: `OTBranchManager`, `LWWBranchManager`
- `/src/algorithms`: Pure algorithm functions for sync operations
  - `/client`: Client-specific algorithms
  - `/server`: Server-specific algorithms
  - `/shared`: Common algorithms used by both client and server
  - `/lww`: LWW-specific algorithms
- `/src/net`: Networking and transport layer
- `/src/json-patch`: JSON Patch operations and transformations
- `/tests`: Test files matching the source structure

## Important Implementation Details

1. **Change Processing Flow**:
   - Client calls `doc.change()` → `makeChange` algorithm creates change objects
   - Change applied locally (optimistic update)
   - `PatchesSync` batches and sends changes to server
   - Server transforms against concurrent changes, assigns new revision
   - Server changes flow back → `PatchesSync` uses `applyCommittedChanges` algorithm
   - `applyCommittedChanges` calls `rebaseChanges` to handle conflicts
   - Updated state propagated to `PatchesDoc` and UI

2. **Versioning**:
   - System creates snapshots after 30 minutes of inactivity
   - Each version may represent one or many changes
   - Allows efficient loading of large documents with many changes

3. **State Handling**:
   - Document state is immutable
   - Changes are made through proxy in `doc.change(state => state.prop = 'new value')`
   - Uses immutable-style updates for performance and consistency

4. **Performance Characteristics**:
   - Handles documents with over 480k operations
   - Load time: 1-2ms for large documents
   - Change application: 0.2ms per operation
   - Scales linearly with document size through snapshots rather than history size

5. **Usage Example**:

   ```typescript
   // Client-side
   import { Patches, InMemoryStore } from '@dabble/patches/client';
   import { PatchesSync } from '@dabble/patches/net';

   const patches = new Patches({ store: new InMemoryStore() });
   const sync = new PatchesSync(patches, 'wss://server.com');

   // Server-side
   import { OTServer } from '@dabble/patches/server';

   const server = new OTServer(store);
   ```

## Testing Approach

Tests are written using Vitest and follow a structure mirroring the source code. Most tests use mocking to isolate components.

To run a single test file:

```bash
npm run test -- tests/path/to/file.spec.ts
```

To run tests with a specific pattern:

```bash
npm run test -- -t "test description pattern"
```

- **When writing tests, always run them and fix the errors**
- **When refactoring code, fix the tests and documentation for that code at the same time.**

## Architecture Analysis and Critical Issues

### Architectural Insights

1. **Four-Layer Architecture**:
   - **Application Layer**: Patches, PatchesDoc for user-facing API
   - **Orchestration Layer**: PatchesSync coordinates between layers
   - **Algorithm Layer**: Pure functions handle OT and state operations
   - **Transport Layer**: Pluggable networking (WebSocket/WebRTC)

2. **State Management Approach**:
   - Immutable state with proxy-based change tracking
   - Optimistic client updates with server reconciliation
   - Algorithm functions handle state transformations
   - Linear history with snapshot-based versioning

3. **Separation of Concerns**:
   - **Pure algorithms** for testable, reusable OT logic
   - **Orchestration classes** handle coordination and events
   - **Clean interfaces** between layers
   - **Focused responsibilities** for each component

4. **Concurrency Model**:
   - Centralized server arbitrates operation order
   - Client-side rebasing for pending changes
   - Event-driven architecture with signal patterns

## Vue 3 Integration

Patches includes first-class Vue 3 Composition API support via `@dabble/patches/vue`. See [src/vue/README.md](src/vue/README.md) for comprehensive documentation, examples, and best practices.

## Solid.js Integration

Patches includes first-class Solid.js support via `@dabble/patches/solid`. See [src/solid/README.md](src/solid/README.md) for comprehensive documentation, examples, and best practices.
