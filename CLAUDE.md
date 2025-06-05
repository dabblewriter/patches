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

Patches is a TypeScript library for building real-time collaborative applications. It leverages Operational Transformation (OT) with a centralized server model to ensure document consistency across multiple clients.

### Import Paths

The library uses subpath exports. Use these import paths:

- Main/Client: `@dabble/patches`
- Client-specific: `@dabble/patches/client`
- Server components: `@dabble/patches/server`
- Networking: `@dabble/patches/net`
- WebRTC: `@dabble/patches/webrtc`

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

1. **Patches**: Main client entry point for document management
2. **PatchesDoc**: Represents a single collaborative document
   - Handles local state management and optimistic updates
   - Implements client-side OT logic for rebasing changes

### Server-Side Components

1. **PatchesServer**: Core server-side logic
   - Processes incoming changes, performs transformations
   - Maintains document history
2. **PatchesHistoryManager**: Handles document history and versioning
3. **PatchesBranchManager**: Manages branching and merging workflows

### Networking & Persistence

1. **Transport Layer**:
   - **WebSocketTransport**: Server-mediated communication
   - **WebRTCTransport**: Peer-to-peer communication
2. **Persistence Layer**:
   - **PatchesStore**: Client-side storage interface
   - **PatchesStoreBackend**: Server-side storage interface
   - Implementations: InMemoryStore, IndexedDBStore

### OT Implementation

The system uses JSON Patch operations (RFC 6902) with custom OT transformations to handle concurrent edits.

## Code Structure

- `/src/client`: Client-side implementation
- `/src/server`: Server-side implementation
- `/src/json-patch`: JSON Patch operations and transformations
- `/src/net`: Networking and transport layer
- `/tests`: Test files matching the source structure

## Important Implementation Details

1. **Change Processing Flow**:

   - Client makes a change → optimistically applied locally
   - Change sent to server with baseRev (server revision it was based on)
   - Server transforms against concurrent changes, assigns new revision
   - Transformed change is broadcast to all clients

2. **Versioning**:

   - System creates snapshots after 30 minutes of inactivity
   - Each version may represent one or many changes
   - Allows efficient loading of large documents with many changes

3. **State Handling**:

   - Document state is immutable
   - Changes are made through proxy in `doc.change(state => state.prop = 'new value')`
   - Uses immutable-style updates for performance and consistency

4. **Performance Characteristics**:

   - Handles documents with 480k+ operations
   - Load time: 1-2ms for large documents
   - Change application: 0.2ms per operation
   - Scales linearly with document size through snapshots

5. **Usage Example**:

   ```typescript
   // Client-side
   import { Patches, InMemoryStore } from '@dabble/patches';
   import { PatchesSync } from '@dabble/patches/net';

   // Server-side
   import { PatchesServer } from '@dabble/patches/server';
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

## Architecture Analysis and Critical Issues

### Architectural Insights

1. **Three-Layer Architecture**:
   - **Application Layer**: Client-side state management with optimistic updates
   - **Transformation Layer**: JSON Patch-based OT implementation
   - **Transport Layer**: Pluggable networking (WebSocket/WebRTC)

2. **State Management Approach**:
   - Immutable state with proxy-based change tracking
   - Optimistic client updates with server reconciliation
   - Linear history with snapshot-based versioning

3. **Concurrency Model**:
   - Centralized server arbitrates operation order
   - Client-side rebasing for pending changes
   - Event-driven architecture with signal patterns

### Critical Logical Errors Found

#### Client-Side Issues

1. **Race Condition in Document Creation** (`Patches.ts:94-119`):
   - Multiple concurrent `openDoc()` calls can create duplicate document instances
   - Missing atomic check-and-create operation

2. **Memory Leaks** (`Patches.ts:115-117`, `PatchesHistoryClient.ts:47-50`):
   - Event listeners not cleaned up on error paths
   - Long-lived instances accumulate listeners without cleanup

3. **State Divergence During Import/Export** (`PatchesDoc.ts:94-101`):
   - Export combines sending and pending changes
   - Import loses distinction, marking all as pending
   - Can cause duplicate operations on reconnection

4. **Silent Data Loss Risk** (`IndexedDBStore.ts:296-309`):
   - Snapshot creation can fail silently
   - Unbounded accumulation of committed changes possible

#### Server-Side Issues

1. **Critical Transformation Bug** (`PatchesServer.ts:146-172`):
   - Applies original ops instead of transformed ops to state
   - Causes server state to diverge from client expectations

2. **Missing Atomicity** (`PatchesServer.ts:175-182`):
   - State saved but clients not notified if emit fails
   - Breaks consistency guarantees

3. **Branch Merge Revision Calculation** (`PatchesBranchManager.ts:137-139`):
   - Incorrect revision calculation for merged changes
   - Can cause revision conflicts

#### JSON Patch Implementation Issues

1. **Array Index Parser Bug** (`toArrayIndex.ts:7-9`):
   - Returns `Infinity` for non-numeric indices
   - Can cause unexpected behavior in array operations

2. **Path Handling Vulnerability**:
   - Inconsistent handling of `-` in array paths
   - Fragile string replacement logic

3. **Memory Leak in State Cache** (`state.ts`):
   - Cache grows unboundedly during large patch operations

#### Networking Layer Issues

1. **Message Loss During Reconnection** (`PatchesSync.ts:232-245`):
   - Partial batch sends possible during disconnection
   - No retry mechanism for failed batches

2. **Security Vulnerability** (`AuthorizationProvider.ts:55-57`):
   - Default provider allows all operations
   - Easy to accidentally deploy with open permissions

3. **OnlineState Logic Error** (`onlineState.ts:9-10`):
   - Offline handler always evaluates to true due to `||` operator

### Recommendations for Fixes

1. **Add Distributed Locking**: Implement proper locking for critical sections
2. **Improve Error Recovery**: Add transaction-like semantics for multi-step operations
3. **Fix Memory Management**: Implement proper cleanup in all error paths
4. **Add Input Validation**: Validate all inputs, especially array indices and paths
5. **Implement Retry Logic**: Add exponential backoff with jitter for network operations
6. **Security Hardening**: Make authorization fail-closed by default
7. **Add Monitoring**: Implement health checks and metrics for production debugging
